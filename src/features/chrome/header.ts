import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
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
} from "../../shared/ansi.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { claimHover, copyToClipboard } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { showCommandPalette } from "../command-palette/index.ts";
import { getPrototypeVariant, isPrototypeActive } from "../transcript/prototype-state.ts";
import { computeLiveContextTokens, showContextMenuModal } from "./context-modal.ts";

const GIT_BRANCH_CACHE_KEY = Symbol.for("conarti.pi-ui.git-branch-cache.v1");
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
	const entry = cache.get(cwd);
	if (!entry || Date.now() - entry.updatedAt > 6000) {
		refreshGitBranchAsync(cwd);
	}
	return entry?.branch ?? null;
}

function formatTildeWorkspacePath(cwd: string): string {
	const home = homedir();
	if (home && cwd.startsWith(home)) {
		const rest = cwd.slice(home.length);
		return rest ? `~${rest}` : "~";
	}
	return cwd;
}

function renderHoverContextBar(
	percent: number,
	targetWidth: number,
	barRgb: readonly [number, number, number],
	trackRgb: readonly [number, number, number],
	theme: Theme,
): string {
	const pctStr = `${percent.toFixed(1)}%`;
	const barCells = Math.max(3, targetWidth - visibleWidth(pctStr) - 1);
	const clamped = Math.max(0, Math.min(100, percent));
	const eighths = Math.max(clamped > 0 ? 2 : 0, Math.round((clamped / 100) * barCells * 8));
	let bar = "";
	for (let i = 0; i < barCells; i++) {
		const cellEighths = Math.max(0, Math.min(8, eighths - i * 8));
		bar += FRACTIONAL_BLOCKS[cellEighths]!;
	}
	const paintedTrack = themeBgRgb(theme, trackRgb, themeFgRgb(theme, barRgb, bar));
	return `${paintedTrack} ${theme.fg("text", pctStr)}`;
}

