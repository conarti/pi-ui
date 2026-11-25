/**
 * PROTOTYPE (throwaway branch: prototype/thinking-and-tool-calls)
 * Three English-first variants of Thinking, Working/TTFT, Tool Calls + inline Images,
 * and Response Metrics mounted inside the live Pi transcript.
 */
import {
	getAnimationElapsedMs,
	paintBreathingWaveGlyph,
	type WaveSampleOptions,
} from "../../shared/animation-scheduler.ts";
import { getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";

export type PrototypeVariant = "A" | "B" | "C" | "off";
export type ActivePrototypeVariant = Exclude<PrototypeVariant, "off">;
export type WorkingPhase = "idle" | "ttft" | "thinking" | "tool" | "text";

export interface PrototypeVariantMeta {
	readonly key: ActivePrototypeVariant;
	readonly name: string;
	readonly shortLabel: string;
	readonly pillLabel: string;
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
		pillLabel: "◌ A · Quiet ↻",
		summary: "Orbital ring ◌/◑/●, 1-line calm streaming Thinking ticker (click expands full stream), Compact all-grouped tools, left turn sign-off",
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
		pillLabel: "❖ B · Prism ↻",
		summary: "Prism mark ❖/✦, contextual working summary, 6-line page-stabilized streaming Thinking (click unfolds full stream), right metrics rule",
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
		pillLabel: "⬢ C · Studio ↻",
		summary: "Hex lattice ⬢ + phase tag, 8-line wheel-scrollable live Thinking box, category-grouped tools, two-zone metrics strip",
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
	demoTranslated: boolean;
	metricsVisible: boolean;
	phase: WorkingPhase;
	turnStartedAt?: number;
	firstContentAt?: number;
	contextualSummary?: string;
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
			demoTranslated: false,
			metricsVisible: true,
			phase: "idle",
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
	return getProtoState().demoTranslated;
}

export function setTranslateSeamPreview(enabled: boolean): void {
	const state = getProtoState();
	if (state.demoTranslated === enabled) return;
	state.demoTranslated = enabled;
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
 * Clean seam for future streaming auto-translation of Thinking blocks (Echelon 3).
 * Never shows a translated badge unless a real translation payload is supplied.
 */
export function registerThinkingDisplayProvider(provider: ThinkingDisplayProvider | undefined): void {
	const state = getProtoState();
	state.thinkingProvider = provider;
	notifyPrototypeChanged();
}

const DEMO_TRANSLATED_TEXT = [
	"Проверим `ThinkingBlock` в `src/features/transcript/thinking-block.ts`: клик по заголовку во время стриминга сразу разворачивает полный текст мысли и сохраняет его открытым после завершения.",
	"В компактном режиме страница на 6 строк заполняется сверху вниз спокойно, без подпрыгивания строк на каждом переносе слова.",
	"Проверим `ToolGroupController` в `grouping.ts`, чтобы результаты с `{ type: \"image\" }` всегда рендерились инлайн через `Image`, а не прятались внутрь свёрнутой сводки.",
].join("\n\n");

export function resolveThinkingDisplay(input: {
	readonly rawText: string;
	readonly runKey?: string;
	readonly isStreaming: boolean;
}): ThinkingDisplayResult {
	const state = getProtoState();
	if (state.thinkingProvider) {
		return state.thinkingProvider(input);
	}
	if (state.demoTranslated && input.runKey === "demo:0") {
		return {
			text: DEMO_TRANSLATED_TEXT,
			mode: "translated",
			badge: "RU",
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
			/* Ignore transient subscriber errors during hot reload or live variant switches. */
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

/* ── Contextual, meaning-aware Working / TTFT status extraction ──────────── */

function cleanSnippetWords(raw: string, maxChars = 48): string | undefined {
	const single = raw
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/[*_#~[\]()]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
	if (!single) return undefined;
	if (single.length <= maxChars) return single;
	const cut = single.slice(0, maxChars - 1).replace(/\s+\S*$/u, "");
	return `${cut || single.slice(0, maxChars - 1)}…`;
}

/**
 * Extracts a concise, concrete status phrase from the model's live Thinking stream
 * (preferring explicit bold/markdown section titles, otherwise the latest active clause).
 */
export function summarizeLiveThinkingIntent(rawThinking: string): string | undefined {
	if (!rawThinking.trim()) return undefined;
	const lines = rawThinking
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !/^(?:`{3,}|~{3,})/u.test(l));
	if (lines.length === 0) return undefined;

	/* 1. Ищем последний явный смысловой заголовок (**Heading** или ### Heading) */
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const boldMatch = /^\*\*([^*]{4,64})\*\*(?::|\s|$)/u.exec(line);
		if (boldMatch?.[1]) {
			const cleaned = cleanSnippetWords(boldMatch[1], 46);
			if (cleaned) return cleaned.endsWith("…") ? cleaned : `${cleaned}…`;
		}
		const mdMatch = /^#{1,4}\s+(.{4,64})$/u.exec(line);
		if (mdMatch?.[1]) {
			const cleaned = cleanSnippetWords(mdMatch[1], 46);
			if (cleaned) return cleaned.endsWith("…") ? cleaned : `${cleaned}…`;
		}
	}

	/* 2. Иначе берём свежую осмысленную фразу из последней непустой строки */
	const latest = lines[lines.length - 1]!;
	const strippedLead = latest
		.replace(/^(?:[-*+]\s+|\d+\.\s+)/u, "")
		.replace(/^(?:ok(?:ay)?[,.]?\s+|so\s+|now\s+|first[,.]?\s+|let's\s+|we\s+(?:need|should|can)\s+to\s+|we\s+(?:need|should|can)\s+)/iu, "");
	if (strippedLead.length < 6) return undefined;
	const firstClause = strippedLead.split(/[.!?;—–]/u)[0]?.trim() ?? strippedLead;
	const cleaned = cleanSnippetWords(firstClause, 46);
	if (!cleaned) return undefined;
	const capitalized = cleaned[0]!.toUpperCase() + cleaned.slice(1);
	return capitalized.endsWith("…") ? capitalized : `${capitalized}…`;
}

export function beginWorkingTurn(now = Date.now()): void {
	const state = getProtoState();
	state.phase = "ttft";
	state.turnStartedAt = now;
	state.firstContentAt = undefined;
	state.contextualSummary = undefined;
}

export function markWorkingPhase(
	phase: WorkingPhase,
	options?: { now?: number; summary?: string },
): void {
	const state = getProtoState();
	const now = options?.now ?? Date.now();
	if (phase === "idle") {
		state.phase = "idle";
		state.turnStartedAt = undefined;
		state.firstContentAt = undefined;
		state.contextualSummary = undefined;
		return;
	}
	state.turnStartedAt ??= now;
	if (phase !== "ttft" && state.firstContentAt === undefined) {
		state.firstContentAt = now;
	}
	state.phase = phase;
	if (options?.summary !== undefined) {
		state.contextualSummary = options.summary;
	} else if (phase === "ttft") {
		state.contextualSummary = undefined;
	}
}

function formatCompactElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 100) return "0.1s";
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const sec = Math.floor(ms / 1000);
	return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function resolveDefaultPhaseLabel(phase: WorkingPhase): string {
	switch (phase) {
		case "ttft":
			return "Connecting…";
		case "thinking":
			return "Thinking…";
		case "tool":
			return "Running tools…";
		case "text":
			return "Responding…";
		case "idle":
		default:
			return "Working…";
	}
}

/**
 * Returns the animated brand glyph and a plain-text status string WITHOUT inner SGR resets
 * and WITHOUT redundant "(esc to interrupt)" hints, so WorkingStatusIndicator paints evenly.
 */
export function buildLiveWorkingPresentation(options?: {
	now?: number;
	animElapsedMs?: number;
	theme?: unknown;
	variant?: ActivePrototypeVariant;
}): {
	readonly indicatorFrame: string;
	readonly borderMessage: string;
} {
	const state = getProtoState();
	const activeVariant = options?.variant ?? (state.variant === "off" ? "B" : state.variant);
	const now = options?.now ?? Date.now();
	const animMs = options?.animElapsedMs ?? getAnimationElapsedMs();
	const theme = options?.theme ?? getActiveGlobalTheme();
	const light = isLightTheme(theme);

	const phase: WorkingPhase = state.phase === "idle" ? "ttft" : state.phase;
	const elapsedTurnMs = state.turnStartedAt !== undefined ? Math.max(0, now - state.turnStartedAt) : animMs;
	const summary = state.contextualSummary || resolveDefaultPhaseLabel(phase);
	const timerText = formatCompactElapsed(elapsedTurnMs);
	const indicatorFrame = samplePrototypeRunningGlyph(0, {
		theme,
		light,
		elapsedMs: animMs,
		variant: activeVariant,
	});

	if (activeVariant === "C") {
		const phaseTag =
			phase === "ttft"
				? "TTFT"
				: phase === "thinking"
					? "THINK"
					: phase === "tool"
						? "TOOLS"
						: "REPLY";
		return {
			indicatorFrame,
			borderMessage: `[${phaseTag} ${timerText}] ${summary}`,
		};
	}

	return {
		indicatorFrame,
		borderMessage: `${summary} · ${timerText}`,
	};
}
