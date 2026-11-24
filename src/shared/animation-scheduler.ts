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

interface SchedulerState {
	elapsedMs: number;
	lastTickAt: number | undefined;
	timer: ReturnType<typeof setInterval> | undefined;
	subscribers: Set<(elapsedMs: number) => void>;
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
			subscribers: new Set(),
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

		for (const listener of [...state.subscribers]) {
			if (!state.subscribers.has(listener)) continue;
			listener(state.elapsedMs);
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

export function subscribeAnimationTicks(listener: (elapsedMs: number) => void): () => void {
	const state = getSchedulerState();
	state.subscribers.add(listener);
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
	state.surfaces.clear();
	state.subscribers.clear();
	syncTimer(state);
}

export function computeWaveIntensity(row: number, elapsedMs = getAnimationElapsedMs()): number {
	const angle = (row / WAVE_ROWS - elapsedMs / BREATHING_PERIOD_MS) * Math.PI * 2;
	return (Math.cos(angle) + 1) * 0.5;
}

function lerpChannel(from: number, to: number, weight: number): number {
	return Math.round(from + (to - from) * weight);
}

export function interpolateWaveStops(
	stops: readonly [RgbTuple, RgbTuple, RgbTuple],
	t: number,
): RgbTuple {
	const clamped = Math.max(0, Math.min(1, t));
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
