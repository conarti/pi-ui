import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	getThemeSurfacePalette,
	parseAnsiColorRgb,
	themeBgRgb,
	type RgbTuple,
} from "./ansi.ts";

export interface SelectedTranscriptLine {
	/** Полная исходная ANSI-строка документа до обрезки по колонкам выделения. */
	readonly fullLine: string;
	/** Выделенный ANSI-фрагмент строки. */
	readonly selectedAnsi: string;
	/** Начальная и конечная колонки выделения на этой строке. */
	readonly startCol: number;
	readonly endCol: number;
	/** Ширина контейнера контента (колонок) для точного распознавания мягкого переноса. */
	readonly contentWidth?: number;
}

export interface ExtractCleanSelectionOptions {
	/** Активная тема для распознавания `mdCode` и фонов карточек. */
	readonly theme?: Theme;
}

type SurfaceKind = "code-header" | "code-body" | "user-card" | "plain";

interface ParsedItem {
	readonly kind: "blank" | "code" | "blockquote" | "prose";
	readonly text: string;
	readonly screenWidth: number;
	readonly wrapWidth: number;
	readonly singleWord?: boolean;
	readonly codeJoinWith?: string;
}

const COPY_CHROME_MARK = "\x1b]9999;pi-ui-copy;chrome\x07";
const COPY_CODE_ROW_RE = /\x1b\]9999;pi-ui-copy;code;(\d+);(-?\d+)\x07/u;
const COPY_METADATA_RE = /\x1b\]9999;pi-ui-copy;(?:chrome|code;\d+;-?\d+)\x07/gu;

export function stripSelectionCopyMetadata(line: string): string {
	return line.replace(COPY_METADATA_RE, "");
}

export function markSelectionChrome(line: string): string {
	return line.replace(/^ */u, (padding) => padding + COPY_CHROME_MARK);
}

export function markSelectionCodeRow(line: string, contentWidth: number, gapBefore: number | undefined): string {
	return `\x1b]9999;pi-ui-copy;code;${contentWidth};${gapBefore ?? -1}\x07${line}`;
}

const COLLAPSED_THINKING_RE =
	/^(?:[✦◆❙┃•]\s*(?:›\s*)?)?(?:Thought(?:\s+for\s+\S+(?:\s+\S+)?)?|Thinking…)(?:\s+›)?$/u;
const RESPONSE_METRICS_RE =
	/^Worked for\s+\S+(?:\s+\S+)?(?:\s+·.*)?(?:\s+\d{1,2}\s+[A-Z][a-z]{2}(?:\s+\d{4})?,\s*\d{2}:\d{2}|\s+\d{2}:\d{2})?$/u;
