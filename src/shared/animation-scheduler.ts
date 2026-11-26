import {
	blueFgRgbPrefix,
	clampHueOutsideForbiddenBands,
	getActiveGlobalTheme,
	isLightTheme,
	type RgbTuple,
} from "./ansi.ts";

export const POLARIS_STAR = "✦";
export const POLARIS_SECONDARY = "•";

export const BREATHING_FPS = 30;
export const BREATHING_TICK_MS = 33;
export const BREATHING_PERIOD_MS = 2400;
export const WAVE_ROWS = 32;

const glimmerSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const LIGHT_CAUSTIC_STOPS: readonly [RgbTuple, RgbTuple, RgbTuple, RgbTuple] = [
	[29, 78, 216],
	[37, 99, 235],
	[24, 146, 246],
	[118, 204, 255],
];

const DARK_CAUSTIC_STOPS: readonly [RgbTuple, RgbTuple, RgbTuple, RgbTuple] = [
	[84, 122, 184],
	[104, 164, 242],
	[148, 210, 255],
	[228, 245, 255],
];

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
	return `${blueFgRgbPrefix(sampleBreathingWaveRgb(row, options), options?.theme)}${glyph}\x1b[39m`;
}

export interface GlimmerSweepOptions extends WaveSampleOptions {
	readonly totalSpanChars?: number;
	readonly startIndex?: number;
	readonly charsPerSecond?: number;
	readonly leadPad?: number;
	readonly trailPad?: number;
	readonly baseRgb?: RgbTuple;
	readonly shimmerRgb?: RgbTuple;
}

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
	return clampHueOutsideForbiddenBands([
		Math.round(a[0] + (b[0] - a[0]) * u),
		Math.round(a[1] + (b[1] - a[1]) * u),
		Math.round(a[2] + (b[2] - a[2]) * u),
	]);
}

function resolveGlimmerStops(
	light: boolean,
	options?: GlimmerSweepOptions,
): readonly [RgbTuple, RgbTuple, RgbTuple, RgbTuple] {
	if (options?.baseRgb && options?.shimmerRgb) {
		const base = options.baseRgb;
		const peak = options.shimmerRgb;
		return [
			base,
			[
				Math.round(base[0] * 0.82 + peak[0] * 0.18),
				Math.round(base[1] * 0.82 + peak[1] * 0.18),
				Math.round(base[2] * 0.82 + peak[2] * 0.18),
			],
			[
				Math.round(base[0] * 0.38 + peak[0] * 0.62),
				Math.round(base[1] * 0.38 + peak[1] * 0.62),
				Math.round(base[2] * 0.38 + peak[2] * 0.62),
			],
			peak,
		];
	}
	return light ? LIGHT_CAUSTIC_STOPS : DARK_CAUSTIC_STOPS;
}

function resolveGlimmerTiming(
	spanChars: number,
	options?: GlimmerSweepOptions,
): {
	readonly cycleLen: number;
	readonly leadPad: number;
	readonly periodMs: number;
} {
	const safeSpan = Math.max(1, Math.floor(spanChars));
	const leadPad = options?.leadPad ?? 9;
	const trailPad = options?.trailPad ?? 15;
	const cycleLen = safeSpan + leadPad + trailPad;
	const charsPerSecond = Math.max(1, options?.charsPerSecond ?? 17);
	const periodSec = Math.max(1.9, cycleLen / charsPerSecond);
	return {
		cycleLen,
		leadPad,
		periodMs: Math.round(periodSec * 1000),
	};
}

export function computeGlimmerPeriodMs(
	textOrSpan: string | number,
	options?: GlimmerSweepOptions,
): number {
	const count =
		typeof textOrSpan === "number"
			? textOrSpan
			: [...glimmerSegmenter.segment(textOrSpan)].length;
	const startIdx = options?.startIndex ?? 0;
	const totalSpan = Math.max(count, options?.totalSpanChars ?? startIdx + count);
	return resolveGlimmerTiming(totalSpan, options).periodMs;
}

