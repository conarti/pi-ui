import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	getPngDimensions,
	sliceByColumn,
	stripTerminalSequences,
	type Component,
	type ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export interface FullscreenShellContext {
	tui: TUI;
	theme: () => Theme;
	keybindings: KeybindingsManager;
	scroll: ScrollView;
	requestRender: () => void;
}

export interface StickyOverlayRender {
	readonly lines: readonly string[];
	readonly visibleLines: readonly string[];
	readonly fullHeight: number;
	readonly pushOffset: number;
}

export interface MountedViewportSlots {
	topSlot?: Component & {
		renderStickyOverlay?(width: number, viewportWidth?: number): StickyOverlayRender;
		handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
		dispose?(): void;
	};
	rightRail?: Component & {
		basisWidth: number;
		isVisible: (viewport: { width: number; height: number }) => boolean;
		render(width: number, explicitHeight?: number): string[];
		handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
		clearHover?(): void;
		dispose?(): void;
	};
}

export interface StickyPushOffset {
	readonly pushOffset: number;
	readonly visibleHeight: number;
	readonly distanceToNext: number;
}

export interface LayoutRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface LayoutBoxNode {
	readonly component: unknown;
	readonly rect: LayoutRect;
	readonly clip: LayoutRect;
	readonly children?: readonly LayoutBoxNode[];
	readonly scrollView?: ScrollView;
	readonly scrollContentLines?: readonly string[];
}

interface CompositedFrameGeometry {
	readonly boxRect: LayoutRect;
	readonly scrollbarCol: number;
	readonly stickyRect?: LayoutRect & {
		readonly pushOffset: number;
		readonly fullHeight: number;
	};
	readonly railRect?: LayoutRect;
}

interface RawSgrMouse {
	readonly button: number;
	readonly x: number;
	readonly y: number;
	readonly release: boolean;
}

const RAIL_PLUS_SCROLLBAR_MARGIN = 3;
const RAIL_COLUMNS = 2;
const KITTY_IMAGE_SEQ_RE = /\x1b_G[^\x1b]*\x1b\\/g;
const ITERM2_IMAGE_SEQ_RE = /(?:\x1b\[\d+A)?\x1b\]1337;File=[^\x07]*\x07/g;

export function computeStickyPushOffset(
	stickyHeight: number,
	scrollTop: number,
	nextTurnStart: number | undefined,
): StickyPushOffset {
	const safeHeight = Math.max(0, Math.floor(stickyHeight));
	if (safeHeight === 0) {
		return {
			pushOffset: 0,
			visibleHeight: 0,
			distanceToNext: nextTurnStart !== undefined ? nextTurnStart - scrollTop : Number.POSITIVE_INFINITY,
		};
	}
	if (nextTurnStart === undefined) {
		return {
			pushOffset: 0,
			visibleHeight: safeHeight,
			distanceToNext: Number.POSITIVE_INFINITY,
		};
	}
	const distanceToNext = nextTurnStart - scrollTop;
	if (distanceToNext >= safeHeight) {
		return {
			pushOffset: 0,
			visibleHeight: safeHeight,
			distanceToNext,
		};
	}
	const pushOffset = Math.max(0, Math.min(safeHeight, safeHeight - distanceToNext));
	return {
		pushOffset,
		visibleHeight: safeHeight - pushOffset,
		distanceToNext,
	};
}

export function computeTranscriptContentWidth(
	viewportWidth: number,
	railVisible: boolean,
	fallbackGetContentWidth: (width: number) => number = (w) => w,
): number {
	const safeWidth = Math.max(1, Math.floor(viewportWidth));
	if (railVisible) {
		return Math.max(1, safeWidth - RAIL_PLUS_SCROLLBAR_MARGIN);
	}
	return Math.max(1, fallbackGetContentWidth(safeWidth));
}

export function stripInlineImageSequences(line: string): string {
	return line.replace(KITTY_IMAGE_SEQ_RE, "").replace(ITERM2_IMAGE_SEQ_RE, "");
}

