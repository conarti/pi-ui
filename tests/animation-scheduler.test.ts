import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BREATHING_FPS,
	BREATHING_PERIOD_MS,
	BREATHING_TICK_MS,
	WAVE_ROWS,
	getAnimationElapsedMs,
	paintBreathingWaveGlyph,
	paintRunningCommandBar,
	paintRunningToolDiamond,
	renderComposerWorkingFrame,
	sampleBreathingWaveRgb,
	stopAllAnimations,
	subscribeAnimationTicks,
} from "../src/shared/animation-scheduler.ts";
import { formatThinkingDuration, formatThoughtLabel } from "../src/features/transcript/thinking-block.ts";
import { loadPackageThemes } from "./harness/index.ts";

describe("animation-scheduler (30 fps monotonic clock)", () => {
	afterEach(() => {
		stopAllAnimations();
		vi.useRealTimers();
	});

	it("runs a single ~33ms timer only while subscribers are active and stops immediately on unsubscribe or stopAllAnimations", () => {
		vi.useFakeTimers();

		expect(BREATHING_FPS).toBe(30);
		expect(BREATHING_TICK_MS).toBe(33);
		expect(vi.getTimerCount()).toBe(0);

		const baselineMs = getAnimationElapsedMs();
		let callsA = 0;
		let callsB = 0;

		const unsubA = subscribeAnimationTicks(() => {
			callsA += 1;
		});
		const unsubB = subscribeAnimationTicks(() => {
			callsB += 1;
		});

		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(33 * 3);
		expect(callsA).toBe(3);
		expect(callsB).toBe(3);
		expect(getAnimationElapsedMs() - baselineMs).toBe(99);

		unsubA();
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(33);
		expect(callsA).toBe(3);
		expect(callsB).toBe(4);
		expect(getAnimationElapsedMs() - baselineMs).toBe(132);

		unsubB();
		expect(vi.getTimerCount()).toBe(0);

		const unsubC = subscribeAnimationTicks(() => {});
		expect(vi.getTimerCount()).toBe(1);
		stopAllAnimations();
		expect(vi.getTimerCount()).toBe(0);
		unsubC();
	});

	it("interpolates a 32-row spatial cosine wave over a 2.4s cycle across adaptive light and dark blue-slate stops without purple accents", async () => {
		expect(WAVE_ROWS).toBe(32);
		expect(BREATHING_PERIOD_MS).toBe(2400);

		const { dark: darkTheme, light: lightTheme } = await loadPackageThemes();

		expect(sampleBreathingWaveRgb(0, { theme: darkTheme, elapsedMs: 0 })).toEqual([125, 207, 255]);
		expect(sampleBreathingWaveRgb(8, { theme: darkTheme, elapsedMs: 0 })).toEqual([88, 148, 214]);
		expect(sampleBreathingWaveRgb(16, { theme: darkTheme, elapsedMs: 0 })).toEqual([64, 82, 112]);

		expect(sampleBreathingWaveRgb(0, { theme: lightTheme, elapsedMs: 0 })).toEqual([37, 99, 235]);
		expect(sampleBreathingWaveRgb(8, { theme: lightTheme, elapsedMs: 0 })).toEqual([78, 132, 212]);
		expect(sampleBreathingWaveRgb(16, { theme: lightTheme, elapsedMs: 0 })).toEqual([148, 163, 184]);

		expect(sampleBreathingWaveRgb(0, { theme: darkTheme, elapsedMs: 1200 })).toEqual([64, 82, 112]);
		expect(sampleBreathingWaveRgb(0, { theme: darkTheme, elapsedMs: 2400 })).toEqual([125, 207, 255]);

		for (let row = 0; row < 32; row++) {
			const darkAtRow = sampleBreathingWaveRgb(row, { theme: darkTheme, elapsedMs: 300 });
			const darkNextPeriod = sampleBreathingWaveRgb(row + 32, { theme: darkTheme, elapsedMs: 300 });
			expect(darkAtRow).toEqual(darkNextPeriod);
		}

		for (const theme of [darkTheme, lightTheme]) {
			for (let elapsedMs = 0; elapsedMs <= 2400; elapsedMs += 150) {
				for (let row = 0; row < 32; row++) {
					const [r, g, b] = sampleBreathingWaveRgb(row, { theme, elapsedMs });
					expect(r).toBeLessThan(g);
					expect(g).toBeLessThan(b);
				}
			}
		}

		expect(paintBreathingWaveGlyph(0, "┃", { theme: darkTheme, elapsedMs: 0 })).toBe(
			"\x1b[38;2;125;207;255m┃\x1b[39m",
		);
		expect(paintRunningToolDiamond({ theme: darkTheme, elapsedMs: 1200 })).toBe(
			"\x1b[38;2;64;82;112m◆\x1b[39m",
		);
		expect(paintRunningCommandBar(8, { theme: lightTheme, elapsedMs: 0 })).toBe(
			"\x1b[38;2;78;132;212m▎\x1b[39m",
		);
		expect(renderComposerWorkingFrame({ theme: lightTheme, elapsedMs: 0 })).toBe(
			"\x1b[38;2;37;99;235m◆\x1b[39m",
		);

		expect(sampleBreathingWaveRgb(Number.NaN, { theme: darkTheme, elapsedMs: Number.NaN })).toEqual([
			125, 207, 255,
		]);
	});

	it("notifies subscriber onStop hooks when stopAllAnimations forcibly detaches active ticks", () => {
		vi.useFakeTimers();
		let stoppedCount = 0;
		const deltas: number[] = [];

		subscribeAnimationTicks(
			(_elapsedMs, deltaMs) => {
				deltas.push(deltaMs);
			},
			() => {
				stoppedCount += 1;
			},
		);

		vi.advanceTimersByTime(33);
		expect(deltas).toEqual([33]);
		expect(stoppedCount).toBe(0);

		stopAllAnimations();
		expect(stoppedCount).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("formats observed thinking durations into concise labels and falls back to plain Thought when unmeasured", () => {
		expect(formatThinkingDuration(undefined)).toBeUndefined();
		expect(formatThinkingDuration(-1)).toBeUndefined();
		expect(formatThinkingDuration(Number.NaN)).toBeUndefined();

		expect(formatThinkingDuration(0)).toBe("1s");
		expect(formatThinkingDuration(350)).toBe("1s");
		expect(formatThinkingDuration(4200)).toBe("4s");
		expect(formatThinkingDuration(4600)).toBe("5s");
		expect(formatThinkingDuration(60_000)).toBe("1m");
		expect(formatThinkingDuration(75_000)).toBe("1m 15s");
		expect(formatThinkingDuration(3_665_000)).toBe("1h 1m 5s");

		expect(formatThoughtLabel(undefined)).toBe("Thought");
		expect(formatThoughtLabel(4200)).toBe("Thought for 4s");
		expect(formatThoughtLabel(75_000)).toBe("Thought for 1m 15s");
	});
});
