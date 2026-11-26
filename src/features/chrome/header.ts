import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	formatCompactTokens,
	getThemeSurfacePalette,
	themeBgRgb,
	themeFgRgb,
	type HitBox,
	type RgbTuple,
} from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { claimHover, copyToClipboard } from "../../shared/runtime-hooks.ts";
import { isSlotOwnedByPiUi } from "../../shared/slot-arbitration.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { showContextInspector } from "../context-inspector/index.ts";

const GIT_BRANCH_CACHE_KEY = Symbol.for("conarti.pi-ui.git-branch-cache.v1");
const GIT_BRANCH_TTL_MS = 6_000;
const FRACTIONAL_BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

interface GitBranchCacheEntry {
	branch: string | null;
	updatedAt: number;
	inflight: boolean;
}

function getGitBranchCache(): Map<string, GitBranchCacheEntry> {
	const g = globalThis as Record<symbol, Map<string, GitBranchCacheEntry> | undefined>;
	if (!g[GIT_BRANCH_CACHE_KEY]) {
		g[GIT_BRANCH_CACHE_KEY] = new Map();
	}
	return g[GIT_BRANCH_CACHE_KEY]!;
}

function detectGitBranchSync(cwd: string): string | null {
	try {
		const out = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 150,
		}).trim();
		if (out) return out;
	} catch {
		/* Пробуем detached HEAD ниже */
	}
	try {
		const rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 150,
		}).trim();
		return rev ? `@${rev}` : null;
	} catch {
		return null;
	}
}

export function refreshGitBranchAsync(cwd: string): void {
	const cache = getGitBranchCache();
	const existing = cache.get(cwd);
	if (existing?.inflight) return;
	const entry: GitBranchCacheEntry = existing ?? {
		branch: null,
		updatedAt: 0,
		inflight: false,
	};
	entry.inflight = true;
	cache.set(cwd, entry);

	execFile(
		"git",
		["symbolic-ref", "--short", "HEAD"],
		{ cwd, encoding: "utf8", timeout: 400 },
		(err, stdout) => {
			const trimmed = typeof stdout === "string" ? stdout.trim() : "";
			if (!err && trimmed) {
				const changed = entry.branch !== trimmed;
				entry.branch = trimmed;
				entry.updatedAt = Date.now();
				entry.inflight = false;
				if (changed) requestRender();
				return;
			}
			execFile(
				"git",
				["rev-parse", "--short", "HEAD"],
				{ cwd, encoding: "utf8", timeout: 400 },
				(revErr, revOut) => {
					const rev = !revErr && typeof revOut === "string" ? revOut.trim() : "";
					const next = rev ? `@${rev}` : null;
					const changed = entry.branch !== next;
					entry.branch = next;
					entry.updatedAt = Date.now();
					entry.inflight = false;
					if (changed) requestRender();
				},
			);
		},
	);
}

function readCachedGitBranch(cwd: string): string | null {
	const cache = getGitBranchCache();
	const existing = cache.get(cwd);
	if (!existing) {
		const initial = detectGitBranchSync(cwd);
		cache.set(cwd, {
			branch: initial,
			updatedAt: Date.now(),
			inflight: false,
		});
		return initial;
	}
	if (Date.now() - existing.updatedAt > GIT_BRANCH_TTL_MS) {
		refreshGitBranchAsync(cwd);
	}
	return existing.branch;
}

export function formatTildeWorkspacePath(cwd: string): string {
	const home = homedir();
	if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
		const rest = cwd.slice(home.length);
		return rest ? `~${rest}` : "~";
	}
	return cwd;
}

