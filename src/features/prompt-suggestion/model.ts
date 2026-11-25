export const MAX_PROMPT_SUGGESTION_LENGTH = 100;

export const PROMPT_SUGGESTION_INSTRUCTION =
	"[Prompt suggestion] Predict what the user will type next in this conversation. Write it the way they would: a short single-line instruction, question, or reply in their language and tone, under 12 words. Suggest only an obvious next step, such as confirming a proposal or asking the natural follow-up. Reply with only the suggestion, no quotes or formatting. If there is no obvious next step, reply with nothing.";

const NO_SUGGESTION_SENTINELS = new Set([
	"nothing",
	"(nothing)",
	"[nothing]",
	"<nothing>",
	"none",
	"(none)",
	"[none]",
	"<none>",
	"null",
	"n/a",
	"no suggestion",
	"no follow-up",
]);

const SURROUNDING_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["«", "»"],
	["“", "”"],
	["‘", "’"],
];

function stripSurroundingQuotes(text: string): string {
	let current = text.trim();
	while (current.length >= 2) {
		const matchedPair = SURROUNDING_QUOTE_PAIRS.find(
			([open, close]) => current.startsWith(open) && current.endsWith(close),
		);
		if (!matchedPair) break;
		const [open, close] = matchedPair;
		current = current.slice(open.length, current.length - close.length).trim();
	}
	return current;
}

export function sanitizePromptSuggestion(rawText: string): string | undefined {
	if (!rawText) return undefined;
	const trimmed = rawText.trim();
	if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) {
		return undefined;
	}

	const unquoted = stripSurroundingQuotes(trimmed);
	if (!unquoted || unquoted.includes("\n") || unquoted.includes("\r")) {
		return undefined;
	}
	if (unquoted.length > MAX_PROMPT_SUGGESTION_LENGTH) {
		return undefined;
	}
	if (NO_SUGGESTION_SENTINELS.has(unquoted.toLowerCase())) {
		return undefined;
	}
	return unquoted;
}

export function extractAssistantTextContent(
	content: ReadonlyArray<{ readonly type?: string; readonly text?: unknown }>,
): string {
	let out = "";
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") {
			out += part.text;
		}
	}
	return out;
}
