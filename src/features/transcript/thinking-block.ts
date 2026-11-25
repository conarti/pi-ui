import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Spacer,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type MarkdownTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	activateAnimationSurface,
	deactivateAnimationSurface,
	paintBreathingWaveGlyph,
} from "../../shared/animation-scheduler.ts";
import { bgRgb, fgRgb, getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import {
	getPrototypeVariant,
	isPrototypeActive,
	resolveThinkingDisplay,
	samplePrototypeRunningGlyph,
	summarizeLiveThinkingIntent,
	type ActivePrototypeVariant,
} from "./prototype-state.ts";

const MAX_THOUGHTS_WIDTH = 120;
const STREAMING_THOUGHT_TAIL_LINES = 3;
const THINKING_BLOCK_MARKER = Symbol.for("conarti.pi-ui.thinking-block");

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
	const formatted = formatThinkingDuration(durationMs);
	return formatted ? `Thought for ${formatted}` : "Thought";
}

export function isThinkingBlock(value: unknown): boolean {
	if (value instanceof ThinkingBlock) return true;
	if (typeof value !== "object" || value === null) return false;
	return (
		(value as Record<PropertyKey, unknown>)[THINKING_BLOCK_MARKER] === true ||
		value.constructor?.name === "ThinkingBlock"
	);
}

const THINKING_WAVE_SURFACE_KEY = "transcript.thinking-wave";
const THINKING_TIMINGS_KEY = Symbol.for("conarti.pi-ui.thinking-timings.v1");
const MAX_TRACKED_THINKING_RUNS = 2000;

interface ThinkingRunTiming {
	startedAt: number;
	endedAt?: number;
	signature: string;
	closedByEvent?: boolean;
}

interface SharedThinkingTimingStore {
	byRunKey: Map<string, ThinkingRunTiming>;
}

function getSharedThinkingTimingStore(): SharedThinkingTimingStore {
	const g = globalThis as Record<symbol, SharedThinkingTimingStore | undefined>;
	if (!g[THINKING_TIMINGS_KEY]) {
		g[THINKING_TIMINGS_KEY] = {
			byRunKey: new Map(),
		};
	}
	return g[THINKING_TIMINGS_KEY]!;
}

export function clearRecordedThinkingTimings(): void {
	getSharedThinkingTimingStore().byRunKey.clear();
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

function lookupSharedTiming(
	key: string | undefined,
	sig: string,
	isStreaming: boolean,
): ThinkingRunTiming | undefined {
	if (!key) return undefined;
	const existing = getSharedThinkingTimingStore().byRunKey.get(key);
	if (!existing) return undefined;
	if (isStreaming || !existing.signature || !sig) return existing;
	if (existing.signature === sig || sig.startsWith(existing.signature)) {
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
			timing.endedAt ??= Date.now();
		}

		const hasSubsequentContent = hasContentAfterThinkingRun(contents, endIdx);
		const activelyThinkingNow = Boolean(
			isStreaming && !hasSubsequentContent && !endedViaStreamEvent && !timing?.closedByEvent,
		);

		if (activelyThinkingNow) {
			if (allRedacted && thinkingParts.length === 0) continue;
			if (!timing) {
				timing = { startedAt: Date.now(), signature: sig };
			} else if (sig) {
				timing.signature = sig;
			}
			rememberSharedTiming(runKey, timing);
		} else if (timing) {
			timing.endedAt ??= Date.now();
			if (sig) timing.signature = sig;
			rememberSharedTiming(runKey, timing);
		}
	}
}

export function stopThinkingWave(): void {
	deactivateAnimationSurface(THINKING_WAVE_SURFACE_KEY);
}

function waveAccentGlyph(row: number, glyph: string, lightMode: boolean): string {
	return paintBreathingWaveGlyph(row, glyph, { light: lightMode });
}

