/**
 * PROTOTYPE (throwaway branch: prototype/thinking-and-tool-calls)
 * Three variants of Thinking, Working/TTFT, Tool Calls + inline Images, and Response Metrics
 * mounted inside the live Pi transcript, switchable via PI_UI_PROTO_VARIANT, /proto A|B|C|demo|stats|off,
 * Alt+V, and the clickable Composer border pill.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	getAnimationElapsedMs,
	paintBreathingWaveGlyph,
	type WaveSampleOptions,
} from "../../shared/animation-scheduler.ts";
import { fgRgb, getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";

export type PrototypeVariant = "A" | "B" | "C" | "off";
export type ActivePrototypeVariant = Exclude<PrototypeVariant, "off">;
export type WorkingPhase = "idle" | "ttft" | "thinking" | "tool" | "text";

export interface PrototypeVariantMeta {
	readonly key: ActivePrototypeVariant;
	readonly name: string;
	readonly shortLabel: string;
	readonly summary: string;
	readonly settledGlyph: string;
	readonly subtleGlyph: string;
	readonly runningFrames: readonly string[];
	readonly frameStepMs: number;
	readonly defaultDensity: "compact" | "grouped";
}

export const PROTOTYPE_VARIANTS: Record<ActivePrototypeVariant, PrototypeVariantMeta> = {
	A: {
		key: "A",
		name: "Quiet Whisper",
		shortLabel: "A · Quiet Whisper",
		summary: "Орбитальное кольцо ◌/◑/●, бесшовный шёпот Thinking, Compact-сводка в 1 строку, тихая подпись метрик слева",
		settledGlyph: "◈",
		subtleGlyph: "•",
		runningFrames: ["◌", "◔", "◑", "◕", "●", "◕", "◑", "◔"],
		frameStepMs: 140,
		defaultDensity: "compact",
	},
	B: {
		key: "B",
		name: "Prism Rail",
		shortLabel: "B · Prism Rail",
		summary: "Фирменная призма ❖/✦, живой TTFT-импульс в ленте + рамке, тактильный Thinking с швом перевода, правая линейка метрик",
		settledGlyph: "❖",
		subtleGlyph: "❖",
		runningFrames: ["·", "✦", "✧", "❖", "✧", "✦"],
		frameStepMs: 160,
		defaultDensity: "compact",
	},
	C: {
		key: "C",
		name: "Structured Studio",
		shortLabel: "C · Structured Studio",
		summary: "Гекса-решётка ⬢ + фазовый бейдж [TTFT], тонированная плашка Thinking, конвейер по типам шагов, приборная полоса метрик",
		settledGlyph: "⬢",
		subtleGlyph: "⬢",
		runningFrames: ["⠋", "⠙", "⠸", "⣠", "⣄", "⡆"],
		frameStepMs: 110,
		defaultDensity: "grouped",
	},
};

export interface ThinkingDisplayResult {
	readonly text: string;
	readonly mode: "original" | "translated";
	readonly badge?: string;
}

export type ThinkingDisplayProvider = (input: {
	readonly rawText: string;
	readonly runKey?: string;
	readonly isStreaming: boolean;
}) => ThinkingDisplayResult;

interface PrototypeRuntimeState {
	variant: PrototypeVariant;
	translatePreview: boolean;
	metricsVisible: boolean;
	phase: WorkingPhase;
	turnStartedAt?: number;
	firstContentAt?: number;
	activeToolHint?: string;
	phraseSeed: number;
	thinkingProvider?: ThinkingDisplayProvider;
	listeners: Set<() => void>;
}

const PROTO_STATE_SYMBOL = Symbol.for("conarti.pi-ui.prototype-transcript-state.v1");

function parseInitialVariant(): PrototypeVariant {
	const raw = process.env.PI_UI_PROTO_VARIANT?.trim().toUpperCase();
	if (raw === "A" || raw === "B" || raw === "C") return raw;
	if (raw === "OFF" || raw === "0" || raw === "FALSE") return "off";
	if (process.env.VITEST) return "off";
	return "B";
}

function getProtoState(): PrototypeRuntimeState {
	const g = globalThis as Record<symbol, PrototypeRuntimeState | undefined>;
	if (!g[PROTO_STATE_SYMBOL]) {
		g[PROTO_STATE_SYMBOL] = {
			variant: parseInitialVariant(),
			translatePreview: false,
			metricsVisible: true,
			phase: "idle",
			phraseSeed: 0,
			listeners: new Set(),
		};
	}
	return g[PROTO_STATE_SYMBOL]!;
}

export function getPrototypeVariant(): PrototypeVariant {
	return getProtoState().variant;
}

export function isPrototypeActive(): boolean {
	return getProtoState().variant !== "off";
}

export function getActiveVariantMeta(): PrototypeVariantMeta | undefined {
	const v = getProtoState().variant;
	return v === "off" ? undefined : PROTOTYPE_VARIANTS[v];
}

export function setPrototypeVariant(next: PrototypeVariant): void {
	const state = getProtoState();
	if (state.variant === next) return;
	state.variant = next;
	notifyPrototypeChanged();
}

export function cyclePrototypeVariant(): PrototypeVariant {
	const cur = getPrototypeVariant();
	const next: PrototypeVariant = cur === "A" ? "B" : cur === "B" ? "C" : cur === "C" ? "A" : "B";
	setPrototypeVariant(next);
	return next;
}

export function isTranslateSeamPreviewEnabled(): boolean {
	return getProtoState().translatePreview;
}

export function setTranslateSeamPreview(enabled: boolean): void {
	const state = getProtoState();
	if (state.translatePreview === enabled) return;
	state.translatePreview = enabled;
	notifyPrototypeChanged();
}

export function isResponseMetricsEnabled(): boolean {
	return getProtoState().metricsVisible;
}

export function setResponseMetricsEnabled(enabled: boolean): void {
	const state = getProtoState();
	if (state.metricsVisible === enabled) return;
	state.metricsVisible = enabled;
	notifyPrototypeChanged();
}

/**
 * Clean seam for future streaming auto-translation of Thinking blocks.
 * External or internal translation pipelines register a pure display provider
 * without mutating the underlying AssistantMessage content in session history.
 */
