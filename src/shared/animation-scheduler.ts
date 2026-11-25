import { fgRgb, getActiveGlobalTheme, isLightTheme, type RgbTuple } from "./ansi.ts";

export const BREATHING_FPS = 30;
export const BREATHING_TICK_MS = 33;
export const BREATHING_PERIOD_MS = 2400;
export const WAVE_ROWS = 32;

export const DARK_WAVE_STOPS: readonly [RgbTuple, RgbTuple, RgbTuple] = [
	[64, 82, 112],
	[88, 148, 214],
	[125, 207, 255],
];

export const LIGHT_WAVE_STOPS: readonly [RgbTuple, RgbTuple, RgbTuple] = [
	[148, 163, 184],
	[78, 132, 212],
	[37, 99, 235],
];

export interface WaveSampleOptions {
	light?: boolean;
	theme?: unknown;
	elapsedMs?: number;
}

export type AnimationTickListener = (elapsedMs: number, deltaMs: number) => void;

interface SchedulerState {
	elapsedMs: number;
	lastTickAt: number | undefined;
	timer: ReturnType<typeof setInterval> | undefined;
	subscribers: Map<AnimationTickListener, (() => void) | undefined>;
	surfaces: Map<object | string, () => void>;
}

const SCHEDULER_STATE_KEY = Symbol.for("conarti.pi-ui.animation-scheduler.v1");

