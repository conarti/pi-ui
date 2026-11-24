import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, isLightTheme } from "../../shared/ansi.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { collectPromptRowOffsets, type OutlineTurn } from "./turn-tracker.ts";

export const RAIL_WIDTH = 2;
export const MIN_TERMINAL_WIDTH_FOR_RAIL = 64;
export const MIN_TURNS_FOR_RAIL = 2;

export type RailHit = { kind: "tick"; turn: number } | { kind: "up" } | { kind: "down" };

export interface RailViewport {
	activeFrom?: number;
	active?: number;
	upTarget?: number;
	downTarget?: number;
	atBottom: boolean;
}

export interface RailGeometry {
	height: number;
	windowStart: number;
	windowEnd: number;
	ticksY: number;
	activeFrom?: number;
	active?: number;
	upTarget?: number;
	downTarget?: number;
	upY: number;
	downY: number;
}

const hitKey = (h?: RailHit) => (!h ? "" : h.kind === "tick" ? `t${h.turn}` : h.kind);

function padRailCell(s: string): string {
	const w = visibleWidth(s);
	if (w >= RAIL_WIDTH) return truncateToWidth(s, RAIL_WIDTH, "");
	return " ".repeat(RAIL_WIDTH - w) + s;
}

function promptsAboveTop(promptYs: readonly number[], top: number, strict: boolean): number {
	let n = 0;
	for (const y of promptYs) {
		if (strict ? y < top : y <= top) n++;
		else break;
	}
	return n;
}

export function computeRailViewport(
	scrollTop: number,
	contentHeight: number,
	viewportHeight: number,
	promptYs: readonly number[],
	turnCount: number,
	promptHeights?: readonly number[],
): RailViewport {
	if (turnCount <= 0) return { atBottom: true };
	const above = promptsAboveTop(promptYs, scrollTop, false);
	const aboveStrict = promptsAboveTop(promptYs, scrollTop, true);
	const shown = promptsAboveTop(promptYs, scrollTop + Math.max(1, viewportHeight) - 1, false);
	const active = Math.max(0, shown - 1);

	let from = shown;
	while (from > 0 && promptYs[from - 1]! + (promptHeights?.[from - 1] ?? 1) - 1 >= scrollTop) from--;
	const activeFrom = from < shown ? from : active;

	const upTarget = aboveStrict > 0 ? aboveStrict - 1 : undefined;
	const downTarget = above < turnCount ? above : undefined;
	const atBottom = contentHeight <= viewportHeight || scrollTop >= contentHeight - viewportHeight;
	return { activeFrom, active, upTarget, downTarget, atBottom };
}

export function computeOutlineGeometry(
	height: number,
	turnCount: number,
	vp: RailViewport,
	refHeight?: number,
): RailGeometry | undefined {
	if (refHeight !== undefined) {
		const stable = computeOutlineGeometry(refHeight - 1, turnCount, vp);
		if (stable && stable.downY < height) return { ...stable, height };
	}
	if (turnCount < MIN_TURNS_FOR_RAIL) return undefined;
	const maxTicks = height - 2;
	if (maxTicks <= 0) return undefined;

	let start: number;
	if (turnCount <= maxTicks) {
		start = 0;
	} else {
		const tailStart = turnCount - maxTicks;
		if (vp.atBottom) {
			start = Math.min(vp.active ?? tailStart, tailStart);
		} else {
			start = Math.min(tailStart, Math.max(0, (vp.active ?? turnCount - 1) - Math.floor(maxTicks / 2)));
		}
	}

	const windowEnd = Math.min(turnCount, start + (turnCount <= maxTicks ? turnCount : maxTicks));
	const totalRows = windowEnd - start + 2;
	const top = Math.floor((height - totalRows) / 2);
	const ticksY = top + 1;

	return {
		height,
		windowStart: start,
		windowEnd,
		ticksY,
		activeFrom: vp.activeFrom,
		active: vp.active,
		upTarget: vp.upTarget,
		downTarget: vp.downTarget,
		upY: top,
		downY: ticksY + (windowEnd - start),
	};
}

export function hitTestRail(geo: RailGeometry, x: number, y: number): RailHit | undefined {
	if (x < 0 || x >= RAIL_WIDTH || y < 0 || y >= geo.height) return undefined;
	if (y === geo.upY) return { kind: "up" };
	if (y === geo.downY) return { kind: "down" };
	if (y >= geo.ticksY) {
		const rel = y - geo.ticksY;
		const len = geo.windowEnd - geo.windowStart;
		if (rel < len) return { kind: "tick", turn: geo.windowStart + rel };
	}
	return undefined;
}

