import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	TuiAltScreen,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	fgRgb,
	getThemeSurfacePalette,
	isLightTheme,
	paintThemeSurfaceRow,
	type RgbTuple,
} from "../../shared/ansi.ts";
import {
	findScrollViewLayoutBox,
	isCoveredByRenderedOverlay,
} from "../../shared/fullscreen-layout.ts";
import {
	getActiveHostRuntime,
	installViewportScrollDismissHooks,
	isSameHostTui,
	registerTransientHoverDismisser,
	unwrapHostTui,
} from "../../shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { t } from "../../shared/i18n.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import {
	computeSelectionQuotePopupAnchor,
	normalizeQuoteText,
} from "./quote-model.ts";

export const QUOTE_SELECTION_POPUP_LABEL = t("quotes.selectionPopup.label");
export const QUOTE_SELECTION_POPUP_WIDTH = visibleWidth(QUOTE_SELECTION_POPUP_LABEL);
export const QUOTE_SELECTION_POPUP_HEIGHT = 1;

export class QuoteSelectionPopup implements Component {
	selectedTextSnapshot = "";
	hovered = false;
	private pressed = false;
	private triggeredInGesture = false;
	onActivate?: (selectedText: string) => void;
	onDismiss?: () => void;

	constructor(
		private readonly getTheme: () => Theme,
		private readonly requestRender: () => void,
	) {}

	invalidate(): void {}

	resetGesture(): void {
		this.hovered = false;
		this.pressed = false;
		this.triggeredInGesture = false;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			claimHover(this, () => {
				if (this.hovered) {
					this.hovered = false;
					this.requestRender();
				}
			});
			if (!this.hovered) {
				this.hovered = true;
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}

		if (event.type === "press" && event.button === "left") {
			this.pressed = true;
			this.triggeredInGesture = false;
			return { handled: true, render: false };
		}

		if (event.type === "release" && event.button === "left") {
			const inBounds =
				event.x >= 0 &&
				event.x < event.width &&
				event.y >= 0 &&
				event.y < event.height;
			const wasPressed = this.pressed;
			this.pressed = false;
			if (wasPressed && inBounds && !this.triggeredInGesture) {
				this.triggeredInGesture = true;
				this.onActivate?.(this.selectedTextSnapshot);
				return { handled: true, render: true };
			}
			if (wasPressed && !inBounds) {
				this.onDismiss?.();
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}

		if (event.type === "click" && event.button === "left") {
			this.pressed = false;
			if (!this.triggeredInGesture) {
				this.triggeredInGesture = true;
				this.onActivate?.(this.selectedTextSnapshot);
			}
			return { handled: true, render: true };
		}

		return undefined;
	}

	render(width: number): string[] {
		const theme = this.getTheme();
		const light = isLightTheme(theme);
		const palette = getThemeSurfacePalette(theme);
		const safeWidth = Math.max(4, Math.min(QUOTE_SELECTION_POPUP_WIDTH, width));

		const bg: RgbTuple = this.hovered
			? palette.selectedRowBg
			: palette.popupSurfaceBg;
		const borderRgb: RgbTuple = light
			? this.hovered
				? [37, 99, 235]
				: [59, 130, 246]
			: this.hovered
				? [125, 207, 255]
				: [92, 138, 198];
		const quoteRgb: RgbTuple = light
			? this.hovered
				? [30, 64, 175]
				: [29, 78, 216]
			: this.hovered
				? [156, 222, 255]
				: [125, 207, 255];
		const textRgb: RgbTuple = light
			? [15, 23, 42]
			: this.hovered
				? [240, 248, 255]
				: [226, 236, 248];

		if (safeWidth < QUOTE_SELECTION_POPUP_WIDTH) {
			const clipped = truncateToWidth(QUOTE_SELECTION_POPUP_LABEL, safeWidth, "…");
			return [paintThemeSurfaceRow(theme, fgRgb(textRgb, clipped), safeWidth, bg)];
		}

		const styled = `${fgRgb(borderRgb, "╭")} ${fgRgb(quoteRgb, "❝")} ${fgRgb(textRgb, t("quotes.selectionPopup.word"))} ${fgRgb(borderRgb, "╮")}`;
		return [paintThemeSurfaceRow(theme, styled, safeWidth, bg)];
	}
}

export interface SelectionPopupAnchorContext {
	readonly focusCol: number;
	readonly focusRow: number;
	readonly anchorCol?: number;
	readonly anchorRow?: number;
	readonly viewportTop: number;
	readonly viewportBottom: number;
	readonly stickyBottom?: number;
	readonly rightReservedCols?: number;
}

export class SelectionQuoteOverlayController {
	private popup: QuoteSelectionPopup | undefined;
	private handle: OverlayHandle | undefined;
	private options: OverlayOptions | undefined;
	private activeTui: TUI | undefined;
	private activeRenderer: object | undefined;
	private visible = false;
	private currentBounds: { col: number; row: number; width: number; height: number } | undefined;