function createSoftThinkingMarkdown(text: string, themeRef: Theme, light: boolean): Markdown {
	const bodyRgb: readonly [number, number, number] = light ? [100, 116, 139] : [124, 138, 160];
	const strongRgb: readonly [number, number, number] = light ? [64, 84, 114] : [156, 174, 200];
	const bodyEsc = `\x1b[38;2;${bodyRgb[0]};${bodyRgb[1]};${bodyRgb[2]}m`;
	const strongEsc = `\x1b[38;2;${strongRgb[0]};${strongRgb[1]};${strongRgb[2]}m`;
	const bodyFg = (s: string) => fgRgb(bodyRgb, s);
	const dimFg = (s: string) => (light ? fgRgb(132, 148, 170, s) : fgRgb(92, 108, 132, s));
	/* Markdown оборачивает вложенный текст в bodyFg до вызова bold(), поэтому заменяем внутренний SGR-префикс. */
	const strongFg = (s: string) => fgRgb(strongRgb, s.replaceAll(bodyEsc, strongEsc));
	const codeFg = (s: string) => (light ? fgRgb(44, 104, 178, s) : fgRgb(128, 178, 218, s));

	const mdTheme: MarkdownTheme = {
		heading: (s: string) => strongFg(s),
		link: (s: string) => codeFg(s),
		linkUrl: (s: string) => dimFg(s),
		code: (s: string) => codeFg(s),
		codeBlock: (s: string) => codeFg(s),
		codeBlockBorder: (s: string) => dimFg(s),
		quote: (s: string) => bodyFg(s),
		quoteBorder: (s: string) => dimFg(s),
		hr: (s: string) => dimFg(s),
		listBullet: (s: string) => dimFg(s),
		bold: (s: string) => themeRef.bold(strongFg(s)),
		italic: (s: string) => themeRef.italic(s),
		underline: (s: string) => themeRef.underline(s),
		strikethrough: (s: string) => themeRef.strikethrough(s),
	};

	const md = new Markdown(text, 0, 0, mdTheme, {
		color: bodyFg,
	});
	(md as any).__conartiThinkingMarkdown = true;
	(md as any).__conartiSkipReplyCopy = true;
	return md;
}

const STREAMING_PAGE_LINES = 6;
const STREAMING_PAGE_STEP = 3;
const STREAMING_BOX_LINES = 8;

function stabilizedPageWindow(
	lines: readonly string[],
	pageSize = STREAMING_PAGE_LINES,
	stepSize = STREAMING_PAGE_STEP,
): { readonly slice: readonly string[]; readonly hiddenAbove: number } {
	if (lines.length <= pageSize) {
		return { slice: lines, hiddenAbove: 0 };
	}
	const steps = Math.ceil((lines.length - pageSize) / stepSize);
	const start = Math.min(lines.length - 1, steps * stepSize);
	return {
		slice: lines.slice(start),
		hiddenAbove: start,
	};
}

export interface ThinkingInteractionSlot {
	hovered: boolean;
	scrollFromBottom?: number;
}

export class ThinkingBlock implements Component {
	readonly [THINKING_BLOCK_MARKER] = true;
	private readonly hoverSlot: ThinkingInteractionSlot;
	private markdownCache?: { light: boolean; md: Markdown };
	private lastTotalStreamLines = 0;

	constructor(
		private readonly thinkingText: string,
		private readonly isStreamingNow: boolean,
		private readonly isExpanded: boolean,
		private readonly onToggle: () => void,
		private readonly themeRef: Theme,
		private readonly durationMs?: number,
		markdownSlot?: { light: boolean; md: Markdown },
		hoverSlot?: ThinkingInteractionSlot,
		private readonly startedAt?: number,
		private readonly runKey?: string,
	) {
		this.markdownCache = markdownSlot;
		this.hoverSlot = hoverSlot ?? { hovered: false, scrollFromBottom: 0 };
	}

	invalidate(): void {
		this.markdownCache?.md.invalidate();
	}

	private renderFormattedLines(contentWidth: number, light: boolean, activeTheme: Theme): string[] {
		if (!this.markdownCache || this.markdownCache.light !== light) {
			this.markdownCache = {
				light,
				md: createSoftThinkingMarkdown(this.thinkingText, activeTheme, light),
			};
		} else if ((this.markdownCache.md as any).text !== this.thinkingText) {
			this.markdownCache.md.setText(this.thinkingText);
		}
		return this.markdownCache.md.render(contentWidth).map((line) => line.replace(/ +$/u, ""));
	}

