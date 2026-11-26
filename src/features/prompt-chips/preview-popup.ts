import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	Image,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	fgRgb,
	getThemeSurfacePalette,
	isLightTheme,
	paintRawThemeSurfaceRow,
	paintThemeSurfaceRow,
	type HitBox,
	type RgbTuple,
} from "../../shared/ansi.ts";
import { registerTransientHoverDismisser, unwrapHostTui } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import {
	hasMarkdownFormatting,
	measurePopupLineNaturalWidth,
	paintPopupMarkdownCell,
	renderPopupMarkdownLines,
} from "../../shared/popup-markdown.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import type { SerializedPromptChip } from "./registry.ts";

export const MAX_PREVIEW_BODY_ROWS = 14;
export const MAX_PREVIEW_WIDTH = 84;
export const THUMB_MAX_WIDTH_CELLS = 36;
export const THUMB_MAX_HEIGHT_CELLS = 12;

export interface PreviewImageSource {
	readonly base64Data: string;
	readonly mimeType: string;
	readonly widthPx?: number;
	readonly heightPx?: number;
}

export interface PreviewPopupActions {
	readonly resolveImageData?: (chip: SerializedPromptChip) => PreviewImageSource | undefined;
	readonly resolveFullText?: (chip: SerializedPromptChip) => string | undefined;
	readonly onCopy?: (chip: SerializedPromptChip, fullText: string) => void;
	readonly onEdit?: (chip: SerializedPromptChip) => void;
	readonly onRemove?: (chip: SerializedPromptChip) => void;
}

export interface PreviewContentSpec {
	readonly title: string;
	readonly lines: Array<{ text: string; muted?: boolean; markdown?: boolean }>;
	readonly allLines: Array<{ text: string; muted?: boolean; markdown?: boolean }>;
	readonly scrollable: boolean;
}

function wrapPlainLines(
	rawLines: readonly string[],
	textWidth: number,
	prefix = "",
): Array<{ text: string; muted?: boolean }> {
	const safeWidth = Math.max(8, textWidth);
	const prefixW = visibleWidth(prefix);
	const innerW = Math.max(4, safeWidth - prefixW);
	const out: Array<{ text: string; muted?: boolean }> = [];
	for (const raw of rawLines) {
		if (!raw) {
			out.push({ text: prefix ? prefix.trimEnd() : " " });
			continue;
		}
		const wrapped = wrapTextWithAnsi(raw, innerW);
		for (const part of wrapped) {
			out.push({ text: prefix ? `${prefix}${part}` : part });
		}
	}
	return out.length > 0 ? out : [{ text: " " }];
}