export function resolveRailHitTarget(geo: RailGeometry, hit?: RailHit): number | undefined {
	if (!hit) return undefined;
	if (hit.kind === "tick") return hit.turn;
	if (hit.kind === "up") return geo.upTarget;
	return geo.downTarget;
}

export function wrapPreviewLines(text: string, width: number): string[] {
	const src = text.trim();
	if (!src) return [];
	const w = Math.max(1, width);
	if (visibleWidth(src) <= w) return [src];
	const chars = [...src];
	const line1: string[] = [];
	let used = 0;
	let i = 0;
	for (; i < chars.length; i++) {
		const cw = Math.max(1, visibleWidth(chars[i]!));
		if (used + cw > w && line1.length) break;
		line1.push(chars[i]!);
		used += cw;
	}
	const rest = chars.slice(i).join("").trim();
	return rest ? [line1.join(""), truncateToWidth(rest, w, "…")] : [line1.join("")];
}

export class OutlinePreviewPopup implements Component {
	preview = "";
	meta = "";
	note = "";

	constructor(private readonly getTheme: () => Theme) {}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.getTheme();
		const light = isLightTheme(th);
		const inner = Math.max(4, width - 2);
		const textW = inner - 2;
		const meta = this.meta.trim();
		const note = this.note.trim();
		const body = wrapPreviewLines(this.preview, textW);
		const lines = body.length ? body : [" "];

		const edge = (s: string) => (light ? fgRgb(37, 99, 235, s) : fgRgb(97, 175, 239, s));
		const fit = (s: string) => {
			const clipped = truncateToWidth(s, textW, "");
			return clipped + " ".repeat(Math.max(0, textW - visibleWidth(clipped)));
		};
		const row = (s: string, kind: "meta" | "body") => {
			const styled =
				kind === "meta"
					? th.fg("muted", fit(truncateToWidth(s, textW, "…")))
					: th.fg("text", fit(s));
			return `${edge("│")} ${styled} ${edge("│")}`;
		};

		return [
			edge(`╭${"─".repeat(inner)}╮`),
			...(meta ? [row(meta, "meta")] : []),
			...(note ? [row(note, "meta")] : []),
			...lines.map((line) => row(line, "body")),
			edge(`╰${"─".repeat(inner)}╯`),
		];
	}
}

export class OutlineRailComponent implements Component {
	readonly basisWidth = RAIL_WIDTH;
	geometry?: RailGeometry;
	hovered?: RailHit;

	private refHeight = 0;
	private refKey = "";
	private cacheTurns?: OutlineTurn[];
	private cacheWidth = -1;
	private cacheHeight = -1;
	private cacheYs: number[] = [];
	private cacheHeights: number[] = [];
	private lastRenderedHeight = -1;
	private syncScheduled = false;

	constructor(
		private readonly tui: TUI,
		private readonly scroll: ScrollView,
		private readonly getTheme: () => Theme,
		private readonly getTurns: () => OutlineTurn[],
		private readonly isEnabled: () => boolean,
		private readonly onHoverChange: (hit: RailHit | undefined, turn: OutlineTurn | undefined, screenY: number) => void,
		private readonly onSelectTurn: (turn: OutlineTurn, targetRow: number) => void,
	) {}

	invalidate(): void {}

	isVisible = (viewport: { width: number; height: number }): boolean => {
		if (!this.isEnabled() || viewport.width < MIN_TERMINAL_WIDTH_FOR_RAIL || viewport.height < 4) {
			return false;
		}
		return this.getTurns().length >= MIN_TURNS_FOR_RAIL;
	};

	clearHover(): void {
		if (this.hovered) {
			this.hovered = undefined;
			this.onHoverChange(undefined, undefined, 0);
		}
	}

	offsetOf(turnIndex: number): number {
		return this.cacheYs[turnIndex] ?? 0;
	}

	handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (e.type === "wheel" && e.wheelDelta) {
			this.scroll.scrollBy(e.wheelDelta);
			return { handled: true, render: true };
		}

		const hit = this.geometry ? hitTestRail(this.geometry, e.x, e.y) : undefined;

		if (e.type === "move") {
			claimHover(this, () => {
				if (this.hovered) {
					this.clearHover();
					this.tui.requestRender();
				}
			});
			if (hitKey(hit) === hitKey(this.hovered)) return undefined;
			this.hovered = hit;
			const turns = this.getTurns();
			let turn: OutlineTurn | undefined;
			if (hit?.kind === "tick") turn = turns[hit.turn];
			else if (hit?.kind === "up" && this.geometry?.upTarget !== undefined) turn = turns[this.geometry.upTarget];
			else if (hit?.kind === "down" && this.geometry?.downTarget !== undefined) turn = turns[this.geometry.downTarget];

			this.onHoverChange(hit, turn, e.screenY);
			return { handled: true, render: true };
		}

