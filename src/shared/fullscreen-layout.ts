import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	getPngDimensions,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
	type Component,
	type ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { hasBlockingModalOverlay } from "./modal-card.ts";

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
	pinnedHeader?: Component & {
		isVisible?: (viewport: { width: number; height: number }) => boolean;
		handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
		dispose?(): void;
	};
	topSlot?: Component & {
		renderStickyOverlay?(width: number, viewportWidth?: number): StickyOverlayRender;
		handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
		dispose?(): void;
	};
	rightRail?: Component & {
		basisWidth: number;
		railPlacement?: "beside-scrollbar" | "over-scrollbar";
		geometry?: { readonly upY: number; readonly downY: number };
		isVisible: (viewport: { width: number; height: number }) => boolean;
		render(width: number, explicitHeight?: number, minTop?: number): string[];
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
	readonly railRect?: LayoutRect & {
		readonly originY: number;
	};
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

const GRAPH_SEG = new Intl.Segmenter("en", { granularity: "grapheme" });

export function computeTranscriptContentWidth(
	viewportWidth: number,
	_railVisible: boolean,
	fallbackGetContentWidth: (width: number) => number = (w) => w,
): number {
	const safeWidth = Math.max(1, Math.floor(viewportWidth));
	return Math.max(1, fallbackGetContentWidth(safeWidth));
}

export function extractActiveBgSgrAtColumn(line: string, targetCol: number): string {
	if (!line.includes("\x1b[")) return "";
	let activeBg = "";
	let col = 0;
	let i = 0;

	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			const next = line[i + 1];
			if (next === "[") {
				const csi = /^\x1b\[([0-9;:?<=>]*)([A-Za-z])/.exec(line.slice(i));
				if (csi) {
					const raw = csi[1] ?? "";
					if (csi[2] === "m" && !/^[?<=>]/.test(raw)) {
						const tokens = raw.length === 0 ? ["0"] : raw.split(";");
						let k = 0;
						while (k < tokens.length) {
							const tok = tokens[k] ?? "";
							if (tok.includes(":")) {
								const sub = tok.split(":").map((s) => (s === "" ? 0 : Number(s)));
								const lead = sub[0] ?? 0;
								if (lead === 0 || lead === 49) {
									activeBg = "";
								} else if (lead === 48 && sub[1] === 5 && sub[2] !== undefined) {
									activeBg = `\x1b[48;5;${sub[2]}m`;
								} else if (lead === 48 && sub[1] === 2) {
									const baseIdx = sub.length >= 6 ? 3 : 2;
									if (
										sub[baseIdx] !== undefined &&
										sub[baseIdx + 1] !== undefined &&
										sub[baseIdx + 2] !== undefined
									) {
										activeBg = `\x1b[48;2;${sub[baseIdx]};${sub[baseIdx + 1]};${sub[baseIdx + 2]}m`;
									}
								}
								k += 1;
								continue;
							}
							const c = tok === "" ? 0 : Number(tok);
							if (c === 0 || c === 49) {
								activeBg = "";
								k += 1;
							} else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) {
								activeBg = `\x1b[${c}m`;
								k += 1;
							} else if (c === 38 || c === 48 || c === 58) {
								const mode = tokens[k + 1] !== undefined ? Number(tokens[k + 1]) : -1;
								if (mode === 5 && tokens[k + 2] !== undefined) {
									if (c === 48) {
										activeBg = `\x1b[48;5;${Number(tokens[k + 2])}m`;
									}
									k += 3;
								} else if (
									mode === 2 &&
									tokens[k + 2] !== undefined &&
									tokens[k + 3] !== undefined &&
									tokens[k + 4] !== undefined
								) {
									if (c === 48) {
										activeBg = `\x1b[48;2;${Number(tokens[k + 2])};${Number(tokens[k + 3])};${Number(tokens[k + 4])}m`;
									}
									k += 5;
								} else {
									k += 1;
								}
							} else {
								k += 1;
							}
						}
					}
					i += csi[0].length;
					continue;
				}
			} else if (next === "]") {
				const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(line.slice(i));
				if (osc) {
					i += osc[0].length;
					continue;
				}
			} else if (next === "_") {
				const apc = /^\x1b_[^\x1b]*\x1b\\/.exec(line.slice(i));
				if (apc) {
					i += apc[0].length;
					continue;
				}
			}
			i += Math.min(2, line.length - i);
			continue;
		}

		if (col >= targetCol) break;

		const nextEsc = line.indexOf("\x1b", i);
		const plainSlice = nextEsc === -1 ? line.slice(i) : line.slice(i, nextEsc);
		for (const seg of GRAPH_SEG.segment(plainSlice)) {
			if (col >= targetCol) {
				i += seg.index;
				return activeBg;
			}
			col += visibleWidth(seg.segment);
		}
		i = nextEsc === -1 ? line.length : nextEsc;
	}

	return activeBg;
}

