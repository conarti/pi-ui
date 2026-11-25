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

const LIGHT_CAUSTIC_STOPS: readonly [RgbTuple, RgbTuple, RgbTuple, RgbTuple] = [
	[29, 78, 216],
	[37, 99, 235],
	[16, 150, 248],
	[126, 210, 255],
];

const DARK_CAUSTIC_STOPS: readonly [RgbTuple, RgbTuple, RgbTuple, RgbTuple] = [
	[84, 122, 184],
	[104, 164, 242],
	[150, 214, 255],
	[236, 250, 255],
];

function interpolateFourStops(
	stops: readonly [RgbTuple, RgbTuple, RgbTuple, RgbTuple],
	level: number,
): RgbTuple {
	const t = Math.max(0, Math.min(1, level));
	let a: RgbTuple;
	let b: RgbTuple;
	let u: number;
	if (t < 0.32) {
		a = stops[0];
		b = stops[1];
		u = t / 0.32;
	} else if (t < 0.7) {
		a = stops[1];
		b = stops[2];
		u = (t - 0.32) / 0.38;
	} else {
		a = stops[2];
		b = stops[3];
		u = (t - 0.7) / 0.3;
	}
	return [
		Math.round(a[0] + (b[0] - a[0]) * u),
		Math.round(a[1] + (b[1] - a[1]) * u),
		Math.round(a[2] + (b[2] - a[2]) * u),
	];
}

/**
 * Wide, organic 30 fps liquid-aurora shimmer:
 * 1) Non-linear eased S-curve glide (`u + 0.14 * sin(2πu)`, C∞ seamless at loop boundary)
 *    so the wave accelerates out of the brand mark and lingers/expands over the words;
 * 2) Asymmetric 12-16 char comet envelope (crisp leading edge + long luminous wake) whose
 *    width dynamically breathes (`1 + 0.36 * sin(2.2t)`) instead of a rigid vertical bar;
 * 3) Dual-harmonic counter-drifting caustic swell beneath the main crest across 4 blue-cyan stops.
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
	const tSec = Math.max(0, elapsed) / 1000;

	const segments = [...shimmerSegmenter.segment(text)].map((s) => s.segment);
	const startIdx = options?.startIndex ?? 0;
	const totalSpan = Math.max(segments.length, options?.totalSpanChars ?? startIdx + segments.length);
	const leadPad = options?.leadPad ?? 9;
	const trailPad = options?.trailPad ?? 15;
	const cycleLen = totalSpan + leadPad + trailPad;
	const periodSec = Math.max(1.9, cycleLen / (options?.charsPerSecond ?? 17));
	const rawU = (tSec / periodSec) % 1;
	const easedU = rawU + (0.14 * Math.sin(rawU * Math.PI * 2)) / (Math.PI * 2) * 4.2;
	const headPos = easedU * cycleLen - leadPad;

	const breathScale = 1 + 0.36 * Math.sin(tSec * 2.25);
	const sigmaFront = 3.4 * breathScale;
	const sigmaTail = 8.4 * breathScale;

	const customStops: readonly [RgbTuple, RgbTuple, RgbTuple, RgbTuple] | undefined =
		options?.baseRgb && options?.shimmerRgb
			? [
					options.baseRgb,
					[
						Math.round(options.baseRgb[0] * 0.82 + options.shimmerRgb[0] * 0.18),
						Math.round(options.baseRgb[1] * 0.82 + options.shimmerRgb[1] * 0.18),
						Math.round(options.baseRgb[2] * 0.82 + options.shimmerRgb[2] * 0.18),
					],
					[
						Math.round(options.baseRgb[0] * 0.38 + options.shimmerRgb[0] * 0.62),
						Math.round(options.baseRgb[1] * 0.38 + options.shimmerRgb[1] * 0.62),
						Math.round(options.baseRgb[2] * 0.38 + options.shimmerRgb[2] * 0.62),
					],
					options.shimmerRgb,
				]
			: undefined;
	const paletteStops = customStops ?? (light ? LIGHT_CAUSTIC_STOPS : DARK_CAUSTIC_STOPS);

	let out = "";
	for (let i = 0; i < segments.length; i++) {
		const ch = segments[i]!;
		if (ch === " ") {
			out += " ";
			continue;
		}
		const x = startIdx + i;
		const delta = x - headPos;
		const sigma = delta > 0 ? sigmaFront : sigmaTail;
		const comet = Math.exp(-(delta * delta) / (2 * sigma * sigma));

		const swellA = (Math.sin(x * 0.21 - tSec * 2.5) + 1) * 0.5;
		const swellB = (Math.sin(x * 0.36 + tSec * 1.65) + 1) * 0.5;
		const caustic = Math.pow(swellA * 0.64 + swellB * 0.36, 1.5);

		const level = Math.min(1, 0.14 + comet * 0.74 + caustic * 0.28);
		out += fgRgb(interpolateFourStops(paletteStops, level), ch);
	}
	return out;
}