function readMonotonicNow(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

function getSchedulerState(): SchedulerState {
	const g = globalThis as Record<symbol, SchedulerState | undefined>;
	if (!g[SCHEDULER_STATE_KEY]) {
		g[SCHEDULER_STATE_KEY] = {
			elapsedMs: 0,
			lastTickAt: undefined,
			timer: undefined,
			subscribers: new Map(),
			surfaces: new Map(),
		};
	}
	return g[SCHEDULER_STATE_KEY]!;
}

function syncTimer(state: SchedulerState): void {
	if (state.subscribers.size === 0) {
		if (state.timer !== undefined) {
			clearInterval(state.timer);
			state.timer = undefined;
		}
		state.lastTickAt = undefined;
		return;
	}

	if (state.timer !== undefined) return;
	state.lastTickAt = readMonotonicNow();
	state.timer = setInterval(() => {
		const now = readMonotonicNow();
		const delta =
			state.lastTickAt !== undefined && now >= state.lastTickAt
				? Math.max(1, now - state.lastTickAt)
				: BREATHING_TICK_MS;
		state.lastTickAt = now;
		state.elapsedMs += delta;

		for (const listener of [...state.subscribers.keys()]) {
			if (!state.subscribers.has(listener)) continue;
			listener(state.elapsedMs, delta);
		}
		if (state.subscribers.size === 0) {
			syncTimer(state);
		}
	}, BREATHING_TICK_MS);
	state.timer.unref?.();
}

export function getAnimationElapsedMs(): number {
	return getSchedulerState().elapsedMs;
}

export function subscribeAnimationTicks(
	listener: AnimationTickListener,
	onStop?: () => void,
): () => void {
	const state = getSchedulerState();
	state.subscribers.set(listener, onStop);
	syncTimer(state);
	return () => {
		state.subscribers.delete(listener);
		syncTimer(state);
	};
}

export function activateAnimationSurface(key: object | string, onFrame: () => void): void {
	const state = getSchedulerState();
	const existing = state.surfaces.get(key);
	if (existing) {
		existing();
	}
	const unsubscribe = subscribeAnimationTicks(() => {
		onFrame();
	});
	state.surfaces.set(key, unsubscribe);
}

export function deactivateAnimationSurface(key: object | string): void {
	const state = getSchedulerState();
	const existing = state.surfaces.get(key);
	if (!existing) return;
	state.surfaces.delete(key);
	existing();
}

export function stopAllAnimations(): void {
	const state = getSchedulerState();
	const stopHooks = [...state.subscribers.values()];
	state.surfaces.clear();
	state.subscribers.clear();
	syncTimer(state);
	for (const onStop of stopHooks) {
		onStop?.();
	}
}

export function computeWaveIntensity(row: number, elapsedMs = getAnimationElapsedMs()): number {
	const safeRow = Number.isFinite(row) ? row : 0;
	const safeElapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
	const angle = (safeRow / WAVE_ROWS - safeElapsed / BREATHING_PERIOD_MS) * Math.PI * 2;
	return (Math.cos(angle) + 1) * 0.5;
}

function lerpChannel(from: number, to: number, weight: number): number {
	return Math.round(from + (to - from) * weight);
}

export function interpolateWaveStops(
	stops: readonly [RgbTuple, RgbTuple, RgbTuple],
	t: number,
): RgbTuple {
	const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
	if (clamped <= 0.5) {
		const local = clamped * 2;
		const [low, mid] = stops;
		return [
			lerpChannel(low[0], mid[0], local),
			lerpChannel(low[1], mid[1], local),
			lerpChannel(low[2], mid[2], local),
		];
	}
	const local = (clamped - 0.5) * 2;
	const [, mid, high] = stops;
	return [
		lerpChannel(mid[0], high[0], local),
		lerpChannel(mid[1], high[1], local),
		lerpChannel(mid[2], high[2], local),
	];
}

export function sampleBreathingWaveRgb(row: number, options?: WaveSampleOptions): RgbTuple {
	const light =
		options?.light !== undefined
			? options.light
			: isLightTheme(options?.theme ?? getActiveGlobalTheme());
	const t = computeWaveIntensity(row, options?.elapsedMs);
	return interpolateWaveStops(light ? LIGHT_WAVE_STOPS : DARK_WAVE_STOPS, t);
}

export function paintBreathingWaveGlyph(
	row: number,
	glyph: string,
	options?: WaveSampleOptions,
): string {
	return fgRgb(sampleBreathingWaveRgb(row, options), glyph);
}

export function paintRunningToolDiamond(
	options?: WaveSampleOptions & { row?: number },
): string {
	return paintBreathingWaveGlyph(options?.row ?? 0, "◆", options);
}

export function paintRunningCommandBar(
	row: number,
	options?: WaveSampleOptions & { glyph?: string },
): string {
	return paintBreathingWaveGlyph(row, options?.glyph ?? "▎", options);
}

export function renderComposerWorkingFrame(options?: WaveSampleOptions): string {
	return paintRunningToolDiamond({ ...options, row: 0 });
}

export const DARK_SHIMMER_STOPS: readonly [RgbTuple, RgbTuple, RgbTuple] = [
	[92, 116, 152],
	[96, 174, 250],
	[218, 244, 255],
];

export const LIGHT_SHIMMER_STOPS: readonly [RgbTuple, RgbTuple, RgbTuple] = [
	[106, 122, 150],
	[37, 99, 235],
	[6, 168, 244],
];

const shimmerSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Samples a smooth 30 fps specular highlight wave (0..1 phase offset) with a focused crest
 * that reads clearly on both dark and light themes without ever changing glyph geometry.
 */
export function sampleSpecularWaveRgb(
	phaseOffset: number,
	options?: WaveSampleOptions & { periodMs?: number },
): RgbTuple {
	const light =
		options?.light !== undefined
			? options.light
			: isLightTheme(options?.theme ?? getActiveGlobalTheme());
	const elapsed = Number.isFinite(options?.elapsedMs) ? options!.elapsedMs! : getAnimationElapsedMs();
	const period = options?.periodMs ?? 2000;
	const safeOffset = Number.isFinite(phaseOffset) ? phaseOffset : 0;
	const angle = (safeOffset - elapsed / period) * Math.PI * 2;
	const raw = (Math.cos(angle) + 1) * 0.5;
	const focused = Math.pow(raw, 1.45);
	return interpolateWaveStops(light ? LIGHT_SHIMMER_STOPS : DARK_SHIMMER_STOPS, focused);
}

export function paintSpecularWaveGlyph(
	phaseOffset: number,
	glyph: string,
	options?: WaveSampleOptions & { periodMs?: number },
): string {
	return fgRgb(sampleSpecularWaveRgb(phaseOffset, options), glyph);
}

/**
 * Paints a smooth 30 fps left-to-right light shimmer across the graphemes of `text`.
 */
export function paintShimmerText(
	text: string,
	options?: WaveSampleOptions & { wavelengthChars?: number; periodMs?: number; startPhase?: number },
): string {
	if (!text) return "";
	const wavelength = Math.max(4, options?.wavelengthChars ?? 16);
	const basePhase = options?.startPhase ?? 0;
	let out = "";
	let idx = 0;
	for (const seg of shimmerSegmenter.segment(text)) {
		const ch = seg.segment;
		if (ch === " ") {
			out += " ";
		} else {
			out += paintSpecularWaveGlyph(basePhase + idx / wavelength, ch, options);
		}
		idx += 1;
	}
	return out;
}

/**
 * Claude-Code-principled sweep-with-pause glimmer upgraded to 30 fps continuous
 * sub-character Gaussian interpolation: text rests calmly in `baseRgb` while a
 * focused ~3-char highlight beam (`shimmerRgb`) glides left-to-right and pauses
 * cleanly between sweeps.
 */
export function paintGlimmerSweepText(
	text: string,
	options?: WaveSampleOptions & {
		totalSpanChars?: number;
		startIndex?: number;
		charsPerSecond?: number;
		leadPad?: number;
		trailPad?: number;
		baseRgb?: RgbTuple;
		shimmerRgb?: RgbTuple;
	},
): string {
	if (!text) return "";
	const light =
		options?.light !== undefined
			? options.light
			: isLightTheme(options?.theme ?? getActiveGlobalTheme());
	const elapsed = Number.isFinite(options?.elapsedMs) ? options!.elapsedMs! : getAnimationElapsedMs();
	const baseRgb: RgbTuple = options?.baseRgb ?? (light ? [37, 99, 235] : [108, 168, 242]);
	const shimmerRgb: RgbTuple = options?.shimmerRgb ?? (light ? [116, 200, 255] : [230, 247, 255]);

	const segments = [...shimmerSegmenter.segment(text)].map((s) => s.segment);
	const startIdx = options?.startIndex ?? 0;
	const totalSpan = Math.max(segments.length, options?.totalSpanChars ?? startIdx + segments.length);
	const leadPad = options?.leadPad ?? 6;
	const trailPad = options?.trailPad ?? 12;
	const cycleLen = totalSpan + leadPad + trailPad;
	const speed = options?.charsPerSecond ?? 18;
	const beamCenter = (((Math.max(0, elapsed) / 1000) * speed) % cycleLen) - leadPad;

	let out = "";
	for (let i = 0; i < segments.length; i++) {
		const ch = segments[i]!;
		if (ch === " ") {
			out += " ";
			continue;
		}
		const dist = startIdx + i - beamCenter;
		const weight = Math.exp(-(dist * dist) / 2.6);
		if (weight < 0.03) {
			out += fgRgb(baseRgb, ch);
		} else {
			const rgb: RgbTuple = [
				Math.round(baseRgb[0] + (shimmerRgb[0] - baseRgb[0]) * weight),
				Math.round(baseRgb[1] + (shimmerRgb[1] - baseRgb[1]) * weight),
				Math.round(baseRgb[2] + (shimmerRgb[2] - baseRgb[2]) * weight),
			];
			out += fgRgb(rgb, ch);
		}
	}
	return out;
}