function evaluateGlimmerLevel(
	x: number,
	totalSpan: number,
	elapsedMs: number,
	options?: GlimmerSweepOptions,
): number {
	const { cycleLen, leadPad, periodMs } = resolveGlimmerTiming(totalSpan, options);
	const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
	/* Строго периодическая фаза rawU в [0, 1) обеспечивает C∞-гладкость на стыке цикла */
	const rawU = ((safeElapsed / periodMs) % 1 + 1) % 1;
	const tau = rawU * Math.PI * 2;
	/* Ускоряется при выходе из ✦ (rawU = 0) и замедляется/расширяется над текстом (rawU ≈ 0.5) */
	const easedU = rawU + (0.088 * Math.sin(tau));
	const headPos = easedU * cycleLen - leadPad;

	const breathScale = 1 - 0.22 * Math.cos(tau);
	const sigmaFront = 3.4 * breathScale;
	const sigmaTail = 8.4 * breathScale;

	/* Периодическая обёртка гауссианы гарантирует равенство интенсивностей при t = 0 и t = periodMs */
	let comet = 0;
	for (let shift = -1; shift <= 1; shift += 1) {
		const delta = x - (headPos + shift * cycleLen);
		const sigma = delta > 0 ? sigmaFront : sigmaTail;
		const energy = Math.exp(-(delta * delta) / (2 * sigma * sigma));
		if (energy > comet) comet = energy;
	}

	/* Двухгармоническая встречная каустическая рябь, синхронизированная с периодом цикла */
	const swellA = (Math.sin(x * 0.21 - tau) + 1) * 0.5;
	const swellB = (Math.sin(x * 0.36 + tau) + 1) * 0.5;
	const caustic = Math.pow(swellA * 0.64 + swellB * 0.36, 1.5);

	return Math.min(1, 0.14 + comet * 0.74 + caustic * 0.28);
}

export function sampleGlimmerSweepRgb(
	charIndex: number,
	totalSpanChars: number,
	options?: GlimmerSweepOptions,
): RgbTuple {
	const light =
		options?.light !== undefined
			? options.light
			: isLightTheme(options?.theme ?? getActiveGlobalTheme());
	const elapsed = Number.isFinite(options?.elapsedMs)
		? options!.elapsedMs!
		: getAnimationElapsedMs();
	const stops = resolveGlimmerStops(light, options);
	const level = evaluateGlimmerLevel(charIndex, totalSpanChars, elapsed, options);
	return interpolateFourStops(stops, level);
}

/**
 * Рисует широкую асимметричную каустическую волну (`30 fps`, 12–16 колонок) напрямую через ANSI-префиксы
 * без внутренних сбросов `\x1b[39m` между символами (только один завершающий `\x1b[39m`).
 */
export function paintGlimmerSweepText(
	text: string,
	options?: GlimmerSweepOptions,
): string {
	if (!text) return "";
	const theme = options?.theme ?? getActiveGlobalTheme();
	const light = options?.light !== undefined ? options.light : isLightTheme(theme);
	const elapsed = Number.isFinite(options?.elapsedMs)
		? options!.elapsedMs!
		: getAnimationElapsedMs();

	const segments = [...glimmerSegmenter.segment(text)].map((s) => s.segment);
	const startIdx = options?.startIndex ?? 0;
	const totalSpan = Math.max(segments.length, options?.totalSpanChars ?? startIdx + segments.length);
	const stops = resolveGlimmerStops(light, options);

	let out = "";
	let lastPrefix = "";
	let paintedAny = false;
	for (let i = 0; i < segments.length; i += 1) {
		const ch = segments[i]!;
		if (ch === " ") {
			out += " ";
			continue;
		}
		const level = evaluateGlimmerLevel(startIdx + i, totalSpan, elapsed, options);
		const rgb = interpolateFourStops(stops, level);
		const prefix = blueFgRgbPrefix(rgb, theme);
		if (prefix !== lastPrefix) {
			out += prefix;
			lastPrefix = prefix;
		}
		out += ch;
		paintedAny = true;
	}
	return paintedAny ? `${out}\x1b[39m` : out;
}

export function paintPolarisStar(
	options?: WaveSampleOptions & { row?: number },
): string {
	return paintBreathingWaveGlyph(options?.row ?? 0, POLARIS_STAR, options);
}

export function paintRunningToolDiamond(
	options?: WaveSampleOptions & { row?: number },
): string {
	return paintPolarisStar(options);
}

export function paintRunningCommandBar(
	row: number,
	options?: WaveSampleOptions & { glyph?: string },
): string {
	return paintBreathingWaveGlyph(row, options?.glyph ?? "▎", options);
}

export function renderComposerWorkingFrame(options?: WaveSampleOptions): string {
	return paintPolarisStar({ ...options, row: 0 });
}
