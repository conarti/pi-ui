import { visibleWidth } from "@earendil-works/pi-tui";
import type { FakeTui } from "./fake-tui.ts";

export type TerminalColor =
	| { kind: "default" }
	| { kind: "ansi"; code: number }
	| { kind: "palette256"; index: number }
	| { kind: "rgb"; r: number; g: number; b: number };

export interface TerminalCell {
	char: string;
	width: 0 | 1 | 2;
	fg: TerminalColor;
	bg: TerminalColor;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	hyperlink?: string;
}

export interface InlineImagePlacement {
	protocol: "kitty" | "iterm2";
	row: number;
	col: number;
	params: Record<string, string>;
	raw: string;
}

export interface TerminalScreenSnapshot {
	readonly width: number;
	readonly height: number;
	readonly cells: TerminalCell[][];
	readonly images: InlineImagePlacement[];
	cellAt(row: number, col: number): TerminalCell | undefined;
	rowText(row: number): string;
	sliceText(row: number, startCol: number, endCol?: number): string;
}

interface PenState {
	fg: TerminalColor;
	bg: TerminalColor;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	hyperlink?: string;
}

const DEFAULT_COLOR: TerminalColor = { kind: "default" };

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function createDefaultPen(): PenState {
	return {
		fg: DEFAULT_COLOR,
		bg: DEFAULT_COLOR,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		inverse: false,
		hyperlink: undefined,
	};
}

function createBlankCell(pen = createDefaultPen()): TerminalCell {
	return {
		char: " ",
		width: 1,
		fg: pen.fg,
		bg: pen.bg,
		bold: pen.bold,
		dim: pen.dim,
		italic: pen.italic,
		underline: pen.underline,
		inverse: pen.inverse,
		hyperlink: pen.hyperlink,
	};
}

function applySgrParams(pen: PenState, rawParams: string): void {
	const parts = rawParams.length === 0 ? [0] : rawParams.split(";").map((s) => (s === "" ? 0 : Number(s)));
	let i = 0;
	while (i < parts.length) {
		const code = parts[i] ?? 0;
		if (code === 0) {
			pen.fg = DEFAULT_COLOR;
			pen.bg = DEFAULT_COLOR;
			pen.bold = false;
			pen.dim = false;
			pen.italic = false;
			pen.underline = false;
			pen.inverse = false;
			i += 1;
		} else if (code === 1) {
			pen.bold = true;
			i += 1;
		} else if (code === 2) {
			pen.dim = true;
			i += 1;
		} else if (code === 3) {
			pen.italic = true;
			i += 1;
		} else if (code === 4) {
			pen.underline = true;
			i += 1;
		} else if (code === 7) {
			pen.inverse = true;
			i += 1;
		} else if (code === 22) {
			pen.bold = false;
			pen.dim = false;
			i += 1;
		} else if (code === 23) {
			pen.italic = false;
			i += 1;
		} else if (code === 24) {
			pen.underline = false;
			i += 1;
		} else if (code === 27) {
			pen.inverse = false;
			i += 1;
		} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
			pen.fg = { kind: "ansi", code };
			i += 1;
		} else if (code === 39) {
			pen.fg = DEFAULT_COLOR;
			i += 1;
		} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
			pen.bg = { kind: "ansi", code };
			i += 1;
		} else if (code === 49) {
			pen.bg = DEFAULT_COLOR;
			i += 1;
		} else if (code === 38 || code === 48) {
			const isFg = code === 38;
			const mode = parts[i + 1];
			if (mode === 5 && parts[i + 2] !== undefined) {
				const color: TerminalColor = { kind: "palette256", index: parts[i + 2]! };
				if (isFg) pen.fg = color;
				else pen.bg = color;
				i += 3;
			} else if (
				mode === 2 &&
				parts[i + 2] !== undefined &&
				parts[i + 3] !== undefined &&
				parts[i + 4] !== undefined
			) {
				const color: TerminalColor = {
					kind: "rgb",
					r: parts[i + 2]!,
					g: parts[i + 3]!,
					b: parts[i + 4]!,
				};
				if (isFg) pen.fg = color;
				else pen.bg = color;
				i += 5;
			} else {
				i += 1;
			}
		} else {
			i += 1;
		}
	}
}

function parseKeyValuePairs(header: string, separator: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header.split(separator)) {
		if (!part) continue;
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		out[part.slice(0, eq)] = part.slice(eq + 1);
	}
	return out;
}

/**
 * Декодирует массив ANSI-строк кадра TuiAltScreen в двумерную сетку ячеек терминала
 * с сохранением RGB/256/inverse-атрибутов, гиперссылок OSC 8 и inline-изображений Kitty/iTerm2.
 */
