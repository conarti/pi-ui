import {
	findPromptChipSpans,
	normalizePastedPlainText,
	type PromptChipRegistry,
	type QuotePromptChipData,
} from "../prompt-chips/registry.ts";

export function normalizeQuoteText(raw: string): string {
	const plain = normalizePastedPlainText(raw).replace(/^\n+|\n+$/g, "");
	return plain.trim().length === 0 ? "" : plain;
}

export function parseQuoteTargetNumber(rawToken: string | undefined): number | undefined {
	if (!rawToken) return undefined;
	const match = /^(?:q|#)?(\d+)$/i.exec(rawToken.trim());
	if (!match) return undefined;
	const n = Number.parseInt(match[1]!, 10);
	return Number.isInteger(n) && n >= 1 ? n : undefined;
}

export type AssistantQuoteExtractionResult =
	| {
			readonly ok: true;
			readonly text: string;
			readonly nthFromEnd: number;
			readonly sourceLabel: string;
			readonly totalReplies: number;
	  }
	| {
			readonly ok: false;
			readonly reason: "empty_history" | "invalid_arg" | "out_of_range";
			readonly totalReplies: number;
			readonly requested?: number;
	  };

function extractSingleAssistantMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as { role?: unknown; content?: unknown };
	if (msg.role !== "assistant") return "";
	if (typeof msg.content === "string") {
		return normalizeQuoteText(msg.content);
	}
	if (!Array.isArray(msg.content)) return "";
	const parts: string[] = [];
	for (const block of msg.content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			const cleaned = normalizeQuoteText((block as { text: string }).text);
			if (cleaned) parts.push(cleaned);
		}
	}
	return parts.join("\n\n");
}

export function extractAssistantQuoteFromBranch(
	branch: readonly unknown[],
	rawArg: string,
): AssistantQuoteExtractionResult {
	const replies: string[] = [];
	for (const rawEntry of branch) {
		if (!rawEntry || typeof rawEntry !== "object") continue;
		const entry = rawEntry as { type?: unknown; message?: unknown; role?: unknown };
		const candidate = entry.type === "message" ? entry.message : entry.role === "assistant" ? entry : undefined;
		const text = extractSingleAssistantMessageText(candidate);
		if (text) replies.push(text);
	}

	if (replies.length === 0) {
		return {
			ok: false,
			reason: "empty_history",
			totalReplies: 0,
		};
	}

	const trimmedArg = rawArg.trim().toLowerCase();
	let nthFromEnd = 1;
	if (trimmedArg !== "" && trimmedArg !== "last") {
		if (!/^\d+$/.test(trimmedArg)) {
			return {
				ok: false,
				reason: "invalid_arg",
				totalReplies: replies.length,
			};
		}
		nthFromEnd = Number.parseInt(trimmedArg, 10);
		if (!Number.isInteger(nthFromEnd) || nthFromEnd < 1) {
			return {
				ok: false,
				reason: "invalid_arg",
				totalReplies: replies.length,
			};
		}
		if (nthFromEnd > replies.length) {
			return {
				ok: false,
				reason: "out_of_range",
				totalReplies: replies.length,
				requested: nthFromEnd,
			};
		}
	}

	const targetText = replies[replies.length - nthFromEnd]!;
	return {
		ok: true,
		text: targetText,
		nthFromEnd,
		sourceLabel: `reply -${nthFromEnd}`,
		totalReplies: replies.length,
	};
}

export interface ActiveDraftQuoteItem {
	readonly number: number;
	readonly token: string;
	readonly entry: QuotePromptChipData;
}