/* Подрезает верхние перекрытые строки многострочного Kitty-изображения и возвращает остаток для строки сразу под Sticky Prompt */
export function cropKittyLineBelowSticky(
	line: string,
	coveredRows: number,
	maxVisibleRows: number,
): string | undefined {
	if (coveredRows <= 0 || maxVisibleRows <= 0 || !line.includes("\x1b_G")) {
		return undefined;
	}
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!match) return undefined;

	const controlsRaw = match[1] ?? "";
	const rowsMatch = /(?:^|,)r=(\d+)(?:,|$)/.exec(controlsRaw);
	const currentRows = rowsMatch ? Number.parseInt(rowsMatch[1]!, 10) : 0;
	if (currentRows <= coveredRows) {
		return undefined;
	}

	const uncoveredRows = Math.min(maxVisibleRows, currentRows - coveredRows);
	if (uncoveredRows <= 0) {
		return undefined;
	}

	const yMatch = /(?:^|,)y=(\d+)(?:,|$)/.exec(controlsRaw);
	const hMatch = /(?:^|,)h=(\d+)(?:,|$)/.exec(controlsRaw);
	let curY = yMatch ? Number.parseInt(yMatch[1]!, 10) : 0;
	let curH = hMatch ? Number.parseInt(hMatch[1]!, 10) : undefined;

	if (curH === undefined) {
		const payloadStart = match.index + match[0].length;
		const payloadEnd = line.indexOf("\x1b\\", payloadStart);
		if (payloadEnd > payloadStart) {
			const headerSlice = line.slice(payloadStart, Math.min(payloadEnd, payloadStart + 64));
			const dims = getPngDimensions(headerSlice);
			if (dims && dims.heightPx > 0) {
				curY = 0;
				curH = dims.heightPx;
			}
		}
	}

	const controls = controlsRaw.split(",").filter((c) => c.length > 0 && !/^[yhr]=/.test(c));
	if (curH !== undefined && curH > 0) {
		const nextY = curY + Math.floor((curH * coveredRows) / currentRows);
		const nextEnd = curY + Math.ceil((curH * (coveredRows + uncoveredRows)) / currentRows);
		const nextH = Math.max(1, Math.min(curY + curH, nextEnd) - nextY);
		controls.push(`y=${nextY}`, `h=${nextH}`);
	}
	controls.push(`r=${uncoveredRows}`);

	return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

