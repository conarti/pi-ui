import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
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
	blueBgRgb,
	themeFgRgb,
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
import { t } from "../../shared/i18n.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { loadPiUiUserConfig } from "../../shared/pi-ui-config.ts";
import {
	claimHover,
	copyToClipboard,
	hookMethod,
} from "../../shared/runtime-hooks.ts";
import {
	extractCleanSelectionText,
	type SelectedTranscriptLine,
} from "../../shared/selection-copy.ts";
import { computeSelectionQuotePopupAnchor } from "./quote-model.ts";

export const QUOTE_SELECTION_POPUP_LABEL = t("quotes.selectionPopup.label");
export const QUOTE_SELECTION_POPUP_WIDTH = visibleWidth(` ${QUOTE_SELECTION_POPUP_LABEL} `);
export const QUOTE_SELECTION_POPUP_HEIGHT = 1;

type SelectionPopupAction = "copy" | "quote";

interface ActionZone {
	readonly action: SelectionPopupAction;
	readonly xStart: number;
	readonly xEnd: number;
}

function getManualCopyLabel(): string {
	return `[${t("quotes.selectionPopup.copy")}]`;
}

function getQuoteActionLabel(): string {
	return `[${t("quotes.selectionPopup.quoteAction")}]`;
}

function getAutoCopiedPrefix(): string {
	return `${t("quotes.selectionPopup.copied")} · `;
}

export function computeSelectionPopupWidth(copyOnSelectMode: boolean): number {
	const quoteLabel = getQuoteActionLabel();
	if (copyOnSelectMode) {
		return visibleWidth(` ${getAutoCopiedPrefix()}${quoteLabel} `);
	}
	return visibleWidth(` ${getManualCopyLabel()}  ${quoteLabel} `);
}

export class QuoteSelectionPopup implements Component {
	selectedTextSnapshot = "";
	copyOnSelectMode = false;
	hoveredAction: SelectionPopupAction | null = null;
	private pressedAction: SelectionPopupAction | null = null;
	private triggeredInGesture = false;
	private zones: readonly ActionZone[] = [];
	onCopy?: (selectedText: string) => void;
	onActivate?: (selectedText: string) => void;
	onDismiss?: () => void;

	constructor(
		private readonly getTheme: () => Theme,
		private readonly requestRender: () => void,
	) {}

	invalidate(): void {}

	resetGesture(): void {
		this.hoveredAction = null;
		this.pressedAction = null;
		this.triggeredInGesture = false;
	}

	private hitAction(x: number, y: number): SelectionPopupAction | null {
		if (y !== 0) return null;
		for (const zone of this.zones) {
			if (x >= zone.xStart && x < zone.xEnd) {
				return zone.action;
			}
		}
		return null;
	}