export function buildChipPreviewSpec(
	chip: SerializedPromptChip,
	options?: { readonly wrapWidth?: number; readonly fullText?: string; readonly theme?: Theme },
): PreviewContentSpec {
	if (chip.kind === "image") {
		const metaParts: string[] = [];
		if (chip.widthPx && chip.heightPx) {
			metaParts.push(`${chip.widthPx}×${chip.heightPx}`);
		}
		if (chip.byteLength > 0) {
			metaParts.push(formatSize(chip.byteLength));
		}
		metaParts.push(chip.mimeType);

		const lines: Array<{ text: string; muted?: boolean }> = [
			{ text: t("chips.popup.file", { name: chip.fileName }) },
			{ text: t("chips.popup.size", { size: metaParts.join(" · ") }), muted: true },
		];
		if (chip.filePath) {
			lines.push({ text: t("chips.popup.path", { path: chip.filePath }), muted: true });
		}
		return {
			title: t("chips.popup.image", { number: chip.number }),
			lines,
			allLines: lines,
			scrollable: false,
		};
	}

	const sourceText = options?.fullText ?? chip.previewText ?? "";
	const rawLines = sourceText.replace(/\t/g, "  ").split("\n");
	const wrapW = options?.wrapWidth;

	const mdTheme = options?.theme;
	const useMarkdown = Boolean(wrapW && mdTheme && hasMarkdownFormatting(sourceText));
	if (chip.kind === "paste") {
		const allLines: Array<{ text: string; muted?: boolean; markdown?: boolean }> =
			useMarkdown && wrapW && mdTheme
				? renderPopupMarkdownLines(sourceText, wrapW, mdTheme).map((line) => ({
						text: line,
						markdown: true,
					}))
				: wrapW
					? wrapPlainLines(rawLines, wrapW)
					: rawLines.map((line) => ({ text: line.length > 0 ? line : " " }));
		const shown = allLines.slice(0, MAX_PREVIEW_BODY_ROWS);
		const remaining = Math.max(0, allLines.length - shown.length);
		if (remaining > 0) {
			shown.push({
				text: t(remaining === 1 ? "chips.popup.moreLine" : "chips.popup.moreLines", { count: remaining }),
				muted: true,
			});
		}
		const count = chip.metric === "chars" ? chip.charCount : chip.lineCount;
		const title = chip.metric === "chars"
			? t(count === 1 ? "chips.popup.pasteChar" : "chips.popup.pasteChars", { number: chip.number, count })
			: t(count === 1 ? "chips.popup.pasteLine" : "chips.popup.pasteLines", { number: chip.number, count });
		return {
			title,
			lines: shown.length > 0 ? shown : [{ text: " " }],
			allLines: allLines.length > 0 ? allLines : [{ text: " " }],
			scrollable: allLines.length > MAX_PREVIEW_BODY_ROWS,
		};
	}

	const allLines: Array<{ text: string; muted?: boolean; markdown?: boolean }> =
		useMarkdown && wrapW && mdTheme
			? renderPopupMarkdownLines(sourceText, wrapW, mdTheme, { quoteRail: true }).map((line) => ({
					text: line,
					markdown: true,
				}))
			: wrapW
				? wrapPlainLines(rawLines, wrapW, "│ ")
				: rawLines.map((line) => ({ text: line.length > 0 ? `│ ${line}` : "│" }));
	const shown = allLines.slice(0, MAX_PREVIEW_BODY_ROWS);
	const remaining = Math.max(0, allLines.length - shown.length);
	if (remaining > 0) {
		shown.push({
			text: t(remaining === 1 ? "chips.popup.moreLine" : "chips.popup.moreLines", { count: remaining }),
			muted: true,
		});
	}
	return {
		title: t(chip.lineCount === 1 ? "chips.popup.quoteLine" : "chips.popup.quoteLines", {
			number: chip.number, count: chip.lineCount,
		}),
		lines: shown.length > 0 ? shown : [{ text: " " }],
		allLines: allLines.length > 0 ? allLines : [{ text: " " }],
		scrollable: allLines.length > MAX_PREVIEW_BODY_ROWS,
	};
}

export type PreviewTriggerSource = "composer-hover" | "composer-caret" | "sent-pill";

export class PromptChipPreviewPopup implements Component {
	private currentChip: SerializedPromptChip | undefined;
	private currentSource: PreviewTriggerSource | undefined;
	private currentActions: PreviewPopupActions = {};
	private cachedThumbKey: string | undefined;
	private cachedThumbLines: readonly string[] | undefined;
	private maxThumbHeightCells = THUMB_MAX_HEIGHT_CELLS;
	private hits: HitBox[] = [];
	private hoveredId: string | null = null;
	private copiedFlash = false;
	private lastWrapWidth = 60;
	private readonly hoverOwner = {};
	scrollOffset = 0;
	onDismiss?: () => void;
	onHoverChange?: (hovered: boolean) => void;

	constructor(private readonly getTheme: () => Theme) {}

	get chip(): SerializedPromptChip | undefined {
		return this.currentChip;
	}

	set chip(next: SerializedPromptChip | undefined) {
		if (this.currentChip?.id !== next?.id || this.currentChip?.token !== next?.token) {
			this.scrollOffset = 0;
			this.copiedFlash = false;
			this.hoveredId = null;
			this.cachedThumbKey = undefined;
			this.cachedThumbLines = undefined;
		}
		this.currentChip = next;
	}

	setContext(
		source: PreviewTriggerSource,
		actions: PreviewPopupActions,
		maxThumbHeightCells = THUMB_MAX_HEIGHT_CELLS,
	): void {
		this.currentSource = source;
		this.currentActions = actions;
		const clamped = Math.max(0, Math.min(THUMB_MAX_HEIGHT_CELLS, Math.floor(maxThumbHeightCells)));
		if (clamped !== this.maxThumbHeightCells) {
			this.maxThumbHeightCells = clamped;
			this.cachedThumbKey = undefined;
			this.cachedThumbLines = undefined;
		}
	}

	invalidate(): void {
		this.cachedThumbKey = undefined;
		this.cachedThumbLines = undefined;
	}

