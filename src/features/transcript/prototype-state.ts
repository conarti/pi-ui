/**
 * PROTOTYPE (throwaway branch: prototype/thinking-and-tool-calls)
 * Three English-first variants of Thinking, Working/TTFT, Tool Calls + inline Images,
 * and Response Metrics mounted inside the live Pi transcript.
 */
import {
	getAnimationElapsedMs,
	paintBreathingWaveGlyph,
	paintGlimmerSweepText,
	paintSpecularWaveGlyph,
	type WaveSampleOptions,
} from "../../shared/animation-scheduler.ts";
import { fgRgb, getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PrototypeVariant = "A" | "B" | "C" | "off";
export type ActivePrototypeVariant = Exclude<PrototypeVariant, "off">;
export type WorkingPhase = "idle" | "ttft" | "thinking" | "tool" | "text";

export interface BrandMarkFacet {
	readonly glyph: string;
	readonly phase: number;
}

export interface PrototypeVariantMeta {
	readonly key: ActivePrototypeVariant;
	readonly name: string;
	readonly shortLabel: string;
	readonly pillLabel: string;
	readonly summary: string;
	readonly borderFacets: readonly BrandMarkFacet[];
	readonly inlineGlyph: string;
	readonly settledGlyph: string;
	readonly subtleGlyph: string;
	readonly defaultDensity: "compact" | "balanced" | "grouped";
}

export const PROTOTYPE_VARIANTS: Record<ActivePrototypeVariant, PrototypeVariantMeta> = {
	A: {
		key: "A",
		name: "Quiet Canvas & Post-Block",
		shortLabel: "A · Quiet Canvas",
		pillLabel: "✦ Proto A · Quiet ↻",
		summary: "Flush canvas Header, pure-air User Prompt (Copy · HH:MM), inline ✦ /skill pill, bottom [Copy] code blocks, 2-line Sticky + 1-col edge rail",
		borderFacets: [{ glyph: "✦", phase: 0 }],
		inlineGlyph: "✦",
		settledGlyph: "✦",
		subtleGlyph: "•",
		defaultDensity: "balanced",
	},
	B: {
		key: "B",
		name: "Structured Two-Tone",
		shortLabel: "B · Two-Tone",
		pillLabel: "✦ Proto B · Two-Tone ↻",
		summary: "Tinted chrome Header, ▎-edged User Prompt (in-place Copy swap), ⚡ skill badge, smart two-tone Code Card, 3-line #N Sticky + 2-col Outline Rail",
		borderFacets: [{ glyph: "✦", phase: 0 }],
		inlineGlyph: "✦",
		settledGlyph: "✦",
		subtleGlyph: "•",
		defaultDensity: "balanced",
	},
	C: {
		key: "C",
		name: "Compact Ribbon & Corner",
		shortLabel: "C · Compact Ribbon",
		pillLabel: "✦ Proto C · Ribbon ↻",
		summary: "Hairline-separated Header, compact 1-row short User Prompt, /skill wash token, corner-pill Code Card, 1-line Sticky ribbon + ✦/• spine",
		borderFacets: [{ glyph: "✦", phase: 0 }],
		inlineGlyph: "✦",
		settledGlyph: "✦",
		subtleGlyph: "•",
		defaultDensity: "balanced",
	},
};

/**
 * Original 1-word tactile/craft/optics/culinary English gerunds inspired by Claude Code's
 * single-word spinner principle (never multi-word corporate boilerplate, never copied verbatim).
 */
export const PLAYFUL_WORKING_VERBS: readonly string[] = [
	"Tinkering…",
	"Simmering…",
	"Unspooling…",
	"Dovetailing…",
	"Steeping…",
	"Refracting…",
	"Whittling…",
	"Sifting…",
	"Triangulating…",
	"Burnishing…",
	"Noodling…",
	"Distilling…",
	"Spelunking…",
	"Weaving…",
	"Percolating…",
	"Sketching…",
	"Tempering…",
	"Untangling…",
	"Decanting…",
	"Stargazing…",
	"Kneading…",
	"Charting…",
	"Riffing…",
	"Sculpting…",
	"Infusing…",
	"Mulling…",
	"Calibrating…",
	"Forging…",
];

const MIN_CONTEXTUAL_HOLD_MS = 4500;
const TOOL_END_LINGER_MS = 1800;

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
	turnVerbSeed: number;
	contextualSummary?: string;
	contextualUpdatedAt?: number;
	contextualExpiresAt?: number;
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
			turnVerbSeed: Math.floor(Math.random() * PLAYFUL_WORKING_VERBS.length),
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

/**
 * Renders the 1-cell inline brand mark with 30 fps specular color wave (stationary geometry,
 * zero glyph jumping) for Thinking headers and running Tool Call rows.
 */
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
	return paintSpecularWaveGlyph(row * 0.14, meta.inlineGlyph, {
		...options,
		periodMs: 1850,
	});
}

