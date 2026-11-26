import { AssistantMessageComponent, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Spacer,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	POLARIS_STAR,
	activateAnimationSurface,
	deactivateAnimationSurface,
	paintBreathingWaveGlyph,
	paintGlimmerSweepText,
	paintPolarisStar,
} from "../../shared/animation-scheduler.ts";
import { fgRgb, getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { t } from "../../shared/i18n.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import { markSelectionChrome } from "../../shared/selection-copy.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";

const MAX_THOUGHTS_WIDTH = 120;
const THINKING_BLOCK_MARKER = Symbol.for("conarti.pi-ui.thinking-block");
const THINKING_WAVE_SURFACE_KEY = "transcript.thinking-wave";
const THINKING_TIMINGS_KEY = Symbol.for("conarti.pi-ui.thinking-timings.v1");
const GLOBAL_THINKING_EXPAND_KEY = Symbol.for("conarti.pi-ui.thinking-expand-all.v1");
const THINKING_DISPLAY_PROVIDER_KEY = Symbol.for("conarti.pi-ui.thinking-display-provider.v1");
const MAX_TRACKED_THINKING_RUNS = 2000;
export const THINKING_DURATION_ENTRY = "pi-ui-thinking-duration";

export const STREAMING_THINKING_PAGE_LINES = 6;
export const STREAMING_THINKING_PAGE_STEP = 3;

export interface ThinkingDisplayProvider {
	transformStreaming?(rawThinking: string, blockKey: string): string;
	transformCompleted?(rawThinking: string, blockKey: string): string;
}

export interface ThinkingWindowState {
	readonly totalLines: number;
	readonly scrollFromBottom: number;
}

export interface ThinkingWindowSlice {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly hiddenAbove: number;
	readonly scrollFromBottom: number;
	readonly isPaused: boolean;
}

export interface ThinkingInteractionSlot {
	hovered: boolean;
	scrollFromBottom: number;
	lastLineCount: number;
}

interface ThinkingRunTiming {
	startedAt: number;
	endedAt?: number;
	signature: string;
	closedByEvent?: boolean;
}

interface SharedThinkingTimingStore {
	byRunKey: Map<string, ThinkingRunTiming>;
	restoredByRunKey: Map<string, ThinkingRunTiming>;
	messageStartedAt: Map<number, number>;
	activeTurnStartedAt?: number;
}

interface GlobalThinkingExpandState {
	expandAll: boolean;
	lastHostHide?: boolean;
}

function getThinkingProviderSlot(): { provider?: ThinkingDisplayProvider } {
	const g = globalThis as Record<symbol, { provider?: ThinkingDisplayProvider } | undefined>;
	if (!g[THINKING_DISPLAY_PROVIDER_KEY]) {
		g[THINKING_DISPLAY_PROVIDER_KEY] = {};
	}
	return g[THINKING_DISPLAY_PROVIDER_KEY]!;
}

export function registerThinkingDisplayProvider(
	provider: ThinkingDisplayProvider | undefined,
): void {
	getThinkingProviderSlot().provider = provider;
}

export function getThinkingDisplayProvider(): ThinkingDisplayProvider | undefined {
	return getThinkingProviderSlot().provider;
}

export function resolveThinkingDisplayText(
	rawThinking: string,
	blockKey: string,
	isStreaming: boolean,
): string {
	const provider = getThinkingProviderSlot().provider;
	if (!provider) return rawThinking;
	try {
		const transformed = isStreaming
			? provider.transformStreaming?.(rawThinking, blockKey)
			: provider.transformCompleted?.(rawThinking, blockKey);
		return typeof transformed === "string" ? transformed : rawThinking;
	} catch {
		return rawThinking;
	}
}

export function computeThinkingWindow(
	totalLines: number,
	scrollFromBottom: number,
	pageSize = STREAMING_THINKING_PAGE_LINES,
	stepSize = STREAMING_THINKING_PAGE_STEP,
): ThinkingWindowSlice {
	const safeTotal = Math.max(0, Math.floor(totalLines));
	const safePage = Math.max(1, Math.floor(pageSize));
	const safeStep = Math.max(1, Math.floor(stepSize));
	if (safeTotal <= safePage) {
		return {
			startIndex: 0,
			endIndex: safeTotal,
			hiddenAbove: 0,
			scrollFromBottom: 0,
			isPaused: false,
		};
	}

	const maxBack = safeTotal - safePage;
	const clampedBack = Math.max(0, Math.min(Math.floor(scrollFromBottom || 0), maxBack));
	if (clampedBack > 0) {
		const endIndex = safeTotal - clampedBack;
		const startIndex = Math.max(0, endIndex - safePage);
		return {
			startIndex,
			endIndex,
			hiddenAbove: startIndex,
			scrollFromBottom: clampedBack,
			isPaused: true,
		};
	}

	const steps = Math.ceil((safeTotal - safePage) / safeStep);
	const startIndex = Math.min(safeTotal - 1, steps * safeStep);
	return {
		startIndex,
		endIndex: safeTotal,
		hiddenAbove: startIndex,
		scrollFromBottom: 0,
		isPaused: false,
	};
}

export function reduceThinkingWheelScroll(
	state: ThinkingWindowState,
	wheelDelta: number,
	pageSize = STREAMING_THINKING_PAGE_LINES,
): number {
	const maxBack = Math.max(0, Math.floor(state.totalLines) - Math.max(1, Math.floor(pageSize)));
	const current = Math.max(0, Math.min(maxBack, Math.floor(state.scrollFromBottom || 0)));
	if (!Number.isFinite(wheelDelta) || wheelDelta === 0 || maxBack === 0) {
		return current;
	}
	const step = Math.max(1, Math.abs(Math.round(wheelDelta)));
	/* Колесо вверх (wheelDelta < 0) прокручивает к более ранним строкам; вниз — возвращает к живому хвосту (0) */
	if (wheelDelta < 0) {
		return Math.min(maxBack, current + step);
	}
	return Math.max(0, current - step);
}

export function formatThinkingDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
		return undefined;
	}
	const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const rem = totalSeconds % 60;
		return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const rem = totalSeconds % 60;
	if (rem > 0) return `${hours}h ${minutes}m ${rem}s`;
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatThoughtLabel(durationMs: number | undefined): string {
	return t("thinking.thoughtFor", { duration: formatThinkingDuration(durationMs) ?? t("thinking.unknownDuration") });
}