function computeHeaderContextUsage(ctx: ExtensionContext): {
	readonly usedTokens: number;
	readonly contextWindow: number;
	readonly percent: number;
} {
	const usage = ctx.getContextUsage?.();
	const contextWindow = Math.max(1, usage?.contextWindow ?? ctx.model?.contextWindow ?? 200_000);
	if (typeof usage?.tokens === "number" && Number.isFinite(usage.tokens)) {
		const usedTokens = Math.max(0, Math.round(usage.tokens));
		const percent =
			typeof usage.percent === "number" && Number.isFinite(usage.percent)
				? Math.max(0, Math.min(100, usage.percent))
				: Math.min(100, (usedTokens / contextWindow) * 100);
		return { usedTokens, contextWindow, percent };
	}

	let chars = (ctx.getSystemPrompt?.() ?? "").length;
	const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
	for (const entry of entries as Array<{ type?: string; message?: { content?: unknown } }>) {
		if (entry?.type !== "message" || !entry.message) continue;
		const content = entry.message.content;
		if (typeof content === "string") {
			chars += content.length;
		} else if (Array.isArray(content)) {
			for (const part of content as Array<{ type?: string; text?: string; thinking?: string }>) {
				if (part?.type === "text") chars += (part.text ?? "").length;
				else if (part?.type === "thinking") chars += (part.thinking ?? "").length;
				else chars += JSON.stringify(part ?? "").length;
			}
		}
	}
	const usedTokens = Math.round(chars / 3.8);
	const percent = Math.min(100, (usedTokens / contextWindow) * 100);
	return { usedTokens, contextWindow, percent };
}

export function renderHeaderContextHoverBar(
	percent: number,
	targetWidth: number,
	barRgb: RgbTuple,
	trackRgb: RgbTuple,
	theme: Theme,
): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const pctStr = `${clamped.toFixed(1)}%`;
	const barCells = Math.max(3, targetWidth - visibleWidth(pctStr) - 1);
	const eighths = Math.max(clamped > 0 ? 2 : 0, Math.round((clamped / 100) * barCells * 8));
	let bar = "";
	for (let i = 0; i < barCells; i += 1) {
		const cellEighths = Math.max(0, Math.min(8, eighths - i * 8));
		bar += FRACTIONAL_BLOCKS[cellEighths]!;
	}
	const paintedTrack = themeBgRgb(theme, trackRgb, themeFgRgb(theme, barRgb, bar));
	const result = `${paintedTrack} ${theme.fg("text", pctStr)}`;
	const delta = targetWidth - visibleWidth(result);
	return delta > 0 ? `${" ".repeat(delta)}${result}` : truncateToWidth(result, targetWidth, "");
}