export function listActiveDraftQuotes(
	registry: PromptChipRegistry,
	draftText: string,
): ActiveDraftQuoteItem[] {
	if (!draftText) return [];
	const synced = registry.syncDraft(draftText);
	const seenNumbers = new Set<number>();
	const items: ActiveDraftQuoteItem[] = [];
	for (const span of findPromptChipSpans(synced)) {
		if (span.kind !== "quote" || seenNumbers.has(span.number)) continue;
		const resolved = registry.resolveChip("quote", span.number);
		if (resolved && resolved.kind === "quote") {
			seenNumbers.add(span.number);
			items.push({
				number: span.number,
				token: span.token,
				entry: resolved,
			});
		}
	}
	return items;
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSpecificTokensFromDraft(draftText: string, tokens: readonly string[]): string {
	if (!draftText || tokens.length === 0) return draftText;
	const unique = [...new Set(tokens)].filter(Boolean);
	if (unique.length === 0) return draftText;
	const alt = unique.map(escapeRegExp).join("|");
	const pattern = new RegExp(`( ?)(?:${alt})(?: ?(?:${alt}))*( ?)`, "g");

	return draftText
		.split("\n")
		.map((line) =>
			line.replace(pattern, (full, lead: string, trail: string, offset: number) => {
				if (lead === " " && trail === " ") return " ";
				if (offset === 0 && trail === " ") return "";
				if (offset + full.length === line.length && lead === " ") return "";
				return `${lead}${trail}`;
			}),
		)
		.join("\n");
}

export interface EditDraftQuoteResult {
	readonly found: boolean;
	readonly removed: boolean;
	readonly draftText: string;
	readonly updatedToken?: string;
}

export function editDraftQuote(
	registry: PromptChipRegistry,
	draftText: string,
	quoteNumber: number,
	nextRawText: string,
): EditDraftQuoteResult {
	const active = listActiveDraftQuotes(registry, draftText);
	const target = active.find((item) => item.number === quoteNumber);
	if (!target) {
		return {
			found: false,
			removed: false,
			draftText,
		};
	}

	const normalizedNext = normalizeQuoteText(nextRawText);
	if (!normalizedNext) {
		const stripped = stripSpecificTokensFromDraft(draftText, [target.token]);
		const synced = registry.syncDraft(stripped);
		return {
			found: true,
			removed: true,
			draftText: synced,
		};
	}

	const replaced = registry.replaceQuoteAtNumber(quoteNumber, normalizedNext, target.entry.sourceLabel);
	if (!replaced) {
		return {
			found: false,
			removed: false,
			draftText,
		};
	}

	const nextDraft = draftText.split(target.token).join(replaced.token);
	const synced = registry.syncDraft(nextDraft);
	return {
		found: true,
		removed: false,
		draftText: synced,
		updatedToken: replaced.token,
	};
}

export interface RemoveDraftQuoteResult {
	readonly removed: boolean;
	readonly draftText: string;
}

export function removeDraftQuote(
	registry: PromptChipRegistry,
	draftText: string,
	quoteNumber: number,
): RemoveDraftQuoteResult {
	const active = listActiveDraftQuotes(registry, draftText);
	const target = active.find((item) => item.number === quoteNumber);
	if (!target) {
		return {
			removed: false,
			draftText,
		};
	}
	const stripped = stripSpecificTokensFromDraft(draftText, [target.token]);
	const synced = registry.syncDraft(stripped);
	return {
		removed: true,
		draftText: synced,
	};
}

export interface ClearAllDraftQuotesResult {
	readonly removedCount: number;
	readonly draftText: string;
}

export function clearAllDraftQuotes(
	registry: PromptChipRegistry,
	draftText: string,
): ClearAllDraftQuotesResult {
	const active = listActiveDraftQuotes(registry, draftText);
	if (active.length === 0) {
		return {
			removedCount: 0,
			draftText,
		};
	}
	const stripped = stripSpecificTokensFromDraft(
		draftText,
		active.map((item) => item.token),
	);
	const synced = registry.syncDraft(stripped);
	return {
		removedCount: active.length,
		draftText: synced,
	};
}

export interface SelectionQuotePopupAnchorParams {
	readonly popupWidth: number;
	readonly popupHeight: number;
	readonly focusCol: number;
	readonly focusRow: number;
	readonly anchorCol?: number;
	readonly anchorRow?: number;
	readonly viewportTop: number;
	readonly viewportBottom: number;
	readonly stickyBottom?: number;
	readonly termCols: number;
	readonly rightReservedCols?: number;
}

export function computeSelectionQuotePopupAnchor(
	params: SelectionQuotePopupAnchorParams,
): { readonly col: number; readonly row: number } {
	const popupWidth = Math.max(1, Math.floor(params.popupWidth));
	const popupHeight = Math.max(1, Math.floor(params.popupHeight));
	const termCols = Math.max(popupWidth, Math.floor(params.termCols));
	const rightReserved = Math.max(0, Math.floor(params.rightReservedCols ?? 0));

	const maxRightEdge = Math.max(popupWidth, termCols - rightReserved);
	const minCol = termCols > popupWidth + 1 ? 1 : 0;
	const maxCol = Math.max(minCol, maxRightEdge - popupWidth);
	const desiredCol = Math.floor(params.focusCol - popupWidth / 2);
	const col = Math.max(minCol, Math.min(desiredCol, maxCol));

	const stickyBottom = Math.max(params.viewportTop, Math.floor(params.stickyBottom ?? params.viewportTop));
	const viewportBottom = Math.max(params.viewportTop + popupHeight, Math.floor(params.viewportBottom));
	const minRow = viewportBottom - stickyBottom >= popupHeight ? stickyBottom : Math.max(0, params.viewportTop);
	const maxRow = Math.max(minRow, viewportBottom - popupHeight);

	const draggedUpward =
		params.anchorRow !== undefined &&
		(params.focusRow < params.anchorRow ||
			(params.focusRow === params.anchorRow &&
				params.anchorCol !== undefined &&
				params.focusCol < params.anchorCol));

	const rowAbove = params.focusRow - popupHeight;
	const rowBelow = params.focusRow + 1;

	let row: number;
	if (draggedUpward) {
		if (rowAbove >= minRow && rowAbove <= maxRow) {
			row = rowAbove;
		} else if (rowBelow >= minRow && rowBelow <= maxRow) {
			row = rowBelow;
		} else {
			row = Math.max(minRow, Math.min(params.focusRow, maxRow));
		}
	} else {
		if (rowBelow >= minRow && rowBelow <= maxRow) {
			row = rowBelow;
		} else if (rowAbove >= minRow && rowAbove <= maxRow) {
			row = rowAbove;
		} else {
			row = Math.max(minRow, Math.min(params.focusRow, maxRow));
		}
	}

	/* В верхних строках (0..3) TuiAltScreen рисует правый верхний тост Copied! поверх оверлеев */
	const flashSafeRightEdge =
		row <= 3 && termCols >= popupWidth + 18
			? Math.min(maxRightEdge, termCols - 15)
			: maxRightEdge;
	const effectiveMaxCol = Math.max(minCol, flashSafeRightEdge - popupWidth);
	const safeCol = Math.max(minCol, Math.min(col, effectiveMaxCol));

	return { col: safeCol, row };
}