	private resolveThumbnailLines(textWidth: number): readonly string[] {
		if (!this.currentChip || this.currentChip.kind !== "image" || this.maxThumbHeightCells <= 0) {
			return [];
		}
		const caps = getCapabilities();
		if (!caps.images) return [];
		const imageSrc = this.currentActions.resolveImageData?.(this.currentChip);
		if (!imageSrc?.base64Data) return [];

		const maxW = Math.max(4, Math.min(THUMB_MAX_WIDTH_CELLS, textWidth));
		const maxH = this.maxThumbHeightCells;
		const key = `${this.currentChip.id}:${caps.images}:${maxW}:${maxH}:${imageSrc.base64Data.length}`;
		if (this.cachedThumbKey === key && this.cachedThumbLines) {
			return this.cachedThumbLines;
		}
		const theme = this.getTheme();
		const dims =
			imageSrc.widthPx && imageSrc.heightPx
				? { widthPx: imageSrc.widthPx, heightPx: imageSrc.heightPx }
				: undefined;
		const img = new Image(
			imageSrc.base64Data,
			imageSrc.mimeType,
			{ fallbackColor: (s) => theme.fg("muted", s) },
			{
				maxWidthCells: maxW,
				maxHeightCells: maxH,
				filename: this.currentChip.fileName,
			},
			dims,
		);
		const lines = img.render(maxW + 2);
		const hasGraphics = lines.some((l) => l.includes("\x1b_G") || l.includes("\x1b]1337;File="));
		this.cachedThumbKey = key;
		this.cachedThumbLines = hasGraphics ? lines : [];
		return this.cachedThumbLines;
	}

	private resolveActionItems(): Array<{
		readonly id: string;
		readonly label: string;
		readonly danger?: boolean;
		readonly onClick: () => void;
	}> {
		if (!this.currentChip) return [];
		const chip = this.currentChip;
		const inComposer = this.currentSource === "composer-hover" || this.currentSource === "composer-caret";
		const out: Array<{
			readonly id: string;
			readonly label: string;
			readonly danger?: boolean;
			readonly onClick: () => void;
		}> = [];

		if (chip.kind === "quote" && inComposer && this.currentActions.onEdit) {
			out.push({
				id: "edit",
				label: `[${t("chips.popup.edit")}]`,
				onClick: () => this.currentActions.onEdit?.(chip),
			});
		}

		if ((chip.kind === "quote" || chip.kind === "paste") && this.currentActions.onCopy) {
			const fullText = this.currentActions.resolveFullText?.(chip) ?? chip.previewText ?? "";
			out.push({
				id: "copy",
				label: this.copiedFlash ? `✓ ${t("chips.popup.copied")}` : `[${t("chips.popup.copy")}]`,
				onClick: () => {
					this.copiedFlash = true;
					this.currentActions.onCopy?.(chip, fullText);
				},
			});
		}

		if (inComposer && this.currentActions.onRemove) {
			out.push({
				id: "remove",
				label: `[${t("chips.popup.remove")}]`,
				danger: true,
				onClick: () => this.currentActions.onRemove?.(chip),
			});
		}

		return out;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta && this.currentChip) {
			const fullText = this.currentActions.resolveFullText?.(this.currentChip);
			const spec = buildChipPreviewSpec(this.currentChip, {
				wrapWidth: this.lastWrapWidth,
				fullText,
				theme: this.getTheme(),
			});
			if (spec.scrollable) {
				const maxScroll = Math.max(0, spec.allLines.length - MAX_PREVIEW_BODY_ROWS);
				const next = Math.max(0, Math.min(maxScroll, this.scrollOffset + event.wheelDelta));
				const changed = next !== this.scrollOffset;
				this.scrollOffset = next;
				return { handled: true, render: changed };
			}
			return { handled: true, render: false };
		}

		const hit = this.hits.find(
			(h) => h.y === event.y && event.x >= h.xStart && event.x < h.xEnd,
		);

		if (event.type === "move") {
			this.onHoverChange?.(true);
			claimHover(this.hoverOwner, () => {
				this.hoveredId = null;
				this.onHoverChange?.(false);
			});
			const nextHover = hit?.id ?? null;
			if (nextHover !== this.hoveredId) {
				this.hoveredId = nextHover;
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}

		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}

