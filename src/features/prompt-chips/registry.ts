import { basename } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export type PromptChipKind = "image" | "paste" | "quote";
export const PROMPT_CHIPS_CUSTOM_ENTRY_TYPE = "conarti-prompt-chips";
const MAX_PERSISTED_PREVIEW_CHARS = 4000;
const MAX_STAGED_DRAFTS = 12;

export interface ImagePromptChipData {
	readonly kind: "image";
	readonly id: string;
	readonly filePath: string;
	readonly fileName: string;
	readonly mimeType: string;
	readonly byteLength: number;
	readonly base64Data?: string;
	readonly widthPx?: number;
	readonly heightPx?: number;
}

export interface PastePromptChipData {
	readonly kind: "paste";
	readonly id: string;
	readonly text: string;
	readonly lineCount: number;
	readonly charCount: number;
	readonly metric: "lines" | "chars";
}

export interface QuotePromptChipData {
	readonly kind: "quote";
	readonly id: string;
	readonly text: string;
	readonly lineCount: number;
	readonly charCount: number;
	readonly sourceLabel?: string;
}

export type PromptChipEntry = ImagePromptChipData | PastePromptChipData | QuotePromptChipData;

export interface RegisteredPromptChip<T extends PromptChipEntry = PromptChipEntry> {
	readonly entry: T;
	readonly number: number;
	readonly token: string;
}

export interface PromptChipSpan {
	readonly kind: PromptChipKind;
	readonly number: number;
	readonly token: string;
	readonly suffix?: string;
	readonly start: number;
	readonly end: number;
}

export interface TextPasteClassification {
	readonly shouldCreateChip: boolean;
	readonly normalizedText: string;
	readonly lineCount: number;
	readonly charCount: number;
}

export const PASTE_CHIP_MIN_LINES = 4;
export const PASTE_CHIP_MAX_INLINE_CHARS = 300;

