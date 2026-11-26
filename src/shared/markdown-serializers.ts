export interface MarkdownInlineTokenLike {
	readonly type?: string;
	readonly text?: string;
	readonly raw?: string;
	readonly href?: string;
	readonly tokens?: readonly MarkdownInlineTokenLike[];
}

export interface MarkdownTableCellLike {
	readonly text?: string;
	readonly tokens?: readonly MarkdownInlineTokenLike[];
}

export interface MarkdownTableToken {
	readonly align?: ReadonlyArray<"left" | "center" | "right" | null | undefined>;
	readonly header: readonly MarkdownTableCellLike[];
	readonly rows: ReadonlyArray<readonly MarkdownTableCellLike[]>;
}

function decodeBasicHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
}

function flattenInlineTokens(tokens: readonly MarkdownInlineTokenLike[]): string {
	let out = "";
	for (const tok of tokens) {
		if (!tok) continue;
		if (tok.type === "br") {
			out += " ";
		} else if (tok.type === "codespan") {
			out += decodeBasicHtmlEntities(String(tok.text ?? ""));
		} else if (Array.isArray(tok.tokens) && tok.tokens.length > 0) {
			out += flattenInlineTokens(tok.tokens);
		} else if (typeof tok.text === "string") {
			out += decodeBasicHtmlEntities(tok.text);
		} else if (typeof tok.raw === "string") {
			out += decodeBasicHtmlEntities(tok.raw);
		}
	}
	return out;
}

export function extractTableCellPlainText(cell: MarkdownTableCellLike | undefined): string {
	if (!cell) return "";
	if (Array.isArray(cell.tokens) && cell.tokens.length > 0) {
		return flattenInlineTokens(cell.tokens).replace(/\s*\r?\n\s*/g, " ").trim();
	}
	return decodeBasicHtmlEntities(String(cell.text ?? ""))
		.replace(/\s*\r?\n\s*/g, " ")
		.trim();
}

function sanitizeTsvCell(value: string): string {
	return value.replace(/[\t\r\n]+/g, " ");
}

function escapeCsvCell(value: string): string {
	if (/[",\r\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

function sanitizeMdTableCell(cell: MarkdownTableCellLike | undefined): string {
	const raw = decodeBasicHtmlEntities(String(cell?.text ?? ""))
		.replace(/\r?\n/g, "<br>")
		.trim();
	return raw.replace(/(?<!\\)\|/g, "\\|");
}

function formatMdAlignCell(align: "left" | "center" | "right" | null | undefined): string {
	if (align === "left") return ":---";
	if (align === "center") return ":---:";
	if (align === "right") return "---:";
	return "---";
}

export function serializeMarkdownTableToTsv(table: MarkdownTableToken): string {
	const rows: string[] = [];
	rows.push(table.header.map((c) => sanitizeTsvCell(extractTableCellPlainText(c))).join("\t"));
	for (const row of table.rows) {
		rows.push(row.map((c) => sanitizeTsvCell(extractTableCellPlainText(c))).join("\t"));
	}
	return rows.join("\n");
}

export function serializeMarkdownTableToCsv(table: MarkdownTableToken): string {
	const rows: string[] = [];
	rows.push(table.header.map((c) => escapeCsvCell(extractTableCellPlainText(c))).join(","));
	for (const row of table.rows) {
		rows.push(row.map((c) => escapeCsvCell(extractTableCellPlainText(c))).join(","));
	}
	return rows.join("\n");
}

export function serializeMarkdownTableToMd(table: MarkdownTableToken): string {
	const colCount = Math.max(
		table.header.length,
		...table.rows.map((r) => r.length),
	);
	const formatRow = (cells: readonly MarkdownTableCellLike[]): string => {
		const out: string[] = [];
		for (let i = 0; i < colCount; i += 1) {
			out.push(sanitizeMdTableCell(cells[i]));
		}
		return `| ${out.join(" | ")} |`;
	};

	const alignRow = `| ${Array.from({ length: colCount }, (_, i) =>
		formatMdAlignCell(table.align?.[i]),
	).join(" | ")} |`;

	const lines: string[] = [formatRow(table.header), alignRow];
	for (const row of table.rows) {
		lines.push(formatRow(row));
	}
	return lines.join("\n");
}

/**
 * Снимает один внешний маркер `>` (и опциональный пробел после него) с каждой строки цитаты,
 * сохраняя Markdown-форматирование, ссылки, inline-код и вложенные уровни `>`.
 */
export function stripBlockquoteMarkers(rawBlockquote: string): string {
	const normalized = rawBlockquote.replace(/\r\n?/g, "\n");
	const strippedLines = normalized
		.split("\n")
		.map((line) => line.replace(/^[ \t]{0,3}> ?/, ""));

	let start = 0;
	while (start < strippedLines.length && strippedLines[start]!.trim() === "") {
		start += 1;
	}
	let end = strippedLines.length;
	while (end > start && strippedLines[end - 1]!.trim() === "") {
		end -= 1;
	}
	if (start >= end) return "";
	return strippedLines
		.slice(start, end)
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n");
}