		if (event.type === "click" && event.button === "left") {
			if (hit) {
				hit.onClick();
				return { handled: true, render: true };
			}
			this.onDismiss?.();
			return { handled: true, render: true };
		}
		return undefined;
	}

	computeDimensions(termCols: number): { width: number; height: number } {
		if (!this.currentChip) return { width: 24, height: 3 };
		const theme = this.getTheme();
		const fullText = this.currentActions.resolveFullText?.(this.currentChip);
		const maxAllowed = Math.max(24, Math.min(MAX_PREVIEW_WIDTH, termCols - 6));
		const maxTextW = Math.max(8, maxAllowed - 4);
		const measuredSpec = buildChipPreviewSpec(this.currentChip, {
			wrapWidth: maxTextW,
			fullText,
			theme,
		});
		const actions = this.resolveActionItems();
		const actionsWidth =
			actions.length > 0
				? actions.reduce((sum, a) => sum + visibleWidth(a.label), 0) + (actions.length - 1) * 2
				: 0;
		const thumbMinWidth =
			this.currentChip.kind === "image" && getCapabilities().images
				? Math.min(THUMB_MAX_WIDTH_CELLS, maxAllowed - 4) + 2
				: 0;

		const naturalInner = Math.max(
			visibleWidth(measuredSpec.title) + 4,
			actionsWidth + 2,
			thumbMinWidth,
			...measuredSpec.allLines.map(
				(l) => (l.markdown ? measurePopupLineNaturalWidth(l.text) : visibleWidth(l.text)) + 2,
			),
		);
		const width = Math.max(24, Math.min(maxAllowed, naturalInner + 2));
		const textWidth = Math.max(8, width - 4);
		this.lastWrapWidth = textWidth;

		const wrappedSpec =
			textWidth === maxTextW
				? measuredSpec
				: buildChipPreviewSpec(this.currentChip, {
						wrapWidth: textWidth,
						fullText,
						theme,
					});
		const thumbLines = this.resolveThumbnailLines(textWidth);
		const bodyRows = wrappedSpec.scrollable
			? MAX_PREVIEW_BODY_ROWS + 1
			: wrappedSpec.lines.length;
		const actionRows = actions.length > 0 ? 1 : 0;
		const height = bodyRows + thumbLines.length + actionRows + 2;
		return { width, height };
	}

	render(width: number): string[] {
		this.hits = [];
		if (!this.currentChip) return [];
		const theme = this.getTheme();
		const light = isLightTheme(theme);
		const palette = getThemeSurfacePalette(theme);
		const safeWidth = Math.max(12, width);
		const innerSpan = Math.max(2, safeWidth - 2);
		const textWidth = Math.max(4, safeWidth - 4);
		this.lastWrapWidth = textWidth;

		const borderRgb: RgbTuple = light ? [148, 163, 184] : [72, 88, 112];
		const titleRgb: RgbTuple = light ? [29, 78, 216] : [125, 207, 255];
		const textRgb: RgbTuple = light ? [15, 23, 42] : [220, 232, 248];
		const mutedRgb: RgbTuple = light ? [100, 116, 139] : [136, 152, 176];
		const dangerRgb: RgbTuple = light ? [185, 28, 28] : [248, 113, 113];
		const popupBg = palette.popupSurfaceBg;

		const fullText = this.currentActions.resolveFullText?.(this.currentChip);
		const spec = buildChipPreviewSpec(this.currentChip, {
			wrapWidth: textWidth,
			fullText,
			theme,
		});
		const thumbLines = this.resolveThumbnailLines(textWidth);
		const b = (s: string) => fgRgb(borderRgb, s);

		let renderRows: Array<{ text: string; muted?: boolean; markdown?: boolean }>;
		if (spec.scrollable) {
			const maxScroll = Math.max(0, spec.allLines.length - MAX_PREVIEW_BODY_ROWS);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			const windowRows = spec.allLines.slice(
				this.scrollOffset,
				this.scrollOffset + MAX_PREVIEW_BODY_ROWS,
			);
			const remainingBelow = Math.max(
				0,
				spec.allLines.length - (this.scrollOffset + windowRows.length),
			);
			const statusParts: string[] = [];
			if (this.scrollOffset > 0) statusParts.push(`↑ ${this.scrollOffset}`);
			if (remainingBelow > 0) {
				statusParts.push(t(remainingBelow === 1 ? "chips.popup.moreLine" : "chips.popup.moreLines", { count: remainingBelow }));
			}
			renderRows = [
				...windowRows,
				{
					text: statusParts.length > 0 ? statusParts.join(" · ") : t("chips.popup.endOfPreview"),
					muted: true,
				},
			];
		} else {
			renderRows = spec.lines;
		}

		const clippedTitle = truncateToWidth(` ${spec.title} `, Math.max(1, innerSpan - 2), "…");
		const titleW = visibleWidth(clippedTitle);
		const rightDashes = Math.max(0, innerSpan - 1 - titleW);
		const topRow = paintThemeSurfaceRow(
			theme,
			`${b("╭─")}${fgRgb(titleRgb, clippedTitle)}${b("─".repeat(rightDashes))}${b("╮")}`,
			safeWidth,
			popupBg,
		);

		const out: string[] = [topRow];

		/* Миниатюра Kitty/iTerm2 вставляется без truncateToWidth, но с тем же фоном popupBg на всех строках */
		for (const thumbLine of thumbLines) {
			if (thumbLine.includes("\x1b_G") || thumbLine.includes("\x1b]1337;File=")) {
				const pad = " ".repeat(textWidth);
				out.push(paintRawThemeSurfaceRow(theme, `${b("│")} ${thumbLine}${pad} ${b("│")}`, popupBg));
			} else {
				const pad = " ".repeat(textWidth);
				out.push(paintThemeSurfaceRow(theme, `${b("│")} ${pad} ${b("│")}`, safeWidth, popupBg));
			}
		}

		for (const row of renderRows) {
			const clipped =
				this.currentChip.kind === "image"
					? truncateToWidth(row.text, textWidth, "…")
					: truncateToWidth(row.text, textWidth, "");
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(clipped)));
			const colored = row.muted
				? fgRgb(mutedRgb, `${clipped}${pad}`)
				: row.markdown
					? paintPopupMarkdownCell(`${clipped}${pad}`, textRgb, theme)
					: fgRgb(textRgb, `${clipped}${pad}`);
			out.push(paintThemeSurfaceRow(theme, `${b("│")} ${colored} ${b("│")}`, safeWidth, popupBg));
		}

		const actions = this.resolveActionItems();
		if (actions.length > 0) {
			const actionRowY = out.length;
			let curX = 2;
			let actionStr = "";
			for (let i = 0; i < actions.length; i += 1) {
				const action = actions[i]!;
				const aw = visibleWidth(action.label);
				const isHov = this.hoveredId === action.id;
				const styled = isHov
					? fgRgb(action.danger ? dangerRgb : titleRgb, theme.bold(action.label))
					: fgRgb(action.danger ? dangerRgb : mutedRgb, action.label);
				this.hits.push({
					id: action.id,
					xStart: curX,
					xEnd: curX + aw,
					y: actionRowY,
					onClick: action.onClick,
				});
				actionStr += styled;
				curX += aw;
				if (i < actions.length - 1) {
					actionStr += "  ";
					curX += 2;
				}
			}
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(actionStr)));
			out.push(
				paintThemeSurfaceRow(theme, `${b("│")} ${actionStr}${pad} ${b("│")}`, safeWidth, popupBg),
			);
		}

		out.push(
			paintThemeSurfaceRow(theme, `${b("╰")}${b("─".repeat(innerSpan))}${b("╯")}`, safeWidth, popupBg),
		);
		return out;
	}
}