	private renderCleanProseLines(
		sourceText: string,
		textAvail: number,
		light: boolean,
		tintInlineCode: boolean,
	): string[] {
		const bodyColor = (s: string) =>
			light ? fgRgb(100, 116, 139, s) : fgRgb(116, 130, 152, s);
		const codeColor = (s: string) =>
			light ? fgRgb(52, 98, 162, s) : fgRgb(132, 168, 206, s);

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
			const styledLine = tintInlineCode
				? rawLine
						.split(/(`[^`\n]+`)/gu)
						.map((seg) =>
							seg.startsWith("`") && seg.endsWith("`") && seg.length >= 2
								? codeColor(seg.slice(1, -1))
								: bodyColor(seg),
						)
						.join("")
				: bodyColor(rawLine);
			for (const w of wrapTextWithAnsi(styledLine, Math.max(8, textAvail))) {
				wrapped.push(w);
			}
		}
		while (wrapped.length > 0 && wrapped[wrapped.length - 1] === "") {
			wrapped.pop();
		}
		return wrapped;
	}

	private renderPrototypeVariant(
		variant: ActivePrototypeVariant,
		width: number,
		light: boolean,
		activeTheme: Theme,
	): string[] {
		const outerPad = width >= 48 ? 2 : 1;
		const rightClearance = width >= 48 ? 4 : 1;
		const margin = " ".repeat(outerPad);
		const usableWidth = Math.max(12, width - outerPad - rightClearance);
		const cappedWidth = Math.max(12, Math.min(usableWidth, MAX_THOUGHTS_WIDTH));
		const textAvail = Math.max(8, cappedWidth - 4);
		const isHovered = Boolean(this.hoverSlot.hovered);
		const display = resolveThinkingDisplay({
			rawText: this.thinkingText,
			runKey: this.runKey,
			isStreaming: this.isStreamingNow,
		});
		const proseLines = this.renderCleanProseLines(
			display.text,
			textAvail,
			light,
			variant === "B",
		);
		const nonEmptyProse = proseLines.filter((l) => stripTerminalSequences(l).trim().length > 0);
		this.lastTotalStreamLines = nonEmptyProse.length;

		const liveStreamingDuration =
			this.isStreamingNow && this.startedAt !== undefined
				? formatThinkingDuration(Math.max(0, Date.now() - this.startedAt))
				: undefined;
		const seamBadge = display.badge
			? ` ${light ? fgRgb(37, 99, 235, `[${display.badge}]`) : fgRgb(118, 184, 248, `[${display.badge}]`)}`
			: "";
		const dimHint = (s: string) => (light ? fgRgb(136, 150, 172, s) : fgRgb(86, 100, 122, s));
		const headerMuted = (s: string) =>
			isHovered
				? light
					? fgRgb(37, 99, 235, s)
					: fgRgb(145, 195, 248, s)
				: light
					? fgRgb(92, 108, 132, s)
					: fgRgb(118, 132, 154, s);

		const padFullWidth = (line: string): string =>
			line + " ".repeat(Math.max(0, width - visibleWidth(line)));

		const out: string[] = [];

		if (variant === "C") {
			const surfaceRgb: readonly [number, number, number] = light
				? [241, 245, 249]
				: [24, 30, 42];
			const bgStart = `\x1b[48;2;${surfaceRgb[0]};${surfaceRgb[1]};${surfaceRgb[2]}m`;
			const cardW = Math.min(usableWidth, Math.max(24, cappedWidth));
			const paintRow = (inner: string): string => {
				const clipped = truncateToWidth(inner, cardW, "…").replaceAll("\x1b[0m", `\x1b[0m${bgStart}`);
				const pad = " ".repeat(Math.max(0, cardW - visibleWidth(clipped)));
				const tinted = bgRgb(surfaceRgb[0], surfaceRgb[1], surfaceRgb[2], `${clipped}${pad}`);
				return padFullWidth(`${margin}${tinted}`);
			};

			if (this.isStreamingNow) {
				const glyph = samplePrototypeRunningGlyph(0, { light, theme: activeTheme, variant: "C" });
				const timer = liveStreamingDuration ? ` · ${liveStreamingDuration}` : "";
				if (this.isExpanded) {
					out.push(paintRow(` ${glyph} ${headerMuted(`⌄ Thinking${timer}`)}${seamBadge} `));
					for (let i = 0; i < proseLines.length; i++) {
						const rail = waveAccentGlyph(i + 1, "│", light);
						const rowText = proseLines[i]!;
						out.push(paintRow(rowText ? ` ${rail} ${rowText} ` : ` ${rail} `));
					}
					return out;
				}

				const maxBack = Math.max(0, nonEmptyProse.length - STREAMING_BOX_LINES);
				const back = Math.max(0, Math.min(this.hoverSlot.scrollFromBottom ?? 0, maxBack));
				this.hoverSlot.scrollFromBottom = back;
				const endIdx = nonEmptyProse.length - back;
				const startIdx = Math.max(0, endIdx - STREAMING_BOX_LINES);
				const windowSlice = nonEmptyProse.slice(startIdx, endIdx);
				const scrollNote =
					back > 0
						? dimHint(` · ⏸ -${back} lines ▸`)
						: startIdx > 0
							? dimHint(` · +${startIdx} lines ▸`)
							: dimHint(" ▸");

				out.push(paintRow(` ${glyph} ${headerMuted(`Thinking${timer}`)}${seamBadge}${scrollNote} `));
				for (let i = 0; i < windowSlice.length; i++) {
					const rail = waveAccentGlyph(i + 1, "│", light);
					out.push(paintRow(` ${rail} ${windowSlice[i]!} `));
				}
				return out;
			}

			const cLabel = formatThoughtLabel(this.durationMs);
			const countText = nonEmptyProse.length > 0 ? dimHint(` · ${nonEmptyProse.length} lines`) : "";
			const hex = isHovered
				? light
					? fgRgb(37, 99, 235, "⬢")
					: fgRgb(118, 186, 250, "⬢")
				: dimHint("⬢");

			if (!this.isExpanded) {
				out.push(paintRow(` ${hex} ${headerMuted(cLabel)}${countText}${seamBadge} ${dimHint("▸")} `));
				return out;
			}

			out.push(paintRow(` ${hex} ${headerMuted(cLabel)}${seamBadge} ${dimHint("▾")} `));
			const openRail = light ? fgRgb(148, 163, 184, "│") : fgRgb(72, 88, 114, "│");
			for (const rowText of proseLines) {
				out.push(paintRow(rowText ? ` ${openRail} ${rowText} ` : ` ${openRail} `));
			}
			return out;
		}

		/* Variant A (Quiet Whisper) & Variant B (Prism Rail) */
		if (this.isStreamingNow) {
			const leadGlyph = samplePrototypeRunningGlyph(0, {
				light,
				theme: activeTheme,
				variant,
			});
			const timerSuffix = liveStreamingDuration ? dimHint(` · ${liveStreamingDuration}`) : "";

			/* Клик по заголовку или Ctrl+T во время стриминга сразу разворачивает ВЕСЬ поток мыслей с первой строки */
			if (this.isExpanded) {
				const hdrRow = truncateToWidth(
					`${margin}${leadGlyph} ${headerMuted("⌄ Thinking…")}${timerSuffix}${seamBadge}`,
					width - rightClearance,
					"…",
				);
				out.push(padFullWidth(hdrRow));
				const openSpine = light ? fgRgb(148, 163, 184, "│") : fgRgb(76, 92, 118, "│");
				for (let i = 0; i < proseLines.length; i++) {
					const rowText = proseLines[i]!;
					const spine =
						i >= proseLines.length - 4 ? waveAccentGlyph(i + 1, "│", light) : openSpine;
					const bodyLine = rowText ? `${margin}${spine} ${rowText}` : `${margin}${spine}`;
					out.push(padFullWidth(truncateToWidth(bodyLine, width - rightClearance, "…")));
				}
				return out;
			}

			if (variant === "A") {
				/* Variant A: спокойная 1-строчная живая сводка без мелькающего хвоста; клик раскрывает весь поток */
				const intent = summarizeLiveThinkingIntent(display.text);
				const intentPart = intent ? dimHint(` · ${intent}`) : "";
				const morePart =
					nonEmptyProse.length > 1 ? dimHint(` (+${nonEmptyProse.length} lines ›)`) : dimHint(" ›");
				const row = truncateToWidth(
					`${margin}${leadGlyph} ${headerMuted("Thinking")}${timerSuffix}${seamBadge}${intentPart}${morePart}`,
					width - rightClearance,
					"…",
				);
				return [padFullWidth(row)];
			}

			/* Variant B: стабильная страница на 6 строк (заполняется сверху вниз без прыжков на каждом переносе слова) */
			const page = stabilizedPageWindow(nonEmptyProse, STREAMING_PAGE_LINES, STREAMING_PAGE_STEP);
			const hiddenCue =
				page.hiddenAbove > 0
					? dimHint(`  · +${page.hiddenAbove} lines ›`)
					: nonEmptyProse.length > 0
						? dimHint(" ›")
						: "";
			const hdrRow = truncateToWidth(
				`${margin}${leadGlyph} ${headerMuted("Thinking…")}${timerSuffix}${seamBadge}${hiddenCue}`,
				width - rightClearance,
				"…",
			);
			out.push(padFullWidth(hdrRow));

			for (let i = 0; i < page.slice.length; i++) {
				const spine = waveAccentGlyph(i + 1, "▎", light);
				const row = truncateToWidth(
					`${margin}${spine} ${page.slice[i]!}`,
					width - rightClearance,
					"…",
				);
				out.push(padFullWidth(row));
			}
			return out;
		}

		const label = formatThoughtLabel(this.durationMs);

		if (!this.isExpanded) {
			const collapsedSpine = isHovered
				? light
					? fgRgb(37, 99, 235, "❙")
					: fgRgb(97, 175, 239, "❙")
				: light
					? fgRgb(148, 163, 184, "❙")
					: fgRgb(78, 92, 114, "❙");
			const line = truncateToWidth(
				`${margin}${collapsedSpine} ${headerMuted(`› ${label}`)}${seamBadge}`,
				width - rightClearance,
				"…",
			);
			return [padFullWidth(line)];
		}

		const openSpine = light ? fgRgb(148, 163, 184, "│") : fgRgb(76, 92, 118, "│");
		const topSpine = isHovered
			? light
				? fgRgb(37, 99, 235, variant === "B" ? "┃" : "│")
				: fgRgb(97, 175, 239, variant === "B" ? "┃" : "│")
			: openSpine;
		const hdr = truncateToWidth(
			`${margin}${topSpine} ${headerMuted(`⌄ ${label}`)}${seamBadge}`,
			width - rightClearance,
			"…",
		);
		out.push(padFullWidth(hdr));

		for (const rowText of proseLines) {
			const bodyLine = rowText ? `${margin}${openSpine} ${rowText}` : `${margin}${openSpine}`;
			const row = truncateToWidth(bodyLine, width - rightClearance, "…");
			out.push(padFullWidth(row));
		}
		return out;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const activeTheme = getActiveGlobalTheme(this.themeRef);
		const light = isLightTheme(activeTheme);
		const variant = getPrototypeVariant();
		if (variant !== "off") {
			return this.renderPrototypeVariant(variant, width, light, activeTheme);
		}

		const outerPad = width >= 48 ? 2 : 1;
		const margin = " ".repeat(outerPad);
		const cappedWidth = Math.max(8, Math.min(width - outerPad * 2, MAX_THOUGHTS_WIDTH));
		const textAvail = Math.max(4, cappedWidth - 2);
		const isHovered = this.hoverSlot.hovered;

		const headerMuted = (s: string) =>
			isHovered
				? light
					? fgRgb(37, 99, 235, s)
					: fgRgb(145, 195, 248, s)
				: light
					? fgRgb(100, 116, 139, s)
					: fgRgb(118, 132, 154, s);

		const out: string[] = [];

		if (this.isStreamingNow) {
			const hdrSpine = waveAccentGlyph(0, "┃", light);
			const hdrRow = truncateToWidth(`${margin}${hdrSpine} ${headerMuted("Thinking…")}`, width, "…");
			out.push(hdrRow + " ".repeat(Math.max(0, width - visibleWidth(hdrRow))));

			const formattedLines = this.renderFormattedLines(textAvail, light, activeTheme);
			const nonEmptyLines = formattedLines.filter((l) => stripTerminalSequences(l).trim().length > 0);
			const contentLines = nonEmptyLines.filter(
				(l) => !/^(?:`{3,}|~{3,})[^\s`~]*$/u.test(stripTerminalSequences(l).trim()),
			);
			const tail = (contentLines.length > 0 ? contentLines : nonEmptyLines).slice(
				-STREAMING_THOUGHT_TAIL_LINES,
			);
			for (let i = 0; i < tail.length; i++) {
				const spine = waveAccentGlyph(i + 1, "▎", light);
				const row = truncateToWidth(`${margin}${spine} ${tail[i]!}`, width, "…");
				out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
			}
			return out;
		}

		const label = formatThoughtLabel(this.durationMs);

		if (!this.isExpanded) {
			const collapsedSpine = isHovered
				? light
					? fgRgb(37, 99, 235, "❙")
					: fgRgb(97, 175, 239, "❙")
				: light
					? fgRgb(148, 163, 184, "❙")
					: fgRgb(78, 92, 114, "❙");
			const line = truncateToWidth(
				`${margin}${collapsedSpine} ${headerMuted(`› ${label}`)}`,
				width,
				"…",
			);
			return [line + " ".repeat(Math.max(0, width - visibleWidth(line)))];
		}

		const openSpine = light ? fgRgb(148, 163, 184, "│") : fgRgb(76, 92, 118, "│");
		const topSpine = isHovered
			? light
				? fgRgb(37, 99, 235, "│")
				: fgRgb(97, 175, 239, "│")
			: openSpine;
		const hdr = truncateToWidth(`${margin}${topSpine} ${headerMuted(`⌄ ${label}`)}`, width, "…");
		out.push(hdr + " ".repeat(Math.max(0, width - visibleWidth(hdr))));

		const formattedLines = this.renderFormattedLines(textAvail, light, activeTheme);
		for (const rowText of formattedLines) {
			const bodyLine = rowText ? `${margin}${openSpine} ${rowText}` : `${margin}${openSpine}`;
			const row = truncateToWidth(bodyLine, width, "…");
			out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
		}
		return out;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const protoActive = isPrototypeActive();
		const variant = getPrototypeVariant();
		const isSingleRow = !this.isExpanded && (!this.isStreamingNow || variant === "A");
		const onHeaderRow = isSingleRow || event.y === 0;

		if (event.type === "move") {
			const shouldHighlight = protoActive ? onHeaderRow : true;
			claimHover(this.hoverSlot, () => {
				if (this.hoverSlot.hovered) {
					this.hoverSlot.hovered = false;
					requestRender();
				}
			});
			if (this.hoverSlot.hovered !== shouldHighlight) {
				this.hoverSlot.hovered = shouldHighlight;
				return { handled: true, render: true };
			}
			return undefined;
		}

		/* В Variant C колесо мыши над стримящимся компактным окном позволяет прокручивать ранние строки мысли на месте */
		if (
			protoActive &&
			variant === "C" &&
			this.isStreamingNow &&
			!this.isExpanded &&
			this.lastTotalStreamLines > STREAMING_BOX_LINES
		) {
			const evType = String(event.type);
			if (evType === "wheel" || evType === "mouse_wheel_up" || evType === "mouse_wheel_down") {
				const maxBack = Math.max(0, this.lastTotalStreamLines - STREAMING_BOX_LINES);
				const step =
					evType === "mouse_wheel_up"
						? 2
						: evType === "mouse_wheel_down"
							? -2
							: ((event as unknown as { deltaY?: number }).deltaY ?? 0) < 0
								? 2
								: -2;
				const prev = this.hoverSlot.scrollFromBottom ?? 0;
				const next = Math.max(0, Math.min(maxBack, prev + step));
				if (next !== prev) {
					this.hoverSlot.scrollFromBottom = next;
					return { handled: true, render: true };
				}
			}
		}

		/* Клик по заголовку (y === 0) работает и ВО ВРЕМЯ стриминга, и после завершения, не ломая выделение текста в теле */
		if (event.type === "press" && event.button === "left" && (!protoActive ? (!this.isExpanded || event.y === 0) : onHeaderRow)) {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left" && (!protoActive || onHeaderRow)) {
			this.onToggle();
			return { handled: true, render: true };
		}
		return undefined;
	}
}

const GLOBAL_THINKING_EXPAND_KEY = Symbol.for("conarti.pi-ui.thinking-expand-all.v1");

function getGlobalThinkingExpandState(): { expandAll: boolean; lastHostHide?: boolean } {
	const g = globalThis as Record<
		symbol,
		{ expandAll: boolean; lastHostHide?: boolean } | undefined
	>;
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

export function installAssistantTranscriptBlocks(): void {
	const proto = AssistantMessageComponent.prototype as any;

	hookMethod(
		proto,
		"setHideThinkingBlock",
		"transcript.thinkingGlobalToggle",
		(_self, args, original) => {
			const [nextHide] = args as [boolean];
			if (isPrototypeActive()) {
				const slot = getGlobalThinkingExpandState();
				if (slot.lastHostHide !== nextHide) {
					slot.lastHostHide = nextHide;
					slot.expandAll = !slot.expandAll;
				}
			}
			return original.apply(_self, args);
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

			self.contentContainer.clear();
			const previousSlots: Array<{ kind: string; markdown: Markdown }> = self.markdownSlots ?? [];
			self.markdownSlots = [];
			const chatPad = Math.max(2, self.outputPad ?? 1);

			const markdownBlock = (kind: string, text: string, create: () => Markdown) => {
				const slot = previousSlots[self.markdownSlots.length];
				const markdown = slot?.kind === kind ? slot.markdown : create();
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
					const defaultExpanded = isPrototypeActive()
						? getGlobalThinkingExpandState().expandAll
						: false;
					const isExpanded = override !== undefined ? !override : defaultExpanded;

					if (thinkingParts.length === 0) {
						if (!activelyThinkingNow || allRedacted || (self.hideThinkingBlock && override === undefined)) {
							continue;
						}
					}

					if (self.hideThinkingBlock && override === undefined && !activelyThinkingNow) {
						if (!String(self.hiddenThinkingLabel ?? "Thinking...").trim()) continue;
					}

					if (activelyThinkingNow) {
						hasActiveThinkingRun = true;
					}

					const durationMs =
						runTiming && runTiming.endedAt !== undefined
							? Math.max(0, runTiming.endedAt - runTiming.startedAt)
							: undefined;

					const mdSlots: Map<number, { light: boolean; md: Markdown }> =
						(self.__conartiThinkingMdSlots ??= new Map());
					const lightNow = isLightTheme(themeRef);
					let mdSlot = mdSlots.get(runIndex);
					if (!mdSlot || mdSlot.light !== lightNow) {
						mdSlot = {
							light: lightNow,
							md: createSoftThinkingMarkdown(joinedThinking, themeRef, lightNow),
						};
						mdSlots.set(runIndex, mdSlot);
					} else {
						mdSlot.md.setText(joinedThinking);
					}
					const hoverSlots: Map<number, { hovered: boolean }> =
						(self.__conartiThinkingHoverSlots ??= new Map());
					let hoverSlot = hoverSlots.get(runIndex);
					if (!hoverSlot) {
						hoverSlot = { hovered: false };
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
							mdSlot,
							hoverSlot,
							runTiming?.startedAt,
							runKey,
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
					new Text(themeRef.fg("error", "Ответ обрезан по лимиту токенов."), chatPad, 0),
				);
			} else if (!hasToolCalls) {
				if (message?.stopReason === "aborted") {
					const abortMsg =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Остановлено";
					self.contentContainer.addChild(new Spacer(1));
					self.contentContainer.addChild(new Text(themeRef.fg("muted", `⏹ ${abortMsg}`), chatPad, 0));
				} else if (message?.stopReason === "error") {
					const errMsg = message.errorMessage || "Unknown error";
					self.contentContainer.addChild(new Spacer(1));
					self.contentContainer.addChild(new Text(themeRef.fg("error", `Ошибка: ${errMsg}`), chatPad, 0));
				}
			}
		},
		["pi.grok-ui.hook.chat.assistantUpdate"],
	);
}
