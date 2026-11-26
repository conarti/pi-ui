import {
	InteractiveMode,
	SkillInvocationMessageComponent,
	UserMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Spacer,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	getActiveGlobalTheme,
	getThemeSurfacePalette,
	paintThemeSurfaceRow,
	themeFgRgb,
	type RgbTuple,
} from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
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
	serializeSkillBlockTag,
	toggleSkillPreviewPopup,
} from "../../shared/skill-tags.ts";
import { formatTurnTime, sanitizeTurnText } from "../../shared/turn-index.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";

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
	readonly surface: "transcript" | "sticky";
	readonly messageId?: string;
	readonly timestamp?: number | string;
}

export interface RenderedUserPromptCard {
	readonly lines: string[];
	readonly totalContentLines: number;
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

export function recordPendingUserMessageTimestamp(timestamp: number | string | undefined): void {
	if (timestamp === undefined) return;
	const g = globalThis as Record<symbol, { value?: number | string } | undefined>;
	g[PENDING_USER_TS_KEY] = { value: timestamp };
}

export function clearPendingUserMessageTimestamps(): void {
	const g = globalThis as Record<symbol, { value?: number | string } | undefined>;
	g[PENDING_USER_TS_KEY] = undefined;
}

export function clearUserPromptCopyTimers(): void {
	userPromptCopyTimers.clearAll();
}

function consumePendingUserMessageTimestamp(): number | string | undefined {
	const g = globalThis as Record<symbol, { value?: number | string } | undefined>;
	const current = g[PENDING_USER_TS_KEY]?.value;
	g[PENDING_USER_TS_KEY] = undefined;
	return current;
}

interface HostSkillBlock {
	readonly name?: string;
	readonly location?: string;
	readonly content?: string;
	readonly userMessage?: string;
}

function readSkillBlock(component: unknown): HostSkillBlock | undefined {
	if (!component || typeof component !== "object") return undefined;
	return Reflect.get(component, "skillBlock") as HostSkillBlock | undefined;
}

function resolveFallbackTimestampFromBranch(self: any): number | string | undefined {
	const runtime = getActiveHostRuntime();
	const branch = runtime?.ctx?.sessionManager?.getBranch?.();
	if (!Array.isArray(branch) || branch.length === 0) return undefined;

	const userEntries: any[] = branch.filter(
		(entry: any) => entry?.type === "message" && entry.message?.role === "user",
	);
	if (userEntries.length === 0) return undefined;

	if (self.messageId !== undefined) {
		const byId = userEntries.find((entry: any) => String(entry.id) === String(self.messageId));
		const ts = byId?.message?.timestamp ?? byId?.timestamp;
		if (ts !== undefined) return ts;
	}

	const chatRoot = runtime?.scroll?.children[0] ?? runtime?.chatContainer;
	if (!chatRoot) return undefined;

	const mountedCards: Array<UserMessageComponent | SkillInvocationMessageComponent> = [];
	const collect = (node: any): void => {
		if (!node) return;
		if (node instanceof UserMessageComponent) {
			mountedCards.push(node);
			return;
		}
		if (node instanceof SkillInvocationMessageComponent) {
			const sb = readSkillBlock(node);
			if (sb?.name && !sb.userMessage) {
				mountedCards.push(node);
			}
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
	const matched = entryIdx >= 0 && entryIdx < userEntries.length ? userEntries[entryIdx] : undefined;
	return matched?.message?.timestamp ?? matched?.timestamp;
}

function resolvePrecedingSkillTagForUserComponent(self: any): string | undefined {
	const runtime = getActiveHostRuntime();
	const chatRoot = runtime?.chatContainer ?? runtime?.scroll?.children[0];
	const children = (chatRoot as { children?: unknown[] } | undefined)?.children;
	if (!Array.isArray(children)) return undefined;
	const idx = children.indexOf(self);
	if (idx <= 0) return undefined;
	for (let i = idx - 1; i >= 0; i -= 1) {
		const prev = children[i];
		if (prev instanceof Spacer) continue;
		if (prev instanceof SkillInvocationMessageComponent) {
			const sb = readSkillBlock(prev);
			if (sb?.name) {
				return serializeSkillBlockTag(sb);
			}
		}
		break;
	}
	return undefined;
}

/* Заменяет стилизованные пилюли на неразрывные заглушки той же видимой ширины до wrapTextWithAnsi, чтобы чипы никогда не разрывались по пробелу или «·» */
function protectPillsForWrap(
	text: string,
	pills: readonly PromptPillDescriptor[],
	maxAtomicWidth: number,
): { wrappedInput: string; restore: (row: string) => string } {
	if (pills.length === 0) {
		return { wrappedInput: text, restore: (row) => row };
	}
	const tagged = tagFormattedPillsWithOsc8(text, pills);
	const placeholders = new Map<string, string>();
	let counter = 0;

	const wrappedInput = tagged.replace(
		/\x1b\]8;;conarti-pill:(\d+)\x07([\s\S]*?)\x1b\]8;;\x07/g,
		(full, idxStr: string, inner: string) => {
			const w = visibleWidth(inner);
			if (w < 2 || w > maxAtomicWidth) {
				return full;
			}
			const idTag = counter.toString(36);
			counter += 1;
			/* Маркер состоит из PUA-символов + букв без пробелов и знаков переноса, шириной ровно w */
			const bodyLen = Math.max(0, w - 2 - idTag.length);
			if (w < idTag.length + 2) {
				return full;
			}
			const token = `\uE001${idTag}${"\uE003".repeat(bodyLen)}\uE002`;
			placeholders.set(token, `${PILL_OSC8_OPEN_PREFIX}${idxStr}\x07${inner}${PILL_OSC8_CLOSE}`);
			return token;
		},
	);

	if (placeholders.size === 0) {
		return { wrappedInput: tagged, restore: (row) => row };
	}

	return {
		wrappedInput,
		restore: (row: string) => {
			if (!row.includes("\uE001")) return row;
			return row.replace(/\uE001[0-9a-z]+\uE003*\uE002/g, (tok) => placeholders.get(tok) ?? tok);
		},
	};
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
			truncated: false,
			pillHits: [],
		};
	}

	const palette = getThemeSurfacePalette(theme);
	const light = palette.isLight;
	const surfaceRgb: RgbTuple = options.hovered ? palette.userCardHoverBg : palette.userCardBg;

	const chevronRgb: RgbTuple = options.hovered ? palette.accentBright : palette.accent;
	const bodyRgb: RgbTuple = light ? [30, 41, 59] : [220, 229, 242];
	const dimRgb: RgbTuple = palette.codeMetaFg;

	const cwd = getActiveHostRuntime()?.ctx?.cwd ?? process.cwd();
	const skillExtraction = extractSkillInvocations(cleanRaw, { cwd });
	const skillDescriptors: PromptPillDescriptor[] = [];
	const styledSkills: string[] = [];
	for (const skill of skillExtraction.skills) {
		const renderedSkill = renderStyledSkillChip(skill.name, theme);
		styledSkills.push(renderedSkill.styled);
		skillDescriptors.push({
			id: skill.id,
			label: renderedSkill.plainLabel,
			onClick: (sx, sy) => toggleSkillPreviewPopup(skill, sx, sy),
		});
	}

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

	const pillDescriptors: readonly PromptPillDescriptor[] = [
		...skillDescriptors,
		...promptChipDescriptors,
	];
	let formattedText: string;
	if (styledSkills.length > 0 && formattedUserBody) {
		formattedText = `${styledSkills.join(" ")} ${formattedUserBody}`;
	} else if (styledSkills.length > 0) {
		formattedText = styledSkills.join(" ");
	} else {
		formattedText = formattedUserBody;
	}

	const outerPad = computeOuterCanvasMargin(width);
	const outerMargin = " ".repeat(outerPad);
	const cardWidth = Math.max(12, width - outerPad * 2);

	const leftPad = cardWidth >= 28 ? "  " : " ";
	const rightPad = cardWidth >= 28 ? "  " : " ";
	const firstPrefix = `${leftPad}${themeFgRgb(theme, chevronRgb, "› ")}`;
	const prefixWidth = leftPad.length + 2;
	const nextPrefix = " ".repeat(prefixWidth);

	/* Резервируем фиксированную правую колонку под дату/время и Copy/✓ Copied, чтобы перенос строк не прыгал при наведении */
	const timeText = options.formattedTime ?? "";
	const copySlotWidth = options.showCopyBadge ? 8 : 0;
	const desiredRightSlot = Math.max(visibleWidth(timeText), copySlotWidth);
	const candidateRightGutter = desiredRightSlot > 0 ? desiredRightSlot + rightPad.length + 1 : 0;
	const rightGutterWidth =
		candidateRightGutter > 0 && cardWidth - prefixWidth - candidateRightGutter >= 10
			? candidateRightGutter
			: 0;
	const textAvail = Math.max(4, cardWidth - prefixWidth - rightGutterWidth);

	const { wrappedInput, restore: restoreWrappedPills } = protectPillsForWrap(
		formattedText,
		pillDescriptors,
		textAvail,
	);
	const wrappedRows: string[] = [];
	for (const logical of wrappedInput.split("\n")) {
		const chunks = wrapTextWithAnsi(logical, textAvail);
		for (const chunk of chunks.length > 0 ? chunks : [""]) {
			wrappedRows.push(restoreWrappedPills(chunk));
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
			const trimmedLast = visibleRows[lastIdx]!.replace(/\s+$/, "");
			const foldHint =
				options.surface === "sticky"
					? ` · +${hidden} ${hidden === 1 ? "line" : "lines"} (Alt+s)`
					: "…";
			const hintWidth = visibleWidth(foldHint);
			const styledHint = themeFgRgb(theme, options.hovered ? chevronRgb : dimRgb, foldHint);
			if (visibleWidth(trimmedLast) + hintWidth <= textAvail) {
				visibleRows[lastIdx] = `${trimmedLast}${styledHint}`;
			} else if (hintWidth < textAvail) {
				visibleRows[lastIdx] = `${truncateToWidth(trimmedLast, Math.max(1, textAvail - hintWidth), "")}${styledHint}`;
			} else {
				visibleRows[lastIdx] = `${truncateToWidth(trimmedLast, Math.max(1, textAvail - 1), "")}${themeFgRgb(theme, dimRgb, "…")}`;
			}
		}
	}

	const paintCardRow = (inner: string): string =>
		`${outerMargin}${paintThemeSurfaceRow(theme, inner, cardWidth, surfaceRgb)}${outerMargin}`;

	/* Симметричный vpad = 1: верхняя и нижняя строки карточки всегда остаются пустыми */
	const lines: string[] = [paintCardRow("")];
	let copyHit: PromptCardHitBox | undefined;
	const pillHits: PromptPillHitTarget[] = [];

	for (let i = 0; i < visibleRows.length; i++) {
		const rowY = i + 1;
		const prefix = i === 0 ? firstPrefix : nextPrefix;
		const { cleanedRow, hits } = extractAndStripPillHits(
			visibleRows[i]!,
			rowY,
			outerPad + prefixWidth,
			pillDescriptors,
		);
		if (hits.length > 0) {
			pillHits.push(...hits);
		}
		const styledBody = styleBodyPreservingPills(cleanedRow, bodyRgb);

		let rightStyled = "";
		if (i === 0 && rightGutterWidth > 0) {
			if (options.showCopyBadge && (options.hovered || options.copied)) {
				const rawLabel = options.copied ? "✓ Copied" : "Copy";
				const labelRgb: RgbTuple = options.copied
					? palette.success
					: light
						? palette.accent
						: palette.accentBright;
				const labelWidth = visibleWidth(rawLabel);
				const labelColInCard = Math.max(prefixWidth, cardWidth - rightPad.length - labelWidth);
				copyHit = {
					y: rowY,
					xStart: Math.max(outerPad, outerPad + labelColInCard - 1),
					xEnd: Math.min(outerPad + cardWidth - 1, outerPad + labelColInCard + labelWidth),
				};
				rightStyled = `${themeFgRgb(theme, labelRgb, rawLabel)}${rightPad}`;
			} else if (timeText) {
				rightStyled = `${themeFgRgb(theme, dimRgb, timeText)}${rightPad}`;
			}
		}

		const gap = " ".repeat(
			Math.max(0, cardWidth - prefixWidth - visibleWidth(styledBody) - visibleWidth(rightStyled)),
		);
		lines.push(paintCardRow(`${prefix}${styledBody}${gap}${rightStyled}`));
	}

	lines.push(paintCardRow(""));

	return {
		lines,
		totalContentLines,
		truncated,
		copyHit,
		pillHits,
	};
}