export class PromptChipOverlayController {
	private popup: PromptChipPreviewPopup | undefined;
	private handle: OverlayHandle | undefined;
	private options: OverlayOptions | undefined;
	private visible = false;
	private popupHovered = false;
	private enteredPopup = false;
	private popupRect: { col: number; row: number; width: number; height: number } | undefined;
	private triggerBounds: { xStart: number; xEnd: number; y: number } | undefined;
	private activeSource: PreviewTriggerSource | undefined;
	private activeChipKey: string | undefined;
	private activeTui: TUI | undefined;
	private activeRenderer: object | undefined;

	constructor(private readonly getTheme: () => Theme) {
		registerTransientHoverDismisser("promptChips.preview", () => this.hide());
	}

	get isShowing(): boolean {
		return this.visible && Boolean(this.handle);
	}

	get sentPopup(): Component | undefined {
		return this.isShowing && this.activeSource === "sent-pill" ? this.popup : undefined;
	}

	get isPopupHovered(): boolean {
		return this.popupHovered;
	}

	isPointerInHoverBridge(screenX: number, screenY: number): boolean {
		if (!this.isShowing || !this.popupRect) return false;
		const { col, row, width, height } = this.popupRect;
		if (screenX >= col && screenX < col + width && screenY >= row && screenY < row + height) {
			return true;
		}
		if (this.enteredPopup || !this.triggerBounds) return false;
		const minX = Math.min(this.triggerBounds.xStart, col) - 1;
		const maxX = Math.max(this.triggerBounds.xEnd, col + width);
		if (screenX < minX || screenX > maxX) return false;
		const popupBottom = row + height - 1;
		if (popupBottom < this.triggerBounds.y) {
			return screenY > popupBottom && screenY < this.triggerBounds.y;
		}
		if (row > this.triggerBounds.y) {
			return screenY > this.triggerBounds.y && screenY < row;
		}
		return false;
	}

