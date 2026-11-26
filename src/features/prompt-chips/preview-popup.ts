import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
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
	paintThemeSurfaceRow,
	type RgbTuple,
} from "../../shared/ansi.ts";
import { registerTransientHoverDismisser, unwrapHostTui } from "../../shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import type { SerializedPromptChip } from "./registry.ts";

const MAX_EXCERPT_LINES = 8;

export interface PreviewContentSpec {
	readonly title: string;
	readonly lines: Array<{ text: string; muted?: boolean }>;
	readonly allLines: Array<{ text: string; muted?: boolean }>;
	readonly scrollable: boolean;
}

export function buildChipPreviewSpec(chip: SerializedPromptChip): PreviewContentSpec {
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
			{ text: `File: ${chip.fileName}` },
			{ text: `Size: ${metaParts.join(" · ")}`, muted: true },
		];
		if (chip.filePath) {
			lines.push({ text: `Path: ${chip.filePath}`, muted: true });
		}
		return {
			title: `🖼 Image #${chip.number}`,
			lines,
			allLines: lines,
			scrollable: false,
		};
	}

	if (chip.kind === "paste") {
		const rawLines = (chip.previewText || "").replace(/\t/g, "  ").split("\n");
		const allLines: Array<{ text: string; muted?: boolean }> = rawLines.map((line) => ({
			text: line.length > 0 ? line : " ",
		}));
		const shown = allLines.slice(0, MAX_EXCERPT_LINES);
		const remaining = Math.max(chip.lineCount, rawLines.length) - shown.length;
		if (remaining > 0) {
			shown.push({ text: `… (+${remaining} more ${remaining === 1 ? "line" : "lines"})`, muted: true });
		}
		const unitLabel =
			chip.metric === "chars"
				? `${chip.charCount} ${chip.charCount === 1 ? "char" : "chars"}`
				: `${chip.lineCount} ${chip.lineCount === 1 ? "line" : "lines"}`;
		return {
			title: `📋 Pasted #${chip.number} · ${unitLabel}`,
			lines: shown.length > 0 ? shown : [{ text: " " }],
			allLines: allLines.length > 0 ? allLines : [{ text: " " }],
			scrollable: allLines.length > MAX_EXCERPT_LINES,
		};
	}

	const quoteLines = (chip.previewText || "").replace(/\t/g, "  ").split("\n");
	const allLines: Array<{ text: string; muted?: boolean }> = quoteLines.map((line) => ({
		text: line.length > 0 ? `│ ${line}` : "│",
	}));
	const shown = allLines.slice(0, MAX_EXCERPT_LINES);
	const remaining = Math.max(chip.lineCount, quoteLines.length) - shown.length;
	if (remaining > 0) {
		shown.push({ text: `… (+${remaining} more ${remaining === 1 ? "line" : "lines"})`, muted: true });
	}
	const unit = chip.lineCount === 1 ? "line" : "lines";
	return {
		title: `❝ Quote #${chip.number} · ${chip.lineCount} ${unit}`,
		lines: shown.length > 0 ? shown : [{ text: " " }],
		allLines: allLines.length > 0 ? allLines : [{ text: " " }],
		scrollable: allLines.length > MAX_EXCERPT_LINES,
	};
}

export class PromptChipPreviewPopup implements Component {
	private currentChip: SerializedPromptChip | undefined;
	scrollOffset = 0;
	onDismiss?: () => void;

	constructor(private readonly getTheme: () => Theme) {}

	get chip(): SerializedPromptChip | undefined {
		return this.currentChip;
	}

