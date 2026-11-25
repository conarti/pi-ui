import {
	InteractiveMode,
	SkillInvocationMessageComponent,
	UserMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	fgRgb,
	getActiveGlobalTheme,
	getThemeSurfacePalette,
	isLightTheme,
	paintSurfaceRow,
	paintThemeSurfaceRow,
	themeFgRgb,
	type RgbTuple,
} from "../../shared/ansi.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import {
	claimHover,
	copyToClipboard,
	createCopyFeedbackTimerRegistry,
	hookMethod,
} from "../../shared/runtime-hooks.ts";
import {
	extractSkillInvocations,
	renderStyledSkillChip,
	toggleSkillPreviewPopup,
} from "../../shared/skill-tags.ts";
import { formatTurnTime, sanitizeTurnText } from "../../shared/turn-index.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { getPrototypeVariant } from "./prototype-state.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const PILL_FORMATTER_KEY = Symbol.for("conarti.pi-ui.prompt-pill-formatter.v1");
const PENDING_USER_TS_KEY = Symbol.for("conarti.pi-ui.pending-user-ts.v1");
const PILL_OSC8_OPEN_PREFIX = "\x1b]8;;conarti-pill:";
const PILL_OSC8_CLOSE = "\x1b]8;;\x07";

const userPromptCopyTimers = createCopyFeedbackTimerRegistry<{
	__conartiCopied?: boolean;
	__conartiCopyTimer?: unknown;
}>("conarti.pi-ui.user-prompt-copy-timers.v1", (target) => {
	target.__conartiCopied = false;
});

export interface PromptPillDescriptor {
	readonly id: string;
	readonly label: string;
	readonly onClick?: (screenX: number, screenY: number) => void;
}

export interface PromptPillFormatContext {
	readonly theme: Theme;
	readonly isLight: boolean;
	readonly surfaceRgb: RgbTuple;
	readonly messageId?: string;
	readonly timestamp?: number | string;
	readonly surface: "transcript" | "sticky";
}

export interface PromptPillFormatResult {
	readonly text: string;
	readonly pills?: readonly PromptPillDescriptor[];
}

export type PromptPillFormatter = (
	rawText: string,
	context: PromptPillFormatContext,
) => string | PromptPillFormatResult;

export interface PromptCardHitBox {
	readonly y: number;
	readonly xStart: number;
	readonly xEnd: number;
}

export interface PromptPillHitTarget extends PromptCardHitBox {
	readonly id: string;
	readonly onClick?: (screenX: number, screenY: number) => void;
}

export interface RenderUserPromptCardOptions {
	readonly formattedTime?: string;
	readonly hovered?: boolean;
	readonly copied?: boolean;
	readonly showCopyBadge?: boolean;
	readonly maxContentLines?: number;
	readonly isExpandedSticky?: boolean;
	readonly turnOrdinal?: number;
	readonly bottomHairline?: boolean;
	readonly compactRibbon?: boolean;
	readonly surface: "transcript" | "sticky";
	readonly messageId?: string;
	readonly timestamp?: number | string;
}

export interface RenderedUserPromptCard {
	readonly lines: string[];
	readonly totalContentLines: number;
	readonly hiddenLineCount: number;
	readonly truncated: boolean;
	readonly copyHit?: PromptCardHitBox;
	readonly pillHits: readonly PromptPillHitTarget[];
}

interface FormatterSlot {
	formatter?: PromptPillFormatter;
}

function getFormatterSlot(): FormatterSlot {
	const g = globalThis as Record<symbol, FormatterSlot | undefined>;
	if (!g[PILL_FORMATTER_KEY]) {
		g[PILL_FORMATTER_KEY] = {};
	}
	return g[PILL_FORMATTER_KEY]!;
}

export function registerPromptPillFormatter(formatter: PromptPillFormatter | undefined): () => void {
	const slot = getFormatterSlot();
	slot.formatter = formatter;
	return () => {
		if (slot.formatter === formatter) {
			slot.formatter = undefined;
		}
	};
}

export function getPromptPillFormatter(): PromptPillFormatter | undefined {
	return getFormatterSlot().formatter;
}

export function clearUserPromptCopyTimers(): void {
	userPromptCopyTimers.clearAll();
}

export function recordPendingUserMessageTimestamp(ts = Date.now()): void {
	const g = globalThis as Record<symbol, number[] | undefined>;
	if (!g[PENDING_USER_TS_KEY]) {
		g[PENDING_USER_TS_KEY] = [];
	}
	const queue = g[PENDING_USER_TS_KEY]!;
	queue.push(ts);
	if (queue.length > 64) {
		queue.splice(0, queue.length - 64);
	}
}

export function clearPendingUserMessageTimestamps(): void {
	const g = globalThis as Record<symbol, number[] | undefined>;
	if (g[PENDING_USER_TS_KEY]) {
		g[PENDING_USER_TS_KEY]!.length = 0;
	}
}