	private triggerAction(action: SelectionPopupAction): void {
		if (action === "copy") {
			this.onCopy?.(this.selectedTextSnapshot);
		} else {
			this.onActivate?.(this.selectedTextSnapshot);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			const nextAction = this.hitAction(event.x, event.y);
			claimHover(this, () => {
				this.onDismiss?.();
				this.requestRender();
			});
			if (nextAction !== this.hoveredAction) {
				this.hoveredAction = nextAction;
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}

		if (event.type === "press" && event.button === "left") {
			const hit = this.hitAction(event.x, event.y);
			this.pressedAction = hit ?? (this.copyOnSelectMode ? "quote" : null);
			this.triggeredInGesture = false;
			return { handled: true, render: false };
		}

		if (event.type === "release" && event.button === "left") {
			const inBounds =
				event.x >= 0 &&
				event.x < event.width &&
				event.y >= 0 &&
				event.y < event.height;
			const wasPressed = this.pressedAction;
			this.pressedAction = null;
			if (wasPressed && inBounds && !this.triggeredInGesture) {
				const releaseHit = this.hitAction(event.x, event.y) ?? wasPressed;
				this.triggeredInGesture = true;
				this.triggerAction(releaseHit);
				return { handled: true, render: true };
			}
			if (wasPressed && !inBounds) {
				this.onDismiss?.();
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}

		if (event.type === "click" && event.button === "left") {
			const hit = this.hitAction(event.x, event.y) ?? this.pressedAction;
			this.pressedAction = null;
			if (hit && !this.triggeredInGesture) {
				this.triggeredInGesture = true;
				this.triggerAction(hit);
			}
			return { handled: true, render: true };
		}

		return undefined;
	}

	render(width: number): string[] {
		const theme = this.getTheme();
		const light = isLightTheme(theme);
		const palette = getThemeSurfacePalette(theme);
		const targetWidth = computeSelectionPopupWidth(this.copyOnSelectMode);
		const safeWidth = Math.max(4, Math.min(targetWidth, width));
		const bg: RgbTuple = palette.popupSurfaceBg;

		const quoteLabel = getQuoteActionLabel();
		const copyLabel = getManualCopyLabel();
		const copiedPrefix = getAutoCopiedPrefix();

		const paintButton = (label: string, hovered: boolean): string => {
			if (hovered) {
				return blueBgRgb(
					theme,
					palette.selectedRowBg,
					themeFgRgb(theme, light ? palette.accent : palette.accentBright, label),
				);
			}
			return themeFgRgb(theme, light ? [15, 23, 42] : [226, 236, 248], label);
		};

		if (this.copyOnSelectMode) {
			const plain = ` ${copiedPrefix}${quoteLabel} `;
			if (safeWidth < visibleWidth(plain)) {
				this.zones = [{ action: "quote", xStart: 0, xEnd: safeWidth }];
				const clipped = truncateToWidth(plain.trim(), safeWidth, "…");
				return [paintThemeSurfaceRow(theme, fgRgb(light ? [15, 23, 42] : [226, 236, 248], clipped), safeWidth, bg)];
			}
			const prefixW = visibleWidth(copiedPrefix);
			const quoteW = visibleWidth(quoteLabel);
			this.zones = [{ action: "quote", xStart: 1 + prefixW, xEnd: 1 + prefixW + quoteW }];
			const styledCopied = `${themeFgRgb(theme, palette.success, t("quotes.selectionPopup.copied"))}${theme.fg("dim", " · ")}`;
			const styledQuote = paintButton(quoteLabel, this.hoveredAction === "quote");
			return [paintThemeSurfaceRow(theme, ` ${styledCopied}${styledQuote} `, safeWidth, bg)];
		}

		const plain = ` ${copyLabel}  ${quoteLabel} `;
		if (safeWidth < visibleWidth(plain)) {
			const clipped = truncateToWidth(plain.trim(), safeWidth, "…");
			const copyW = Math.min(safeWidth, visibleWidth(copyLabel));
			this.zones = [
				{ action: "copy", xStart: 0, xEnd: copyW },
				{ action: "quote", xStart: copyW, xEnd: safeWidth },
			];
			return [paintThemeSurfaceRow(theme, fgRgb(light ? [15, 23, 42] : [226, 236, 248], clipped), safeWidth, bg)];
		}

		const copyW = visibleWidth(copyLabel);
		const quoteW = visibleWidth(quoteLabel);
		const copyStart = 1;
		const quoteStart = copyStart + copyW + 2;
		this.zones = [
			{ action: "copy", xStart: copyStart, xEnd: copyStart + copyW },
			{ action: "quote", xStart: quoteStart, xEnd: quoteStart + quoteW },
		];

		const styledCopy = paintButton(copyLabel, this.hoveredAction === "copy");
		const styledQuote = paintButton(quoteLabel, this.hoveredAction === "quote");
		return [paintThemeSurfaceRow(theme, ` ${styledCopy}  ${styledQuote} `, safeWidth, bg)];
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
	readonly copyOnSelect?: boolean;
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
		private readonly onCopyConfirmed?: (selectedText: string, tui: TUI) => void,
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
		if (!tui || !selectedText.trim() || hasBlockingModalOverlay(tui)) {
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
			this.popup.onCopy = (text) => {
				const targetTui = this.activeTui;
				this.hide();
				if (targetTui && text) {
					this.onCopyConfirmed?.(text, targetTui);
				}
			};
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

		const copyOnSelectMode = Boolean(anchorCtx.copyOnSelect);
		this.popup.resetGesture();
		this.popup.copyOnSelectMode = copyOnSelectMode;
		this.popup.selectedTextSnapshot = selectedText;

		const termCols = Math.max(8, tui.terminal?.columns ?? 80);
		const width = Math.min(computeSelectionPopupWidth(copyOnSelectMode), termCols);
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

/**
 * Временно делает `nonCapturing`-попапы невидимыми для `this.hasOverlay()` внутри
 * методов выделения и скроллбара `TuiAltScreen`, чтобы открытый Hover Popup не
 * ломал выделение текста и автоскролл транскрипта.
 */
function withNonCapturingOverlaysTransparent<T>(self: any, run: () => T): T {
	const hadOwn = Object.prototype.hasOwnProperty.call(self, "hasOverlay");
	const prevDesc = hadOwn ? Object.getOwnPropertyDescriptor(self, "hasOverlay") : undefined;
	Object.defineProperty(self, "hasOverlay", {
		configurable: true,
		writable: true,
		value: () => hasBlockingModalOverlay(self),
	});
	try {
		return run();
	} finally {
		if (prevDesc) {
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
			"getActiveSelectionText",
			"quotes.cleanSelectionText",
			(self, args, original) => {
				const runtime = getActiveHostRuntime();
				if (!runtime || !runtime.isFullscreen || !isSameHostTui(runtime.tui, self)) {
					return original.apply(self, args);
				}
				const selection = self.getSelectionBounds?.() as
					| { start?: SelectionPointLike; end?: SelectionPointLike }
					| undefined;
				if (!selection?.start || !selection.end || !runtime.scroll) {
					return original.apply(self, args);
				}
				if (selection.start.scrollView !== runtime.scroll) {
					return original.apply(self, args);
				}
				const scrollBox = findScrollViewLayoutBox(self.currentLayout?.root, runtime.scroll);
				const sourceLines = scrollBox?.scrollContentLines;
				if (!sourceLines) {
					return original.apply(self, args);
				}
				const selectedLines: SelectedTranscriptLine[] = [];
				for (let row = selection.start.row; row <= selection.end.row; row += 1) {
					const fullLine = sourceLines[row] ?? "";
					const columns = self.getSelectionColumns(fullLine, row, selection) as {
						start: number;
						end: number;
					};
					const span = Math.max(0, columns.end - columns.start);
					selectedLines.push({
						fullLine,
						selectedAnsi: sliceByColumn(fullLine, columns.start, span, true),
						startCol: columns.start,
						endCol: columns.end,
						contentWidth: scrollBox.rect.width,
					});
				}
				const cleaned = extractCleanSelectionText(selectedLines, { theme: runtime.theme() });
				return cleaned.length > 0 ? cleaned : undefined;
			},
		);

		hookMethod(
			altProto,
			"copySelectionToClipboard",
			"quotes.cleanCopySelectionToClipboard",
			(self, args, original) => {
				const runtime = getActiveHostRuntime();
				if (!runtime || !runtime.isFullscreen || !isSameHostTui(runtime.tui, self)) {
					return original.apply(self, args);
				}
				const text = self.getActiveSelectionText?.() as string | undefined;
				if (!text) return Promise.resolve(false);
				copyToClipboard(text);
				return Promise.resolve(true);
			},
		);

		hookMethod(
			altProto,
			"handleSelectionMouseEvent",
			"quotes.allowSelectionWithHoverOverlays",
			(self, args, original) => {
				const runtime = getActiveHostRuntime();
				if (runtime && isSameHostTui(runtime.tui, self)) {
					self.copyOnSelect = loadPiUiUserConfig().copyOnSelect;
				}
				return withNonCapturingOverlaysTransparent(self, () => original.apply(self, args));
			},
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
					const cleaned = typeof rawSelected === "string" ? rawSelected : "";

					const scrollBox = runtime.scroll
						? findScrollViewLayoutBox(self.currentLayout?.root, runtime.scroll)
						: undefined;
					const inTranscript = runtime.scroll
						? bounds?.start?.scrollView === runtime.scroll
						: !scrollBox || raw.y < scrollBox.rect.y + scrollBox.rect.height;

					if (cleaned.trim() && bounds && inTranscript) {
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
							rightReservedCols: railVisible ? 2 : 1,
							copyOnSelect: loadPiUiUserConfig().copyOnSelect,
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