export function parseTerminalFrame(lines: string[], explicitWidth?: number): TerminalScreenSnapshot {
	const height = lines.length;
	const inferredWidth =
		explicitWidth ?? Math.max(0, ...lines.map((line) => visibleWidth(line)));
	const width = Math.max(1, inferredWidth);

	const cells: TerminalCell[][] = Array.from({ length: height }, () =>
		Array.from({ length: width }, () => createBlankCell()),
	);
	const images: InlineImagePlacement[] = [];

	for (let row = 0; row < height; row += 1) {
		const line = lines[row] ?? "";
		const pen = createDefaultPen();
		let col = 0;
		let idx = 0;

		while (idx < line.length) {
			if (line[idx] === "\x1b") {
				const next = line[idx + 1];

				/* Kitty APC: \x1b_G<params>;<payload>\x1b\\ */
				if (next === "_" && line[idx + 2] === "G") {
					const st = line.indexOf("\x1b\\", idx + 3);
					const end = st === -1 ? line.length : st + 2;
					const raw = line.slice(idx, end);
					const body = line.slice(idx + 3, st === -1 ? line.length : st);
					const semi = body.indexOf(";");
					const header = semi === -1 ? body : body.slice(0, semi);
					images.push({
						protocol: "kitty",
						row,
						col,
						params: parseKeyValuePairs(header, ","),
						raw,
					});
					idx = end;
					continue;
				}

				/* OSC: \x1b]...(\x07 | \x1b\\) */
				if (next === "]") {
					const bel = line.indexOf("\x07", idx + 2);
					const st = line.indexOf("\x1b\\", idx + 2);
					let termPos = -1;
					let termLen = 0;
					if (bel !== -1 && (st === -1 || bel < st)) {
						termPos = bel;
						termLen = 1;
					} else if (st !== -1) {
						termPos = st;
						termLen = 2;
					}
					const body = termPos === -1 ? line.slice(idx + 2) : line.slice(idx + 2, termPos);
					const end = termPos === -1 ? line.length : termPos + termLen;

					if (body.startsWith("8;")) {
						const secondSemi = body.indexOf(";", 2);
						if (secondSemi !== -1) {
							const uri = body.slice(secondSemi + 1);
							pen.hyperlink = uri.length > 0 ? uri : undefined;
						}
					} else if (body.startsWith("1337;File=")) {
						const headerAndData = body.slice("1337;File=".length);
						const colon = headerAndData.indexOf(":");
						const header = colon === -1 ? headerAndData : headerAndData.slice(0, colon);
						images.push({
							protocol: "iterm2",
							row,
							col,
							params: parseKeyValuePairs(header, ";"),
							raw: line.slice(idx, end),
						});
					}
					idx = end;
					continue;
				}

				/* CSI: \x1b[...<final> */
				if (next === "[") {
					let csiEnd = idx + 2;
					while (csiEnd < line.length && (line.charCodeAt(csiEnd) < 0x40 || line.charCodeAt(csiEnd) > 0x7e)) {
						csiEnd += 1;
					}
					const finalByte = line[csiEnd] ?? "";
					const params = line.slice(idx + 2, csiEnd);
					if (finalByte === "m") {
						applySgrParams(pen, params);
					}
					idx = Math.min(line.length, csiEnd + 1);
					continue;
				}

				idx += 2;
				continue;
			}

			const nextEsc = line.indexOf("\x1b", idx);
			const plainChunk = nextEsc === -1 ? line.slice(idx) : line.slice(idx, nextEsc);
			for (const seg of graphemeSegmenter.segment(plainChunk)) {
				const grapheme = seg.segment;
				if (grapheme === "\r" || grapheme === "\n") continue;
				const w = Math.max(0, Math.min(2, visibleWidth(grapheme))) as 0 | 1 | 2;
				if (w === 0) {
					if (col > 0 && col <= width && cells[row]![col - 1]) {
						cells[row]![col - 1]!.char += grapheme;
					}
					continue;
				}
				if (col >= width) break;
				cells[row]![col] = {
					char: grapheme,
					width: w,
					fg: pen.fg,
					bg: pen.bg,
					bold: pen.bold,
					dim: pen.dim,
					italic: pen.italic,
					underline: pen.underline,
					inverse: pen.inverse,
					hyperlink: pen.hyperlink,
				};
				if (w === 2 && col + 1 < width) {
					cells[row]![col + 1] = {
						char: "",
						width: 0,
						fg: pen.fg,
						bg: pen.bg,
						bold: pen.bold,
						dim: pen.dim,
						italic: pen.italic,
						underline: pen.underline,
						inverse: pen.inverse,
						hyperlink: pen.hyperlink,
					};
				}
				col += w;
			}
			idx = nextEsc === -1 ? line.length : nextEsc;
		}
	}

	return {
		width,
		height,
		cells,
		images,
		cellAt(row: number, col: number): TerminalCell | undefined {
			return cells[row]?.[col];
		},
		rowText(row: number): string {
			const lineCells = cells[row];
			if (!lineCells) return "";
			return lineCells.map((c) => (c.width === 0 ? "" : c.char)).join("");
		},
		sliceText(row: number, startCol: number, endCol = width): string {
			const lineCells = cells[row];
			if (!lineCells) return "";
			return lineCells
				.slice(Math.max(0, startCol), Math.min(width, endCol))
				.map((c) => (c.width === 0 ? "" : c.char))
				.join("");
		},
	};
}

export function captureTerminalScreen(
	tui: FakeTui,
	width = tui.terminal.columns,
	height = tui.terminal.rows,
): TerminalScreenSnapshot {
	const lines = tui.renderViewport(width, height);
	return parseTerminalFrame(lines, width);
}