export function isThinkingBlock(value: unknown): boolean {
	if (value instanceof ThinkingBlock) return true;
	if (typeof value !== "object" || value === null) return false;
	return (
		(value as Record<PropertyKey, unknown>)[THINKING_BLOCK_MARKER] === true ||
		value.constructor?.name === "ThinkingBlock"
	);
}

function getSharedThinkingTimingStore(): SharedThinkingTimingStore {
	const g = globalThis as Record<symbol, SharedThinkingTimingStore | undefined>;
	if (!g[THINKING_TIMINGS_KEY]) {
		g[THINKING_TIMINGS_KEY] = {
			byRunKey: new Map(),
			restoredByRunKey: new Map(),
			messageStartedAt: new Map(),
		};
	}
	return g[THINKING_TIMINGS_KEY]!;
}

function getGlobalThinkingExpandState(): GlobalThinkingExpandState {
	const g = globalThis as Record<symbol, GlobalThinkingExpandState | undefined>;
	if (!g[GLOBAL_THINKING_EXPAND_KEY]) {
		g[GLOBAL_THINKING_EXPAND_KEY] = { expandAll: false };
	}
	return g[GLOBAL_THINKING_EXPAND_KEY]!;
}

export function resetGlobalThinkingExpandState(): void {
	const slot = getGlobalThinkingExpandState();
	slot.expandAll = false;
	slot.lastHostHide = undefined;
}

export function noteThinkingTurnStart(now = Date.now()): void {
	getSharedThinkingTimingStore().activeTurnStartedAt = now;
}

export function clearRecordedThinkingTimings(): void {
	const store = getSharedThinkingTimingStore();
	store.byRunKey.clear();
	store.restoredByRunKey?.clear();
	store.messageStartedAt.clear();
	store.activeTurnStartedAt = undefined;
}

export function getMeasuredThinkingDurations(message: { timestamp: number; content: readonly unknown[] }) {
	const { byRunKey } = getSharedThinkingTimingStore();
	const runs: Record<number, number> = {};
	for (let index = 0; index < message.content.length; index += 1) {
		const timing = byRunKey.get(`${message.timestamp}:${index}`);
		if (timing?.endedAt !== undefined) runs[index] = Math.max(0, timing.endedAt - timing.startedAt);
	}
	return Object.keys(runs).length ? { timestamp: message.timestamp, runs } : undefined;
}

export function restoreThinkingDurations(entries: readonly SessionEntry[]): void {
	const store = getSharedThinkingTimingStore();
	const restored = store.restoredByRunKey ??= new Map();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== THINKING_DURATION_ENTRY) continue;
		const data = entry.data as { timestamp?: unknown; runs?: unknown } | undefined;
		if (typeof data?.timestamp !== "number" || !Number.isFinite(data.timestamp) ||
			!data.runs || typeof data.runs !== "object") continue;
		for (const [index, duration] of Object.entries(data.runs)) {
			if (!/^\d+$/u.test(index) || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) continue;
			restored.set(`${data.timestamp}:${index}`, {
				startedAt: 0, endedAt: duration, signature: "", closedByEvent: true,
			});
		}
	}
}