function consumePendingUserMessageTimestamp(): number | undefined {
	const g = globalThis as Record<symbol, number[] | undefined>;
	return g[PENDING_USER_TS_KEY]?.shift();
}

function resolveFallbackTimestampFromBranch(self: unknown): number | string | undefined {
	const runtime = getActiveHostRuntime();
	const chatRoot = runtime?.chatContainer;
	const entries = runtime?.ctx.sessionManager?.getBranch?.();
	if (!chatRoot || !Array.isArray(entries) || entries.length === 0) return undefined;

	const userEntries = entries.filter(
		(e: any) => e?.type === "message" && e.message?.role === "user",
	);
	if (userEntries.length === 0) return undefined;

	const mountedCards: unknown[] = [];
	const collect = (node: any): void => {
		if (!node) return;
		if (node instanceof UserMessageComponent) {
			mountedCards.push(node);
			return;
		}
		if (Array.isArray(node.children)) {
			for (const child of node.children) collect(child);
		}
	};
	collect(chatRoot);

	const cardIdx = mountedCards.indexOf(self);
	if (cardIdx === -1) return undefined;

	const tailOffset = Math.max(0, userEntries.length - mountedCards.length);
	const entryIdx = cardIdx + tailOffset;
	const matched: any =
		entryIdx >= 0 && entryIdx < userEntries.length ? userEntries[entryIdx] : undefined;
	return matched?.message?.timestamp ?? matched?.timestamp;
}

/* Оборачивает стилизованные пилюли во временные OSC 8 маркеры до переноса строк, чтобы не путать их с обычным текстом */
function tagFormattedPillsWithOsc8(
	text: string,
	pills: readonly PromptPillDescriptor[],
): string {
	if (pills.length === 0) return text;
	let result = text;
	let searchPos = 0;

	for (let idx = 0; idx < pills.length; idx++) {
		const label = pills[idx]!.label;
		if (!label) continue;

		let chosenStart = -1;
		let chosenEnd = -1;
		let fallbackIdx = -1;
		let cursor = searchPos;

		while (cursor <= result.length - label.length) {
			const found = result.indexOf(label, cursor);
			if (found === -1) break;
			if (fallbackIdx === -1) fallbackIdx = found;

			const beforeSlice = result.slice(searchPos, found);
			const leadingMatch = /((?:\x1b\[[0-9;]*m)+ ?)$/.exec(beforeSlice);
			if (leadingMatch) {
				const afterSlice = result.slice(found + label.length);
				const trailingMatch = /^( ?(?:\x1b\[[0-9;]*m)+)/.exec(afterSlice);
				chosenStart = found - leadingMatch[1]!.length;
				chosenEnd = found + label.length + (trailingMatch ? trailingMatch[1]!.length : 0);
				break;
			}
			cursor = found + label.length;
		}

		if (chosenStart === -1 && fallbackIdx !== -1) {
			chosenStart = fallbackIdx;
			chosenEnd = fallbackIdx + label.length;
		}
		if (chosenStart === -1) continue;

		const openSeq = `${PILL_OSC8_OPEN_PREFIX}${idx}\x07`;
		result =
			result.slice(0, chosenStart) +
			openSeq +
			result.slice(chosenStart, chosenEnd) +
			PILL_OSC8_CLOSE +
			result.slice(chosenEnd);
		searchPos = chosenEnd + openSeq.length + PILL_OSC8_CLOSE.length;
	}

	return result;
}

function extractAndStripPillHits(
	rowBody: string,
	rowY: number,
	prefixWidth: number,
	pills: readonly PromptPillDescriptor[],
): { cleanedRow: string; hits: PromptPillHitTarget[] } {
	if (pills.length === 0 || !rowBody.includes(PILL_OSC8_OPEN_PREFIX)) {
		return { cleanedRow: rowBody, hits: [] };
	}

	const hits: PromptPillHitTarget[] = [];
	let cleanedRow = "";
	let col = 0;
	let activePill: { idx: number; startCol: number } | undefined;
	let i = 0;

	while (i < rowBody.length) {
		const escAt = rowBody.indexOf("\x1b", i);
		if (escAt === -1) {
			const tail = rowBody.slice(i);
			cleanedRow += tail;
			col += visibleWidth(tail);
			break;
		}
		if (escAt > i) {
			const chunk = rowBody.slice(i, escAt);
			cleanedRow += chunk;
			col += visibleWidth(chunk);
			i = escAt;
		}

		const pillOpen = /^\x1b\]8;;conarti-pill:(\d+)(?:\x07|\x1b\\)/.exec(rowBody.slice(i));
		if (pillOpen) {
			activePill = { idx: Number.parseInt(pillOpen[1]!, 10), startCol: col };
			i += pillOpen[0].length;
			continue;
		}

		const pillClose = /^\x1b\]8;;(?:\x07|\x1b\\)/.exec(rowBody.slice(i));
		if (pillClose && activePill !== undefined) {
			const desc = pills[activePill.idx];
			if (desc && col > activePill.startCol) {
				hits.push({
					id: desc.id,
					y: rowY,
					xStart: prefixWidth + activePill.startCol,
					xEnd: prefixWidth + col,
					onClick: desc.onClick,
				});
			}
			activePill = undefined;
			i += pillClose[0].length;
			continue;
		}

		const anyEsc = /^\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/.exec(
			rowBody.slice(i),
		);
		if (anyEsc) {
			cleanedRow += anyEsc[0];
			i += anyEsc[0].length;
			continue;
		}

		cleanedRow += rowBody[i]!;
		col += 1;
		i += 1;
	}

	if (activePill !== undefined) {
		const desc = pills[activePill.idx];
		if (desc && col > activePill.startCol) {
			hits.push({
				id: desc.id,
				y: rowY,
				xStart: prefixWidth + activePill.startCol,
				xEnd: prefixWidth + col,
				onClick: desc.onClick,
			});
		}
	}

	return { cleanedRow, hits };
}