/**
 * Renders the multi-facet Composer border brand mark (✦, ▍▎, or ◢◤) with a 30 fps
 * phase-shifted specular wave across facets.
 */
export function renderPrototypeBrandMark(
	options?: WaveSampleOptions & { variant?: ActivePrototypeVariant },
): string {
	const state = getProtoState();
	const activeKey = options?.variant ?? (state.variant === "off" ? "B" : state.variant);
	const meta = PROTOTYPE_VARIANTS[activeKey];
	return meta.borderFacets
		.map((facet) =>
			paintSpecularWaveGlyph(facet.phase, facet.glyph, {
				...options,
				periodMs: 1850,
			}),
		)
		.join("");
}

export function getPrototypeSettledGlyph(variant?: PrototypeVariant): string {
	const v = variant ?? getPrototypeVariant();
	if (v === "off") return "◆";
	return PROTOTYPE_VARIANTS[v].settledGlyph;
}

/* ── Zero-token heading extraction & playful 1-word fallback verbs ──────── */

function cleanSnippetWords(raw: string, maxChars = 46): string | undefined {
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
 * Extracts explicit section headings (**Heading** or ### Heading) emitted naturally
 * in the model's streaming thoughts (100% token-free local parsing). Never grabs random
 * half-sentences so fallback 1-word verbs remain crisp and readable.
 */
export function summarizeLiveThinkingIntent(rawThinking: string): string | undefined {
	if (!rawThinking.trim()) return undefined;
	const lines = rawThinking
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !/^(?:`{3,}|~{3,})/u.test(l));
	if (lines.length === 0) return undefined;

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const boldMatch = /^\*\*([^*]{4,56})\*\*(?::|\s|$)/u.exec(line);
		if (boldMatch?.[1]) {
			const cleaned = cleanSnippetWords(boldMatch[1], 44);
			if (cleaned) return cleaned.endsWith("…") ? cleaned : `${cleaned}…`;
		}
		const mdMatch = /^#{1,4}\s+(.{4,56})$/u.exec(line);
		if (mdMatch?.[1]) {
			const cleaned = cleanSnippetWords(mdMatch[1], 44);
			if (cleaned) return cleaned.endsWith("…") ? cleaned : `${cleaned}…`;
		}
	}
	return undefined;
}

export function beginWorkingTurn(now = Date.now()): void {
	const state = getProtoState();
	state.phase = "ttft";
	state.turnStartedAt = now;
	state.firstContentAt = undefined;
	state.turnVerbSeed = (state.turnVerbSeed + 5 + Math.floor(now % 7)) % PLAYFUL_WORKING_VERBS.length;
	state.contextualSummary = undefined;
	state.contextualUpdatedAt = undefined;
	state.contextualExpiresAt = undefined;
}

export function markWorkingPhase(
	phase: WorkingPhase,
	options?: { now?: number; summary?: string; lingerPrevious?: boolean },
): void {
	const state = getProtoState();
	const now = options?.now ?? Date.now();
	if (phase === "idle") {
		state.phase = "idle";
		state.turnStartedAt = undefined;
		state.firstContentAt = undefined;
		state.contextualSummary = undefined;
		state.contextualUpdatedAt = undefined;
		state.contextualExpiresAt = undefined;
		return;
	}
	state.turnStartedAt ??= now;
	if (phase !== "ttft" && state.firstContentAt === undefined) {
		state.firstContentAt = now;
	}
	state.phase = phase;

	if (options?.lingerPrevious) {
		if (state.contextualSummary) {
			state.contextualExpiresAt = now + TOOL_END_LINGER_MS;
		}
		return;
	}

	if (phase === "text") {
		state.contextualSummary = "Drafting…";
		state.contextualUpdatedAt = now;
		state.contextualExpiresAt = undefined;
		return;
	}

	if (options && "summary" in options) {
		const nextSummary = options.summary;
		if (!nextSummary) {
			/* Keep current contextual summary if it hasn't finished its minimum display hold yet */
			if (
				state.contextualSummary &&
				state.contextualUpdatedAt !== undefined &&
				now - state.contextualUpdatedAt < MIN_CONTEXTUAL_HOLD_MS
			) {
				return;
			}
			state.contextualSummary = undefined;
			state.contextualUpdatedAt = undefined;
			state.contextualExpiresAt = undefined;
			return;
		}
		if (nextSummary === state.contextualSummary) {
			state.contextualExpiresAt = undefined;
			return;
		}
		/* Avoid rapid flickering between consecutive headings or fast sub-1s tool calls */
		if (
			state.contextualSummary &&
			state.contextualUpdatedAt !== undefined &&
			now - state.contextualUpdatedAt < MIN_CONTEXTUAL_HOLD_MS
		) {
			return;
		}
		state.contextualSummary = nextSummary;
		state.contextualUpdatedAt = now;
		state.contextualExpiresAt = undefined;
	} else if (phase === "ttft") {
		state.contextualSummary = undefined;
		state.contextualUpdatedAt = undefined;
		state.contextualExpiresAt = undefined;
	}
}

function resolveActiveContextualSummary(state: PrototypeRuntimeState, now: number): string | undefined {
	if (!state.contextualSummary) return undefined;
	if (state.contextualExpiresAt !== undefined && now >= state.contextualExpiresAt) {
		state.contextualSummary = undefined;
		state.contextualUpdatedAt = undefined;
		state.contextualExpiresAt = undefined;
		return undefined;
	}
	return state.contextualSummary;
}

function formatCompactElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 100) return "0.1s";
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const sec = Math.floor(ms / 1000);
	return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function pickPlayfulVerb(seed: number): string {
	const idx = Math.abs(seed) % PLAYFUL_WORKING_VERBS.length;
	return PLAYFUL_WORKING_VERBS[idx] ?? "Tinkering…";
}

function resolveDefaultPhaseLabel(phase: WorkingPhase, seed: number): string {
	if (phase === "text") {
		return "Drafting…";
	}
	return pickPlayfulVerb(seed);
}

/**
 * Plain-text fallback for hosts outside Composer's custom shimmer border.
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
	const activeContextual = resolveActiveContextualSummary(state, now);
	const summary = activeContextual || resolveDefaultPhaseLabel(phase, state.turnVerbSeed);
	const timerText = formatCompactElapsed(elapsedTurnMs);
	const indicatorFrame = renderPrototypeBrandMark({
		theme,
		light,
		elapsedMs: animMs,
		variant: activeVariant,
	});

	return {
		indicatorFrame,
		borderMessage: `${summary} · ${timerText}`,
	};
}

/**
 * Renders the full 30 fps shimmering Composer top-border working status:
 * stationary multi-facet brand mark + per-character specular shimmer across the status
 * label + calm muted elapsed timer, strictly fitted within `maxWidth`.
 */
export function renderPrototypeBorderWorkingStatus(
	maxWidth: number,
	options?: {
		now?: number;
		animElapsedMs?: number;
		theme?: unknown;
		variant?: ActivePrototypeVariant;
	},
): string {
	if (maxWidth <= 0) return "";
	const state = getProtoState();
	const activeVariant = options?.variant ?? (state.variant === "off" ? "B" : state.variant);
	const meta = PROTOTYPE_VARIANTS[activeVariant];
	const now = options?.now ?? Date.now();
	const animMs = options?.animElapsedMs ?? getAnimationElapsedMs();
	const theme = options?.theme ?? getActiveGlobalTheme();
	const light = isLightTheme(theme);

	const markPlain = meta.borderFacets.map((f) => f.glyph).join("");
	const markW = visibleWidth(markPlain);
	if (maxWidth <= markW) {
		return truncateToWidth(
			renderPrototypeBrandMark({ theme, light, elapsedMs: animMs, variant: activeVariant }),
			maxWidth,
			"",
		);
	}

	const phase: WorkingPhase = state.phase === "idle" ? "ttft" : state.phase;
	const elapsedTurnMs = state.turnStartedAt !== undefined ? Math.max(0, now - state.turnStartedAt) : animMs;
	const activeContextual = resolveActiveContextualSummary(state, now);
	const rawSummary = activeContextual || resolveDefaultPhaseLabel(phase, state.turnVerbSeed);
	const timerPlain = ` · ${formatCompactElapsed(elapsedTurnMs)}`;
	const timerW = visibleWidth(timerPlain);
	const dimTimer = light ? fgRgb(124, 138, 160, timerPlain) : fgRgb(104, 118, 142, timerPlain);

	const availAfterMark = maxWidth - markW - 1;
	if (availAfterMark < 4) {
		return renderPrototypeBrandMark({
			theme,
			light,
			elapsedMs: animMs,
			variant: activeVariant,
		});
	}

	const includeTimer = availAfterMark >= timerW + 8;
	const summaryBudget = includeTimer ? availAfterMark - timerW : availAfterMark;
	const clippedSummary = truncateToWidth(rawSummary, summaryBudget, "…");
	const combinedPlain = `${markPlain} ${clippedSummary}`;
	const glimmerCombined = paintGlimmerSweepText(combinedPlain, {
		theme,
		light,
		elapsedMs: animMs,
		charsPerSecond: 18,
		leadPad: 5,
		trailPad: 12,
	});

	return includeTimer ? `${glimmerCombined}${dimTimer}` : glimmerCombined;
}