export function installUserPromptCards(): void {
	const proto = UserMessageComponent.prototype as any;
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
			const rawText = String(self.text ?? "").trim();
			const precedingSkill = resolvePrecedingSkillTagForUserComponent(self);
			const combinedRaw = precedingSkill
				? rawText
					? `${precedingSkill}\n\n${rawText}`
					: precedingSkill
				: rawText;
			if (!combinedRaw || width < 12) return [];

			const theme = getActiveGlobalTheme(self?.theme);
			const effectiveTs = self.timestamp ?? resolveFallbackTimestampFromBranch(self);
			const formattedTime = formatTurnTime(effectiveTs);

			const rendered = renderUserPromptCardLines(combinedRaw, width, theme, {
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
					const precedingSkill = resolvePrecedingSkillTagForUserComponent(self);
					const combinedRaw = precedingSkill
						? baseRaw
							? `${precedingSkill}\n\n${baseRaw}`
							: precedingSkill
						: baseRaw;
					copyToClipboard(extractSkillInvocations(combinedRaw).cleanCopyText);
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

	/* Поглощаем хостовые баннеры SkillInvocationMessageComponent в кликабельные пилюли Skill Chip */
	const skillProto = (
		SkillInvocationMessageComponent as unknown as { prototype?: object } | undefined
	)?.prototype;
	if (skillProto) {
		hookMethod(
			skillProto,
			"render",
			"transcript.skillInvocationRender",
			(self, args, original) => {
				const sb = self?.skillBlock;
				if (!sb?.name) {
					return original.apply(self, args);
				}
				/* Когда следом идёт UserMessageComponent, карточка пользователя сама рисует пилюлю навыка */
				if (sb.userMessage) {
					return [];
				}
				const width = args[0] as number;
				if (width < 12) return [];
				const theme = getActiveGlobalTheme(self?.theme);
				const effectiveTs = self.timestamp ?? resolveFallbackTimestampFromBranch(self);
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
				const out = rendered.lines;
				if (out.length > 0) {
					out[0] = OSC133_ZONE_START + out[0];
					out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
				}
				return out;
			},
		);

		hookMethod(
			skillProto,
			"handleMouse",
			"transcript.skillInvocationMouse",
			(self, args) => {
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