function makeThinkingRunKey(message: any, runIndex: number): string | undefined {
	const ts = message?.timestamp;
	if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
	return `${ts}:${runIndex}`;
}

function rememberSharedTiming(key: string | undefined, timing: ThinkingRunTiming): void {
	if (!key) return;
	const { byRunKey } = getSharedThinkingTimingStore();
	byRunKey.set(key, timing);
	if (byRunKey.size > MAX_TRACKED_THINKING_RUNS) {
		const oldest = byRunKey.keys().next().value;
		if (oldest !== undefined) byRunKey.delete(oldest);
	}
}

function rememberMessageStart(ts: number | undefined, now: number): void {
	if (typeof ts !== "number" || !Number.isFinite(ts)) return;
	const { messageStartedAt } = getSharedThinkingTimingStore();
	if (!messageStartedAt.has(ts)) {
		messageStartedAt.set(ts, now);
		if (messageStartedAt.size > MAX_TRACKED_THINKING_RUNS) {
			const oldest = messageStartedAt.keys().next().value;
			if (oldest !== undefined) messageStartedAt.delete(oldest);
		}
	}
}

function lookupSharedTiming(
	key: string | undefined,
	sig: string,
	isStreaming: boolean,
): ThinkingRunTiming | undefined {
	if (!key) return undefined;
	const { byRunKey, restoredByRunKey } = getSharedThinkingTimingStore();
	const existing = byRunKey.get(key) ?? (!isStreaming ? restoredByRunKey?.get(key) : undefined);
	if (!existing) return undefined;
	if (!existing.signature || !sig) return existing;
	if (
		existing.signature === sig ||
		sig.startsWith(existing.signature) ||
		(isStreaming && existing.signature.startsWith(sig))
	) {
		return existing;
	}
	return undefined;
}

function hasContentAfterThinkingRun(contents: any[], endIdx: number): boolean {
	for (let k = endIdx; k < contents.length; k++) {
		const item = contents[k];
		if (item?.type === "text" || item?.type === "toolCall") return true;
	}
	return false;
}

export function observeAssistantThinkingMessage(
	message: any,
	isStreaming: boolean,
	assistantEvent?: any,
): void {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
	const now = Date.now();
	const store = getSharedThinkingTimingStore();
	const messageTs = typeof message.timestamp === "number" ? message.timestamp : undefined;
	if (isStreaming) {
		rememberMessageStart(messageTs, now);
	}

	const contents: any[] = message.content;
	let thinkingRunIndex = 0;

	for (let i = 0; i < contents.length; i++) {
		if (contents[i]?.type !== "thinking") continue;
		const startIdx = i;
		const thinkingParts: string[] = [];
		let allRedacted = true;
		let endIdx = i;
		for (; endIdx < contents.length; endIdx++) {
			const tc = contents[endIdx];
			if (tc?.type !== "thinking") break;
			if (tc.redacted !== true) allRedacted = false;
			const trimmed = String(tc.thinking ?? "").trim();
			if (trimmed) thinkingParts.push(trimmed);
		}
		i = endIdx - 1;
		const runIndex = thinkingRunIndex++;
		const joined = thinkingParts.join("\n\n");
		const sig = joined.slice(0, 160);
		const runKey = makeThinkingRunKey(message, runIndex);
		let timing = lookupSharedTiming(runKey, sig, isStreaming);

		const endedViaStreamEvent =
			(assistantEvent?.type === "thinking_end" &&
				typeof assistantEvent.contentIndex === "number" &&
				assistantEvent.contentIndex >= startIdx &&
				assistantEvent.contentIndex < endIdx &&
				assistantEvent.contentIndex === endIdx - 1) ||
			((assistantEvent?.type === "text_start" || assistantEvent?.type === "toolcall_start") &&
				typeof assistantEvent.contentIndex === "number" &&
				assistantEvent.contentIndex >= endIdx);

		if (endedViaStreamEvent && timing) {
			timing.closedByEvent = true;
			timing.endedAt ??= now;
		}

		const hasSubsequentContent = hasContentAfterThinkingRun(contents, endIdx);
		const activelyThinkingNow = Boolean(
			isStreaming && !hasSubsequentContent && !endedViaStreamEvent && !timing?.closedByEvent,
		);

		if (activelyThinkingNow) {
			if (allRedacted && thinkingParts.length === 0) continue;
			if (!timing) {
				timing = { startedAt: now, signature: sig };
			} else if (sig) {
				timing.signature = sig;
			}
			rememberSharedTiming(runKey, timing);
		} else {
			if (!timing && !(allRedacted && thinkingParts.length === 0)) {
				/* Буферизованные/нестримящие провайдеры могут отдать thinking только в message_end */
				const fallbackStart =
					(messageTs !== undefined ? store.messageStartedAt.get(messageTs) : undefined) ??
					store.activeTurnStartedAt ??
					now;
				timing = { startedAt: fallbackStart, endedAt: now, signature: sig };
			}
			if (timing) {
				timing.endedAt ??= now;
				if (sig) timing.signature = sig;
				rememberSharedTiming(runKey, timing);
			}
		}
	}
}