	constructor(
		private readonly getTheme: () => Theme,
		private readonly onQuoteConfirmed: (selectedText: string, tui: TUI) => void,
	) {}

	get isShowing(): boolean {
		return (
			this.visible &&
			Boolean(this.handle) &&
			Boolean(this.activeTui) &&
			!hasBlockingModalOverlay(this.activeTui!)
		);
	}

	get snapshottedText(): string {
		return this.isShowing ? (this.popup?.selectedTextSnapshot ?? "") : "";
	}

	containsScreenPoint(screenX: number, screenY: number): boolean {
		if (!this.isShowing) return false;
		const bounds = this.handle?.getBounds?.() ?? this.currentBounds;
		if (!bounds) return false;
		return (
			screenX >= bounds.col &&
			screenX < bounds.col + bounds.width &&
			screenY >= bounds.row &&
			screenY < bounds.row + bounds.height
		);
	}

	show(
		tui: TUI | undefined,
		selectedText: string,
		anchorCtx: SelectionPopupAnchorContext,
	): void {
		const cleaned = normalizeQuoteText(selectedText);
		if (!tui || !cleaned || hasBlockingModalOverlay(tui)) {
			this.hide();
			return;
		}

		const nextRenderer = unwrapHostTui(tui);
		if (this.activeRenderer && this.activeRenderer !== nextRenderer) {
			this.hide();
		}
		this.activeTui = tui;
		this.activeRenderer = nextRenderer;

		if (!this.popup) {
			this.popup = new QuoteSelectionPopup(this.getTheme, () => this.activeTui?.requestRender());
			this.popup.onActivate = (text) => {
				const targetTui = this.activeTui;
				this.hide();
				if (targetTui && text) {
					this.onQuoteConfirmed(text, targetTui);
				}
			};
			this.popup.onDismiss = () => {
				this.hide();
			};
		}

		this.popup.resetGesture();
		this.popup.selectedTextSnapshot = cleaned;

		const termCols = Math.max(8, tui.terminal?.columns ?? 80);
		const width = Math.min(QUOTE_SELECTION_POPUP_WIDTH, termCols);
		const height = QUOTE_SELECTION_POPUP_HEIGHT;

		const { col, row } = computeSelectionQuotePopupAnchor({
			popupWidth: width,
			popupHeight: height,
			focusCol: anchorCtx.focusCol,
			focusRow: anchorCtx.focusRow,
			anchorCol: anchorCtx.anchorCol,
			anchorRow: anchorCtx.anchorRow,
			viewportTop: anchorCtx.viewportTop,
			viewportBottom: anchorCtx.viewportBottom,
			stickyBottom: anchorCtx.stickyBottom,
			termCols,
			rightReservedCols: anchorCtx.rightReservedCols,
		});

		this.visible = true;
		this.currentBounds = { col, row, width, height };

		if (!this.options) {
			this.options = {
				nonCapturing: true,
				width,
				col,
				row,
				visible: () =>
					this.visible &&
					Boolean(this.activeTui) &&
					!hasBlockingModalOverlay(this.activeTui!),
			};
		} else {
			this.options.width = width;
			this.options.col = col;
			this.options.row = row;
		}

		if (!this.handle) {
			this.handle = tui.showOverlay(this.popup, this.options);
		} else {
			tui.requestRender();
		}
	}