export function registerThinkingDisplayProvider(provider: ThinkingDisplayProvider | undefined): void {
	const state = getProtoState();
	state.thinkingProvider = provider;
	notifyPrototypeChanged();
}

function previewTranslateSample(raw: string): string {
	const sampleMap: ReadonlyArray<readonly [RegExp, string]> = [
		[/\bLet's inspect\b/gi, "Проверим"],
		[/\bLet's check\b/gi, "Проверим"],
		[/\bWe need to\b/gi, "Нужно"],
		[/\bFirst,\s*/gi, "Сначала "],
		[/\bNow let's\b/gi, "Теперь давайте"],
		[/\bChecking\b/gi, "Проверяю"],
		[/\bReading\b/gi, "Читаю"],
		[/\bLooking at\b/gi, "Смотрю на"],
	];
	let out = raw;
	for (const [re, rep] of sampleMap) {
		out = out.replace(re, rep);
	}
	return out;
}

export function resolveThinkingDisplay(input: {
	readonly rawText: string;
	readonly runKey?: string;
	readonly isStreaming: boolean;
}): ThinkingDisplayResult {
	const state = getProtoState();
	if (state.thinkingProvider) {
		return state.thinkingProvider(input);
	}
	if (state.translatePreview && /[A-Za-z]{4,}/.test(input.rawText)) {
		return {
			text: previewTranslateSample(input.rawText),
			mode: "translated",
			badge: input.isStreaming ? "RU · поток" : "RU · авто",
		};
	}
	return {
		text: input.rawText,
		mode: "original",
	};
}

export function subscribePrototypeChanges(listener: () => void): () => void {
	const state = getProtoState();
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
	};
}

export function notifyPrototypeChanged(): void {
	const state = getProtoState();
	for (const listener of [...state.listeners]) {
		try {
			listener();
		} catch {
			/* Игнорируем сбои отдельных подписчиков при горячем переключении прототипа. */
		}
	}
}

export function samplePrototypeRunningGlyph(
	row = 0,
	options?: WaveSampleOptions & { variant?: ActivePrototypeVariant },
): string {
	const state = getProtoState();
	const activeKey = options?.variant ?? (state.variant === "off" ? undefined : state.variant);
	if (!activeKey) {
		return paintBreathingWaveGlyph(row, "◆", options);
	}
	const meta = PROTOTYPE_VARIANTS[activeKey];
	const elapsed = options?.elapsedMs ?? getAnimationElapsedMs();
	const idx = Math.floor(Math.max(0, elapsed) / meta.frameStepMs) % meta.runningFrames.length;
	const glyph = meta.runningFrames[idx] ?? meta.settledGlyph;
	return paintBreathingWaveGlyph(row, glyph, options);
}

export function getPrototypeSettledGlyph(variant?: PrototypeVariant): string {
	const v = variant ?? getPrototypeVariant();
	if (v === "off") return "◆";
	return PROTOTYPE_VARIANTS[v].settledGlyph;
}

/* ── Живые фазы и глаголы статуса Working / TTFT ─────────────────────────── */

const TTFT_VERBS: readonly string[] = [
	"Ловлю волну…",
	"Вникаю в контекст…",
	"Настраиваю фокус…",
	"Собираю нить…",
	"Ищу лучшую точку входа…",
];

const THINKING_VERBS: readonly string[] = [
	"Прокручиваю варианты…",
	"Сверяю архитектуру…",
	"Взвешиваю компромиссы…",
	"Выстраиваю маршрут…",
	"Проверяю детали…",
];

const TOOL_VERBS: readonly string[] = [
	"Исследую проект…",
	"Сверяю фактуру в коде…",
	"Проверяю гипотезу…",
	"Собираю картину…",
];

const TEXT_VERBS: readonly string[] = [
	"Кристаллизую ответ…",
	"Формулирую решение…",
	"Шлифую детали…",
	"Собираю всё воедино…",
];

export function beginWorkingTurn(now = Date.now()): void {
	const state = getProtoState();
	state.phase = "ttft";
	state.turnStartedAt = now;
	state.firstContentAt = undefined;
	state.activeToolHint = undefined;
	state.phraseSeed = (state.phraseSeed + 1) % 97;
}

export function markWorkingPhase(
	phase: WorkingPhase,
	options?: { now?: number; toolHint?: string },
): void {
	const state = getProtoState();
	const now = options?.now ?? Date.now();
	if (phase !== "idle" && phase !== "ttft" && state.firstContentAt === undefined) {
		state.firstContentAt = now;
	}
	state.phase = phase;
	if (options?.toolHint !== undefined) {
		state.activeToolHint = options.toolHint;
	} else if (phase !== "tool") {
		state.activeToolHint = undefined;
	}
	if (phase === "idle") {
		state.turnStartedAt = undefined;
		state.firstContentAt = undefined;
		state.activeToolHint = undefined;
	}
}

export function getWorkingSnapshot(): {
	readonly phase: WorkingPhase;
	readonly turnStartedAt?: number;
	readonly firstContentAt?: number;
	readonly activeToolHint?: string;
} {
	const state = getProtoState();
	return {
		phase: state.phase,
		turnStartedAt: state.turnStartedAt,
		firstContentAt: state.firstContentAt,
		activeToolHint: state.activeToolHint,
	};
}

function formatCompactElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 100) return "0.1s";
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const sec = Math.floor(ms / 1000);
	return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function pickPhasePhrase(phase: WorkingPhase, elapsedTurnMs: number, seed: number, toolHint?: string): string {
	if (phase === "tool" && toolHint) {
		return toolHint;
	}
	const pool =
		phase === "ttft"
			? TTFT_VERBS
			: phase === "thinking"
				? THINKING_VERBS
				: phase === "tool"
					? TOOL_VERBS
					: TEXT_VERBS;
	const bucket = Math.floor(Math.max(0, elapsedTurnMs) / 2600);
	return pool[(seed + bucket) % pool.length] ?? "Работаю…";
}

export function buildLiveWorkingPresentation(options?: {
	now?: number;
	animElapsedMs?: number;
	theme?: Theme;
	interruptKey?: string;
	variant?: ActivePrototypeVariant;
}): {
	readonly indicatorFrame: string;
	readonly borderMessage: string;
	readonly ttftTranscriptLine?: string;
} {
	const state = getProtoState();
	const activeVariant = options?.variant ?? (state.variant === "off" ? "B" : state.variant);
	const now = options?.now ?? Date.now();
	const animMs = options?.animElapsedMs ?? getAnimationElapsedMs();
	const theme = options?.theme ?? getActiveGlobalTheme();
	const light = isLightTheme(theme);
	const interruptHint = options?.interruptKey ?? "esc";

	const phase: WorkingPhase = state.phase === "idle" ? "ttft" : state.phase;
	const elapsedTurnMs = state.turnStartedAt !== undefined ? Math.max(0, now - state.turnStartedAt) : animMs;
	const phrase = pickPhasePhrase(phase, elapsedTurnMs, state.phraseSeed, state.activeToolHint);
	const timerText = formatCompactElapsed(elapsedTurnMs);
	const indicatorFrame = samplePrototypeRunningGlyph(0, {
		theme,
		light,
		elapsedMs: animMs,
		variant: activeVariant,
	});

	if (activeVariant === "C") {
		const badgeLabel =
			phase === "ttft"
				? `TTFT ${timerText}`
				: phase === "thinking"
					? `МЫСЛЬ ${timerText}`
					: phase === "tool"
						? `ШАГИ ${timerText}`
						: `ОТВЕТ ${timerText}`;
		const badgeStyled = light
			? fgRgb(37, 99, 235, `[${badgeLabel}]`)
			: fgRgb(125, 196, 255, `[${badgeLabel}]`);
		return {
			indicatorFrame,
			borderMessage: `${badgeStyled} ${phrase} (${interruptHint} стоп)`,
		};
	}

	const subtleDot = light ? fgRgb(148, 163, 184, "·") : fgRgb(92, 108, 132, "·");
	const styledTimer = light ? fgRgb(71, 85, 105, timerText) : fgRgb(138, 156, 182, timerText);
	const borderMessage = `${phrase} ${subtleDot} ${styledTimer} (${interruptHint} прервать)`;

	let ttftTranscriptLine: string | undefined;
	if (activeVariant === "B" && phase === "ttft") {
		const phraseStyled = light ? fgRgb(71, 85, 105, phrase) : fgRgb(132, 152, 180, phrase);
		ttftTranscriptLine = `  ${indicatorFrame} ${phraseStyled} ${subtleDot} ${styledTimer}`;
	}

	return {
		indicatorFrame,
		borderMessage,
		ttftTranscriptLine,
	};
}