		if (e.type === "click" && e.button === "left") {
			const targetIdx = this.geometry ? resolveRailHitTarget(this.geometry, hit) : undefined;
			const turns = this.getTurns();
			if (targetIdx === undefined || !turns[targetIdx]) return undefined;
			this.onSelectTurn(turns[targetIdx]!, this.offsetOf(targetIdx));
			return { handled: true, render: true };
		}

		return undefined;
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.min(width, RAIL_WIDTH));
		const turns = this.getTurns();
		const height = Math.max(0, this.scroll.viewportHeight ?? 0);

		if (height === 0 && turns.length >= MIN_TURNS_FOR_RAIL && !this.syncScheduled) {
			this.syncScheduled = true;
			queueMicrotask(() => {
				this.syncScheduled = false;
				if ((this.scroll.viewportHeight ?? 0) !== this.lastRenderedHeight) {
					this.tui.requestRender();
				}
			});
		}
		this.lastRenderedHeight = height;

		if (!this.isEnabled() || turns.length < MIN_TURNS_FOR_RAIL || height < 3) {
			this.geometry = undefined;
			return [];
		}

		const th = this.getTheme();
		const lines = Array.from({ length: height }, () => " ".repeat(w));
		const termW = this.tui.terminal?.columns ?? 80;
		const transcriptAvail = Math.max(1, termW - RAIL_WIDTH);
		const contentWidth = Math.max(1, this.scroll.getContentWidth(transcriptAvail));
		const doc = this.scroll.children[0];
		const contentHeight = (this.scroll as any).contentHeight ?? 0;

		let promptYs: number[];
		const promptHeights: number[] = [];
		if (
			doc &&
			this.cacheTurns === turns &&
			this.cacheWidth === contentWidth &&
			this.cacheHeight === contentHeight
		) {
			promptYs = this.cacheYs;
			promptHeights.push(...this.cacheHeights);
		} else {
			promptYs = doc ? collectPromptRowOffsets(doc, turns, contentWidth, promptHeights) : turns.map(() => 0);
			this.cacheTurns = turns;
			this.cacheWidth = contentWidth;
			this.cacheHeight = contentHeight;
			this.cacheYs = promptYs;
			this.cacheHeights = promptHeights.slice();
		}

		const vp = computeRailViewport(
			this.scroll.scrollTop ?? 0,
			contentHeight,
			height,
			promptYs,
			turns.length,
			promptHeights,
		);
		const sizeKey = `${termW}x${this.tui.terminal?.rows ?? 0}`;
		if (sizeKey !== this.refKey || !this.refHeight || (this.scroll.isFollowingEnd ?? vp.atBottom)) {
			this.refKey = sizeKey;
			this.refHeight = height;
		}

		const geo = computeOutlineGeometry(height, turns.length, vp, this.refHeight);
		this.geometry = geo;
		if (!geo) return lines;

		const light = isLightTheme(th);
		const paint = (y: number, glyph: string, tone: "dim" | "muted" | "active" | "hover") => {
			if (y < 0 || y >= height) return;
			const padded = padRailCell(glyph);
			if (tone === "hover") {
				lines[y] = light ? fgRgb(29, 78, 216, padded) : fgRgb(125, 207, 255, padded);
			} else if (tone === "active") {
				lines[y] = light ? fgRgb(37, 99, 235, padded) : fgRgb(97, 175, 239, padded);
			} else if (tone === "muted") {
				lines[y] = th.fg("muted", padded);
			} else {
				lines[y] = th.fg("dim", padded);
			}
		};

		const upOn = geo.upTarget !== undefined;
		const downOn = geo.downTarget !== undefined;
		paint(geo.upY, "▲", this.hovered?.kind === "up" && upOn ? "hover" : upOn ? "muted" : "dim");
		paint(geo.downY, "▼", this.hovered?.kind === "down" && downOn ? "hover" : downOn ? "muted" : "dim");

		for (let i = 0; i < geo.windowEnd - geo.windowStart; i++) {
			const turn = geo.windowStart + i;
			const isActive =
				geo.active !== undefined && turn >= (geo.activeFrom ?? geo.active) && turn <= geo.active;
			const isHovered = this.hovered?.kind === "tick" && this.hovered.turn === turn;
			paint(
				geo.ticksY + i,
				isActive || isHovered ? "━━" : "─",
				isHovered ? "hover" : isActive ? "active" : "dim",
			);
		}

		return lines;
	}
}
