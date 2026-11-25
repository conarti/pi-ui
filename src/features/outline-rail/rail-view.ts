import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	getThemeSurfacePalette,
	paintThemeSurfaceRow,
	themeFgRgb,
} from "../../shared/ansi.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { sanitizeTurnText, type IndexedTurn, type TranscriptTurnIndex } from "../../shared/turn-index.ts";
import { getPrototypeVariant, isPrototypeActive } from "../transcript/prototype-state.ts";

export const RAIL_WIDTH = 2;
export const MIN_TERMINAL_WIDTH_FOR_RAIL = 24;
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
	showArrows?: boolean;
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
	minTop = 0,
	arrowsOnOverflowOnly = false,
): RailGeometry | undefined {
	if (turnCount < MIN_TURNS_FOR_RAIL) return undefined;
	const safeMinTop = Math.max(0, Math.floor(minTop));
	const availHeight = height - safeMinTop;
	if (availHeight <= 0) return undefined;

	const needsArrows = !arrowsOnOverflowOnly || turnCount > availHeight;
	if (!needsArrows) {
		const totalRows = turnCount;
		const centeredTop = Math.floor((height - totalRows) / 2);
		const top = Math.max(safeMinTop, Math.min(height - totalRows, centeredTop));
		return {
			height,
			windowStart: 0,
			windowEnd: turnCount,
			ticksY: top,
			activeFrom: vp.activeFrom,
			active: vp.active,
			upTarget: vp.upTarget,
			downTarget: vp.downTarget,
			upY: top,
			downY: top + totalRows - 1,
			showArrows: false,
		};
	}

	const maxTicks = availHeight - 2;
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
	const centeredTop = Math.floor((height - totalRows) / 2);
	const top = Math.max(safeMinTop, Math.min(height - totalRows, centeredTop));
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
		showArrows: true,
	};
}

export function hitTestRail(geo: RailGeometry, x: number, y: number): RailHit | undefined {
	if (x < 0 || x >= RAIL_WIDTH || y < 0 || y >= geo.height) return undefined;
	if (geo.showArrows !== false) {
		if (y === geo.upY) return { kind: "up" };
		if (y === geo.downY) return { kind: "down" };
	}
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

export function wrapPreviewLines(text: string, width: number, maxLines = 4): string[] {
	const src = sanitizeTurnText(text).replace(/\s+/g, " ").trim();
	if (!src) return [];
	const w = Math.max(1, width);
	const wrapped = wrapTextWithAnsi(src, w);
	if (wrapped.length <= maxLines) return wrapped;
	const clipped = wrapped.slice(0, maxLines);
	const lastIdx = clipped.length - 1;
	if (lastIdx >= 0) {
		const trimmed = clipped[lastIdx]!.replace(/\s+$/, "");
		clipped[lastIdx] =
			visibleWidth(trimmed) + 1 <= w
				? `${trimmed}…`
				: `${truncateToWidth(trimmed, Math.max(1, w - 1), "")}…`;
	}
	return clipped;
}

export class OutlinePreviewPopup implements Component {
	ordinal = 1;
	preview = "";
	time = "";

	constructor(private readonly getTheme: () => Theme) {}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.getTheme();
		const safeWidth = Math.max(6, width);
		const inner = Math.max(4, safeWidth - 2);
		const textW = Math.max(1, inner - 2);
		const time = this.time.trim();
		const body = wrapPreviewLines(this.preview, textW);
		const lines = body.length ? body : [" "];

		if (isPrototypeActive()) {
			const palette = getThemeSurfacePalette(th);
			const edge = (s: string) => themeFgRgb(th, palette.borderSubtle, s);
			const out: string[] = [
				paintThemeSurfaceRow(
					th,
					`${edge("╭")}${edge("─".repeat(inner))}${edge("╮")}`,
					safeWidth,
					palette.popupSurfaceBg,
				),
			];

			for (const line of lines) {
				const clipped = truncateToWidth(line, textW, "");
				const pad = " ".repeat(Math.max(0, textW - visibleWidth(clipped)));
				out.push(
					paintThemeSurfaceRow(
						th,
						`${edge("│")} ${th.fg("text", `${clipped}${pad}`)} ${edge("│")}`,
						safeWidth,
						palette.popupSurfaceBg,
					),
				);
			}

			out.push(
				paintThemeSurfaceRow(
					th,
					`${edge("╰")}${edge("─".repeat(inner))}${edge("╯")}`,
					safeWidth,
					palette.popupSurfaceBg,
				),
			);
			return out;
		}

		/* Legacy transparent rendering when prototype is off */
		const edge = (s: string) => th.fg("borderMuted", s);
		const fit = (s: string) => {
			const clipped = truncateToWidth(s, textW, "");
			return clipped + " ".repeat(Math.max(0, textW - visibleWidth(clipped)));
		};
		const bodyRow = (s: string) => `${edge("│")} ${th.fg("text", fit(s))} ${edge("│")}`;

		const out: string[] = [];
		if (time) {
			const clippedTime = truncateToWidth(time, safeWidth, "");
			const padLeft = " ".repeat(Math.max(0, safeWidth - visibleWidth(clippedTime)));
			out.push(`${padLeft}${th.fg("muted", clippedTime)}`);
		}
		out.push(edge(`╭${"─".repeat(inner)}╮`));
		for (const line of lines) {
			out.push(bodyRow(line));
		}
		out.push(edge(`╰${"─".repeat(inner)}╯`));
		return out;
	}
}

