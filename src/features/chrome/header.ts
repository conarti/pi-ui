import { execFile } from "node:child_process";
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
	getThemeSurfacePalette,
	paintThemeSurfaceRow,
	renderPill,
	themeFgRgb,
	type HitBox,
} from "../../shared/ansi.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { getSessionWorkflow } from "../../shared/session-workflow.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { showCommandPalette } from "../command-palette/index.ts";
import { cycleSessionMode } from "../plan-studio/index.ts";
import { showPlanStudio } from "../plan-studio/studio-overlay.ts";
import { setSessionStyleOverride } from "../tool-calls/command.ts";
import {
	cyclePrototypeVariant,
	getActiveVariantMeta,
	getPrototypeVariant,
	isPrototypeActive,
} from "../transcript/prototype-state.ts";
import { openResponseMetricsModal } from "../transcript/response-metrics.ts";

const GIT_BRANCH_CACHE_KEY = Symbol.for("conarti.pi-ui.git-branch-cache.v1");

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

		/* Suppress inside-ScrollView fallback header whenever fullscreen pinnedHeader is active */
		if (!this.pinnedMode && isPrototypeActive() && getActiveHostRuntime()?.isFullscreen) {
			return [];
		}

		const theme = this.getTheme();
		const palette = getThemeSurfacePalette(theme);
		const variant = getPrototypeVariant();
		const projectName = basename(this.ctx.cwd) || this.ctx.cwd;
		const gitBranch = readCachedGitBranch(this.ctx.cwd);
		const wf = getSessionWorkflow();

		const starMark = themeFgRgb(theme, palette.accent, "✦");
		const sep = theme.fg("dim", "·");

		/* Legacy fallback when prototype is disabled (e.g. baseline tests) */
		if (variant === "off") {
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

		const protoMeta = getActiveVariantMeta();
		const sessionName = this.ctx.sessionManager?.getSessionName?.()?.trim();
		const leftParts: string[] = [
			`${starMark} ${theme.bold("pi-ui")}`,
			theme.fg("text", sessionName || projectName),
		];
		if (gitBranch) {
			if (variant === "B") {
				leftParts.push(
					renderPill(gitBranch, {
						hovered: false,
						active: false,
						variant: "neutral",
						theme,
					}),
				);
			} else {
				leftParts.push(themeFgRgb(theme, palette.codeMetaFg, gitBranch));
			}
		}
		const left = `  ${leftParts.join(` ${sep} `)}`;

		const rightSpecs: Array<{
			id: string;
			rendered: string;
			onClick: () => void;
		}> = [];

		if (wf.mode !== "code") {
			const modeLabel = wf.mode === "plan" ? "Plan" : "Auto";
			rightSpecs.push({
				id: "mode",
				rendered: renderPill(modeLabel, {
					hovered: this.hoveredId === "mode",
					active: true,
					variant: wf.mode === "plan" ? "warning" : "primary",
					theme,
				}),
				onClick: () => {
					if (wf.hasPlan()) void showPlanStudio(this.pi, this.ctx);
					else cycleSessionMode(this.pi, this.ctx);
				},
			});
		}

		if (protoMeta && !process.env.VITEST) {
			const shortPill =
				variant === "A"
					? "Proto A · Quiet ↻"
					: variant === "B"
						? "Proto B · Two-Tone ↻"
						: "Proto C · Ribbon ↻";
			rightSpecs.push({
				id: "proto",
				rendered:
					variant === "A"
						? this.hoveredId === "proto"
							? themeFgRgb(theme, palette.accentBright, `[✦ ${shortPill}]`)
							: themeFgRgb(theme, palette.accent, `✦ ${shortPill}`)
						: renderPill(shortPill, {
								hovered: this.hoveredId === "proto",
								active: true,
								variant: "primary",
								theme,
							}),
				onClick: () => {
					setSessionStyleOverride(undefined);
					cyclePrototypeVariant();
				},
			});
		}

		rightSpecs.push({
			id: "stats",
			rendered:
				variant === "A"
					? this.hoveredId === "stats"
						? themeFgRgb(theme, palette.accentBright, "Stats")
						: theme.fg("muted", "Stats")
					: renderPill("Stats", {
							hovered: this.hoveredId === "stats",
							active: false,
							variant: "neutral",
							theme,
						}),
			onClick: () => void openResponseMetricsModal(this.ctx),
		});

		rightSpecs.push({
			id: "palette",
			rendered:
				variant === "A"
					? this.hoveredId === "palette"
						? themeFgRgb(theme, palette.accentBright, "Palette ⌃K")
						: theme.fg("muted", "Palette ⌃K")
					: renderPill("⌃K Palette", {
							hovered: this.hoveredId === "palette",
							active: false,
							variant: "neutral",
							theme,
						}),
			onClick: () => void showCommandPalette(this.pi, this.ctx),
		});

		const joinGap = variant === "A" ? ` ${sep} ` : " ";
		const joinWidth = visibleWidth(joinGap);

		/* Fit right-side interactive items gracefully to available width */
		const fittedSpecs = [...rightSpecs];
		while (
			fittedSpecs.length > 1 &&
			visibleWidth(left) +
				4 +
				fittedSpecs.reduce((acc, s, idx) => acc + visibleWidth(s.rendered) + (idx > 0 ? joinWidth : 0), 0) >
				width
		) {
			fittedSpecs.shift();
		}

		const rightContent = fittedSpecs.map((s) => s.rendered).join(joinGap);
		const trailingPad = "  ";
		const rightTotalW = visibleWidth(rightContent) + trailingPad.length;
		const maxLeftW = Math.max(8, width - rightTotalW - 2);
		const clippedLeft =
			visibleWidth(left) > maxLeftW ? truncateToWidth(left, maxLeftW, "…") : left;
		const middleSpaces = Math.max(1, width - visibleWidth(clippedLeft) - rightTotalW);

		let cursorX = visibleWidth(clippedLeft) + middleSpaces;
		for (let i = 0; i < fittedSpecs.length; i++) {
			const spec = fittedSpecs[i]!;
			const w = visibleWidth(spec.rendered);
			this.hits.push({
				id: spec.id,
				xStart: cursorX,
				xEnd: cursorX + Math.max(0, w - 1),
				y: 0,
				onClick: spec.onClick,
			});
			cursorX += w + joinWidth;
		}

		const rawRow = `${clippedLeft}${" ".repeat(middleSpaces)}${rightContent}${trailingPad}`;

		if (variant === "B") {
			return [paintThemeSurfaceRow(theme, rawRow, width, palette.headerChromeBg)];
		}

		const paddedRow = rawRow + " ".repeat(Math.max(0, width - visibleWidth(rawRow)));
		if (variant === "C" && (this.ctx.hasUI ? (getActiveHostRuntime()?.tui?.terminal?.rows ?? this.lastViewportRows) : this.lastViewportRows) >= 20) {
			const rule = themeFgRgb(theme, palette.borderSubtle, "─".repeat(width));
			return [paddedRow, rule];
		}

		return [paddedRow];
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