function styleBodyPreservingPills(line: string, rgb: RgbTuple): string {
	const fgEsc = `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	const patched = line
		.replace(/\x1b\[0m/g, `\x1b[0m${fgEsc}`)
		.replace(/\x1b\[39m/g, fgEsc);
	return `${fgEsc}${patched}\x1b[39m`;
}

function renderLegacyUserPromptCardLines(
	cleanRaw: string,
	width: number,
	theme: Theme,
	options: RenderUserPromptCardOptions,
): RenderedUserPromptCard {
	const light = isLightTheme(theme);
	const surfaceRgb: RgbTuple = light
		? options.hovered
			? [228, 238, 252]
			: [237, 243, 252]
		: options.hovered
			? [33, 43, 60]
			: [27, 35, 50];

	const chevronRgb: RgbTuple = light
		? options.hovered
			? [29, 78, 216]
			: [37, 99, 235]
		: options.hovered
			? [125, 207, 255]
			: [97, 175, 239];
	const bodyRgb: RgbTuple = light ? [30, 41, 59] : [220, 229, 242];
	const dimRgb: RgbTuple = light ? [100, 116, 139] : [124, 138, 160];

	const formatter = getPromptPillFormatter();
	let formattedText = cleanRaw;
	let pillDescriptors: readonly PromptPillDescriptor[] = [];
	if (formatter) {
		const res = formatter(cleanRaw, {
			theme,
			isLight: light,
			surfaceRgb,
			messageId: options.messageId,
			timestamp: options.timestamp,
			surface: options.surface,
		});
		if (typeof res === "string") {
			formattedText = res;
		} else {
			formattedText = res.text;
			pillDescriptors = res.pills ?? [];
		}
	}

	const leftPad = width >= 32 ? "  " : " ";
	const rightPad = width >= 32 ? "  " : " ";
	const firstPrefix = `${leftPad}${fgRgb(chevronRgb, "› ")}`;
	const prefixWidth = leftPad.length + 2;
	const nextPrefix = " ".repeat(prefixWidth);

	const timeGutterWidth = width >= 32 ? 9 : width >= 22 ? 7 : 0;
	const textAvail = Math.max(4, width - prefixWidth - timeGutterWidth);

	const taggedText = tagFormattedPillsWithOsc8(formattedText, pillDescriptors);
	const wrappedRows: string[] = [];
	for (const logical of taggedText.split("\n")) {
		const chunks = wrapTextWithAnsi(logical, textAvail);
		for (const chunk of chunks.length > 0 ? chunks : [""]) {
			wrappedRows.push(chunk);
		}
	}

	const totalContentLines = wrappedRows.length;
	let truncated = false;
	let visibleRows = wrappedRows;
	if (options.maxContentLines !== undefined && wrappedRows.length > options.maxContentLines) {
		truncated = true;
		visibleRows = wrappedRows.slice(0, options.maxContentLines);
		const lastIdx = visibleRows.length - 1;
		if (lastIdx >= 0) {
			const trimmedLast = visibleRows[lastIdx]!.replace(/\s+$/, "");
			if (visibleWidth(trimmedLast) + 1 <= textAvail) {
				visibleRows[lastIdx] = `${trimmedLast}${fgRgb(dimRgb, "…")}`;
			} else {
				visibleRows[lastIdx] = `${truncateToWidth(trimmedLast, Math.max(1, textAvail - 1), "")}${fgRgb(dimRgb, "…")}`;
			}
		}
	}

	const lines: string[] = [];
	let copyHit: PromptCardHitBox | undefined;

	if (options.showCopyBadge && (options.hovered || options.copied) && width >= 20) {
		const rawLabel = options.copied ? "✓ Copied" : "Copy";
		const styledLabel = options.copied
			? fgRgb(light ? [21, 128, 61] : [140, 194, 101], rawLabel)
			: fgRgb(light ? [71, 85, 105] : [148, 168, 198], rawLabel);
		const labelWidth = visibleWidth(rawLabel);
		const padCount = Math.max(0, width - labelWidth - rightPad.length);
		copyHit = {
			y: 0,
			xStart: Math.max(0, padCount - 1),
			xEnd: Math.min(width - 1, padCount + labelWidth),
		};
		lines.push(
			paintSurfaceRow(
				`${" ".repeat(padCount)}${styledLabel}${rightPad}`,
				width,
				surfaceRgb[0],
				surfaceRgb[1],
				surfaceRgb[2],
			),
		);
	} else {
		lines.push(paintSurfaceRow("", width, surfaceRgb[0], surfaceRgb[1], surfaceRgb[2]));
	}

	const pillHits: PromptPillHitTarget[] = [];

	for (let i = 0; i < visibleRows.length; i++) {
		const prefix = i === 0 ? firstPrefix : nextPrefix;
		const { cleanedRow, hits } = extractAndStripPillHits(
			visibleRows[i]!,
			i + 1,
			prefixWidth,
			pillDescriptors,
		);
		if (hits.length > 0) {
			pillHits.push(...hits);
		}
		const styledBody = styleBodyPreservingPills(cleanedRow, bodyRgb);

		const timeStr = i === 0 && options.formattedTime && timeGutterWidth > 0 ? options.formattedTime : "";
		const rightStyled = timeStr ? `${fgRgb(dimRgb, timeStr)}${rightPad}` : "";
		const gap = " ".repeat(
			Math.max(0, width - prefixWidth - visibleWidth(styledBody) - visibleWidth(rightStyled)),
		);
		lines.push(
			paintSurfaceRow(
				`${prefix}${styledBody}${gap}${rightStyled}`,
				width,
				surfaceRgb[0],
				surfaceRgb[1],
				surfaceRgb[2],
			),
		);
	}

	lines.push(paintSurfaceRow("", width, surfaceRgb[0], surfaceRgb[1], surfaceRgb[2]));

	return {
		lines,
		totalContentLines,
		hiddenLineCount: Math.max(0, totalContentLines - visibleRows.length),
		truncated,
		copyHit,
		pillHits,
	};
}

export function renderUserPromptCardLines(
	rawInputText: string,
	width: number,
	theme: Theme,
	options: RenderUserPromptCardOptions,
): RenderedUserPromptCard {
	const cleanRaw = sanitizeTurnText(rawInputText).replace(/\t/g, "  ").trim();
	if (!cleanRaw || width < 12) {
		return {
			lines: [],
			totalContentLines: 0,
			hiddenLineCount: 0,
			truncated: false,
			pillHits: [],
		};
	}

	const variant = getPrototypeVariant();
	if (variant === "off") {
		return renderLegacyUserPromptCardLines(cleanRaw, width, theme, options);
	}

	const palette = getThemeSurfacePalette(theme);
	const light = palette.isLight;
	const surfaceRgb: RgbTuple = options.hovered ? palette.userCardHoverBg : palette.userCardBg;
	const chevronRgb: RgbTuple = options.hovered ? palette.accentBright : palette.accent;
	const bodyRgb: RgbTuple = light ? [24, 33, 47] : [224, 232, 245];
	const dimRgb: RgbTuple = palette.codeMetaFg;

	/* 1. Extract <skill name="..."> blocks into clickable thematic Skill Chips */
	const skillExtraction = extractSkillInvocations(cleanRaw);
	const skillDescriptors: PromptPillDescriptor[] = [];
	const styledSkills: string[] = [];
	for (const skill of skillExtraction.skills) {
		const renderedSkill = renderStyledSkillChip(skill.name, variant, theme);
		styledSkills.push(renderedSkill.styled);
		skillDescriptors.push({
			id: skill.id,
			label: renderedSkill.plainLabel,
			onClick: (sx, sy) => toggleSkillPreviewPopup(skill, sx, sy),
		});
	}

	/* 2. Format Prompt Chips ([Image #N], [Pasted #N], [Quote #N]) on the user's message text */
	const formatter = getPromptPillFormatter();
	let formattedUserBody = skillExtraction.userText;
	let promptChipDescriptors: readonly PromptPillDescriptor[] = [];
	if (formatter && formattedUserBody) {
		const res = formatter(formattedUserBody, {
			theme,
			isLight: light,
			surfaceRgb,
			messageId: options.messageId,
			timestamp: options.timestamp,
			surface: options.surface,
		});
		if (typeof res === "string") {
			formattedUserBody = res;
		} else {
			formattedUserBody = res.text;
			promptChipDescriptors = res.pills ?? [];
		}
	}

	const allPills: PromptPillDescriptor[] = [...skillDescriptors, ...promptChipDescriptors];

	let combinedText: string;
	if (styledSkills.length > 0 && formattedUserBody) {
		if (variant === "B" && !options.compactRibbon) {
			combinedText = `${styledSkills.join(" ")}\n${formattedUserBody}`;
		} else {
			combinedText = `${styledSkills.join(" ")} ${formattedUserBody}`;
		}
	} else if (styledSkills.length > 0) {
		combinedText = styledSkills.join(" ");
	} else {
		combinedText = formattedUserBody;
	}

	/* 4-column right plumb line aligns HH:MM & Copy clear of Outline Rail (width-3..width-2) + scrollbar (width-1) */
	const rightGuard = width >= 48 ? 4 : width >= 32 ? 2 : 1;
	const rightPad = " ".repeat(rightGuard);

	const hasLeftBar = variant === "B";
	const edgeBar = hasLeftBar ? themeFgRgb(theme, chevronRgb, "▎") : "";
	const padBar = hasLeftBar ? themeFgRgb(theme, palette.borderSubtle, "▎") : "";

	const ordinalPrefix =
		options.surface === "sticky" && variant === "B" && options.turnOrdinal !== undefined
			? `${themeFgRgb(theme, dimRgb, `#${options.turnOrdinal}`)} `
			: "";

	const firstPrefix = hasLeftBar
		? ` ${edgeBar} ${ordinalPrefix}${themeFgRgb(theme, chevronRgb, "› ")}`
		: `  ${ordinalPrefix}${themeFgRgb(theme, chevronRgb, "› ")}`;
	const prefixWidth = visibleWidth(firstPrefix);
	const nextPrefix = hasLeftBar
		? ` ${edgeBar}${" ".repeat(Math.max(1, prefixWidth - 2))}`
		: " ".repeat(prefixWidth);

	/* Fixed meta gutter reserves room so hover Copy never shifts text wrapping by even 1 column */
	const metaGutterWidth =
		width >= 56
			? variant === "A"
				? 14 + rightGuard
				: 10 + rightGuard
			: width >= 34
				? 7 + rightGuard
				: 0;
	const textAvail = Math.max(6, width - prefixWidth - metaGutterWidth);

	const taggedText = tagFormattedPillsWithOsc8(combinedText, allPills);

	/* Variant C collapsed Sticky Prompt: ultra-slim 1-line condensed ribbon */
	if (options.compactRibbon) {
		const singleLogical = taggedText.replace(/\n+/g, "  ").trim();
		const fullWrapped = wrapTextWithAnsi(singleLogical, textAvail);
		const totalContentLines = Math.max(1, fullWrapped.length);
		const truncated = totalContentLines > 1;
		const hiddenLineCount = Math.max(0, totalContentLines - 1);

		let firstLine = fullWrapped[0] ?? "";
		if (truncated) {
			const foldTag = ` · +${hiddenLineCount} ▾`;
			const maxSlice = Math.max(4, textAvail - visibleWidth(foldTag));
			const baseClip =
				visibleWidth(firstLine) > maxSlice
					? truncateToWidth(firstLine, maxSlice, "…")
					: firstLine;
			firstLine = `${baseClip}${themeFgRgb(theme, chevronRgb, foldTag)}`;
		}

		const { cleanedRow, hits } = extractAndStripPillHits(firstLine, 0, prefixWidth, allPills);
		const styledBody = styleBodyPreservingPills(cleanedRow, bodyRgb);
		const timeStr = options.formattedTime && metaGutterWidth > 0 ? options.formattedTime : "";
		const rightStyled = timeStr ? `${themeFgRgb(theme, dimRgb, timeStr)}${rightPad}` : "";
		const gap = " ".repeat(
			Math.max(0, width - prefixWidth - visibleWidth(styledBody) - visibleWidth(rightStyled)),
		);
		const ribbonRow = paintThemeSurfaceRow(
			theme,
			`${firstPrefix}${styledBody}${gap}${rightStyled}`,
			width,
			surfaceRgb,
		);
		return {
			lines: [ribbonRow],
			totalContentLines,
			hiddenLineCount,
			truncated,
			pillHits: hits,
		};
	}

	const wrappedRows: string[] = [];
	for (const logical of taggedText.split("\n")) {
		const chunks = wrapTextWithAnsi(logical, textAvail);
		for (const chunk of chunks.length > 0 ? chunks : [""]) {
			wrappedRows.push(chunk);
		}
	}

	const totalContentLines = wrappedRows.length;
	let truncated = false;
	let visibleRows = wrappedRows;
	if (options.maxContentLines !== undefined && wrappedRows.length > options.maxContentLines) {
		truncated = true;
		visibleRows = wrappedRows.slice(0, options.maxContentLines);
		const hidden = wrappedRows.length - visibleRows.length;
		const lastIdx = visibleRows.length - 1;
		if (lastIdx >= 0) {
			const foldHint =
				options.surface === "sticky"
					? ` · +${hidden} ${hidden === 1 ? "line" : "lines"} ▾`
					: "…";
			const hintW = visibleWidth(foldHint);
			const trimmedLast = visibleRows[lastIdx]!.replace(/\s+$/, "");
			const styledHint = themeFgRgb(
				theme,
				options.hovered ? chevronRgb : dimRgb,
				foldHint,
			);
			if (visibleWidth(trimmedLast) + hintW <= textAvail) {
				visibleRows[lastIdx] = `${trimmedLast}${styledHint}`;
			} else {
				visibleRows[lastIdx] = `${truncateToWidth(trimmedLast, Math.max(1, textAvail - hintW), "")}${styledHint}`;
			}
		}
	} else if (options.surface === "sticky" && options.isExpandedSticky && visibleRows.length > 0) {
		const collapseHint = "  ▴ Collapse";
		const lastIdx = visibleRows.length - 1;
		const trimmedLast = visibleRows[lastIdx]!.replace(/\s+$/, "");
		if (visibleWidth(trimmedLast) + visibleWidth(collapseHint) <= textAvail) {
			visibleRows[lastIdx] = `${trimmedLast}${themeFgRgb(theme, chevronRgb, collapseHint)}`;
		}
	}

	const hiddenLineCount = Math.max(0, totalContentLines - visibleRows.length);

	/* Vertical padding: A & B keep pure-air vpad=1; C uses compact vpad=0 on 1-2 line prompts */
	const useVpad =
		variant === "C"
			? visibleRows.length >= 3 && options.surface === "transcript"
			: options.surface === "sticky" && variant === "A"
				? false
				: true;

	const lines: string[] = [];
	const topPadRows = useVpad ? 1 : 0;
	if (topPadRows > 0) {
		lines.push(
			paintThemeSurfaceRow(
				theme,
				hasLeftBar ? ` ${padBar}` : "",
				width,
				surfaceRgb,
			),
		);
	}

	let copyHit: PromptCardHitBox | undefined;
	const pillHits: PromptPillHitTarget[] = [];

	for (let i = 0; i < visibleRows.length; i++) {
		const rowY = topPadRows + i;
		const prefix = i === 0 ? firstPrefix : nextPrefix;
		const { cleanedRow, hits } = extractAndStripPillHits(
			visibleRows[i]!,
			rowY,
			prefixWidth,
			allPills,
		);
		if (hits.length > 0) {
			pillHits.push(...hits);
		}
		const styledBody = styleBodyPreservingPills(cleanedRow, bodyRgb);

		let rightStyled = "";
		if (i === 0 && metaGutterWidth > 0) {
			const timeStr = options.formattedTime ?? "";
			const showCopy =
				Boolean(options.showCopyBadge) && Boolean(options.hovered || options.copied) && width >= 36;

			if (showCopy) {
				if (variant === "A") {
					const copyText = options.copied ? "✓ Copied" : "Copy";
					const styledCopy = options.copied
						? themeFgRgb(theme, palette.success, copyText)
						: themeFgRgb(theme, chevronRgb, copyText);
					const timeSuffix =
						timeStr && width >= 56
							? `${themeFgRgb(theme, dimRgb, " · ")}${themeFgRgb(theme, dimRgb, timeStr)}`
							: "";
					rightStyled = `${styledCopy}${timeSuffix}${rightPad}`;
					const totalRightW = visibleWidth(rightStyled);
					const copyStart = width - totalRightW;
					copyHit = {
						y: rowY,
						xStart: Math.max(0, copyStart - 1),
						xEnd: Math.min(width - 1, copyStart + visibleWidth(copyText)),
					};
				} else {
					const copyText = options.copied
						? "✓ Copied"
						: variant === "B"
							? "[Copy]"
							: "Copy";
					const styledCopy = options.copied
						? themeFgRgb(theme, palette.success, copyText)
						: themeFgRgb(theme, chevronRgb, copyText);
					rightStyled = `${styledCopy}${rightPad}`;
					const copyStart = width - visibleWidth(rightStyled);
					copyHit = {
						y: rowY,
						xStart: Math.max(0, copyStart - 1),
						xEnd: Math.min(width - 1, copyStart + visibleWidth(copyText)),
					};
				}
			} else if (timeStr) {
				rightStyled = `${themeFgRgb(theme, dimRgb, timeStr)}${rightPad}`;
			}
		}

		const gap = " ".repeat(
			Math.max(0, width - prefixWidth - visibleWidth(styledBody) - visibleWidth(rightStyled)),
		);
		lines.push(
			paintThemeSurfaceRow(
				theme,
				`${prefix}${styledBody}${gap}${rightStyled}`,
				width,
				surfaceRgb,
			),
		);
	}

	if (options.bottomHairline) {
		lines.push(
			paintThemeSurfaceRow(
				theme,
				themeFgRgb(theme, palette.borderSubtle, "─".repeat(width)),
				width,
				surfaceRgb,
			),
		);
	} else if (useVpad) {
		lines.push(
			paintThemeSurfaceRow(
				theme,
				hasLeftBar ? ` ${padBar}` : "",
				width,
				surfaceRgb,
			),
		);
	}

	return {
		lines,
		totalContentLines,
		hiddenLineCount,
		truncated,
		copyHit,
		pillHits,
	};
}

function serializeSkillBlockTag(skillBlock: {
	name?: string;
	location?: string;
	content?: string;
}): string {
	const name = String(skillBlock.name ?? "skill").trim();
	const loc = skillBlock.location ? ` location="${skillBlock.location}"` : "";
	const body = String(skillBlock.content ?? "");
	return `<skill name="${name}"${loc}>\n${body}\n</skill>`;
}

export function resolvePrecedingSkillTagForUserComponent(self: unknown): string | undefined {
	const children = (getActiveHostRuntime()?.chatContainer as { children?: any[] } | undefined)?.children;
	if (!Array.isArray(children)) return undefined;
	const idx = children.indexOf(self);
	if (idx <= 0) return undefined;

	for (let k = idx - 1; k >= Math.max(0, idx - 3); k--) {
		const prev = children[k];
		if (!prev) continue;
		if (prev instanceof SkillInvocationMessageComponent) {
			const sb = (prev as any).skillBlock;
			if (sb?.name && sb?.userMessage) {
				return serializeSkillBlockTag(sb);
			}
			return undefined;
		}
		const prevName = prev.constructor?.name;
		if (prevName === "Spacer") continue;
		break;
	}
	return undefined;
}

export function installUserPromptCards(): void {
	const proto = UserMessageComponent.prototype as any;
	const skillProto = (SkillInvocationMessageComponent as unknown as { prototype?: any } | undefined)
		?.prototype;
	const interactiveProto = (InteractiveMode as unknown as { prototype?: object } | undefined)?.prototype;

	/* Подставляем метку чипа изображения для реплик без текстовых блоков, чтобы InteractiveMode монтировал карточку в транскрипт */
	if (interactiveProto) {
		hookMethod(
			interactiveProto,
			"getUserMessageText",
			"transcript.userMessageTextFallback",
			(self, args, original) => {
				const text = String(original.apply(self, args) ?? "");
				if (text.trim().length > 0) return text;
				const msg = args[0] as { role?: string; content?: unknown } | undefined;
				if (msg?.role !== "user" || !Array.isArray(msg.content)) return text;
				let imageCount = 0;
				for (const block of msg.content) {
					if (block && typeof block === "object" && (block as { type?: string }).type === "image") {
						imageCount += 1;
					}
				}
				if (imageCount <= 0) return text;
				return Array.from({ length: imageCount }, (_, idx) => `[🖼 Image #${idx + 1}]`).join(" ");
			},
		);
	}

	hookMethod(
		proto,
		"rebuild",
		"transcript.userPromptRebuild",
		(self, args, original) => {
			if (self.timestamp === undefined) {
				const pendingTs = consumePendingUserMessageTimestamp();
				if (pendingTs !== undefined) {
					self.timestamp = pendingTs;
				}
			}
			return original.apply(self, args);
		},
	);

	hookMethod(
		proto,
		"render",
		"transcript.userPromptRender",
		(self, args) => {
			const width = args[0] as number;
			const baseText = String(self.text ?? "").trim();
			if (!baseText || width < 12) return [];

			const precedingSkill =
				getPrototypeVariant() !== "off"
					? resolvePrecedingSkillTagForUserComponent(self)
					: undefined;
			const rawText = precedingSkill ? `${precedingSkill}\n\n${baseText}` : baseText;

			const theme = getActiveGlobalTheme(self?.theme);
			const effectiveTs = self.timestamp ?? resolveFallbackTimestampFromBranch(self);
			const formattedTime = formatTurnTime(effectiveTs);

			const rendered = renderUserPromptCardLines(rawText, width, theme, {
				formattedTime,
				hovered: Boolean(self.__conartiHovered),
				copied: Boolean(self.__conartiCopied),
				showCopyBadge: true,
				surface: "transcript",
				messageId: self.messageId !== undefined ? String(self.messageId) : undefined,
				timestamp: effectiveTs,
			});

			self.__conartiCopyHit = rendered.copyHit;
			self.__conartiPillHits = rendered.pillHits;

			const out = rendered.lines;
			if (out.length > 0) {
				out[0] = OSC133_ZONE_START + out[0];
				out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
			}
			return out;
		},
		["pi.grok-ui.hook.chat.userPromptRender"],
	);

	hookMethod(
		proto,
		"handleMouse",
		"transcript.userPromptMouse",
		(self, args) => {
			const event = args[0] as TuiMouseEvent;

			if (event.type === "move") {
				claimHover(self, () => {
					if (self.__conartiHovered) {
						self.__conartiHovered = false;
						requestRender();
					}
				});
				if (!self.__conartiHovered) {
					self.__conartiHovered = true;
					return { handled: true, render: true };
				}
				return undefined;
			}

			const copyHit = self.__conartiCopyHit as PromptCardHitBox | undefined;
			const pillHits = (self.__conartiPillHits as readonly PromptPillHitTarget[] | undefined) ?? [];
			const matchedCopy =
				copyHit && event.y === copyHit.y && event.x >= copyHit.xStart && event.x <= copyHit.xEnd;
			const matchedPill = pillHits.find(
				(hit) => event.y === hit.y && event.x >= hit.xStart && event.x < hit.xEnd,
			);

			if (event.type === "press" && event.button === "left" && (matchedCopy || matchedPill)) {
				return { handled: true, render: false };
			}

			if (event.type === "click" && event.button === "left") {
				if (matchedCopy) {
					const baseRaw = sanitizeTurnText(String(self.text ?? "")).trim();
					const precedingSkill =
						getPrototypeVariant() !== "off"
							? resolvePrecedingSkillTagForUserComponent(self)
							: undefined;
					const combinedRaw = precedingSkill ? `${precedingSkill}\n\n${baseRaw}` : baseRaw;
					const cleanCopy =
						getPrototypeVariant() !== "off"
							? extractSkillInvocations(combinedRaw).cleanCopyText
							: baseRaw;
					copyToClipboard(cleanCopy);
					self.__conartiCopied = true;
					requestRender();
					userPromptCopyTimers.arm(self, (target) => {
						target.__conartiCopied = false;
						requestRender();
					});
					return { handled: true, render: true };
				}
				if (matchedPill) {
					matchedPill.onClick?.(event.screenX, event.screenY);
					return { handled: true, render: true };
				}
			}

			return undefined;
		},
		["pi.grok-ui.hook.chat.userPromptMouse"],
	);

	/* Absorb SkillInvocationMessageComponent into User Prompt Skill Chips in prototype mode */
	if (skillProto) {
		hookMethod(
			skillProto,
			"render",
			"transcript.skillInvocationRender",
			(self, args, original) => {
				if (getPrototypeVariant() === "off") {
					return original.apply(self, args);
				}
				const sb = self?.skillBlock;
				if (!sb?.name) {
					return original.apply(self, args);
				}
				/* When accompanied by userMessage, the sibling UserMessageComponent renders the Skill Chip */
				if (sb.userMessage) {
					return [];
				}
				const width = args[0] as number;
				if (width < 12) return [];
				const theme = getActiveGlobalTheme(self?.theme);
				const effectiveTs = self.timestamp;
				const formattedTime = formatTurnTime(effectiveTs);
				const syntheticRaw = serializeSkillBlockTag(sb);
				const rendered = renderUserPromptCardLines(syntheticRaw, width, theme, {
					formattedTime,
					hovered: Boolean(self.__conartiHovered),
					copied: Boolean(self.__conartiCopied),
					showCopyBadge: true,
					surface: "transcript",
					messageId: self.messageId !== undefined ? String(self.messageId) : undefined,
					timestamp: effectiveTs,
				});
				self.__conartiCopyHit = rendered.copyHit;
				self.__conartiPillHits = rendered.pillHits;
				return rendered.lines;
			},
		);

		hookMethod(
			skillProto,
			"handleMouse",
			"transcript.skillInvocationMouse",
			(self, args, original) => {
				if (getPrototypeVariant() === "off") {
					return original ? original.apply(self, args) : undefined;
				}
				const sb = self?.skillBlock;
				if (!sb?.name || sb.userMessage) return undefined;
				const event = args[0] as TuiMouseEvent;

				if (event.type === "move") {
					claimHover(self, () => {
						if (self.__conartiHovered) {
							self.__conartiHovered = false;
							requestRender();
						}
					});
					if (!self.__conartiHovered) {
						self.__conartiHovered = true;
						return { handled: true, render: true };
					}
					return undefined;
				}

				const copyHit = self.__conartiCopyHit as PromptCardHitBox | undefined;
				const pillHits = (self.__conartiPillHits as readonly PromptPillHitTarget[] | undefined) ?? [];
				const matchedCopy =
					copyHit && event.y === copyHit.y && event.x >= copyHit.xStart && event.x <= copyHit.xEnd;
				const matchedPill = pillHits.find(
					(hit) => event.y === hit.y && event.x >= hit.xStart && event.x < hit.xEnd,
				);

				if (event.type === "press" && event.button === "left" && (matchedCopy || matchedPill)) {
					return { handled: true, render: false };
				}

				if (event.type === "click" && event.button === "left") {
					if (matchedCopy) {
						copyToClipboard(`/skill:${String(sb.name).trim()}`);
						self.__conartiCopied = true;
						requestRender();
						userPromptCopyTimers.arm(self, (target) => {
							target.__conartiCopied = false;
							requestRender();
						});
						return { handled: true, render: true };
					}
					if (matchedPill) {
						matchedPill.onClick?.(event.screenX, event.screenY);
						return { handled: true, render: true };
					}
				}
				return undefined;
			},
		);
	}
}