class SessionHeaderView implements Component {
	private hoveredId: string | null = null;
	private hits: HitBox[] = [];
	private readonly hoverOwner = {};

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly getTheme: () => Theme,
		private readonly pinnedMode: boolean,
	) {
		readCachedGitBranch(ctx.cwd);
	}

	isVisible = (viewport: { width: number; height: number }): boolean => {
		if (!isSlotOwnedByPiUi("header")) return false;
		if (!this.pinnedMode) return true;
		return viewport.height >= 8;
	};

	invalidate(): void {}

	dispose(): void {
		this.hoveredId = null;
		this.hits = [];
	}

	render(width: number): string[] {
		this.hits = [];
		if (width <= 0 || !isSlotOwnedByPiUi("header")) return [];

		if (!this.pinnedMode && getActiveHostRuntime()?.isFullscreen) {
			return [];
		}

		const theme = this.getTheme();
		const palette = getThemeSurfacePalette(theme);
		const outerPad = computeOuterCanvasMargin(width);
		const contentRowY = this.pinnedMode ? 1 : 0;
		const gitBranch = readCachedGitBranch(this.ctx.cwd);
		const tildePath = formatTildeWorkspacePath(this.ctx.cwd);

		const isWorkspaceHov = this.hoveredId === "workspace";
		const branchStyled = gitBranch
			? `${isWorkspaceHov ? theme.fg("muted", gitBranch) : themeFgRgb(theme, palette.codeMetaFg, gitBranch)} `
			: "";
		const pathStyled = isWorkspaceHov
			? themeFgRgb(theme, palette.accentBright, tildePath)
			: theme.fg("text", tildePath);
		const leftContent = `${branchStyled}${pathStyled}`;

		const { usedTokens, contextWindow, percent } = computeHeaderContextUsage(this.ctx);
		const usedStr = formatCompactTokens(usedTokens);
		const winStr = formatCompactTokens(contextWindow);
		const restPlain = `${usedStr} / ${winStr}`;
		const available = width - outerPad * 2;
		const gapWidth = 2;
		const slotWidth = available < 14 ? 0 : Math.min(available - gapWidth - 1, Math.max(11, visibleWidth(restPlain)));
		const isCtxHov = this.hoveredId === "context";

		let ctxRendered: string;
		if (slotWidth === 0) {
			ctxRendered = "";
		} else if (isCtxHov) {
			const barRgb =
				percent >= 85 ? palette.danger : percent >= 70 ? palette.warning : palette.accentBright;
			ctxRendered = renderHeaderContextHoverBar(
				percent,
				slotWidth,
				barRgb,
				palette.codeHeaderBg,
				theme,
			);
		} else {
			const rawStyled = `${theme.fg("text", usedStr)} ${themeFgRgb(theme, palette.codeMetaFg, `/ ${winStr}`)}`;
			const padLead = " ".repeat(Math.max(0, slotWidth - visibleWidth(rawStyled)));
			ctxRendered = truncateToWidth(`${padLead}${rawStyled}`, slotWidth, "…");
		}

		const rightTotalW = visibleWidth(ctxRendered) + outerPad;
		const minGap = slotWidth > 0 ? gapWidth : 0;
		const maxLeftW = width - outerPad - rightTotalW - minGap;
		const clippedLeft =
			visibleWidth(leftContent) > maxLeftW
				? truncateToWidth(leftContent, maxLeftW, "…")
				: leftContent;
		const leftW = visibleWidth(clippedLeft);
		const middleSpaces = Math.max(minGap, width - outerPad - leftW - rightTotalW);

		this.hits.push({
			id: "workspace",
			xStart: outerPad,
			xEnd: outerPad + Math.max(0, leftW - 1),
			y: contentRowY,
			onClick: () => {
				copyToClipboard(this.ctx.cwd);
				this.ctx.ui.notify(t("header.copiedPath", { path: tildePath }), "info");
			},
		});

		const ctxX = outerPad + leftW + middleSpaces;
		const ctxW = visibleWidth(ctxRendered);
		if (ctxW > 0) this.hits.push({
			id: "context",
			xStart: ctxX,
			xEnd: ctxX + Math.max(0, ctxW - 1),
			y: contentRowY,
			onClick: () => void showContextInspector(this.pi, this.ctx),
		});

		const contentRow = `${" ".repeat(outerPad)}${clippedLeft}${" ".repeat(middleSpaces)}${ctxRendered}${" ".repeat(outerPad)}`;
		const paddedContent = contentRow + " ".repeat(Math.max(0, width - visibleWidth(contentRow)));

		if (this.pinnedMode) {
			const blank = " ".repeat(width);
			return [blank, paddedContent, blank];
		}
		return [paddedContent];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const matched = this.hits.find(
			(h) => event.y === (h.y ?? 0) && event.x >= h.xStart && event.x <= h.xEnd,
		);

		if (event.type === "move") {
			const nextId = matched?.id ?? null;
			if (nextId) {
				claimHover(this.hoverOwner, () => {
					if (this.hoveredId !== null) {
						this.hoveredId = null;
						requestRender();
					}
				});
			}
			if (nextId !== this.hoveredId) {
				this.hoveredId = nextId;
				return { handled: true, render: true };
			}
			return undefined;
		}

		if (event.button === "left" && matched) {
			if (event.type === "press") {
				return { handled: true, render: false };
			}
			if (event.type === "click") {
				matched.onClick();
				return { handled: true, render: true };
			}
		}

		return undefined;
	}
}

export function createPinnedSessionHeaderSlot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): SessionHeaderView {
	return new SessionHeaderView(pi, ctx, () => ctx.ui.theme, true);
}

export function mountSessionHeader(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	ctx.ui.setHeader((_tui, theme) => new SessionHeaderView(pi, ctx, () => theme, false));
}