	hide(): void {
		if (!this.visible && !this.handle) return;
		this.visible = false;
		this.currentBounds = undefined;
		const targetRenderer = (this.activeRenderer ??
			(this.activeTui ? unwrapHostTui(this.activeTui) : undefined)) as
			| {
					overlayStack?: unknown[];
					renderedOverlayLayouts?: Array<{ entry?: { component?: unknown } }>;
			  }
			| undefined;
		this.activeRenderer = undefined;
		if (this.popup) {
			this.popup.resetGesture();
			this.popup.selectedTextSnapshot = "";
		}
		const currentHandle = this.handle;
		this.handle = undefined;
		if (currentHandle) {
			try {
				currentHandle.hide();
			} catch {
				/* Уже скрыто хостом */
			}
		}
		/* Синхронно очищаем renderedOverlayLayouts, чтобы первый же клик или тройной клик не попадал в скрытый попап */
		if (targetRenderer && Array.isArray(targetRenderer.renderedOverlayLayouts) && this.popup) {
			const popupRef = this.popup;
			targetRenderer.renderedOverlayLayouts = targetRenderer.renderedOverlayLayouts.filter(
				(layout) => layout?.entry?.component !== popupRef,
			);
		}
	}
}

interface SelectionPointLike {
	readonly row: number;
	readonly col: number;
	readonly scrollView?: ScrollView;
}

function pointToScreenCoords(
	point: SelectionPointLike | undefined,
	scrollBox: { rect: { x: number; y: number; width: number; height: number } } | undefined,
	fallbackX: number,
	fallbackY: number,
): { col: number; row: number } {
	if (!point) return { col: fallbackX, row: fallbackY };
	if (point.scrollView && scrollBox) {
		const rawScreenRow = scrollBox.rect.y + (point.row - point.scrollView.scrollTop);
		const clampedRow = Math.max(
			scrollBox.rect.y,
			Math.min(scrollBox.rect.y + scrollBox.rect.height - 1, rawScreenRow),
		);
		const clampedCol = Math.max(
			scrollBox.rect.x,
			Math.min(scrollBox.rect.x + scrollBox.rect.width - 1, scrollBox.rect.x + point.col),
		);
		return { col: clampedCol, row: clampedRow };
	}
	return { col: point.col, row: point.row };
}

/* TuiBase.hasOverlay учитывает nonCapturing Hover Popup, поэтому локально подменяем проверку на блокирующие модалки */
function withNonCapturingOverlaysTransparent<T>(self: any, fn: () => T): T {
	const hadOwn = Object.prototype.hasOwnProperty.call(self, "hasOverlay");
	const prevDesc = hadOwn ? Object.getOwnPropertyDescriptor(self, "hasOverlay") : undefined;
	Object.defineProperty(self, "hasOverlay", {
		configurable: true,
		value: () => hasBlockingModalOverlay(self),
	});
	try {
		return fn();
	} finally {
		if (hadOwn && prevDesc) {
			Object.defineProperty(self, "hasOverlay", prevDesc);
		} else {
			delete self.hasOverlay;
		}
	}
}

export function installSelectionQuoteRuntimeHooks(
	controller: SelectionQuoteOverlayController,
): void {
	registerTransientHoverDismisser("quotes.selection", () => controller.hide());

	installViewportScrollDismissHooks(
		"quotes.selection",
		() => controller.isShowing,
		() => controller.hide(),
	);

	const altProto = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
	if (altProto) {
		hookMethod(
			altProto,
			"handleSelectionMouseEvent",
			"quotes.allowSelectionWithHoverOverlays",
			(self, args, original) =>
				withNonCapturingOverlaysTransparent(self, () => original.apply(self, args)),
		);

		hookMethod(
			altProto,
			"getScrollbarTargetAt",
			"quotes.allowScrollbarWithHoverOverlays",
			(self, args, original) => {
				const x = Number(args[0] ?? -1);
				const y = Number(args[1] ?? -1);
				if (isCoveredByRenderedOverlay(self, x, y)) {
					return undefined;
				}
				return withNonCapturingOverlaysTransparent(self, () => original.apply(self, args));
			},
		);

		hookMethod(
			altProto,
			"handleMouseEvent",
			"quotes.selectionMouseLifecycle",
			(self, args, original) => {
				const raw = args[0] as
					| { button: number; x: number; y: number; release: boolean }
					| undefined;
				const runtime = getActiveHostRuntime();
				if (!raw || !runtime || !runtime.isFullscreen || !isSameHostTui(runtime.tui, self)) {
					return original.apply(self, args);
				}

				const isMotion = (raw.button & 32) !== 0;
				const isPress = !raw.release && !isMotion;
				const isLeftRelease = raw.release && !isMotion && (raw.button & 3) === 0;

				if (isPress && controller.isShowing && !controller.containsScreenPoint(raw.x, raw.y)) {
					controller.hide();
				}

				const hadSelectionPress = Boolean(self.selectionPressActive);
				const res = original.apply(self, args);

				if (isLeftRelease && hadSelectionPress) {
					if (hasBlockingModalOverlay(self)) {
						controller.hide();
						return res;
					}

					const bounds = self.getSelectionBounds?.() as
						| { start?: SelectionPointLike; end?: SelectionPointLike }
						| undefined;
					const rawSelected = self.getActiveSelectionText?.() as string | undefined;
					const cleaned = typeof rawSelected === "string" ? normalizeQuoteText(rawSelected) : "";

					const scrollBox = runtime.scroll
						? findScrollViewLayoutBox(self.currentLayout?.root, runtime.scroll)
						: undefined;
					const inTranscript = runtime.scroll
						? bounds?.start?.scrollView === runtime.scroll
						: !scrollBox || raw.y < scrollBox.rect.y + scrollBox.rect.height;

					if (cleaned && bounds && inTranscript) {
						const focusPt = self.selectionFocus as SelectionPointLike | undefined;
						const anchorPt = self.selectionAnchor as SelectionPointLike | undefined;
						const focusCoords = pointToScreenCoords(focusPt, scrollBox, raw.x, raw.y);
						const anchorCoords = anchorPt
							? pointToScreenCoords(anchorPt, scrollBox, raw.x, raw.y)
							: undefined;

						let effectiveFocusCol = focusCoords.col;
						if (focusPt) {
							const rawSourceLine =
								typeof self.getSelectionSourceLine === "function"
									? String(self.getSelectionSourceLine(focusPt) ?? "")
									: "";
							const trimmedLineWidth = visibleWidth(
								stripTerminalSequences(rawSourceLine).trimEnd(),
							);
							const lineEndScreenCol = (scrollBox?.rect.x ?? 0) + trimmedLineWidth;
							if (self.selectionGranularity === "line") {
								effectiveFocusCol =
									trimmedLineWidth > 0
										? Math.min(Math.max(raw.x, scrollBox?.rect.x ?? 0), lineEndScreenCol)
										: raw.x;
							} else if (trimmedLineWidth > 0 && effectiveFocusCol > lineEndScreenCol) {
								effectiveFocusCol = lineEndScreenCol;
							}
						}

						const viewportTop = scrollBox?.rect.y ?? 0;
						const termRows = Math.max(8, self.terminal?.rows ?? 30);
						const termCols = Math.max(8, self.terminal?.columns ?? 80);
						const viewportBottom = scrollBox
							? scrollBox.rect.y + scrollBox.rect.height
							: termRows;

						const topSlot = runtime.viewportSlots?.topSlot as
							| { lastVisibleHeight?: number }
							| undefined;
						const stickyBottom = viewportTop + Math.max(0, topSlot?.lastVisibleHeight ?? 0);

						const railVisible = Boolean(
							runtime.viewportSlots?.rightRail?.isVisible({
								width: scrollBox?.rect.width ?? termCols,
								height: scrollBox?.rect.height ?? termRows,
							}),
						);

						controller.show(runtime.tui, cleaned, {
							focusCol: effectiveFocusCol,
							focusRow: focusCoords.row,
							anchorCol: anchorCoords?.col,
							anchorRow: anchorCoords?.row,
							viewportTop,
							viewportBottom,
							stickyBottom,
							rightReservedCols: railVisible ? 3 : 1,
						});
						self.requestRender?.();
					} else {
						controller.hide();
					}
				}

				return res;
			},
		);
	}
}