	set chip(next: SerializedPromptChip | undefined) {
		if (this.currentChip?.id !== next?.id || this.currentChip?.token !== next?.token) {
			this.scrollOffset = 0;
		}
		this.currentChip = next;
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta && this.currentChip) {
			const spec = buildChipPreviewSpec(this.currentChip);
			if (spec.scrollable) {
				const maxScroll = Math.max(0, spec.allLines.length - MAX_EXCERPT_LINES);
				const next = Math.max(0, Math.min(maxScroll, this.scrollOffset + event.wheelDelta));
				const changed = next !== this.scrollOffset;
				this.scrollOffset = next;
				return { handled: true, render: changed };
			}
			return undefined;
		}
		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			this.onDismiss?.();
			return { handled: true, render: true };
		}
		return undefined;
	}

	computeDimensions(termCols: number): { width: number; height: number } {
		if (!this.currentChip) return { width: 24, height: 3 };
		const spec = buildChipPreviewSpec(this.currentChip);
		const maxAllowed = Math.max(20, Math.min(68, termCols - 4));
		const naturalInner = Math.max(
			visibleWidth(spec.title) + 4,
			...spec.allLines.map((l) => visibleWidth(l.text) + 2),
		);
		const width = Math.max(20, Math.min(maxAllowed, naturalInner + 2));
		const visibleRows = spec.scrollable ? MAX_EXCERPT_LINES + 1 : spec.lines.length;
		const height = visibleRows + 2;
		return { width, height };
	}

	render(width: number): string[] {
		if (!this.currentChip) return [];
		const theme = this.getTheme();
		const light = isLightTheme(theme);
		const palette = getThemeSurfacePalette(theme);
		const safeWidth = Math.max(12, width);
		const innerSpan = Math.max(2, safeWidth - 2);
		const textWidth = Math.max(1, safeWidth - 4);

		const borderRgb: RgbTuple = light ? [148, 163, 184] : [72, 88, 112];
		const titleRgb: RgbTuple = light ? [29, 78, 216] : [125, 207, 255];
		const textRgb: RgbTuple = light ? [15, 23, 42] : [220, 232, 248];
		const mutedRgb: RgbTuple = light ? [100, 116, 139] : [136, 152, 176];
		const popupBg = palette.popupSurfaceBg;

		const spec = buildChipPreviewSpec(this.currentChip);
		const b = (s: string) => fgRgb(borderRgb, s);

		let renderRows: Array<{ text: string; muted?: boolean }>;
		if (spec.scrollable) {
			const maxScroll = Math.max(0, spec.allLines.length - MAX_EXCERPT_LINES);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			const windowRows = spec.allLines.slice(this.scrollOffset, this.scrollOffset + MAX_EXCERPT_LINES);
			const remainingBelow = Math.max(
				0,
				spec.allLines.length - (this.scrollOffset + windowRows.length),
			);
			const statusParts: string[] = [];
			if (this.scrollOffset > 0) statusParts.push(`↑ ${this.scrollOffset}`);
			if (remainingBelow > 0) {
				statusParts.push(`… (+${remainingBelow} more ${remainingBelow === 1 ? "line" : "lines"})`);
			}
			renderRows = [
				...windowRows,
				{
					text: statusParts.length > 0 ? statusParts.join(" · ") : "End of preview",
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
		for (const row of renderRows) {
			const clipped = truncateToWidth(row.text, textWidth, "…");
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(clipped)));
			const colored = fgRgb(row.muted ? mutedRgb : textRgb, `${clipped}${pad}`);
			out.push(paintThemeSurfaceRow(theme, `${b("│")} ${colored} ${b("│")}`, safeWidth, popupBg));
		}

		out.push(
			paintThemeSurfaceRow(theme, `${b("╰")}${b("─".repeat(innerSpan))}${b("╯")}`, safeWidth, popupBg),
		);
		return out;
	}
}

export type PreviewTriggerSource = "composer-hover" | "composer-caret" | "sent-pill";

export class PromptChipOverlayController {
	private popup: PromptChipPreviewPopup | undefined;
	private handle: OverlayHandle | undefined;
	private options: OverlayOptions | undefined;
	private visible = false;
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
		anchor: { col: number; rowAbove: number; rowBelow?: number },
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
		this.popup.chip = chip;

		const termCols = Math.max(24, tui.terminal?.columns ?? 80);
		const termRows = Math.max(8, tui.terminal?.rows ?? 30);
		const { width, height } = this.popup.computeDimensions(termCols);

		const clampedCol = Math.max(1, Math.min(anchor.col, Math.max(1, termCols - width - 1)));
		let row = anchor.rowAbove - height;
		if (row < 0 && anchor.rowBelow !== undefined && anchor.rowBelow + height <= termRows) {
			row = anchor.rowBelow;
		}
		const clampedRow = Math.max(0, Math.min(row, Math.max(0, termRows - height)));

		this.visible = true;
		this.activeSource = source;
		this.activeChipKey = `${source}:${chip.id}:${chip.token}`;

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