function stripItermUpwardBleed(line: string, rowOffsetFromStickyBottom: number): string {
	const itermIdx = line.indexOf("\x1b]1337;File=");
	if (itermIdx === -1) return line;
	const moveUpMatch = /\x1b\[(\d+)A$/.exec(line.slice(0, itermIdx));
	const moveUpRows = moveUpMatch ? Number.parseInt(moveUpMatch[1]!, 10) : 0;
	return moveUpRows > rowOffsetFromStickyBottom ? stripInlineImageSequences(line) : line;
}

export function findScrollViewLayoutBox(
	box: LayoutBoxNode | undefined,
	scroll: ScrollView,
): LayoutBoxNode | undefined {
	if (!box) return undefined;
	if (box.scrollView === scroll || box.component === scroll) return box;
	for (const child of box.children ?? []) {
		const found = findScrollViewLayoutBox(child, scroll);
		if (found) return found;
	}
	return undefined;
}

function decodeButtonName(button: number): "left" | "middle" | "right" | "none" {
	switch (button & 3) {
		case 0:
			return "left";
		case 1:
			return "middle";
		case 2:
			return "right";
		default:
			return "none";
	}
}

function createChromeMouseEvent(
	type: TuiMouseEvent["type"],
	button: TuiMouseEvent["button"],
	x: number,
	y: number,
	screenX: number,
	screenY: number,
	width: number,
	height: number,
	rawButton: number,
): TuiMouseEvent {
	return {
		type,
		button,
		x,
		y,
		screenX,
		screenY,
		width,
		height,
		shift: (rawButton & 4) !== 0,
		alt: (rawButton & 8) !== 0,
		ctrl: (rawButton & 16) !== 0,
		...(type === "click" ? { clickCount: 1 } : {}),
	};
}

function isCoveredByRenderedOverlay(self: any, screenX: number, screenY: number): boolean {
	const layouts = self?.renderedOverlayLayouts;
	if (!Array.isArray(layouts)) return false;
	for (let i = layouts.length - 1; i >= 0; i--) {
		const layout = layouts[i];
		if (
			layout &&
			screenX >= layout.col &&
			screenX < layout.col + layout.width &&
			screenY >= layout.row &&
			screenY < layout.row + layout.height
		) {
			return true;
		}
	}
	return false;
}

function isCoveredByScrollToEndIndicator(self: any, screenX: number, screenY: number): boolean {
	const rect = self?.scrollToEndIndicatorRect;
	if (!rect) return false;
	return (
		screenY === rect.row &&
		screenX >= rect.column &&
		screenX < rect.column + rect.width
	);
}

/**
 * Накладывает Sticky Prompt и Outline Rail поверх кадра без оборачивания layoutRoot,
 * чтобы нативный скроллбар оставался в крайней правой колонке и viewportHeight не прыгал (ADR 0002).
 */
export class ViewportChromeCompositor {
	private readonly origGetContentWidth: (width: number) => number;
	private lastGeometry: CompositedFrameGeometry | undefined;
	private activePress: { zone: "rail" | "sticky"; x: number; y: number } | undefined;
	private disposed = false;
	applyingSelection = false;

	get scrollRef(): ScrollView {
		return this.scroll;
	}

	constructor(
		private readonly tui: TUI,
		private readonly scroll: ScrollView,
		readonly slots: MountedViewportSlots,
	) {
		const boundOrig = scroll.getContentWidth.bind(scroll);
		this.origGetContentWidth = boundOrig;

		(scroll as any).getContentWidth = (width: number): number => {
			const safeW = Math.max(1, Math.floor(width));
			const safeH = Math.max(1, scroll.viewportHeight || tui.terminal?.rows || 24);
			const railVisible = Boolean(this.slots.rightRail?.isVisible({ width: safeW, height: safeH }));
			return computeTranscriptContentWidth(safeW, railVisible, this.origGetContentWidth);
		};
		scroll.invalidate();
	}

	compositeFrame(screen: string[], layout: { root?: LayoutBoxNode } | undefined, totalWidth: number): string[] {
		if (this.disposed) {
			this.lastGeometry = undefined;
			return screen;
		}

		const box = findScrollViewLayoutBox(layout?.root, this.scroll);
		if (!box || box.rect.width <= 0 || box.rect.height <= 0) {
			this.lastGeometry = undefined;
			return screen;
		}

		const boxRect = box.rect;
		const scrollbarCol = boxRect.x + boxRect.width - 1;
		const railVisible = Boolean(
			this.slots.rightRail?.isVisible({ width: boxRect.width, height: boxRect.height }) &&
				boxRect.width >= RAIL_PLUS_SCROLLBAR_MARGIN + 1,
		);

		const stickyLayoutWidth = computeTranscriptContentWidth(
			boxRect.width,
			railVisible,
			this.origGetContentWidth,
		);
		const stickyWidth = railVisible
			? stickyLayoutWidth
			: this.scroll.isScrollbarVisible || this.scroll.scrollbar === "always"
				? Math.max(1, boxRect.width - 1)
				: stickyLayoutWidth;

		let result: string[] | undefined;
		let stickyRect: CompositedFrameGeometry["stickyRect"];

		if (this.slots.topSlot) {
			const stickyRender: StickyOverlayRender = this.slots.topSlot.renderStickyOverlay
				? this.slots.topSlot.renderStickyOverlay(stickyLayoutWidth, boxRect.width)
				: (() => {
						const raw = this.slots.topSlot!.render(stickyLayoutWidth);
						return { lines: raw, visibleLines: raw, fullHeight: raw.length, pushOffset: 0 };
					})();

			const visibleCount = Math.min(stickyRender.visibleLines.length, boxRect.height);
			if (visibleCount > 0) {
				result = [...screen];
				const boxBottom = Math.min(result.length, boxRect.y + boxRect.height);
				const stickyBottom = boxRect.y + visibleCount;
				let relocatedKittyLine: string | undefined;

				for (let i = 0; i < visibleCount; i++) {
					const row = boxRect.y + i;
					if (row < 0 || row >= result.length) continue;
					const origRow = result[row] ?? "";
					if (stickyBottom < boxBottom && origRow.includes("\x1b_G")) {
						const cropped = cropKittyLineBelowSticky(
							origRow,
							stickyBottom - row,
							boxBottom - stickyBottom,
						);
						if (cropped) relocatedKittyLine = cropped;
					}
					const sanitized = stripInlineImageSequences(origRow);
					result[row] = compositeTuiLine(
						sanitized,
						stickyRender.visibleLines[i]!,
						boxRect.x,
						stickyWidth,
						totalWidth,
					);
				}

				if (relocatedKittyLine && stickyBottom >= 0 && stickyBottom < boxBottom) {
					const targetLine = result[stickyBottom] ?? "";
					if (
						!targetLine.includes("\x1b_G") &&
						!targetLine.includes("\x1b]1337;File=") &&
						stripTerminalSequences(sliceByColumn(targetLine, boxRect.x, stickyWidth, true)).trim() === ""
					) {
						result[stickyBottom] = relocatedKittyLine;
					}
				}

				for (let row = stickyBottom; row < boxBottom; row++) {
					const line = result[row];
					if (line && line.includes("\x1b]1337;File=")) {
						result[row] = stripItermUpwardBleed(line, row - stickyBottom);
					}
				}
				stickyRect = {
					x: boxRect.x,
					y: boxRect.y,
					width: stickyWidth,
					height: visibleCount,
					pushOffset: stickyRender.pushOffset,
					fullHeight: stickyRender.fullHeight,
				};
			}
		}

		let railRect: LayoutRect | undefined;
		if (railVisible && this.slots.rightRail) {
			const railStartCol = boxRect.x + boxRect.width - RAIL_PLUS_SCROLLBAR_MARGIN;
			const railLines = this.slots.rightRail.render(RAIL_COLUMNS, boxRect.height);
			if (railLines.length > 0) {
				if (!result) result = [...screen];
				const count = Math.min(railLines.length, boxRect.height);
				for (let i = 0; i < count; i++) {
					const row = boxRect.y + i;
					if (row < 0 || row >= result.length) continue;
					result[row] = compositeTuiLine(
						result[row] ?? "",
						railLines[i]!,
						railStartCol,
						RAIL_COLUMNS,
						totalWidth,
					);
				}
				railRect = {
					x: railStartCol,
					y: boxRect.y,
					width: RAIL_COLUMNS,
					height: count,
				};
			}
		} else {
			this.slots.rightRail?.clearHover?.();
		}

		this.lastGeometry = {
			boxRect,
			scrollbarCol,
			stickyRect,
			railRect,
		};

		return result ?? screen;
	}

	/* Ограничивает колонки выделения транскрипта до правого края контента и скрывает выделение под Sticky Prompt */
	clampSelectionColumns(
		row: number,
		columns: { start: number; end: number },
	): { start: number; end: number } {
		if (this.disposed || !this.applyingSelection || !this.lastGeometry) {
			return columns;
		}
		const { stickyRect, railRect, scrollbarCol } = this.lastGeometry;
		if (stickyRect && row >= stickyRect.y && row < stickyRect.y + stickyRect.height) {
			return { start: 0, end: 0 };
		}
		const maxCol = railRect
			? railRect.x
			: this.scroll.isScrollbarVisible || this.scroll.scrollbar === "always"
				? scrollbarCol
				: undefined;
		if (maxCol !== undefined && columns.end > maxCol) {
			const clampedEnd = Math.max(columns.start, maxCol);
			return { start: Math.min(columns.start, maxCol), end: clampedEnd };
		}
		return columns;
	}

	isChromeHit(self: any, screenX: number, screenY: number): boolean {
		if (this.disposed || !this.lastGeometry) return false;
		if (self.getTopmostVisibleOverlay?.() || isCoveredByRenderedOverlay(self, screenX, screenY)) {
			return false;
		}
		const { stickyRect, railRect } = this.lastGeometry;
		if (
			railRect &&
			screenX >= railRect.x &&
			screenX < railRect.x + railRect.width &&
			screenY >= railRect.y &&
			screenY < railRect.y + railRect.height
		) {
			return true;
		}
		if (
			stickyRect &&
			screenX >= stickyRect.x &&
			screenX < stickyRect.x + stickyRect.width &&
			screenY >= stickyRect.y &&
			screenY < stickyRect.y + stickyRect.height
		) {
			return true;
		}
		return false;
	}

	/* Восстанавливает ячейки оверлеев, Sticky Prompt, Outline Rail и скроллбара поверх выделения транскрипта */
	maskSelection(
		self: any,
		preSelection: string[],
		postSelection: string[],
		totalWidth: number,
		isPrimaryScrollSelection = false,
	): string[] {
		if (
			this.disposed ||
			postSelection === preSelection ||
			!this.lastGeometry
		) {
			return postSelection;
		}

		const overlayLayouts: ReadonlyArray<{
			row: number;
			col: number;
			width: number;
			height: number;
		}> = Array.isArray(self?.renderedOverlayLayouts) ? self.renderedOverlayLayouts : [];

		if (isPrimaryScrollSelection) {
			if (overlayLayouts.length === 0) return postSelection;
			let out: string[] | undefined;
			for (let row = 0; row < postSelection.length; row++) {
				const preLine = preSelection[row];
				const postLine = postSelection[row];
				if (preLine === undefined || postLine === undefined || preLine === postLine) continue;
				let line = postLine;
				let patched = false;
				for (const ov of overlayLayouts) {
					if (!ov || ov.width <= 0 || row < ov.row || row >= ov.row + ov.height) continue;
					const col = Math.max(0, ov.col);
					const span = Math.min(ov.width, totalWidth - col);
					if (span <= 0) continue;
					line = compositeTuiLine(
						line,
						sliceByColumn(preLine, col, span, true),
						col,
						span,
						totalWidth,
					);
					patched = true;
				}
				if (patched) {
					if (!out) out = [...postSelection];
					out[row] = line;
				}
			}
			return out ?? postSelection;
		}

		const { boxRect, scrollbarCol, stickyRect, railRect } = this.lastGeometry;
		if (!stickyRect && !railRect) return postSelection;

		let out: string[] | undefined;
		const startRow = Math.max(0, boxRect.y);
		const endRow = Math.min(postSelection.length, boxRect.y + boxRect.height);

		for (let row = startRow; row < endRow; row++) {
			const preLine = preSelection[row];
			const postLine = postSelection[row];
			if (preLine === undefined || postLine === undefined || preLine === postLine) continue;

			const inSticky =
				stickyRect !== undefined &&
				row >= stickyRect.y &&
				row < stickyRect.y + stickyRect.height;

			if (inSticky && stickyRect) {
				if (!out) out = [...postSelection];
				if (railRect || stickyRect.width >= boxRect.width) {
					out[row] = preLine;
				} else {
					let line = compositeTuiLine(
						postLine,
						sliceByColumn(preLine, stickyRect.x, stickyRect.width, true),
						stickyRect.x,
						stickyRect.width,
						totalWidth,
					);
					if (scrollbarCol >= stickyRect.x + stickyRect.width && scrollbarCol < totalWidth) {
						line = compositeTuiLine(
							line,
							sliceByColumn(preLine, scrollbarCol, 1, true),
							scrollbarCol,
							1,
							totalWidth,
						);
					}
					out[row] = line;
				}
				continue;
			}

			if (railRect && row >= railRect.y && row < railRect.y + railRect.height) {
				if (!out) out = [...postSelection];
				const span = Math.min(RAIL_PLUS_SCROLLBAR_MARGIN, totalWidth - railRect.x);
				if (span > 0) {
					out[row] = compositeTuiLine(
						postLine,
						sliceByColumn(preLine, railRect.x, span, true),
						railRect.x,
						span,
						totalWidth,
					);
				}
			}
		}

		return out ?? postSelection;
	}

	handleMouseEvent(self: any, raw: RawSgrMouse): boolean {
		if (this.disposed || !this.lastGeometry) return false;

		if (self.getTopmostVisibleOverlay?.()) {
			this.activePress = undefined;
			return false;
		}
		if (self.mouseCapture || self.mousePressTarget || self.scrollbarDrag) {
			return false;
		}

		const isMotion = (raw.button & 32) !== 0;
		const buttonName = decodeButtonName(raw.button);
		const type: TuiMouseEvent["type"] = raw.release
			? "release"
			: isMotion
				? buttonName === "none"
					? "move"
					: "drag"
				: "press";

		if (this.activePress) {
			if (type === "move") {
				this.activePress = undefined;
			} else if (type === "drag") {
				return true;
			} else if (type === "release") {
				const press = this.activePress;
				this.activePress = undefined;
				const { railRect, stickyRect } = this.lastGeometry;
				if (press.zone === "rail" && railRect && this.slots.rightRail?.handleMouse) {
					if (
						raw.x >= railRect.x &&
						raw.x < railRect.x + railRect.width &&
						raw.y === press.y
					) {
						const res = this.slots.rightRail.handleMouse(
							createChromeMouseEvent(
								"click",
								"left",
								raw.x - railRect.x,
								raw.y - railRect.y,
								raw.x,
								raw.y,
								railRect.width,
								railRect.height,
								raw.button,
							),
						);
						if (res?.render !== false) self.requestRender?.();
					}
				} else if (press.zone === "sticky" && stickyRect && this.slots.topSlot?.handleMouse) {
					if (
						raw.x >= stickyRect.x &&
						raw.x < stickyRect.x + stickyRect.width &&
						raw.y >= stickyRect.y &&
						raw.y < stickyRect.y + stickyRect.height
					) {
						const localY = raw.y - stickyRect.y + stickyRect.pushOffset;
						const res = this.slots.topSlot.handleMouse(
							createChromeMouseEvent(
								"click",
								"left",
								raw.x - stickyRect.x,
								localY,
								raw.x,
								raw.y,
								stickyRect.width,
								stickyRect.fullHeight,
								raw.button,
							),
						);
						if (res?.render !== false) self.requestRender?.();
					}
				}
				return true;
			}
		}

		if (isCoveredByRenderedOverlay(self, raw.x, raw.y)) {
			return false;
		}

		const { railRect, stickyRect } = this.lastGeometry;
		const onScrollbar =
			raw.x === this.lastGeometry.scrollbarCol &&
			Boolean(self.getScrollbarTargetAt?.(raw.x, raw.y, true));
		if (onScrollbar) {
			if (type === "move") {
				self.updateScrollbarHover?.(raw.x, raw.y);
				return true;
			}
			return false;
		}

		if (
			railRect &&
			raw.x >= railRect.x &&
			raw.x < railRect.x + railRect.width &&
			raw.y >= railRect.y &&
			raw.y < railRect.y + railRect.height
		) {
			self.updateScrollbarHover?.(raw.x, raw.y);
			if (type === "move") {
				const res = this.slots.rightRail?.handleMouse?.(
					createChromeMouseEvent(
						"move",
						"none",
						raw.x - railRect.x,
						raw.y - railRect.y,
						raw.x,
						raw.y,
						railRect.width,
						railRect.height,
						raw.button,
					),
				);
				if (res?.render) self.requestRender?.();
				return true;
			}
			if (type === "press" && buttonName === "left") {
				self.clearTextSelection?.();
				this.activePress = { zone: "rail", x: raw.x, y: raw.y };
				this.slots.rightRail?.handleMouse?.(
					createChromeMouseEvent(
						"press",
						"left",
						raw.x - railRect.x,
						raw.y - railRect.y,
						raw.x,
						raw.y,
						railRect.width,
						railRect.height,
						raw.button,
					),
				);
				return true;
			}
			return true;
		}

		if (isCoveredByScrollToEndIndicator(self, raw.x, raw.y)) {
			return false;
		}

		if (
			stickyRect &&
			raw.x >= stickyRect.x &&
			raw.x < stickyRect.x + stickyRect.width &&
			raw.y >= stickyRect.y &&
			raw.y < stickyRect.y + stickyRect.height
		) {
			self.updateScrollbarHover?.(raw.x, raw.y);
			const localY = raw.y - stickyRect.y + stickyRect.pushOffset;
			if (type === "move") {
				const res = this.slots.topSlot?.handleMouse?.(
					createChromeMouseEvent(
						"move",
						"none",
						raw.x - stickyRect.x,
						localY,
						raw.x,
						raw.y,
						stickyRect.width,
						stickyRect.fullHeight,
						raw.button,
					),
				);
				if (res?.render) self.requestRender?.();
				return true;
			}
			if (type === "press" && buttonName === "left") {
				self.clearTextSelection?.();
				this.activePress = { zone: "sticky", x: raw.x, y: raw.y };
				this.slots.topSlot?.handleMouse?.(
					createChromeMouseEvent(
						"press",
						"left",
						raw.x - stickyRect.x,
						localY,
						raw.x,
						raw.y,
						stickyRect.width,
						stickyRect.fullHeight,
						raw.button,
					),
				);
				return true;
			}
			return true;
		}

		return false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.activePress = undefined;
		this.lastGeometry = undefined;
		(this.scroll as any).getContentWidth = this.origGetContentWidth;
		this.scroll.invalidate();
		this.slots.topSlot?.dispose?.();
		this.slots.rightRail?.dispose?.();
	}
}