export class OutlineRailComponent implements Component {
	readonly basisWidth = RAIL_WIDTH;
	geometry?: RailGeometry;
	hovered?: RailHit;

	private lastPointer?: { x: number; y: number; screenY: number };
	private lastHoverTurnId?: string;
	private lastRenderedHeight = -1;
	private syncScheduled = false;

	get railPlacement(): "beside-scrollbar" | "over-scrollbar" {
		return isPrototypeActive() ? "over-scrollbar" : "beside-scrollbar";
	}

	constructor(
		private readonly tui: TUI,
		private readonly scroll: ScrollView,
		private readonly getTheme: () => Theme,
		private readonly turnIndex: TranscriptTurnIndex,
		private readonly isEnabled: () => boolean,
		private readonly onHoverChange: (
			hit: RailHit | undefined,
			turn: IndexedTurn | undefined,
			screenY: number,
			fromRender?: boolean,
		) => void,
		private readonly onSelectTurn: (
			turn: IndexedTurn,
			turnIndex: number,
			direction: "prev" | "next" | "jump",
		) => void,
	) {}

	invalidate(): void {}

	isVisible = (viewport: { width: number; height: number }): boolean => {
		if (!this.isEnabled() || viewport.width < MIN_TERMINAL_WIDTH_FOR_RAIL || viewport.height < 4) {
			return false;
		}
		return this.turnIndex.getTurnCount() >= MIN_TURNS_FOR_RAIL;
	};

	clearHover(fromRender = false): void {
		const hadState = Boolean(this.hovered || this.lastPointer || this.lastHoverTurnId);
		this.hovered = undefined;
		this.lastPointer = undefined;
		this.lastHoverTurnId = undefined;
		if (hadState) {
			this.onHoverChange(undefined, undefined, 0, fromRender);
		}
	}

	private resolveTurnForHit(
		geo: RailGeometry | undefined,
		hit: RailHit | undefined,
		turns: readonly IndexedTurn[],
	): IndexedTurn | undefined {
		if (!geo || !hit) return undefined;
		if (hit.kind === "tick") return turns[hit.turn];
		if (hit.kind === "up" && geo.upTarget !== undefined) return turns[geo.upTarget];
		if (hit.kind === "down" && geo.downTarget !== undefined) return turns[geo.downTarget];
		return undefined;
	}

	offsetOf(turnIndex: number): number {
		return this.turnIndex.getTurns()[turnIndex]?.start ?? 0;
	}

	handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (e.type === "wheel" && e.wheelDelta) {
			this.scroll.scrollBy(e.wheelDelta);
			return { handled: true, render: true };
		}

		if (hasBlockingModalOverlay(this.tui)) {
			this.clearHover();
			return undefined;
		}

		const hit = this.geometry ? hitTestRail(this.geometry, e.x, e.y) : undefined;

		if (e.type === "move") {
			claimHover(this, () => {
				if (this.hovered || this.lastPointer) {
					this.clearHover();
					this.tui.requestRender();
				}
			});
			this.lastPointer = { x: e.x, y: e.y, screenY: e.screenY };
			const turns = this.turnIndex.getTurns();
			const turn = this.resolveTurnForHit(this.geometry, hit, turns);
			const nextTurnId = turn?.id;
			if (hitKey(hit) === hitKey(this.hovered) && nextTurnId === this.lastHoverTurnId) {
				return undefined;
			}
			this.hovered = hit;
			this.lastHoverTurnId = nextTurnId;
			this.onHoverChange(hit, turn, e.screenY, false);
			return { handled: true, render: true };
		}