export function stripInlineImageSequences(line: string): string {
	return line.replace(KITTY_IMAGE_SEQ_RE, "").replace(ITERM2_IMAGE_SEQ_RE, "");
}

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

export function isCoveredByRenderedOverlay(self: any, screenX: number, screenY: number): boolean {
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
	private readonly detachPinnedHeader: (() => void) | undefined;
	private lastGeometry: CompositedFrameGeometry | undefined;
	private activePress: { zone: "rail" | "sticky"; x: number; y: number } | undefined;
	private scrollbarHiddenByRail = false;
	private disposed = false;
	applyingSelection = false;

	get scrollRef(): ScrollView {
		return this.scroll;
	}

	constructor(
		private readonly tui: TUI,
		private readonly scroll: ScrollView,
		readonly slots: MountedViewportSlots,
		layoutRoot?: unknown,
	) {
		this.origGetContentWidth = scroll.getContentWidth.bind(scroll);
		this.detachPinnedHeader = this.mountPinnedHeaderIntoLayout(layoutRoot);
	}

	private mountPinnedHeaderIntoLayout(layoutRoot: unknown): (() => void) | undefined {
		const header = this.slots.pinnedHeader;
		if (!header || !layoutRoot || typeof layoutRoot !== "object") return undefined;
		const stack = layoutRoot as {
			children?: Component[];
			entries?: Array<{
				component: Component;
				basis?: "auto" | number;
				grow?: number;
				shrink?: number;
				minSize?: number;
				visible?: (vp: { width: number; height: number }) => boolean;
			}>;
			removeChild?: (c: Component) => void;
		};
		if (!Array.isArray(stack.children) || !Array.isArray(stack.entries)) return undefined;

		if (!stack.children.includes(header)) {
			stack.children.unshift(header);
			stack.entries.unshift({
				component: header,
				basis: "auto",
				grow: 0,
				shrink: 0,
				minSize: 0,
				visible: (vp) => (header.isVisible ? header.isVisible(vp) : vp.height >= 8),
			});
		}

		/* Suppress duplicate header + Spacer(1) inside ScrollView.documentContainer when pinnedHeader is visible */
		const docContainer = this.scroll.children?.[0] as { children?: Component[] } | undefined;
		const headerContainer = docContainer?.children?.[0] as
			| (Component & { render: (width: number) => string[] })
			| undefined;
		let restoreDocHeader: (() => void) | undefined;
		if (headerContainer && typeof headerContainer.render === "function") {
			const origRender = headerContainer.render.bind(headerContainer);
			headerContainer.render = (width: number): string[] => {
				const rows = this.tui.terminal?.rows ?? 24;
				const pinnedActive = header.isVisible
					? header.isVisible({ width, height: rows })
					: rows >= 8;
				return pinnedActive ? [] : [...origRender(width)];
			};
			restoreDocHeader = () => {
				headerContainer.render = origRender;
			};
		}

		return () => {
			restoreDocHeader?.();
			if (typeof stack.removeChild === "function") {
				stack.removeChild(header);
			} else {
				const cIdx = stack.children?.indexOf(header) ?? -1;
				if (cIdx !== -1) stack.children?.splice(cIdx, 1);
				const eIdx = stack.entries?.findIndex((e) => e.component === header) ?? -1;
				if (eIdx !== -1) stack.entries?.splice(eIdx, 1);
			}
		};
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
		const railCols = Math.max(1, Math.min(2, this.slots.rightRail?.basisWidth ?? RAIL_COLUMNS));
		const overScrollbar = this.slots.rightRail?.railPlacement === "over-scrollbar";
		const railMargin = overScrollbar ? railCols : railCols + 1;
		const railVisible = Boolean(
			this.slots.rightRail?.isVisible({ width: boxRect.width, height: boxRect.height }) &&
				boxRect.width >= railMargin + 1,
		);

		/* In over-scrollbar mode (Variant A), hide native scrollbar while rail is active so only one edge scale renders */
		if (overScrollbar && railVisible) {
			if (this.scroll.scrollbar !== "hidden") {
				this.scroll.setScrollbar("hidden");
				this.scrollbarHiddenByRail = true;
			}
		} else if (this.scrollbarHiddenByRail) {
			this.scrollbarHiddenByRail = false;
			if (this.scroll.scrollbar === "hidden") {
				this.scroll.setScrollbar("auto");
			}
		}

		const stickyLayoutWidth = computeTranscriptContentWidth(
			boxRect.width,
			railVisible,
			this.origGetContentWidth,
		);
		const stickyWidth =
			this.scroll.isScrollbarVisible || this.scroll.scrollbar === "always"
				? Math.max(1, boxRect.width - 1)
				: stickyLayoutWidth;

		let result: string[] | undefined;
		let stickyRect: CompositedFrameGeometry["stickyRect"];

		if (this.slots.topSlot) {
			const stickyRender: StickyOverlayRender = this.slots.topSlot.renderStickyOverlay
				? this.slots.topSlot.renderStickyOverlay(stickyLayoutWidth, boxRect.width)
				: (() => {
						const raw = [...this.slots.topSlot!.render(stickyLayoutWidth)];
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

		let railRect: CompositedFrameGeometry["railRect"];
		if (railVisible && this.slots.rightRail) {
			const railStartCol = boxRect.x + boxRect.width - railMargin;
			const stickyCoveredRows = stickyRect?.height ?? 0;
			const railLines = this.slots.rightRail.render(
				railCols,
				boxRect.height,
				stickyCoveredRows,
			);
			const railGeo = this.slots.rightRail.geometry;
			if (railLines.length > 0 && (!this.slots.rightRail.geometry || railGeo)) {
				const maxRowIdx = Math.min(railLines.length, boxRect.height) - 1;
				const startIdx = railGeo ? Math.max(0, railGeo.upY) : 0;
				const endIdx = railGeo ? Math.min(maxRowIdx, railGeo.downY) : maxRowIdx;
				if (endIdx >= startIdx) {
					if (!result) result = [...screen];
					for (let i = startIdx; i <= endIdx; i++) {
						const row = boxRect.y + i;
						if (row < 0 || row >= result.length) continue;
						const baseRow = result[row] ?? "";
						const isImgRow = baseRow.includes("\x1b_G") || baseRow.includes("\x1b]1337;File=");
						const rawRailLine = railLines[i]!;
						const plainRail = stripTerminalSequences(rawRailLine);
						const leadingBlank = plainRail.startsWith(" ") && plainRail.length >= 2 && railCols >= 2;
						const targetCol = leadingBlank ? railStartCol + 1 : railStartCol;
						const targetWidth = leadingBlank ? railCols - 1 : railCols;
						const trimmedRail = leadingBlank
							? sliceByColumn(rawRailLine, 1, targetWidth, true)
							: sliceByColumn(rawRailLine, 0, targetWidth, true);
						const applyRailBg = (seg: string, bg: string): string =>
							bg
								? `${bg}${seg.replace(/\x1b\[(?:0|49)m/g, (m) => `${m}${bg}`)}`
								: `\x1b[49m${seg}`;
						const bgStart = !isImgRow ? extractActiveBgSgrAtColumn(baseRow, targetCol) : "";
						const bgSecond =
							!isImgRow && !leadingBlank && targetWidth >= 2
								? extractActiveBgSgrAtColumn(baseRow, targetCol + 1)
								: bgStart;
						/* pi-tui extractSegments не сбрасывает хвостовой SGR без символа после него перед beforePad */
						const safeBaseRow =
							!isImgRow && baseRow.includes("\x1b[") && visibleWidth(baseRow) < targetCol
								? `${baseRow}${bgStart ? `\x1b[0m${bgStart}` : "\x1b[0m"} `
								: baseRow;
						const railOverlay =
							bgStart === bgSecond || targetWidth < 2
								? bgStart
									? applyRailBg(trimmedRail, bgStart)
									: trimmedRail
								: `${applyRailBg(sliceByColumn(rawRailLine, 0, 1, true), bgStart)}${applyRailBg(sliceByColumn(rawRailLine, 1, 1, true), bgSecond)}`;
						result[row] = compositeTuiLine(
							safeBaseRow,
							railOverlay,
							targetCol,
							targetWidth,
							totalWidth,
						);
					}
					railRect = {
						x: railStartCol,
						y: boxRect.y + startIdx,
						width: railCols,
						height: endIdx - startIdx + 1,
						originY: boxRect.y,
					};
				}
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
		const onRailRow =
			railRect !== undefined && row >= railRect.y && row < railRect.y + railRect.height;
		const maxCol = onRailRow
			? railRect.x
			: this.scroll.isScrollbarVisible || this.scroll.scrollbar === "always"
				? scrollbarCol
				: undefined;
		if (maxCol !== undefined && columns.end > maxCol) {
			const clampedStart = Math.min(columns.start, maxCol);
			const clampedEnd = Math.min(columns.end, maxCol);
			return { start: clampedStart, end: Math.max(clampedStart, clampedEnd) };
		}
		return columns;
	}

	isChromeHit(self: any, screenX: number, screenY: number): boolean {
		if (this.disposed || !this.lastGeometry) return false;
		if (hasBlockingModalOverlay(self) || isCoveredByRenderedOverlay(self, screenX, screenY)) {
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
				if (stickyRect.width >= boxRect.width) {
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

		if (hasBlockingModalOverlay(self)) {
			this.activePress = undefined;
			return false;
		}
		if (self.mouseCapture || self.mousePressTarget || self.scrollbarDrag || self.selectionPressActive) {
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
								raw.y - railRect.originY,
								raw.x,
								raw.y,
								railRect.width,
								this.lastGeometry.boxRect.height,
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
		const overScrollbar = this.slots.rightRail?.railPlacement === "over-scrollbar";
		const onScrollbar =
			!overScrollbar &&
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
						raw.y - railRect.originY,
						raw.x,
						raw.y,
						railRect.width,
						this.lastGeometry.boxRect.height,
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
						raw.y - railRect.originY,
						raw.x,
						raw.y,
						railRect.width,
						this.lastGeometry.boxRect.height,
						raw.button,
					),
				);
				return true;
			}
			return false;
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
			return false;
		}

		return false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.activePress = undefined;
		this.lastGeometry = undefined;
		if (this.scrollbarHiddenByRail) {
			this.scrollbarHiddenByRail = false;
			if (this.scroll.scrollbar === "hidden") {
				this.scroll.setScrollbar("auto");
			}
		}
		this.detachPinnedHeader?.();
		(this.scroll as any).getContentWidth = this.origGetContentWidth;
		this.scroll.invalidate();
		this.slots.pinnedHeader?.dispose?.();
		this.slots.topSlot?.dispose?.();
		this.slots.rightRail?.dispose?.();
	}
}