const COPY_ACTION_ROW_RE =
	/^(?:(?:[a-z0-9_+#.-]+\s+)?(?:·\s*)?(?:\[?Copy\]?|✓\s*Copied)|\[Copy TSV\]\s+\[Copy CSV\]\s+\[Copy MD\])$/i;
const BOX_HORIZONTAL_BORDER_RE = /^[╭╰├┌└][─┬┴┼]+[╮╯┤┐┘]$/u;
const USER_CARD_TRAILING_TIME_RE =
	/\s{2,}(\d{1,2}\s+[A-Z][a-z]{2}(?:\s+\d{4})?,\s*\d{2}:\d{2}|\d{2}:\d{2}|Copy|✓\s*Copied)$/u;
const STRUCTURAL_LINE_START_RE = /^(?:#{1,6}\s|(?:[-*+•]|\d+[.)])\s|[│|┌├└─┬┼┴]|[-─═_*]{3,}$)/u;

function rgbMatches(a: RgbTuple | undefined, b: RgbTuple | undefined, tolerance = 14): boolean {
	if (!a || !b) return false;
	return (
		Math.abs(a[0] - b[0]) <= tolerance &&
		Math.abs(a[1] - b[1]) <= tolerance &&
		Math.abs(a[2] - b[2]) <= tolerance
	);
}

function extractFirstBgRgb(ansiLine: string): RgbTuple | undefined {
	if (!ansiLine.includes("\x1b[")) return undefined;
	const match = /\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/.exec(ansiLine);
	return match ? parseAnsiColorRgb(match[0]) : undefined;
}

function detectRowSurfaceKind(fullLine: string, theme?: Theme): SurfaceKind {
	const bgRgb = extractFirstBgRgb(fullLine);
	if (!bgRgb) return "plain";

	const palette = getThemeSurfacePalette(theme);
	const candidates: [SurfaceKind, RgbTuple][] = [
		["user-card", palette.userCardBg],
		["user-card", palette.userCardHoverBg],
		["code-body", palette.codeBodyBg],
		["code-header", palette.codeHeaderBg],
		["code-header", palette.codeHeaderActiveBg],
		["code-header", palette.codeFooterBg],
	];
	/* В 256 цветах фоны могут совпасть: плашка запроса начинается на внешней оси, код — на оси диалога. */
	const codeAxis = /^ {4}/u.test(fullLine);
	if (codeAxis) candidates.push(...candidates.splice(0, 2));
	for (const [kind, color] of candidates) {
		const rendered = extractFirstBgRgb(themeBgRgb(theme, color, " "));
		if (rgbMatches(bgRgb, rendered, 0)) return kind;
	}
	return "plain";
}

export function isCollapsedChromeRow(plainTrimmed: string): boolean {
	if (!plainTrimmed) return false;
	return (
		COLLAPSED_THINKING_RE.test(plainTrimmed) ||
		RESPONSE_METRICS_RE.test(plainTrimmed) ||
		COPY_ACTION_ROW_RE.test(plainTrimmed) ||
		BOX_HORIZONTAL_BORDER_RE.test(plainTrimmed)
	);
}

function wrapInlineCodeSegment(rawCode: string): string {
	const match = /^(\s*)(.*?)(\s*)$/s.exec(rawCode);
	const lead = match?.[1] ?? "";
	const core = match?.[2] ?? "";
	const tail = match?.[3] ?? "";
	if (!core) return rawCode;
	if (core.includes("`")) {
		const needsPad = core.startsWith("`") || core.endsWith("`");
		return `${lead}\`\`${needsPad ? ` ${core} ` : core}\`\`${tail}`;
	}
	return `${lead}\`${core}\`${tail}`;
}

/**
 * Восстанавливает обратные кавычки `` `inline code` `` по SGR-токену `mdCode` активной темы,
 * игнорируя цветные ссылки (подчёркнутые) и строки с фоном карточек/кода.
 */
export function restoreInlineCodeBackticks(
	ansiText: string,
	mdCodeRgb: RgbTuple | undefined,
): string {
	if (!mdCodeRgb || !ansiText.includes("\x1b[")) {
		return stripTerminalSequences(ansiText);
	}

	let currentFg: RgbTuple | undefined;
	let hasBg = false;
	let underlined = false;
	let inCode = false;
	let codeBuf = "";
	let out = "";

	const flushCode = () => {
		if (!codeBuf) return;
		out += wrapInlineCodeSegment(codeBuf);
		codeBuf = "";
	};

	const syncCodeState = () => {
		const nextInCode = Boolean(currentFg && rgbMatches(currentFg, mdCodeRgb, 6) && !hasBg && !underlined);
		if (inCode && !nextInCode) {
			flushCode();
		}
		inCode = nextInCode;
	};

	let i = 0;
	while (i < ansiText.length) {
		if (ansiText.charCodeAt(i) === 0x1b) {
			const next = ansiText[i + 1];
			if (next === "[") {
				const csi = /^\x1b\[([0-9;:?<=>]*)([A-Za-z])/.exec(ansiText.slice(i));
				if (csi) {
					if (csi[2] === "m" && !/^[?<=>]/.test(csi[1] ?? "")) {
						const raw = csi[1] ?? "";
						const tokens = raw.length === 0 ? ["0"] : raw.split(";");
						let k = 0;
						while (k < tokens.length) {
							const tok = tokens[k] ?? "";
							const num = Number(tok);
							if (num === 0) {
								currentFg = undefined;
								hasBg = false;
								underlined = false;
								k += 1;
							} else if (num === 4) {
								underlined = true;
								k += 1;
							} else if (num === 24) {
								underlined = false;
								k += 1;
							} else if (num === 39) {
								currentFg = undefined;
								k += 1;
							} else if (num === 49) {
								hasBg = false;
								k += 1;
							} else if ((num >= 40 && num <= 47) || (num >= 100 && num <= 107)) {
								hasBg = true;
								k += 1;
							} else if (num === 38) {
								const mode = Number(tokens[k + 1] ?? -1);
								if (mode === 5 && tokens[k + 2] !== undefined) {
									currentFg = parseAnsiColorRgb(`\x1b[38;5;${tokens[k + 2]}m`);
									k += 3;
								} else if (
									mode === 2 &&
									tokens[k + 2] !== undefined &&
									tokens[k + 3] !== undefined &&
									tokens[k + 4] !== undefined
								) {
									currentFg = [
										Number(tokens[k + 2]),
										Number(tokens[k + 3]),
										Number(tokens[k + 4]),
									];
									k += 5;
								} else {
									k += 1;
								}
							} else if (num === 48) {
								const mode = Number(tokens[k + 1] ?? -1);
								hasBg = true;
								if (mode === 5 && tokens[k + 2] !== undefined) {
									k += 3;
								} else if (mode === 2 && tokens[k + 4] !== undefined) {
									k += 5;
								} else {
									k += 1;
								}
							} else {
								k += 1;
							}
						}
						syncCodeState();
					}
					i += csi[0].length;
					continue;
				}
			} else if (next === "]") {
				const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(ansiText.slice(i));
				if (osc) {
					i += osc[0].length;
					continue;
				}
			} else if (next === "_") {
				const apc = /^\x1b_[^\x1b]*\x1b\\/.exec(ansiText.slice(i));
				if (apc) {
					i += apc[0].length;
					continue;
				}
			}
			i += Math.min(2, ansiText.length - i);
			continue;
		}

		const nextEsc = ansiText.indexOf("\x1b", i);
		const plainChunk = nextEsc === -1 ? ansiText.slice(i) : ansiText.slice(i, nextEsc);
		if (inCode) {
			codeBuf += plainChunk;
		} else {
			out += plainChunk;
		}
		i = nextEsc === -1 ? ansiText.length : nextEsc;
	}

	flushCode();
	return out;
}

function stripFrameAndRailPrefix(text: string): { text: string; isBlockquote: boolean } {
	let s = text.trimEnd();
	/* Симметричная рамка карточек/попапов `│ ... │` */
	const framed = /^\s*│\s?(.*?)\s?│\s*$/u.exec(s);
	if (framed) {
		return { text: framed[1]!.trim(), isBlockquote: false };
	}
	/* Цитаты и декоративные вертикальные полосы `│ ` / `▎ ` */
	const quoted = /^\s*[│▎]\s(.*)$/u.exec(s);
	if (quoted) {
		return { text: quoted[1]!.trimEnd(), isBlockquote: true };
	}
	s = s.replace(/^\s+/u, "");
	return { text: s, isBlockquote: false };
}

function shouldUnwrapProsePair(prev: ParsedItem, curr: ParsedItem): boolean {
	if (prev.kind !== curr.kind) return false;
	if (prev.kind !== "prose" && prev.kind !== "blockquote") return false;
	if (!prev.text || !curr.text) return false;
	if (STRUCTURAL_LINE_START_RE.test(curr.text)) return false;
	if (/^[│|┌├└─┬┼┴]|^[-─═_*]{3,}$/u.test(prev.text)) return false;

	const firstWord = curr.text.split(/\s+/u)[0] ?? "";
	const firstWordPlainWidth = visibleWidth(firstWord.replace(/`/g, ""));
	if (firstWordPlainWidth <= 0) return false;

	return prev.screenWidth + 1 + firstWordPlainWidth > prev.wrapWidth - 1;
}

function joinWrappedText(prevText: string, currText: string, prev: ParsedItem): string {
	const sep = prev.screenWidth >= prev.wrapWidth && prev.singleWord ? "" : " ";
	/* Склейка одного inline-code спана, перенесённого терминалом на следующую строку */
	if (prevText.endsWith("`") && currText.startsWith("`")) {
		return `${prevText.slice(0, -1)}${sep}${currText.slice(1)}`;
	}
	return `${prevText}${sep}${currText}`;
}

/**
 * Извлекает чистый текст из выделенных строк транскрипта:
 * - пропускает свёрнутые строки `✦` / `Thought for …` / `Worked for …` и шапки код-блоков при многострочном выделении;
 * - восстанавливает `` `inline code` `` обратные кавычки;
 * - склеивает мягкие переносы прозы без рамок и левых отступов, сохраняя абзацы, явные переносы и переносы строк в коде.
 */
export function extractCleanSelectionText(
	lines: readonly SelectedTranscriptLine[],
	options?: ExtractCleanSelectionOptions,
): string {
	if (lines.length === 0) return "";

	const theme = options?.theme;
	const mdCodeAnsi = (
		theme as { getFgAnsi?: (token: string) => string } | undefined
	)?.getFgAnsi?.("mdCode");
	const mdCodeRgb = parseAnsiColorRgb(mdCodeAnsi);

	const nonEmptyInputCount = lines.filter(
		(entry) => stripTerminalSequences(entry.selectedAnsi).trim().length > 0,
	).length;
	const isMultiLineSelection = nonEmptyInputCount > 1 || lines.length > 1;

	const parsed: ParsedItem[] = [];
	let promptWrapWidth: number | undefined;

	for (const entry of lines) {
		const codeRow = COPY_CODE_ROW_RE.exec(entry.fullLine);
		const markedChrome = entry.fullLine.includes(COPY_CHROME_MARK);
		if (isMultiLineSelection && markedChrome) continue;
		const surface = codeRow ? "code-body" : detectRowSurfaceKind(entry.fullLine, theme);
		const plainSelected = stripTerminalSequences(entry.selectedAnsi);
		const plainTrimmed = plainSelected.trim();
		const fullPlainTrimmed = stripTerminalSequences(entry.fullLine).trim();
		if (surface !== "user-card" || !fullPlainTrimmed) promptWrapWidth = undefined;

		if (surface === "code-body") {
			/* Две ячейки внутри цветного фона принадлежат карточке, а не коду. */
			const bgStart = entry.fullLine.search(/\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/u);
			const codeStart = visibleWidth(entry.fullLine.slice(0, bgStart)) + 2;
			const contentEnd = codeStart + Number(codeRow?.[1] ?? 0);
			const start = Math.max(codeStart, entry.startCol);
			const end = Math.min(contentEnd, entry.endCol);
			const gap = Number(codeRow?.[2] ?? -1);
			parsed.push({
				kind: "code",
				text: codeRow
					? sliceByColumn(plainSelected, start - entry.startCol, Math.max(0, end - start), true)
					: plainSelected.slice(Math.max(0, codeStart - entry.startCol)).trimEnd(),
				codeJoinWith: gap < 0 ? undefined : " ".repeat(Math.min(gap, 100_000)),
				screenWidth: 0,
				wrapWidth: 0,
			});
			continue;
		}

		if (!plainTrimmed) {
			parsed.push({ kind: "blank", text: "", screenWidth: 0, wrapWidth: 0 });
			continue;
		}

		if (isMultiLineSelection) {
			if (surface === "code-header") continue;
			if (surface === "plain" && isCollapsedChromeRow(fullPlainTrimmed)) {
				continue;
			}
			if (surface === "user-card" && (plainTrimmed === "Copy" || plainTrimmed === "✓ Copied")) {
				continue;
			}
		}

		const contentW = entry.contentWidth ?? Math.max(40, visibleWidth(entry.fullLine));

		if (surface === "user-card") {
			const firstRow = fullPlainTrimmed.startsWith("› ");
			const tail = firstRow ? USER_CARD_TRAILING_TIME_RE.exec(fullPlainTrimmed) : null;
			const margin = /^ */u.exec(entry.fullLine)?.[0].length ?? 0;
			const cardWidth = contentW - 2 * margin;
			const pad = 2;
			const innerWidth = cardWidth - pad - 2;
			if (firstRow) {
				const gutter = Math.max(8, visibleWidth(tail?.[1] ?? "")) + pad + 1;
				promptWrapWidth = innerWidth - gutter >= 10 ? innerWidth - gutter : innerWidth;
			}
			let cardText = plainSelected.trim();
			if (firstRow && entry.startCol <= 6 && cardText.startsWith("› ")) {
				cardText = cardText.slice(2);
			}
			if (tail) cardText = cardText.replace(USER_CARD_TRAILING_TIME_RE, "").trimEnd();
			if (!cardText) {
				parsed.push({ kind: "blank", text: "", screenWidth: 0, wrapWidth: 0 });
				continue;
			}
			const wrapW = Math.max(4, promptWrapWidth ?? innerWidth);
			const fullText = (tail ? fullPlainTrimmed.slice(0, tail.index) : fullPlainTrimmed)
				.replace(/^› /u, "");
			parsed.push({
				kind: "prose",
				text: cardText,
				screenWidth: visibleWidth(fullText),
				wrapWidth: wrapW,
				singleWord: !/\s/u.test(fullText),
			});
			continue;
		}

		const withBackticks = restoreInlineCodeBackticks(entry.selectedAnsi, mdCodeRgb);
		const cleaned = stripFrameAndRailPrefix(withBackticks);
		const fullCleaned = stripFrameAndRailPrefix(stripTerminalSequences(entry.fullLine));
		if (!cleaned.text) {
			parsed.push({ kind: "blank", text: "", screenWidth: 0, wrapWidth: 0 });
			continue;
		}

		const leftPad = Math.max(
			0,
			stripTerminalSequences(entry.fullLine).length -
				stripTerminalSequences(entry.fullLine).trimStart().length,
		);
		const horizontalPad = leftPad >= 4 ? leftPad * 2 : 4;
		const quoteExtra = fullCleaned.isBlockquote ? 2 : 0;
		const wrapW = Math.max(16, contentW - horizontalPad - quoteExtra);

		parsed.push({
			kind: fullCleaned.isBlockquote ? "blockquote" : "prose",
			text: cleaned.text,
			screenWidth: visibleWidth(fullCleaned.text),
			wrapWidth: wrapW,
			singleWord: !/\s/u.test(fullCleaned.text),
		});
	}

	const outputBlocks: string[] = [];
	let i = 0;

	while (i < parsed.length) {
		const item = parsed[i]!;
		if (item.kind === "blank") {
			i += 1;
			continue;
		}

		if (item.kind === "code") {
			const codeChunk: string[] = [item.text];
			i += 1;
			while (i < parsed.length && parsed[i]!.kind === "code") {
				const row = parsed[i++]!;
				codeChunk.push(row.codeJoinWith ?? "\n", row.text);
			}
			outputBlocks.push(codeChunk.join(""));
			continue;
		}

		const proseLines: string[] = [item.text];
		let prev = item;
		i += 1;

		while (i < parsed.length) {
			const curr = parsed[i]!;
			if (curr.kind === "blank" || curr.kind === "code") break;
			if (shouldUnwrapProsePair(prev, curr)) {
				const lastIdx = proseLines.length - 1;
				proseLines[lastIdx] = joinWrappedText(
					proseLines[lastIdx]!,
					curr.text,
					prev,
				);
			} else {
				proseLines.push(curr.text);
			}
			prev = curr;
			i += 1;
		}

		outputBlocks.push(proseLines.join("\n"));
	}

	return outputBlocks.join("\n\n");
}