	get source(): PreviewTriggerSource | undefined {
		return this.activeSource;
	}

	get chipKey(): string | undefined {
		return this.activeChipKey;
	}

	show(
		tui: TUI | undefined,
		chip: SerializedPromptChip,
		source: PreviewTriggerSource,
		anchor: {
			col: number;
			rowAbove: number;
			rowBelow?: number;
			key?: string;
			triggerBounds?: { xStart: number; xEnd: number; y: number };
		},
		actions?: PreviewPopupActions,
		onPopupLeave?: () => void,
	): void {
		if (!tui || hasBlockingModalOverlay(tui)) {
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
			this.popup = new PromptChipPreviewPopup(this.getTheme);
			this.popup.onDismiss = () => this.hide(["sent-pill"]);
		}
		this.popup.onHoverChange = (hovered) => {
			this.popupHovered = hovered;
			if (hovered) {
				this.enteredPopup = true;
			} else {
				onPopupLeave?.();
			}
		};
		const termCols = Math.max(24, tui.terminal?.columns ?? 80);
		const termRows = Math.max(8, tui.terminal?.rows ?? 30);

		/* Ограничиваем высоту миниатюры доступным пространством над/под якорем, чтобы попап не перекрывал строку самого чипа */
		const availAbove = Math.max(0, anchor.rowAbove);
		const availBelow =
			anchor.rowBelow !== undefined ? Math.max(0, termRows - anchor.rowBelow) : 0;
		const bestSpace = Math.max(availAbove, availBelow);
		const nonThumbEstimate = chip.kind === "image" ? (chip.filePath ? 6 : 5) : 0;
		const allowedThumbHeight =
			chip.kind === "image"
				? Math.max(0, Math.min(THUMB_MAX_HEIGHT_CELLS, bestSpace - nonThumbEstimate))
				: 0;

		const chipKey = anchor.key ?? `${source}:${chip.id}:${chip.token}`;
		if (this.activeChipKey !== chipKey) {
			this.popup.chip = undefined;
			this.enteredPopup = false;
		}
		this.popup.chip = chip;
		this.popup.setContext(source, actions ?? {}, allowedThumbHeight);

		const { width, height } = this.popup.computeDimensions(termCols);

		const clampedCol = Math.max(1, Math.min(anchor.col, Math.max(1, termCols - width - 1)));
		let row = anchor.rowAbove - height;
		if (row < 0 && anchor.rowBelow !== undefined && anchor.rowBelow + height <= termRows) {
			row = anchor.rowBelow;
		}
		const clampedRow = Math.max(0, Math.min(row, Math.max(0, termRows - height)));

		this.visible = true;
		this.activeSource = source;
		this.activeChipKey = chipKey;
		this.popupRect = { col: clampedCol, row: clampedRow, width, height };
		this.triggerBounds = anchor.triggerBounds;

		if (!this.options) {
			this.options = {
				nonCapturing: true,
				width,
				col: clampedCol,
				row: clampedRow,
				visible: () =>
					this.visible &&
					Boolean(this.activeTui) &&
					!hasBlockingModalOverlay(this.activeTui!),
			};
		} else {
			this.options.width = width;
			this.options.col = clampedCol;
			this.options.row = clampedRow;
		}

		if (!this.handle) {
			this.handle = tui.showOverlay(this.popup, this.options);
		} else {
			tui.requestRender();
		}
	}

	hide(onlySources?: readonly PreviewTriggerSource[]): void {
		if (onlySources && this.activeSource && !onlySources.includes(this.activeSource)) {
			return;
		}
		if (!this.visible && !this.handle) {
			return;
		}
		this.visible = false;
		this.popupHovered = false;
		this.enteredPopup = false;
		this.popupRect = undefined;
		this.triggerBounds = undefined;
		this.activeSource = undefined;
		this.activeChipKey = undefined;
		this.activeRenderer = undefined;
		const currentHandle = this.handle;
		this.handle = undefined;
		if (currentHandle) {
			try {
				currentHandle.hide();
			} catch {
				/* Уже скрыто хостом */
			}
		}
	}
}