		if (e.type === "press" && e.button === "left") {
			const targetIdx = this.geometry ? resolveRailHitTarget(this.geometry, hit) : undefined;
			return targetIdx !== undefined ? { handled: true, render: false } : undefined;
		}

		if (e.type === "click" && e.button === "left") {
			const targetIdx = this.geometry ? resolveRailHitTarget(this.geometry, hit) : undefined;
			const turns = this.turnIndex.getTurns();
			if (targetIdx === undefined || !turns[targetIdx]) return undefined;
			const direction = hit?.kind === "up" ? "prev" : hit?.kind === "down" ? "next" : "jump";
			this.onSelectTurn(turns[targetIdx]!, targetIdx, direction);
			return { handled: true, render: true };
		}

		return undefined;
	}

	render(width: number, explicitHeight?: number, minTop = 0): string[] {
		const w = Math.max(1, Math.min(width, RAIL_WIDTH));
		const turns = this.turnIndex.getTurns();
		const height = Math.max(0, explicitHeight ?? this.scroll.viewportHeight ?? 0);

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
			this.clearHover(true);
			return [];
		}

		const th = this.getTheme();
		const palette = getThemeSurfacePalette(th);
		const variant = getPrototypeVariant();
		const lines = Array.from({ length: height }, () => " ".repeat(w));
		const contentHeight = (this.scroll as any).contentHeight ?? 0;

		const promptYs = turns.map((turn) => turn.start);
		const promptHeights = turns.map((turn) => turn.height);

		const vp = computeRailViewport(
			this.scroll.scrollTop ?? 0,
			contentHeight,
			height,
			promptYs,
			turns.length,
			promptHeights,
		);
		const geo = computeOutlineGeometry(
			height,
			turns.length,
			vp,
			minTop,
			false,
		);
		this.geometry = geo;
		if (!geo) {
			this.clearHover(true);
			return lines;
		}

		if (this.lastPointer && !hasBlockingModalOverlay(this.tui)) {
			const syncedHit = hitTestRail(geo, this.lastPointer.x, this.lastPointer.y);
			const syncedTurn = this.resolveTurnForHit(geo, syncedHit, turns);
			const syncedTurnId = syncedTurn?.id;
			if (hitKey(syncedHit) !== hitKey(this.hovered) || syncedTurnId !== this.lastHoverTurnId) {
				this.hovered = syncedHit;
				this.lastHoverTurnId = syncedTurnId;
				this.onHoverChange(syncedHit, syncedTurn, this.lastPointer.screenY, true);
			}
		}

		const paint = (y: number, glyph: string, tone: "dim" | "muted" | "primary" | "accent" | "hover") => {
			if (y < 0 || y >= height) return;
			const padded = padRailCell(glyph);
			if (tone === "hover") {
				lines[y] = themeFgRgb(th, palette.accentBright, padded);
			} else if (tone === "accent") {
				lines[y] = themeFgRgb(th, palette.accent, padded);
			} else if (tone === "primary") {
				lines[y] = th.fg("text", padded);
			} else if (tone === "muted") {
				lines[y] = th.fg("muted", padded);
			} else {
				lines[y] = th.fg("dim", padded);
			}
		};

		if (geo.showArrows !== false) {
			const upOn = geo.upTarget !== undefined;
			const downOn = geo.downTarget !== undefined;
			paint(
				geo.upY,
				"▲",
				this.hovered?.kind === "up" && upOn
					? variant === "off"
						? "primary"
						: "hover"
					: upOn
						? "muted"
						: "dim",
			);
			paint(
				geo.downY,
				"▼",
				this.hovered?.kind === "down" && downOn
					? variant === "off"
						? "primary"
						: "hover"
					: downOn
						? "muted"
						: "dim",
			);
		}

		for (let i = 0; i < geo.windowEnd - geo.windowStart; i++) {
			const turn = geo.windowStart + i;
			const isActive =
				geo.active !== undefined && turn >= (geo.activeFrom ?? geo.active) && turn <= geo.active;
			const isHovered = this.hovered?.kind === "tick" && this.hovered.turn === turn;

			if (variant === "off") {
				paint(
					geo.ticksY + i,
					isHovered ? "━━" : isActive ? "──" : "─",
					isHovered || isActive ? "primary" : "dim",
				);
			} else {
				paint(
					geo.ticksY + i,
					isHovered ? "━━" : isActive ? "━━" : "─",
					isHovered ? "hover" : isActive ? "primary" : "dim",
				);
			}
		}

		return lines;
	}
}
