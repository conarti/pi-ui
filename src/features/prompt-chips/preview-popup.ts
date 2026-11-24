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
	paintSurfaceRow,
	type RgbTuple,
} from "../../shared/ansi.ts";
import {
	formatPromptChipToken,
	type PromptChipEntry,
	type SerializedPromptChip,
} from "./registry.ts";

const MAX_EXCERPT_LINES = 8;

export function entryToSerializedChip(entry: PromptChipEntry, number: number): SerializedPromptChip {
	const token = formatPromptChipToken(entry, number);
	if (entry.kind === "image") {
		return {
			id: entry.id,
			kind: "image",
			number,
			token,
			filePath: entry.filePath,
			fileName: entry.fileName,
			mimeType: entry.mimeType,
			byteLength: entry.byteLength,
			...(entry.widthPx !== undefined ? { widthPx: entry.widthPx } : {}),
			...(entry.heightPx !== undefined ? { heightPx: entry.heightPx } : {}),
		};
	}
	if (entry.kind === "paste") {
		return {
			id: entry.id,
			kind: "paste",
			number,
			token,
			lineCount: entry.lineCount,
			charCount: entry.charCount,
			metric: entry.metric,
			previewText: entry.text,
		};
	}
	return {
		id: entry.id,
		kind: "quote",
		number,
		token,
		lineCount: entry.lineCount,
		charCount: entry.charCount,
		...(entry.sourceLabel ? { sourceLabel: entry.sourceLabel } : {}),
		previewText: entry.text,
	};
}

export interface PreviewContentSpec {
	readonly title: string;
	readonly lines: Array<{ text: string; muted?: boolean }>;
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
		};
	}

	if (chip.kind === "paste") {
		const rawLines = (chip.previewText || "").replace(/\t/g, "  ").split("\n");
		const shown: Array<{ text: string; muted?: boolean }> = rawLines
			.slice(0, MAX_EXCERPT_LINES)
			.map((line) => ({
				text: line.length > 0 ? line : " ",
			}));
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
		};
	}

	const quoteLines = (chip.previewText || "").replace(/\t/g, "  ").split("\n");
	const shown: Array<{ text: string; muted?: boolean }> = quoteLines
		.slice(0, MAX_EXCERPT_LINES)
		.map((line) => ({
			text: line.length > 0 ? `│ ${line}` : "│",
		}));
	const remaining = Math.max(chip.lineCount, quoteLines.length) - shown.length;
	if (remaining > 0) {
		shown.push({ text: `… (+${remaining} more ${remaining === 1 ? "line" : "lines"})`, muted: true });
	}
	const unit = chip.lineCount === 1 ? "line" : "lines";
	return {
		title: `❝ Quote #${chip.number} · ${chip.lineCount} ${unit}`,
		lines: shown.length > 0 ? shown : [{ text: " " }],
	};
}

export class PromptChipPreviewPopup implements Component {
	chip: SerializedPromptChip | undefined;
	onDismiss?: () => void;

	constructor(private readonly getTheme: () => Theme) {}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
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
		if (!this.chip) return { width: 24, height: 3 };
		const spec = buildChipPreviewSpec(this.chip);
		const maxAllowed = Math.max(20, Math.min(68, termCols - 4));
		const naturalInner = Math.max(
			visibleWidth(spec.title) + 4,
			...spec.lines.map((l) => visibleWidth(l.text) + 2),
		);
		const width = Math.max(20, Math.min(maxAllowed, naturalInner + 2));
		const height = spec.lines.length + 2;
		return { width, height };
	}

	render(width: number): string[] {
		if (!this.chip) return [];
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
		const [bgR, bgG, bgB] = palette.surfaceBg;

		const spec = buildChipPreviewSpec(this.chip);
		const b = (s: string) => fgRgb(borderRgb, s);

		const clippedTitle = truncateToWidth(` ${spec.title} `, Math.max(1, innerSpan - 2), "…");
		const titleW = visibleWidth(clippedTitle);
		const rightDashes = Math.max(0, innerSpan - 1 - titleW);
		const topRow = paintSurfaceRow(
			`${b("╭─")}${fgRgb(titleRgb, clippedTitle)}${b("─".repeat(rightDashes))}${b("╮")}`,
			safeWidth,
			bgR,
			bgG,
			bgB,
		);

		const out: string[] = [topRow];
		for (const row of spec.lines) {
			const clipped = truncateToWidth(row.text, textWidth, "…");
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(clipped)));
			const colored = fgRgb(row.muted ? mutedRgb : textRgb, `${clipped}${pad}`);
			out.push(paintSurfaceRow(`${b("│")} ${colored} ${b("│")}`, safeWidth, bgR, bgG, bgB));
		}

		out.push(
			paintSurfaceRow(`${b("╰")}${b("─".repeat(innerSpan))}${b("╯")}`, safeWidth, bgR, bgG, bgB),
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

	constructor(private readonly getTheme: () => Theme) {}

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
		if (!tui || (tui as unknown as { getTopmostVisibleOverlay?: () => unknown }).getTopmostVisibleOverlay?.()) {
			this.hide();
			return;
		}

		if (this.activeTui && this.activeTui !== tui) {
			this.hide();
		}
		this.activeTui = tui;

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
					!(this.activeTui as unknown as { getTopmostVisibleOverlay?: () => unknown }).getTopmostVisibleOverlay?.(),
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