const PROMPT_CHIP_TOKEN_RE =
	/\[(?:🖼 Image #(\d+)|📋 Pasted #(\d+) · (\d+ (?:lines?|chars?))|❝ Quote #(\d+) · (\d+ lines?))\]/gu;

export function decodeBracketedPasteControlSequences(raw: string): string {
	return raw.replace(/\x1b\[(\d+);5u/g, (match, code) => {
		const cp = Number(code);
		if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
		if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
		return match;
	});
}

export function normalizePastedPlainText(raw: string): string {
	const decoded = decodeBracketedPasteControlSequences(raw)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	let out = "";
	for (let i = 0; i < decoded.length; i++) {
		const ch = decoded[i]!;
		const code = ch.charCodeAt(0);
		if (ch === "\n" || ch === "\t" || code >= 32) {
			out += ch;
		}
	}
	return out;
}

export function classifyTextPaste(raw: string): TextPasteClassification {
	const normalizedText = normalizePastedPlainText(raw);
	const lineCount = normalizedText.length === 0 ? 0 : normalizedText.split("\n").length;
	const charCount = normalizedText.length;
	const shouldCreateChip =
		lineCount >= PASTE_CHIP_MIN_LINES || charCount > PASTE_CHIP_MAX_INLINE_CHARS;
	return {
		shouldCreateChip,
		normalizedText,
		lineCount,
		charCount,
	};
}

export function formatPromptChipToken(entry: PromptChipEntry, number: number): string {
	switch (entry.kind) {
		case "image":
			return `[🖼 Image #${number}]`;
		case "paste": {
			if (entry.metric === "chars") {
				const unit = entry.charCount === 1 ? "char" : "chars";
				return `[📋 Pasted #${number} · ${entry.charCount} ${unit}]`;
			}
			const unit = entry.lineCount === 1 ? "line" : "lines";
			return `[📋 Pasted #${number} · ${entry.lineCount} ${unit}]`;
		}
		case "quote": {
			const unit = entry.lineCount === 1 ? "line" : "lines";
			return `[❝ Quote #${number} · ${entry.lineCount} ${unit}]`;
		}
	}
}

export function findPromptChipSpans(text: string): PromptChipSpan[] {
	if (!text || !text.includes("[")) return [];
	const spans: PromptChipSpan[] = [];
	for (const match of text.matchAll(PROMPT_CHIP_TOKEN_RE)) {
		const token = match[0];
		const start = match.index ?? 0;
		const end = start + token.length;
		if (match[1] !== undefined) {
			spans.push({
				kind: "image",
				number: Number.parseInt(match[1], 10),
				token,
				start,
				end,
			});
		} else if (match[2] !== undefined) {
			spans.push({
				kind: "paste",
				number: Number.parseInt(match[2], 10),
				token,
				suffix: match[3],
				start,
				end,
			});
		} else if (match[4] !== undefined) {
			spans.push({
				kind: "quote",
				number: Number.parseInt(match[4], 10),
				token,
				suffix: match[5],
				start,
				end,
			});
		}
	}
	return spans;
}

export function makeChipBindingKey(kind: PromptChipKind, number: number): string {
	return `${kind}:${number}`;
}

export interface RegisterImageChipInput {
	readonly filePath: string;
	readonly fileName: string;
	readonly mimeType: string;
	readonly byteLength: number;
	readonly base64Data?: string;
	readonly widthPx?: number;
	readonly heightPx?: number;
}

export interface PromptChipUndoSnapshot {
	readonly bindings: ReadonlyArray<readonly [string, string]>;
	readonly nextDraftNumber: number;
}

export interface SyncDraftLinesResult {
	readonly lines: string[];
	readonly cursorLine: number;
	readonly cursorCol: number;
	readonly changed: boolean;
}

export interface SerializedImageChip {
	readonly id: string;
	readonly kind: "image";
	readonly number: number;
	readonly token: string;
	readonly filePath: string;
	readonly fileName: string;
	readonly mimeType: string;
	readonly byteLength: number;
	readonly widthPx?: number;
	readonly heightPx?: number;
}

export interface SerializedPasteChip {
	readonly id: string;
	readonly kind: "paste";
	readonly number: number;
	readonly token: string;
	readonly lineCount: number;
	readonly charCount: number;
	readonly metric: "lines" | "chars";
	readonly previewText: string;
}

export interface SerializedQuoteChip {
	readonly id: string;
	readonly kind: "quote";
	readonly number: number;
	readonly token: string;
	readonly lineCount: number;
	readonly charCount: number;
	readonly sourceLabel?: string;
	readonly previewText: string;
}

export type SerializedPromptChip = SerializedImageChip | SerializedPasteChip | SerializedQuoteChip;

export interface PersistedPromptChipsPayload {
	readonly timestamp?: number | string;
	readonly displayText: string;
	readonly expandedText: string;
	readonly chips: readonly SerializedPromptChip[];
}

export interface ExpandDraftResult {
	readonly transformed: boolean;
	readonly text: string;
	readonly images?: ImageContent[];
	readonly record?: PersistedPromptChipsPayload;
}

export interface ReconstructedSubmittedPrompt {
	readonly displayText: string;
	readonly chips: readonly SerializedPromptChip[];
}

interface StagedDraftSnapshot {
	readonly rawText: string;
	readonly bindings: ReadonlyMap<string, string>;
}

const LEGACY_IMAGE_MARKER_RE = /\[Image #(\d+):\s*([^\]]+)\]/g;
const IMAGE_PLACEHOLDER_TOKEN_RE = /\[изображение\]/gu;
const TRAILING_IMAGE_PLACEHOLDER_RE = /(?:\s*\[изображение\])+\s*$/u;
const TRAILING_SYNTHETIC_IMAGE_PILLS_RE = /((?:\s*\[🖼 Image #\d+\])+)\s*$/u;
const SYNTHETIC_IMAGE_PILL_RE = /\[🖼 Image #(\d+)\]/gu;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function stripTrailingImagePlaceholders(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(TRAILING_IMAGE_PLACEHOLDER_RE, "").trim();
}

/* renderUserPromptCardLines заменяет табы на два пробела, поэтому ключи поиска нормализуют их одинаково */
function canonicalizePromptLookupText(text: string): string {
	const sanitized = stripTerminalSequences(text.replace(/\r\n?/g, "\n"))
		.replace(CONTROL_CHARS_RE, "")
		.replace(/\t/g, "  ");
	return stripTrailingImagePlaceholders(sanitized);
}

function inferImageMimeTypeFromPath(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/png";
}

export function serializePromptChip(
	entry: PromptChipEntry,
	number: number,
	maxPreviewChars?: number,
): SerializedPromptChip {
	const token = formatPromptChipToken(entry, number);
	switch (entry.kind) {
		case "image":
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
		case "paste":
			return {
				id: entry.id,
				kind: "paste",
				number,
				token,
				lineCount: entry.lineCount,
				charCount: entry.charCount,
				metric: entry.metric,
				previewText:
					maxPreviewChars !== undefined ? entry.text.slice(0, maxPreviewChars) : entry.text,
			};
		case "quote":
			return {
				id: entry.id,
				kind: "quote",
				number,
				token,
				lineCount: entry.lineCount,
				charCount: entry.charCount,
				...(entry.sourceLabel ? { sourceLabel: entry.sourceLabel } : {}),
				previewText:
					maxPreviewChars !== undefined ? entry.text.slice(0, maxPreviewChars) : entry.text,
			};
	}
}

function formatBlockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
}

export class PromptChipRegistry {
	private nextChipSeq = 1;
	private nextDraftNumber = 1;
	private readonly sessionVault = new Map<string, PromptChipEntry>();
	private readonly activeBindings = new Map<string, string>();
	private readonly historyByBindingKey = new Map<string, string>();
	private readonly historyByToken = new Map<string, string>();
	private readonly stagedDrafts: StagedDraftSnapshot[] = [];
	private readonly pendingPersistQueue: PersistedPromptChipsPayload[] = [];
	private readonly submittedByMessageId = new Map<string, PersistedPromptChipsPayload>();
	private readonly submittedByTimestamp = new Map<string, PersistedPromptChipsPayload>();
	private readonly submittedByExpanded = new Map<string, PersistedPromptChipsPayload>();

	private allocateChipId(): string {
		const id = `chip-${this.nextChipSeq}`;
		this.nextChipSeq += 1;
		return id;
	}

	private allocateDraftNumber(): number {
		const n = this.nextDraftNumber;
		this.nextDraftNumber += 1;
		return n;
	}

	private bindEntry<T extends PromptChipEntry>(entry: T): RegisteredPromptChip<T> {
		const number = this.allocateDraftNumber();
		const token = formatPromptChipToken(entry, number);
		const key = makeChipBindingKey(entry.kind, number);
		this.sessionVault.set(entry.id, entry);
		this.activeBindings.set(key, entry.id);
		this.historyByBindingKey.set(key, entry.id);
		this.historyByToken.set(token, entry.id);
		return { entry, number, token };
	}

	registerImage(input: RegisterImageChipInput): RegisteredPromptChip<ImagePromptChipData> {
		const entry: ImagePromptChipData = {
			kind: "image",
			id: this.allocateChipId(),
			filePath: input.filePath,
			fileName: input.fileName,
			mimeType: input.mimeType,
			byteLength: input.byteLength,
			base64Data: input.base64Data,
			widthPx: input.widthPx,
			heightPx: input.heightPx,
		};
		return this.bindEntry(entry);
	}

	registerPaste(rawText: string): RegisteredPromptChip<PastePromptChipData> {
		const { normalizedText, lineCount, charCount } = classifyTextPaste(rawText);
		const metric: "lines" | "chars" = lineCount >= PASTE_CHIP_MIN_LINES ? "lines" : "chars";
		const entry: PastePromptChipData = {
			kind: "paste",
			id: this.allocateChipId(),
			text: normalizedText,
			lineCount: Math.max(1, lineCount),
			charCount,
			metric,
		};
		return this.bindEntry(entry);
	}

	registerQuote(rawText: string, sourceLabel?: string): RegisteredPromptChip<QuotePromptChipData> {
		const trimmedVertical = normalizePastedPlainText(rawText).replace(/^\n+|\n+$/g, "");
		const normalizedText = trimmedVertical.trim().length === 0 ? "" : trimmedVertical;
		const lineCount = Math.max(1, normalizedText.length === 0 ? 1 : normalizedText.split("\n").length);
		const entry: QuotePromptChipData = {
			kind: "quote",
			id: this.allocateChipId(),
			text: normalizedText,
			lineCount,
			charCount: normalizedText.length,
			sourceLabel,
		};
		return this.bindEntry(entry);
	}

	replaceQuoteAtNumber(
		number: number,
		rawText: string,
		sourceLabelOverride?: string,
	): RegisteredPromptChip<QuotePromptChipData> | undefined {
		const key = makeChipBindingKey("quote", number);
		const existingId = this.activeBindings.get(key) ?? this.historyByBindingKey.get(key);
		const existing = existingId ? this.sessionVault.get(existingId) : undefined;
		const priorSourceLabel = existing?.kind === "quote" ? existing.sourceLabel : undefined;

		const trimmedVertical = normalizePastedPlainText(rawText).replace(/^\n+|\n+$/g, "");
		const normalizedText = trimmedVertical.trim().length === 0 ? "" : trimmedVertical;
		if (!normalizedText) return undefined;

		const lineCount = Math.max(1, normalizedText.split("\n").length);
		const entry: QuotePromptChipData = {
			kind: "quote",
			id: this.allocateChipId(),
			text: normalizedText,
			lineCount,
			charCount: normalizedText.length,
			sourceLabel: sourceLabelOverride ?? priorSourceLabel,
		};
		const token = formatPromptChipToken(entry, number);
		this.sessionVault.set(entry.id, entry);
		this.activeBindings.set(key, entry.id);
		this.historyByBindingKey.set(key, entry.id);
		this.historyByToken.set(token, entry.id);
		return { entry, number, token };
	}

	resolveChip(kind: PromptChipKind, number: number): PromptChipEntry | undefined {
		const key = makeChipBindingKey(kind, number);
		const id = this.activeBindings.get(key);
		return id ? this.sessionVault.get(id) : undefined;
	}

	getChipById(id: string): PromptChipEntry | undefined {
		return this.sessionVault.get(id);
	}

	hasActiveDraftChips(): boolean {
		return this.activeBindings.size > 0;
	}

	isKnownChipSpan(span: Pick<PromptChipSpan, "kind" | "number" | "token">): boolean {
		const key = makeChipBindingKey(span.kind, span.number);
		const chipId =
			this.activeBindings.get(key) ??
			this.historyByToken.get(span.token) ??
			this.historyByBindingKey.get(key);
		const entry = chipId ? this.sessionVault.get(chipId) : undefined;
		return Boolean(entry && entry.kind === span.kind);
	}

	resolveChipsForSubmit(inputText: string): PromptChipEntry[] {
		const spans = findPromptChipSpans(inputText);
		if (spans.length === 0) return [];
		const trimmedInput = inputText.trim();
		const stagedIdx = this.stagedDrafts.findLastIndex((s) => s.rawText === trimmedInput);
		const lookupBindings =
			stagedIdx !== -1 ? this.stagedDrafts[stagedIdx]!.bindings : this.activeBindings;
		const resolved: PromptChipEntry[] = [];
		const seenIds = new Set<string>();
		for (const span of spans) {
			const key = makeChipBindingKey(span.kind, span.number);
			const chipId =
				lookupBindings.get(key) ??
				this.activeBindings.get(key) ??
				this.historyByToken.get(span.token) ??
				this.historyByBindingKey.get(key);
			const entry = chipId ? this.sessionVault.get(chipId) : undefined;
			if (entry && entry.kind === span.kind && !seenIds.has(entry.id)) {
				seenIds.add(entry.id);
				resolved.push(entry);
			}
		}
		return resolved;
	}

	updateImageChipPayload(
		chipId: string,
		patch: {
			readonly mimeType: string;
			readonly base64Data: string;
			readonly byteLength?: number;
			readonly widthPx?: number;
			readonly heightPx?: number;
		},
	): void {
		const existing = this.sessionVault.get(chipId);
		if (!existing || existing.kind !== "image") return;
		this.sessionVault.set(chipId, {
			...existing,
			mimeType: patch.mimeType,
			base64Data: patch.base64Data,
			byteLength: patch.byteLength ?? existing.byteLength,
			widthPx: patch.widthPx ?? existing.widthPx,
			heightPx: patch.heightPx ?? existing.heightPx,
		});
	}

	captureUndoSnapshot(): PromptChipUndoSnapshot {
		return {
			bindings: [...this.activeBindings.entries()],
			nextDraftNumber: this.nextDraftNumber,
		};
	}

	restoreUndoSnapshot(snapshot: PromptChipUndoSnapshot): void {
		this.activeBindings.clear();
		for (const [key, chipId] of snapshot.bindings) {
			const entry = this.sessionVault.get(chipId);
			if (!entry) continue;
			this.activeBindings.set(key, chipId);
			this.historyByBindingKey.set(key, chipId);
			const numPart = Number.parseInt(key.split(":")[1] ?? "0", 10);
			if (numPart > 0) {
				this.historyByToken.set(formatPromptChipToken(entry, numPart), chipId);
			}
		}
		this.nextDraftNumber = Math.max(1, snapshot.nextDraftNumber);
	}

	syncDraftLines(
		lines: readonly string[],
		cursorLine = 0,
		cursorCol = 0,
	): SyncDraftLinesResult {
		const isEmpty = lines.length === 0 || (lines.length === 1 && lines[0] === "");
		if (isEmpty) {
			this.activeBindings.clear();
			this.nextDraftNumber = 1;
			return { lines: [...lines], cursorLine, cursorCol, changed: false };
		}

		const lineSpans = lines.map((line) => findPromptChipSpans(line));
		const distinctByOldKey = new Map<
			string,
			{ oldKey: string; oldNumber: number; order: number; chipId: string; entry: PromptChipEntry }
		>();
		let appearanceOrder = 0;

		for (const spans of lineSpans) {
			for (const span of spans) {
				const oldKey = makeChipBindingKey(span.kind, span.number);
				if (distinctByOldKey.has(oldKey)) continue;
				const chipId =
					this.activeBindings.get(oldKey) ??
					this.historyByToken.get(span.token) ??
					this.historyByBindingKey.get(oldKey);
				if (!chipId) continue;
				const entry = this.sessionVault.get(chipId);
				if (!entry || entry.kind !== span.kind) continue;
				distinctByOldKey.set(oldKey, {
					oldKey,
					oldNumber: span.number,
					order: appearanceOrder++,
					chipId,
					entry,
				});
			}
		}

		if (distinctByOldKey.size === 0) {
			this.activeBindings.clear();
			this.nextDraftNumber = 1;
			return { lines: [...lines], cursorLine, cursorCol, changed: false };
		}

		const sorted = [...distinctByOldKey.values()].sort(
			(a, b) => a.oldNumber - b.oldNumber || a.order - b.order,
		);

		const nextBindings = new Map<string, string>();
		const replacementByOldKey = new Map<string, string>();

		for (let i = 0; i < sorted.length; i++) {
			const item = sorted[i]!;
			const newNumber = i + 1;
			const newKey = makeChipBindingKey(item.entry.kind, newNumber);
			const newToken = formatPromptChipToken(item.entry, newNumber);
			nextBindings.set(newKey, item.chipId);
			this.historyByBindingKey.set(newKey, item.chipId);
			this.historyByToken.set(newToken, item.chipId);
			replacementByOldKey.set(item.oldKey, newToken);
		}

		let changed = false;
		let nextCursorCol = cursorCol;
		const nextLines = lines.map((line, lineIdx) => {
			const spans = lineSpans[lineIdx]!;
			if (spans.length === 0) return line;
			let rebuilt = "";
			let pos = 0;
			let colDelta = 0;
			for (const span of spans) {
				const oldKey = makeChipBindingKey(span.kind, span.number);
				const replacement = replacementByOldKey.get(oldKey) ?? span.token;
				rebuilt += line.slice(pos, span.start) + replacement;
				pos = span.end;
				if (replacement !== span.token) {
					changed = true;
					if (lineIdx === cursorLine) {
						if (span.end <= cursorCol) {
							colDelta += replacement.length - span.token.length;
						} else if (span.start < cursorCol && cursorCol < span.end) {
							colDelta += span.start - cursorCol;
						}
					}
				}
			}
			rebuilt += line.slice(pos);
			if (lineIdx === cursorLine && colDelta !== 0) {
				nextCursorCol = Math.max(0, Math.min(rebuilt.length, cursorCol + colDelta));
			}
			return rebuilt;
		});

		this.activeBindings.clear();
		for (const [k, v] of nextBindings) {
			this.activeBindings.set(k, v);
		}
		this.nextDraftNumber = sorted.length + 1;

		return {
			lines: nextLines,
			cursorLine,
			cursorCol: nextCursorCol,
			changed,
		};
	}

	syncDraft(text: string): string {
		if (!text) {
			this.activeBindings.clear();
			this.nextDraftNumber = 1;
			return text;
		}
		const synced = this.syncDraftLines(text.split("\n"), 0, 0);
		return synced.changed ? synced.lines.join("\n") : text;
	}

	stageDraftBeforeClear(previousDraftText: string): void {
		const trimmed = previousDraftText.trim();
		if (!trimmed || this.activeBindings.size === 0) return;
		if (findPromptChipSpans(trimmed).length === 0) return;
		this.stagedDrafts.push({
			rawText: trimmed,
			bindings: new Map(this.activeBindings),
		});
		while (this.stagedDrafts.length > MAX_STAGED_DRAFTS) {
			this.stagedDrafts.shift();
		}
	}

	expandDraftForSubmit(
		inputText: string,
		existingImages?: readonly ImageContent[],
	): ExpandDraftResult {
		const spans = findPromptChipSpans(inputText);
		if (spans.length === 0) {
			return {
				transformed: false,
				text: inputText,
				images: existingImages ? [...existingImages] : undefined,
			};
		}

		const trimmedInput = inputText.trim();
		const stagedIdx = this.stagedDrafts.findLastIndex((s) => s.rawText === trimmedInput);
		const staged = stagedIdx !== -1 ? this.stagedDrafts.splice(stagedIdx, 1)[0] : undefined;
		const lookupBindings = staged?.bindings ?? this.activeBindings;

		const resolveForSpan = (span: PromptChipSpan): PromptChipEntry | undefined => {
			const key = makeChipBindingKey(span.kind, span.number);
			const chipId =
				lookupBindings.get(key) ??
				this.activeBindings.get(key) ??
				this.historyByToken.get(span.token) ??
				this.historyByBindingKey.get(key);
			const entry = chipId ? this.sessionVault.get(chipId) : undefined;
			return entry && entry.kind === span.kind ? entry : undefined;
		};

		const attachedImages: ImageContent[] = existingImages ? [...existingImages] : [];
		const seenImageChipIds = new Set<string>();
		const serializedChips: SerializedPromptChip[] = [];
		let anyExpanded = false;
		let expanded = "";
		let cursor = 0;

		for (const span of spans) {
			const entry = resolveForSpan(span);
			if (!entry) {
				expanded += inputText.slice(cursor, span.end);
				cursor = span.end;
				continue;
			}

			anyExpanded = true;
			serializedChips.push(serializePromptChip(entry, span.number, MAX_PERSISTED_PREVIEW_CHARS));
			const chunkBefore = inputText.slice(cursor, span.start);

			if (entry.kind === "image") {
				expanded += `${chunkBefore}[Image #${span.number}: ${entry.filePath}]`;
				if (entry.base64Data && !seenImageChipIds.has(entry.id)) {
					seenImageChipIds.add(entry.id);
					attachedImages.push({
						type: "image",
						data: entry.base64Data,
						mimeType: entry.mimeType,
					});
				}
				cursor = span.end;
				continue;
			}

			if (entry.kind === "paste") {
				expanded += chunkBefore + entry.text;
				cursor = span.end;
				continue;
			}

			let combinedBefore = (expanded + chunkBefore).replace(/[ \t]+$/, "");
			let quoteLead = "";
			if (combinedBefore.length > 0) {
				if (/\n[ \t]*\n$/.test(combinedBefore)) {
					combinedBefore = combinedBefore.replace(/\n[ \t]*\n$/, "\n\n");
					quoteLead = "";
				} else if (combinedBefore.endsWith("\n")) {
					quoteLead = "\n";
				} else {
					quoteLead = "\n\n";
				}
			}

			const restAfter = inputText.slice(span.end);
			let skipAfterChars = 0;
			let quoteTrail = "";
			if (restAfter.length > 0) {
				if (/^\n[ \t]*\n/.test(restAfter)) {
					quoteTrail = "";
				} else if (restAfter.startsWith("\n")) {
					quoteTrail = "\n";
				} else {
					const wsMatch = /^[ \t]+/.exec(restAfter);
					skipAfterChars = wsMatch ? wsMatch[0].length : 0;
					const afterTrimmed = restAfter.slice(skipAfterChars);
					if (/^\n[ \t]*\n/.test(afterTrimmed)) {
						quoteTrail = "";
					} else if (afterTrimmed.startsWith("\n")) {
						quoteTrail = "\n";
					} else if (afterTrimmed.length > 0) {
						quoteTrail = "\n\n";
					}
				}
			}

			expanded = `${combinedBefore}${quoteLead}${formatBlockquote(entry.text)}${quoteTrail}`;
			cursor = span.end + skipAfterChars;
		}

		expanded += inputText.slice(cursor);

		if (!anyExpanded) {
			return {
				transformed: false,
				text: inputText,
				images: existingImages ? [...existingImages] : undefined,
			};
		}

		if (!staged) {
			this.activeBindings.clear();
			this.nextDraftNumber = 1;
		}

		const finalExpanded = expanded.trim();
		const record: PersistedPromptChipsPayload = {
			displayText: trimmedInput,
			expandedText: finalExpanded,
			chips: serializedChips,
		};
		this.pendingPersistQueue.push(record);
		this.submittedByExpanded.set(finalExpanded, record);
		this.submittedByExpanded.set(canonicalizePromptLookupText(finalExpanded), record);

		return {
			transformed: true,
			text: finalExpanded,
			images: attachedImages.length > 0 ? attachedImages : existingImages ? [...existingImages] : undefined,
			record,
		};
	}

	bindSubmittedMessageTimestamp(
		messageText: string,
		timestamp: number | string | undefined,
	): PersistedPromptChipsPayload | undefined {
		const clean = stripTrailingImagePlaceholders(messageText);
		const canonical = canonicalizePromptLookupText(messageText);
		const matchesPayload = (r: PersistedPromptChipsPayload): boolean =>
			r.expandedText === clean || canonicalizePromptLookupText(r.expandedText) === canonical;
		const queued = this.pendingPersistQueue.find(
			(r) => r.timestamp === undefined && matchesPayload(r),
		);
		const target =
			queued ?? this.submittedByExpanded.get(clean) ?? this.submittedByExpanded.get(canonical);
		if (!target) return undefined;

		const updated: PersistedPromptChipsPayload =
			timestamp !== undefined ? { ...target, timestamp } : target;
		if (queued) {
			const idx = this.pendingPersistQueue.indexOf(queued);
			if (idx !== -1) this.pendingPersistQueue[idx] = updated;
		}
		this.submittedByExpanded.set(updated.expandedText, updated);
		this.submittedByExpanded.set(canonicalizePromptLookupText(updated.expandedText), updated);
		if (timestamp !== undefined) {
			this.submittedByTimestamp.set(String(timestamp), updated);
		}
		return updated;
	}

	consumePersistPayload(
		messageText: string,
		timestamp: number | string | undefined,
	): PersistedPromptChipsPayload | undefined {
		const clean = stripTrailingImagePlaceholders(messageText);
		const canonical = canonicalizePromptLookupText(messageText);
		const idx = this.pendingPersistQueue.findIndex(
			(r) =>
				(timestamp !== undefined && r.timestamp !== undefined && String(r.timestamp) === String(timestamp)) ||
				r.expandedText === clean ||
				canonicalizePromptLookupText(r.expandedText) === canonical,
		);
		if (idx === -1) return undefined;
		const base = this.pendingPersistQueue.splice(idx, 1)[0]!;
		const finalized: PersistedPromptChipsPayload =
			timestamp !== undefined ? { ...base, timestamp } : base;
		this.submittedByExpanded.set(finalized.expandedText, finalized);
		this.submittedByExpanded.set(canonicalizePromptLookupText(finalized.expandedText), finalized);
		if (finalized.timestamp !== undefined) {
			this.submittedByTimestamp.set(String(finalized.timestamp), finalized);
		}
		return finalized;
	}

	private lastHydratedEntries?: readonly unknown[];
	private lastHydratedLength = -1;

	restorePersistedEntries(entries: readonly unknown[]): void {
		this.lastHydratedEntries = entries;
		this.lastHydratedLength = entries.length;
		const customByEntryId = new Map<string, PersistedPromptChipsPayload>();
		let immediatelyPrecedingPayload: PersistedPromptChipsPayload | undefined;

		for (const raw of entries) {
			if (!raw || typeof raw !== "object") continue;
			const entry = raw as {
				type?: unknown;
				id?: unknown;
				parentId?: unknown;
				timestamp?: unknown;
				customType?: unknown;
				data?: unknown;
				message?: {
					role?: unknown;
					timestamp?: unknown;
					content?: unknown;
				};
			};

			if (entry.type === "custom" && entry.customType === PROMPT_CHIPS_CUSTOM_ENTRY_TYPE) {
				const data = entry.data as Partial<PersistedPromptChipsPayload> | undefined;
				if (
					!data ||
					typeof data.displayText !== "string" ||
					typeof data.expandedText !== "string" ||
					!Array.isArray(data.chips)
				) {
					immediatelyPrecedingPayload = undefined;
					continue;
				}
				const payload: PersistedPromptChipsPayload = {
					timestamp: data.timestamp,
					displayText: data.displayText,
					expandedText: data.expandedText,
					chips: data.chips,
				};
				this.submittedByExpanded.set(payload.expandedText, payload);
				this.submittedByExpanded.set(canonicalizePromptLookupText(payload.expandedText), payload);
				if (payload.timestamp !== undefined) {
					this.submittedByTimestamp.set(String(payload.timestamp), payload);
				}
				if (typeof entry.id === "string" && entry.id.length > 0) {
					customByEntryId.set(entry.id, payload);
				}
				immediatelyPrecedingPayload = payload;
				continue;
			}

			if (entry.type === "message" && entry.message?.role === "user") {
				const msgTs = entry.message.timestamp;
				const byParent =
					typeof entry.parentId === "string" ? customByEntryId.get(entry.parentId) : undefined;
				const byMsgTs =
					msgTs !== undefined ? this.submittedByTimestamp.get(String(msgTs)) : undefined;
				const matched = byParent ?? byMsgTs ?? immediatelyPrecedingPayload;
				if (matched) {
					if (entry.id !== undefined && entry.id !== null) {
						this.submittedByMessageId.set(String(entry.id), matched);
					}
					if (typeof entry.timestamp === "string" || typeof entry.timestamp === "number") {
						this.submittedByTimestamp.set(String(entry.timestamp), matched);
					}
					if (typeof msgTs === "string" || typeof msgTs === "number") {
						this.submittedByTimestamp.set(String(msgTs), matched);
					}
				}
			}

			immediatelyPrecedingPayload = undefined;
		}
	}

	ensurePersistedEntriesHydrated(entries: readonly unknown[] | undefined): void {
		if (!entries || entries.length === 0) return;
		if (this.lastHydratedEntries === entries && this.lastHydratedLength === entries.length) {
			return;
		}
		this.restorePersistedEntries(entries);
	}

	reconstructSubmittedPrompt(
		rawCardText: string,
		timestamp?: number | string,
		messageId?: string,
	): ReconstructedSubmittedPrompt {
		const normalizedRaw = rawCardText.replace(/\r\n?/g, "\n").trim();
		const placeholderCount = [...normalizedRaw.matchAll(IMAGE_PLACEHOLDER_TOKEN_RE)].length;
		const clean = stripTrailingImagePlaceholders(normalizedRaw);
		const canonical = canonicalizePromptLookupText(normalizedRaw);

		const findMatchingRecord = (
			candidateClean: string,
			candidateCanonical: string,
		): PersistedPromptChipsPayload | undefined => {
			const matches = (rec: PersistedPromptChipsPayload): boolean =>
				rec.expandedText === candidateClean ||
				rec.expandedText === normalizedRaw ||
				rec.displayText === candidateClean ||
				canonicalizePromptLookupText(rec.expandedText) === candidateCanonical ||
				canonicalizePromptLookupText(rec.displayText) === candidateCanonical;

			if (messageId !== undefined) {
				const byId = this.submittedByMessageId.get(String(messageId));
				if (byId && matches(byId)) return byId;
			}
			if (timestamp !== undefined) {
				const byTs = this.submittedByTimestamp.get(String(timestamp));
				if (byTs && matches(byTs)) return byTs;
			}
			return (
				this.submittedByExpanded.get(candidateClean) ??
				this.submittedByExpanded.get(normalizedRaw) ??
				this.submittedByExpanded.get(candidateCanonical)
			);
		};

		const buildFallbackImageChip = (number: number, filePath = ""): SerializedPromptChip => ({
			id: `fallback-image-${number}`,
			kind: "image",
			number,
			token: `[🖼 Image #${number}]`,
			filePath,
			fileName: filePath ? basename(filePath) || `image-${number}.png` : `Image #${number}`,
			mimeType: filePath ? inferImageMimeTypeFromPath(filePath) : "image/png",
			byteLength: 0,
		});

		const appendExtraImagePills = (
			baseDisplay: string,
			baseChips: readonly SerializedPromptChip[],
			extraNumbers: readonly number[],
		): ReconstructedSubmittedPrompt => {
			if (extraNumbers.length === 0) {
				return { displayText: baseDisplay, chips: baseChips };
			}
			const extraChips = extraNumbers.map((n) => buildFallbackImageChip(n));
			const suffix = extraChips.map((c) => c.token).join(" ");
			return {
				displayText: baseDisplay ? `${baseDisplay} ${suffix}` : suffix,
				chips: [...baseChips, ...extraChips],
			};
		};

		const directRecord = findMatchingRecord(clean, canonical);
		if (directRecord) {
			const recImageCount = directRecord.chips.filter((c) => c.kind === "image").length;
			const extraCount = Math.max(0, placeholderCount - recImageCount);
			if (extraCount === 0) {
				return { displayText: directRecord.displayText, chips: directRecord.chips };
			}
			const maxImgNum = directRecord.chips.reduce(
				(max, c) => (c.kind === "image" && c.number > max ? c.number : max),
				0,
			);
			const extraNums = Array.from({ length: extraCount }, (_, idx) => maxImgNum + idx + 1);
			return appendExtraImagePills(directRecord.displayText, directRecord.chips, extraNums);
		}

		const trailingPillMatch = TRAILING_SYNTHETIC_IMAGE_PILLS_RE.exec(clean);
		if (trailingPillMatch && trailingPillMatch.index > 0) {
			const strippedClean = clean.slice(0, trailingPillMatch.index).trim();
			const strippedCanonical = canonicalizePromptLookupText(strippedClean);
			const strippedRecord = findMatchingRecord(strippedClean, strippedCanonical);
			if (strippedRecord) {
				const trailingNums = [...trailingPillMatch[1]!.matchAll(SYNTHETIC_IMAGE_PILL_RE)].map((m) =>
					Number.parseInt(m[1]!, 10),
				);
				return appendExtraImagePills(strippedRecord.displayText, strippedRecord.chips, trailingNums);
			}
		}

		const fallbackChips: SerializedPromptChip[] = [];
		let rebuilt = clean.includes("[Image #")
			? clean.replace(LEGACY_IMAGE_MARKER_RE, (_full, numStr: string, rawPath: string) => {
					const number = Number.parseInt(numStr, 10);
					const chip = buildFallbackImageChip(number, rawPath.trim());
					fallbackChips.push(chip);
					return chip.token;
				})
			: clean;

		if (placeholderCount > 0) {
			let existingImageCount = 0;
			let maxImageNum = 0;
			for (const span of findPromptChipSpans(rebuilt)) {
				if (span.kind === "image") {
					existingImageCount += 1;
					if (span.number > maxImageNum) maxImageNum = span.number;
				}
			}
			const missingImages = placeholderCount - existingImageCount;
			if (missingImages > 0) {
				const added = Array.from({ length: missingImages }, (_, idx) =>
					buildFallbackImageChip(maxImageNum + idx + 1),
				);
				fallbackChips.push(...added);
				const suffix = added.map((c) => c.token).join(" ");
				rebuilt = rebuilt ? `${rebuilt} ${suffix}` : suffix;
			}
		}

		if (fallbackChips.length > 0 && findPromptChipSpans(rebuilt).length === fallbackChips.length) {
			return { displayText: rebuilt, chips: fallbackChips };
		}

		const inlineSpans = findPromptChipSpans(rebuilt);
		if (inlineSpans.length > 0) {
			const fallbackByNum = new Map<number, SerializedPromptChip>(
				fallbackChips.map((c) => [c.number, c]),
			);
			const inlineChips: SerializedPromptChip[] = inlineSpans.map((span) => {
				const key = makeChipBindingKey(span.kind, span.number);
				const chipId =
					this.activeBindings.get(key) ??
					this.historyByToken.get(span.token) ??
					this.historyByBindingKey.get(key);
				const known = chipId ? this.sessionVault.get(chipId) : undefined;
				if (known && known.kind === span.kind) {
					return serializePromptChip(known, span.number, MAX_PERSISTED_PREVIEW_CHARS);
				}
				if (span.kind === "image") {
					return fallbackByNum.get(span.number) ?? {
						id: `inline-image-${span.number}`,
						kind: "image",
						number: span.number,
						token: span.token,
						filePath: "",
						fileName: `Image #${span.number}`,
						mimeType: "image/png",
						byteLength: 0,
					};
				}
				if (span.kind === "paste") {
					const numVal = Number.parseInt(span.suffix ?? "1", 10) || 1;
					const isChars = Boolean(span.suffix?.includes("char"));
					return {
						id: `inline-paste-${span.number}`,
						kind: "paste",
						number: span.number,
						token: span.token,
						lineCount: isChars ? 1 : numVal,
						charCount: isChars ? numVal : 0,
						metric: isChars ? "chars" : "lines",
						previewText: span.token,
					};
				}
				const qLines = Number.parseInt(span.suffix ?? "1", 10) || 1;
				return {
					id: `inline-quote-${span.number}`,
					kind: "quote",
					number: span.number,
					token: span.token,
					lineCount: qLines,
					charCount: 0,
					previewText: span.token,
				};
			});
			return { displayText: rebuilt, chips: inlineChips };
		}

		return { displayText: rebuilt, chips: [] };
	}

	clearSession(): void {
		this.nextDraftNumber = 1;
		this.sessionVault.clear();
		this.activeBindings.clear();
		this.historyByBindingKey.clear();
		this.historyByToken.clear();
		this.stagedDrafts.length = 0;
		this.pendingPersistQueue.length = 0;
		this.submittedByMessageId.clear();
		this.submittedByTimestamp.clear();
		this.submittedByExpanded.clear();
		this.lastHydratedEntries = undefined;
		this.lastHydratedLength = -1;
	}
}

const REGISTRY_KEY = Symbol.for("conarti.pi-ui.prompt-chip-registry.v1");

export function getActivePromptChipRegistry(): PromptChipRegistry {
	const g = globalThis as Record<symbol, PromptChipRegistry | undefined>;
	if (!g[REGISTRY_KEY]) {
		g[REGISTRY_KEY] = new PromptChipRegistry();
	}
	return g[REGISTRY_KEY]!;
}

export function reconstructTurnPromptText(
	rawPrompt: string,
	options?: {
		readonly timestamp?: number | string;
		readonly messageId?: string;
		readonly entries?: readonly unknown[];
	},
): string {
	if (!rawPrompt) return "";
	const registry = getActivePromptChipRegistry();
	registry.ensurePersistedEntriesHydrated(options?.entries);
	const reconstructed = registry.reconstructSubmittedPrompt(
		rawPrompt,
		options?.timestamp,
		options?.messageId,
	);
	return reconstructed.displayText;
}