export function stopThinkingWave(): void {
	deactivateAnimationSurface(THINKING_WAVE_SURFACE_KEY);
}

function waveAccentGlyph(row: number, glyph: string, lightMode: boolean): string {
	return paintBreathingWaveGlyph(row, glyph, { light: lightMode });
}

function styleInlineCodeProse(
	line: string,
	bodyColor: (s: string) => string,
	codeColor: (s: string) => string,
): string {
	if (!line.includes("`")) {
		return bodyColor(line);
	}
	const parts = line.split(/`([^`\n]+)`/gu);
	let out = "";
	for (let i = 0; i < parts.length; i += 1) {
		const chunk = parts[i] ?? "";
		if (!chunk) continue;
		out += i % 2 === 1 ? codeColor(chunk) : bodyColor(chunk);
	}
	return out;
}

/**
 * Форматирует текст `Thinking` как спокойную прозу без кодовых ограждений ```/~~~
 * с мягкой подсветкой встроенного `` `code` `` и переносом по ширине.
 */
export function formatThinkingProseLines(
	sourceText: string,
	maxWidth: number,
	light: boolean,
): string[] {
	const safeWidth = Math.max(4, Math.floor(maxWidth));
	const bodyColor = (s: string) =>
		light ? fgRgb(100, 116, 139, s) : fgRgb(116, 130, 152, s);
	const codeColor = (s: string) =>
		light ? fgRgb(44, 104, 178, s) : fgRgb(132, 168, 206, s);

	const rawLines = sourceText
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.filter((line) => !/^\s*(?:`{3,}|~{3,})[^\s`~]*\s*$/u.test(line))
		.map((line) =>
			line
				.replace(/^\s*#{1,6}\s+/u, "")
				.replace(/^\s*[-*+]\s+/u, "· ")
				.replace(/\*\*([^*\n]+)\*\*/gu, "$1")
				.trimEnd(),
		);

	const wrapped: string[] = [];
	for (const rawLine of rawLines) {
		if (!rawLine.trim()) {
			if (wrapped.length > 0 && wrapped[wrapped.length - 1] !== "") {
				wrapped.push("");
			}
			continue;
		}
		const styled = styleInlineCodeProse(rawLine, bodyColor, codeColor);
		const lines = wrapTextWithAnsi(styled, safeWidth);
		for (const item of lines) {
			wrapped.push(item.replace(/ +$/u, ""));
		}
	}
	while (wrapped.length > 0 && wrapped[wrapped.length - 1] === "") {
		wrapped.pop();
	}
	return wrapped;
}

const EMPTY_THINKING_LINES: string[] = [];

export class ThinkingBlock implements Component {
	readonly [THINKING_BLOCK_MARKER] = true;
	private readonly hoverSlot: ThinkingInteractionSlot;
	private lastTotalStreamLines = 0;
	private completedRenderCache?: {
		width: number;
		theme: Theme;
		light: boolean;
		expanded: boolean;
		hovered: boolean;
		isFullscreen: boolean;
		lines: string[];
	};
	private streamProseCache?: {
		text: string;
		width: number;
		light: boolean;
		proseLines: string[];
		nonEmptyProse: string[];
	};

	constructor(
		private readonly thinkingText: string,
		private readonly isStreamingNow: boolean,
		private readonly isExpanded: boolean,
		private readonly onToggle: () => void,
		private readonly themeRef: Theme,
		private readonly durationMs?: number,
		hoverSlot?: ThinkingInteractionSlot,
		private readonly startedAt?: number,
		private readonly blockKey = "0",
	) {
		this.hoverSlot = hoverSlot ?? { hovered: false, scrollFromBottom: 0, lastLineCount: 0 };
	}

	invalidate(): void {
		this.completedRenderCache = undefined;
		this.streamProseCache = undefined;
	}

	render(width: number): string[] {
		if (width <= 0) return EMPTY_THINKING_LINES;
		const activeTheme = getActiveGlobalTheme(this.themeRef);
		const light = isLightTheme(activeTheme);
		const isHovered = this.hoverSlot.hovered;
		const isFullscreen = Boolean(getActiveHostRuntime()?.isFullscreen);

		if (!this.isStreamingNow) {
			const cached = this.completedRenderCache;
			if (
				cached &&
				cached.width === width &&
				cached.theme === activeTheme &&
				cached.light === light &&
				cached.expanded === this.isExpanded &&
				cached.hovered === isHovered &&
				cached.isFullscreen === isFullscreen
			) {
				return cached.lines;
			}
		}

		const rightPad = computeOuterCanvasMargin(width);
		const leftPad = rightPad + 2;
		const margin = " ".repeat(leftPad);
		const maxRowWidth = Math.max(8, width - rightPad);
		const cappedWidth = Math.max(8, Math.min(width - leftPad - rightPad, MAX_THOUGHTS_WIDTH));
		const textAvail = Math.max(4, cappedWidth - 2);

		const headerMuted = (s: string) =>
			isHovered
				? light
					? fgRgb(37, 99, 235, s)
					: fgRgb(145, 195, 248, s)
				: light
					? fgRgb(100, 116, 139, s)
					: fgRgb(118, 132, 154, s);
		const dimHint = (s: string) =>
			light ? fgRgb(132, 148, 170, s) : fgRgb(96, 112, 136, s);
		const padFullWidth = (line: string) =>
			line + " ".repeat(Math.max(0, width - visibleWidth(line)));

		if (!this.isStreamingNow) {
			const commitCompleted = (lines: string[]): string[] => {
				this.completedRenderCache = {
					width,
					theme: activeTheme,
					light,
					expanded: this.isExpanded,
					hovered: isHovered,
					isFullscreen,
					lines,
				};
				return lines;
			};

			const label = formatThoughtLabel(this.durationMs);
			const starColor = isHovered
				? light
					? fgRgb(37, 99, 235, POLARIS_STAR)
					: fgRgb(97, 175, 239, POLARIS_STAR)
				: light
					? fgRgb(148, 163, 184, POLARIS_STAR)
					: fgRgb(78, 92, 114, POLARIS_STAR);

			/* Свёрнутый завершённый блок не тратит CPU на обёртку прозы мыслей */
			if (!this.isExpanded) {
				const line = truncateToWidth(
					`${margin}${starColor} ${headerMuted(`› ${label}`)}`,
					maxRowWidth,
					"…",
				);
				const row = padFullWidth(line);
				return commitCompleted([isFullscreen ? markSelectionChrome(row) : row]);
			}

			const displayText = resolveThinkingDisplayText(
				this.thinkingText,
				this.blockKey,
				false,
			);
			const proseLines = formatThinkingProseLines(displayText, textAvail, light);
			const out: string[] = [];
			const openSpine = light ? fgRgb(148, 163, 184, "│") : fgRgb(76, 92, 118, "│");
			const hdr = truncateToWidth(
				`${margin}${starColor} ${headerMuted(`⌄ ${label}`)}`,
				maxRowWidth,
				"…",
			);
			out.push(padFullWidth(hdr));

			for (const rowText of proseLines) {
				const bodyLine = rowText ? `${margin}${openSpine} ${rowText}` : `${margin}${openSpine}`;
				const row = truncateToWidth(bodyLine, maxRowWidth, "…");
				out.push(padFullWidth(row));
			}
			return commitCompleted(out);
		}

		const displayText = resolveThinkingDisplayText(
			this.thinkingText,
			this.blockKey,
			true,
		);
		let proseLines: string[];
		let nonEmptyProse: string[];
		if (
			this.streamProseCache &&
			this.streamProseCache.text === displayText &&
			this.streamProseCache.width === textAvail &&
			this.streamProseCache.light === light
		) {
			proseLines = this.streamProseCache.proseLines;
			nonEmptyProse = this.streamProseCache.nonEmptyProse;
		} else {
			proseLines = formatThinkingProseLines(displayText, textAvail, light);
			nonEmptyProse = proseLines.filter((l) => stripTerminalSequences(l).trim().length > 0);
			this.streamProseCache = {
				text: displayText,
				width: textAvail,
				light,
				proseLines,
				nonEmptyProse,
			};
		}
		const out: string[] = [];

		{
			const leadGlyph = paintPolarisStar({ light, theme: activeTheme, row: 0 });
			const liveElapsedMs =
				this.startedAt !== undefined ? Math.max(0, Date.now() - this.startedAt) : 0;
			const liveDuration = formatThinkingDuration(liveElapsedMs);
			const timerSuffix = liveDuration ? dimHint(` · ${liveDuration}`) : "";

			if (this.isExpanded) {
				this.lastTotalStreamLines = nonEmptyProse.length;
				const expandedTitle = `⌄ ${t("thinking.streaming")}`;
				const hdrLabel = isHovered
					? headerMuted(expandedTitle)
					: paintGlimmerSweepText(expandedTitle, {
							light,
							theme: activeTheme,
							charsPerSecond: 16,
							leadPad: 5,
							trailPad: 11,
						});
				const hdrRow = truncateToWidth(
					`${margin}${leadGlyph} ${hdrLabel}${timerSuffix}`,
					maxRowWidth,
					"…",
				);
				out.push(padFullWidth(hdrRow));

				for (let i = 0; i < proseLines.length; i += 1) {
					const rowText = proseLines[i]!;
					const spine = waveAccentGlyph(i + 1, "│", light);
					const bodyLine = rowText ? `${margin}${spine} ${rowText}` : `${margin}${spine}`;
					out.push(padFullWidth(truncateToWidth(bodyLine, maxRowWidth, "…")));
				}
				return out;
			}

			/* Удерживаем прокрученные строки на месте при приходе новых строк во время паузы */
			if (
				this.hoverSlot.scrollFromBottom > 0 &&
				this.hoverSlot.lastLineCount > 0 &&
				nonEmptyProse.length > this.hoverSlot.lastLineCount
			) {
				this.hoverSlot.scrollFromBottom += nonEmptyProse.length - this.hoverSlot.lastLineCount;
			}
			this.hoverSlot.lastLineCount = nonEmptyProse.length;
			this.lastTotalStreamLines = nonEmptyProse.length;

			const win = computeThinkingWindow(
				nonEmptyProse.length,
				this.hoverSlot.scrollFromBottom,
				STREAMING_THINKING_PAGE_LINES,
				STREAMING_THINKING_PAGE_STEP,
			);
			this.hoverSlot.scrollFromBottom = win.scrollFromBottom;
			const visibleSlice = nonEmptyProse.slice(win.startIndex, win.endIndex);

			const cueSuffix = win.isPaused
				? dimHint(` · ⏸ -${win.scrollFromBottom} lines ›`)
				: win.hiddenAbove > 0
					? dimHint(` · +${win.hiddenAbove} lines ›`)
					: nonEmptyProse.length > 0
						? dimHint(" ›")
						: "";
			const streamTitle = t("thinking.streaming");
			const hdrLabel = isHovered
				? headerMuted(streamTitle)
				: paintGlimmerSweepText(streamTitle, {
						light,
						theme: activeTheme,
						charsPerSecond: 16,
						leadPad: 5,
						trailPad: 11,
					});
			const hdrRow = truncateToWidth(
				`${margin}${leadGlyph} ${hdrLabel}${timerSuffix}${cueSuffix}`,
				maxRowWidth,
				"…",
			);
			out.push(padFullWidth(hdrRow));

			const bodyHeight = Math.min(nonEmptyProse.length, STREAMING_THINKING_PAGE_LINES);
			for (let i = 0; i < bodyHeight; i += 1) {
				const spine = waveAccentGlyph(i + 1, "▎", light);
				const row = truncateToWidth(
					`${margin}${spine} ${visibleSlice[i] ?? ""}`,
					maxRowWidth,
					"…",
				);
				out.push(padFullWidth(row));
			}
			return out;
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const onHeaderRow = event.y === 0;

		if (event.type === "move") {
			claimHover(this.hoverSlot, () => {
				if (this.hoverSlot.hovered) {
					this.hoverSlot.hovered = false;
					requestRender();
				}
			});
			if (this.hoverSlot.hovered !== onHeaderRow) {
				this.hoverSlot.hovered = onHeaderRow;
				return { handled: true, render: true };
			}
			return undefined;
		}

		/* Локальная прокрутка 6-строчного стримящегося окна с overscroll = "contain" */
		if (
			event.type === "wheel" &&
			this.isStreamingNow &&
			!this.isExpanded &&
			this.lastTotalStreamLines > STREAMING_THINKING_PAGE_LINES
		) {
			const delta = event.wheelDelta ?? 0;
			if (delta !== 0) {
				const prev = this.hoverSlot.scrollFromBottom;
				const next = reduceThinkingWheelScroll(
					{ totalLines: this.lastTotalStreamLines, scrollFromBottom: prev },
					delta,
					STREAMING_THINKING_PAGE_LINES,
				);
				this.hoverSlot.scrollFromBottom = next;
				return { handled: true, render: next !== prev };
			}
			return { handled: true, render: false };
		}

		/* Строго строка заголовка (y === 0) разворачивает/сворачивает блок; клики по телу не мешают выделению текста */
		if (onHeaderRow && event.button === "left") {
			if (event.type === "press") {
				return { handled: true, render: false };
			}
			if (event.type === "click") {
				this.onToggle();
				return { handled: true, render: true };
			}
		}
		return undefined;
	}
}

export function installAssistantTranscriptBlocks(): void {
	const proto = AssistantMessageComponent.prototype as any;

	hookMethod(
		proto,
		"setHideThinkingBlock",
		"transcript.thinkingGlobalToggle",
		(self, args) => {
			const [nextHide] = args as [boolean];
			const slot = getGlobalThinkingExpandState();
			const prevGlobalHide = slot.lastHostHide;
			if (prevGlobalHide !== nextHide) {
				slot.lastHostHide = nextHide;
				slot.expandAll = !slot.expandAll;
			}
			const prevCompHide: boolean | undefined = self.__conartiLastHostHide;
			const isExactTransition =
				prevCompHide !== undefined ? prevCompHide !== nextHide : prevGlobalHide !== nextHide;
			self.__conartiLastHostHide = nextHide;
			self.hideThinkingBlock = nextHide;
			if (isExactTransition) {
				self.thinkingVisibilityOverrides?.clear?.();
			}
			if (self.lastMessage) {
				self.updateContent(self.lastMessage, self.isStreaming);
			}
		},
	);

	hookMethod(
		proto,
		"updateContent",
		"transcript.assistantUpdate",
		(self, args) => {
			const [message, isStreamingArg] = args as [any, boolean | undefined];
			const isStreaming = isStreamingArg ?? self.isStreaming ?? false;
			self.lastMessage = message;
			self.isStreaming = isStreaming;

			const globalExpand = getGlobalThinkingExpandState();
			const hostHideNow = Boolean(self.hideThinkingBlock);
			if (globalExpand.lastHostHide === undefined) {
				globalExpand.lastHostHide = hostHideNow;
			}
			if (self.__conartiLastHostHide === undefined) {
				self.__conartiLastHostHide = hostHideNow;
			}

			self.contentContainer.clear();
			const previousSlots: Array<{ kind: string; markdown: Markdown }> = self.markdownSlots ?? [];
			self.markdownSlots = [];
			const chatPad = 4;

			const markdownBlock = (kind: string, text: string, create: () => Markdown) => {
				const slot = previousSlots[self.markdownSlots.length];
				const markdown = slot?.kind === kind ? slot.markdown : create();
				const mdAny = markdown as Markdown & { __conartiStreaming?: boolean; __conartiAssistantMarkdown?: boolean };
				const nextStreaming = Boolean(isStreaming);
				if (!mdAny.__conartiAssistantMarkdown || mdAny.__conartiStreaming !== nextStreaming) {
					mdAny.__conartiAssistantMarkdown = true;
					mdAny.__conartiStreaming = nextStreaming;
					markdown.invalidate();
				}
				markdown.setText(text);
				self.markdownSlots.push({ kind, markdown });
				return markdown;
			};

			let needsSpacer = true;
			const addVisibleChild = (child: Component) => {
				if (needsSpacer) {
					self.contentContainer.addChild(new Spacer(1));
					needsSpacer = false;
				}
				self.contentContainer.addChild(child);
			};

			const themeRef = getActiveGlobalTheme(self?.theme);
			const contents: any[] = Array.isArray(message?.content) ? message.content : [];
			let thinkingRunIndex = 0;
			let hasActiveThinkingRun = false;

			for (let i = 0; i < contents.length; i++) {
				const part = contents[i];
				if (part?.type === "text" && String(part.text ?? "").trim()) {
					const text = String(part.text).trim();
					const transformers: Array<(md: string, ctx: any) => unknown> = Array.isArray(self.markdownTransformers)
						? self.markdownTransformers
						: [];
					addVisibleChild(
						markdownBlock("text", text, () =>
							new Markdown(text, chatPad, 0, self.markdownTheme, undefined, {
								transform: (markdown: string, availableWidth: number) => {
									let outMd = markdown;
									const txCtx = {
										messageType: "assistant",
										isStreaming: Boolean(self.isStreaming),
										availableWidth,
										messageId: self.messageId,
										timestamp: self.timestamp,
									};
									for (const fn of transformers) {
										try {
											const next = fn(outMd, txCtx);
											if (typeof next === "string") outMd = next;
										} catch {}
									}
									return outMd;
								},
							}),
						),
					);
					needsSpacer = true;
				} else if (part?.type === "thinking") {
					const thinkingParts: string[] = [];
					let allRedacted = true;
					let endIdx = i;
					for (; endIdx < contents.length; endIdx++) {
						const tc = contents[endIdx];
						if (tc?.type !== "thinking") break;
						if (tc.redacted !== true) allRedacted = false;
						const trimmed = String(tc.thinking ?? "").trim();
						if (trimmed) thinkingParts.push(trimmed);
					}
					i = endIdx - 1;
					const runIndex = thinkingRunIndex++;
					const hasSubsequentContent = hasContentAfterThinkingRun(contents, endIdx);

					const compTimings: Map<number, ThinkingRunTiming> =
						(self.__conartiThinkingTimings ??= new Map());
					const joinedThinking = thinkingParts.join("\n\n");
					const sig = joinedThinking.slice(0, 160);
					const runKey = makeThinkingRunKey(message, runIndex);

					let runTiming =
						compTimings.get(runIndex) ?? lookupSharedTiming(runKey, sig, Boolean(isStreaming));

					const activelyThinkingNow = Boolean(
						isStreaming && !hasSubsequentContent && !runTiming?.closedByEvent,
					);

					if (activelyThinkingNow) {
						if (allRedacted && thinkingParts.length === 0) continue;
						if (!runTiming) {
							runTiming = { startedAt: Date.now(), signature: sig };
						} else if (sig) {
							runTiming.signature = sig;
						}
						compTimings.set(runIndex, runTiming);
						rememberSharedTiming(runKey, runTiming);
					} else if (runTiming) {
						runTiming.endedAt ??= Date.now();
						if (sig) runTiming.signature = sig;
						compTimings.set(runIndex, runTiming);
						rememberSharedTiming(runKey, runTiming);
					}

					const override: boolean | undefined = self.thinkingVisibilityOverrides?.get?.(runIndex);
					const isExpanded = override !== undefined ? !override : globalExpand.expandAll;

					if (thinkingParts.length === 0) {
						if (!activelyThinkingNow || allRedacted || (self.hideThinkingBlock && override === undefined && !isExpanded)) {
							continue;
						}
					}

					if (self.hideThinkingBlock && override === undefined && !activelyThinkingNow && !isExpanded) {
						if (!String(self.hiddenThinkingLabel ?? "Thinking...").trim()) continue;
					}

					if (activelyThinkingNow) {
						hasActiveThinkingRun = true;
					}

					const durationMs =
						runTiming && runTiming.endedAt !== undefined
							? Math.max(0, runTiming.endedAt - runTiming.startedAt)
							: undefined;

					const hoverSlots: Map<number, ThinkingInteractionSlot> =
						(self.__conartiThinkingHoverSlots ??= new Map());
					let hoverSlot = hoverSlots.get(runIndex);
					if (!hoverSlot) {
						hoverSlot = { hovered: false, scrollFromBottom: 0, lastLineCount: 0 };
						hoverSlots.set(runIndex, hoverSlot);
					}
					addVisibleChild(
						new ThinkingBlock(
							joinedThinking,
							activelyThinkingNow,
							isExpanded,
							() => {
								self.thinkingVisibilityOverrides.set(runIndex, isExpanded);
								if (self.lastMessage) {
									self.updateContent(self.lastMessage, self.isStreaming);
								}
							},
							themeRef,
							durationMs,
							hoverSlot,
							runTiming?.startedAt,
							runKey ?? String(runIndex),
						),
					);
					needsSpacer = true;
				}
			}

			if (hasActiveThinkingRun) {
				activateAnimationSurface(self, () => {
					requestRender();
				});
			} else {
				deactivateAnimationSurface(self);
			}

			const hasToolCalls = contents.some((c) => c?.type === "toolCall");
			self.hasToolCalls = hasToolCalls;
			if (message?.stopReason === "length") {
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(themeRef.fg("error", t("transcript.truncated")), chatPad, 0),
				);
			} else if (!hasToolCalls) {
				if (message?.stopReason === "aborted") {
					const abortMsg =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: t("transcript.stopped");
					self.contentContainer.addChild(new Spacer(1));
					self.contentContainer.addChild(new Text(themeRef.fg("muted", `⏹ ${abortMsg}`), chatPad, 0));
				} else if (message?.stopReason === "error") {
					const errMsg = message.errorMessage || "Unknown error";
					self.contentContainer.addChild(new Spacer(1));
					self.contentContainer.addChild(
						new Text(themeRef.fg("error", t("transcript.error", { message: errMsg })), chatPad, 0),
					);
				}
			}
		},
		["pi.grok-ui.hook.chat.assistantUpdate"],
	);
}
