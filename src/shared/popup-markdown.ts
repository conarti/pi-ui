import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	stripTerminalSequences,
	visibleWidth,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { isLightTheme, themeFgRgb, type RgbTuple } from "./ansi.ts";

const LEADING_YAML_FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n+|$)/;
const TABLE_DELIMITER_LINE_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m;
const BLOCK_MD_SYNTAX_RE =
	/(?:^|\n)[ \t]{0,3}(?:#{1,6}\s+|(?:```|~~~)|[-*+]\s+\S|\d+\.\s+\S|>\s*\S|(?:---+|_{3,}|\*{3,})[ \t]*(?:\n|$))/;
const INLINE_MD_SYNTAX_RE =
	/`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\n]+\)|(?:^|[\s(])\*[^\s*][^*\n]*\*(?=[\s).,!?:;]|$)/;

export interface PopupMarkdownOptions {
	readonly quoteRail?: boolean;
	readonly stripYamlFrontmatter?: boolean;
}

interface CacheEntry {
	readonly key: string;
	readonly lines: readonly string[];
}

const renderCache: CacheEntry[] = [];
const MAX_CACHE_ENTRIES = 8;

/**
 * Определяет, содержит ли вставленный или процитированный фрагмент разметку Markdown
 * (GFM-таблицы, заголовки, списки, цитаты, код, ссылки или выделение), чтобы обычный
 * многострочный лог/код без разметки сохранял буквальные отступы.
 */
export function hasMarkdownFormatting(text: string): boolean {
	if (!text) return false;
	const norm = text.replace(/\r\n?/g, "\n");
	return (
		TABLE_DELIMITER_LINE_RE.test(norm) ||
		BLOCK_MD_SYNTAX_RE.test(norm) ||
		INLINE_MD_SYNTAX_RE.test(norm)
	);
}

/**
 * Измеряет естественную видимую ширину строки после `Markdown.render()`,
 * отбрасывая хвостовые пробелы выравнивания контейнера, но сохраняя рамки таблиц `│`.
 */
export function measurePopupLineNaturalWidth(line: string): number {
	const plain = stripTerminalSequences(line).replace(/ +$/u, "");
	return visibleWidth(plain);
}

function buildBoundMarkdownTheme(theme: Theme): MarkdownTheme {
	const base = getMarkdownTheme();
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		underline: (text) => theme.underline(text),
		strikethrough: (text) => theme.strikethrough(text),
		highlightCode: base.highlightCode,
	};
}

/**
 * Рендерит Markdown (GFM-таблицы, заголовки, списки, inline code и блоки кода с подсветкой)
 * внутри попапов чипов (`paste`, `quote`) и навыков (`SKILL.md`), сохраняя переносы строк.
 */
export function renderPopupMarkdownLines(
	sourceText: string,
	width: number,
	theme: Theme,
	options?: PopupMarkdownOptions,
): string[] {
	const safeWidth = Math.max(8, Math.floor(width));
	const quoteRail = Boolean(options?.quoteRail);
	const innerWidth = quoteRail ? Math.max(4, safeWidth - 2) : safeWidth;
	const normalized = (
		options?.stripYamlFrontmatter
			? sourceText.replace(LEADING_YAML_FRONTMATTER_RE, "")
			: sourceText
	)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ");

	if (normalized.trim().length === 0) {
		return [quoteRail ? theme.fg("mdQuoteBorder", "│") : " "];
	}

	const lightFlag = isLightTheme(theme) ? "L" : "D";
	const themeProbe = theme.fg("mdHeading", "H") + theme.fg("text", "T");
	const cacheKey = `${lightFlag}:${quoteRail ? 1 : 0}:${innerWidth}:${themeProbe}:${normalized}`;
	const hit = renderCache.find((entry) => entry.key === cacheKey);
	if (hit) {
		return [...hit.lines];
	}

	const md = new Markdown(
		normalized,
		0,
		0,
		buildBoundMarkdownTheme(theme),
		{ color: (s) => theme.fg("text", s) },
	);
	const rawRendered = md.render(innerWidth);

	let endIdx = rawRendered.length;
	while (endIdx > 1 && stripTerminalSequences(rawRendered[endIdx - 1] ?? "").trim() === "") {
		endIdx -= 1;
	}
	const trimmed = rawRendered.slice(0, endIdx);
	const railPrefix = quoteRail ? `${theme.fg("mdQuoteBorder", "│")} ` : "";
	const railBlank = quoteRail ? theme.fg("mdQuoteBorder", "│") : " ";

	const out =
		trimmed.length > 0
			? trimmed.map((line) => {
					const isBlank = stripTerminalSequences(line).trim().length === 0;
					if (isBlank) return railBlank;
					return quoteRail ? `${railPrefix}${line}` : line;
				})
			: [railBlank];

	if (renderCache.length >= MAX_CACHE_ENTRIES) {
		renderCache.shift();
	}
	renderCache.push({ key: cacheKey, lines: out });
	return [...out];
}

/**
 * Применяет базовый цвет текста попапа вокруг ANSI-спанов Markdown, восстанавливая его после `\x1b[39m` и `\x1b[0m`.
 */
export function paintPopupMarkdownCell(
	content: string,
	baseFgRgb: RgbTuple,
	theme: unknown,
): string {
	const fgPrefix = themeFgRgb(theme, baseFgRgb, "").replace(/\x1b\[39m$/, "");
	const patched = content
		.replace(/\x1b\[0m/g, `\x1b[0m${fgPrefix}`)
		.replace(/\x1b\[39m/g, fgPrefix);
	return `${fgPrefix}${patched}\x1b[39m`;
}