class SessionHeaderView implements Component {
	private hoveredId: string | null = null;
	private hits: HitBox[] = [];
	private readonly hoverOwner = {};
	private lastViewportRows = 24;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly getTheme: () => Theme,
		private readonly pinnedMode: boolean,
	) {
		refreshGitBranchAsync(ctx.cwd);
	}

	isVisible = (viewport: { width: number; height: number }): boolean => {
		this.lastViewportRows = viewport.height;
		if (!this.pinnedMode) return true;
		return isPrototypeActive() && viewport.width >= 24 && viewport.height >= 8;
	};

	invalidate(): void {}

	dispose(): void {
		this.hoveredId = null;
		this.hits = [];
	}

	render(width: number): string[] {
		this.hits = [];
		if (width < 24) return [];

		if (!this.pinnedMode && isPrototypeActive() && getActiveHostRuntime()?.isFullscreen) {
			return [];
		}

		const theme = this.getTheme();
		const palette = getThemeSurfacePalette(theme);
		const variant = getPrototypeVariant();
		const gitBranch = readCachedGitBranch(this.ctx.cwd);

		/* Legacy fallback when prototype is disabled (baseline tests) */
		if (variant === "off") {
			const projectName = basename(this.ctx.cwd) || this.ctx.cwd;
			const starMark = themeFgRgb(theme, palette.accent, "✦");
			const sep = theme.fg("dim", "·");
			const brand = `${starMark} ${theme.bold("pi")} ${theme.fg("dim", `v${VERSION} · @conarti/pi-ui`)}`;
			const branchText = gitBranch ? ` ${themeFgRgb(theme, palette.info, `(${gitBranch})`)}` : "";
			const proj = `${theme.fg("muted", projectName)}${branchText}`;
			const isMenuHov = this.hoveredId === "palette";
			const menuText = isMenuHov
				? themeFgRgb(theme, palette.accentBright, "⌃K Palette")
				: theme.fg("dim", "⌃K Palette");
			const left = `  ${brand}  ${sep}  ${proj}`;
			const right = `${menuText}  `;
			const gapLen = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
			if (visibleWidth(left) + visibleWidth(right) + 2 <= width) {
				const xStart = visibleWidth(left) + gapLen;
				this.hits.push({
					id: "palette",
					xStart,
					xEnd: xStart + visibleWidth(menuText) - 1,
					y: 0,
					onClick: () => void showCommandPalette(this.pi, this.ctx),
				});
				return [`${left}${" ".repeat(gapLen)}${right}`];
			}
			return [truncateToWidth(left, width, "…")];
		}

		/* Grok-faithful Top Header:
		   Left:  `  <git-branch> ~/Projects/pi-ui`
		   Right: `3.9k / 256k` -> morphs in-place on hover to `▎    10.3%` (fixed width, zero shift),
		          click opens the 3-tab Context usage / Session usage / Session info modal.
		   Row 1: 1 blank row of pure canvas air above Sticky Prompt / transcript. */
		const outerPad = width >= 40 ? 2 : 1;
		const tildePath = formatTildeWorkspacePath(this.ctx.cwd);
		const isWorkspaceHov = this.hoveredId === "workspace";
		const branchStyled = gitBranch
			? `${isWorkspaceHov ? theme.fg("muted", gitBranch) : themeFgRgb(theme, palette.codeMetaFg, gitBranch)} `
			: "";
		const pathStyled = isWorkspaceHov
			? theme.fg("text", tildePath)
			: theme.fg("text", tildePath);
		const leftContent = `${branchStyled}${pathStyled}`;

		const { usedTokens, contextWindow, percent } = computeLiveContextTokens(this.ctx);
		const usedStr = formatCompactTokens(usedTokens);
		const winStr = formatCompactTokens(contextWindow);
		const restPlain = `${usedStr} / ${winStr}`;
		const slotWidth = Math.max(11, visibleWidth(restPlain));
		const isCtxHov = this.hoveredId === "context";

		let ctxRendered: string;
		if (isCtxHov) {
			const barRgb =
				percent >= 85 ? palette.danger : percent >= 70 ? palette.warning : palette.accentBright;
			ctxRendered = renderHoverContextBar(
				percent,
				slotWidth,
				barRgb,
				palette.codeHeaderBg,
				theme,
			);
		} else {
			const rawStyled = `${theme.fg("text", usedStr)} ${themeFgRgb(theme, palette.codeMetaFg, `/ ${winStr}`)}`;
			const padLead = " ".repeat(Math.max(0, slotWidth - visibleWidth(rawStyled)));
			ctxRendered = `${padLead}${rawStyled}`;
		}

		const rightTotalW = visibleWidth(ctxRendered) + outerPad;
		const maxLeftW = Math.max(8, width - outerPad - rightTotalW - 2);
		const clippedLeft =
			visibleWidth(leftContent) > maxLeftW
				? truncateToWidth(leftContent, maxLeftW, "…")
				: leftContent;
		const leftW = visibleWidth(clippedLeft);
		const middleSpaces = Math.max(2, width - outerPad - leftW - rightTotalW);

		this.hits.push({
			id: "workspace",
			xStart: outerPad,
			xEnd: outerPad + Math.max(0, leftW - 1),
			y: 0,
			onClick: () => {
				copyToClipboard(this.ctx.cwd);
				this.ctx.ui.notify(`Copied path: ${tildePath}`, "info");
			},
		});

		const ctxX = outerPad + leftW + middleSpaces;
		const ctxW = visibleWidth(ctxRendered);
		this.hits.push({
			id: "context",
			xStart: ctxX,
			xEnd: ctxX + Math.max(0, ctxW - 1),
			y: 0,
			onClick: () => void showContextMenuModal(this.pi, this.ctx, "context"),
		});

		const row0 = `${" ".repeat(outerPad)}${clippedLeft}${" ".repeat(middleSpaces)}${ctxRendered}${" ".repeat(outerPad)}`;
		const paddedRow0 = row0 + " ".repeat(Math.max(0, width - visibleWidth(row0)));

		const termRows = this.ctx.hasUI
			? (getActiveHostRuntime()?.tui?.terminal?.rows ?? this.lastViewportRows)
			: this.lastViewportRows;
		if (termRows >= 16) {
			return [paddedRow0, " ".repeat(width)];
		}
		return [paddedRow0];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const matched =
			event.y === 0
				? this.hits.find((h) => event.x >= h.xStart && event.x <= h.xEnd)
				: undefined;

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
	refreshGitBranchAsync(ctx.cwd);
	ctx.ui.setHeader((_tui, theme) => new SessionHeaderView(pi, ctx, () => theme, false));
}
