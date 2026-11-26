import { afterEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	BREATHING_FPS,
	BREATHING_PERIOD_MS,
	BREATHING_TICK_MS,
	POLARIS_SECONDARY,
	POLARIS_STAR,
	WAVE_ROWS,
	computeGlimmerPeriodMs,
	getAnimationElapsedMs,
	paintBreathingWaveGlyph,
	paintGlimmerSweepText,
	paintRunningCommandBar,
	paintRunningToolDiamond,
	renderComposerWorkingFrame,
	sampleBreathingWaveRgb,
	sampleGlimmerSweepRgb,
	stopAllAnimations,
	subscribeAnimationTicks,
} from "../src/shared/animation-scheduler.ts";
import { parseAnsiColorRgb, rgbHueDegrees } from "../src/shared/ansi.ts";
import { TOOL_DIAMOND, indicatorGlyph } from "../src/features/tool-calls/core.ts";
import {
	STREAMING_THINKING_PAGE_LINES,
	STREAMING_THINKING_PAGE_STEP,
	computeThinkingWindow,
	formatThinkingDuration,
	formatThinkingProseLines,
	formatThoughtLabel,
	reduceThinkingWheelScroll,
	registerThinkingDisplayProvider,
	resolveThinkingDisplayText,
} from "../src/features/transcript/thinking-block.ts";
import {
	WORKING_CONTEXTUAL_HOLD_MS,
	WORKING_TOOL_COMPLETION_HOLD_MS,
	WORKING_VERBS,
	WorkingStatusController,
	extractThinkingHeading,
	formatWorkingToolAction,
	renderWorkingStatusRow,
} from "../src/features/chrome/working-indicator.ts";
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

		expect(POLARIS_STAR).toBe("✦");
		expect(POLARIS_SECONDARY).toBe("•");
		expect(TOOL_DIAMOND).toBe("✦");
		expect(indicatorGlyph("running", 0)).toBe("✦");
		expect(indicatorGlyph("success", 0)).toBe("✦");

		expect(paintBreathingWaveGlyph(0, "┃", { theme: darkTheme, elapsedMs: 0 })).toBe(
			"\x1b[38;2;125;207;255m┃\x1b[39m",
		);
		expect(paintRunningToolDiamond({ theme: darkTheme, elapsedMs: 1200 })).toBe(
			"\x1b[38;2;64;82;112m✦\x1b[39m",
		);
		expect(paintRunningCommandBar(8, { theme: lightTheme, elapsedMs: 0 })).toBe(
			"\x1b[38;2;78;132;212m▎\x1b[39m",
		);
		expect(renderComposerWorkingFrame({ theme: lightTheme, elapsedMs: 0 })).toBe(
			"\x1b[38;2;37;99;235m✦\x1b[39m",
		);

		expect(sampleBreathingWaveRgb(Number.NaN, { theme: darkTheme, elapsedMs: Number.NaN })).toEqual([
			125, 207, 255,
		]);
	});

	it("paints a 30 fps asymmetric caustic wave with C∞ cycle continuity, zero inner SGR resets, and strict blue-azure hue bounds on dark and light themes", async () => {
		const { dark: darkTheme, light: lightTheme } = await loadPackageThemes();
		const sample = "✦ Tinkering through modules…";
		const periodMs = computeGlimmerPeriodMs(sample);
		expect(periodMs).toBeGreaterThanOrEqual(1900);

		for (const theme of [darkTheme, lightTheme]) {
			const frame0 = paintGlimmerSweepText(sample, { theme, elapsedMs: 0 });
			const frameEnd = paintGlimmerSweepText(sample, { theme, elapsedMs: periodMs });
			expect(stripTerminalSequences(frame0)).toBe(sample);
			expect(frameEnd).toBe(frame0);

			/* Прямая ANSI-покраска: допускается только один завершающий \x1b[39m без внутренних сбросов */
			const innerBody = frame0.endsWith("\x1b[39m") ? frame0.slice(0, -"\x1b[39m".length) : frame0;
			expect(innerBody.includes("\x1b[39m")).toBe(false);

			/* Плавность перехода через границу цикла (t = periodMs - 33 -> t = 0) */
			const spanChars = [...sample].length;
			for (let idx = 0; idx < spanChars; idx += 1) {
				const beforeWrap = sampleGlimmerSweepRgb(idx, spanChars, {
					theme,
					elapsedMs: periodMs - BREATHING_TICK_MS,
				});
				const atWrap = sampleGlimmerSweepRgb(idx, spanChars, { theme, elapsedMs: 0 });
				const maxDelta = Math.max(
					Math.abs(beforeWrap[0] - atWrap[0]),
					Math.abs(beforeWrap[1] - atWrap[1]),
					Math.abs(beforeWrap[2] - atWrap[2]),
				);
				expect(maxDelta).toBeLessThanOrEqual(28);
			}

			/* Строго сине-лазурный диапазон оттенков без фиолетового (255°-320°) и бирюзового (165°-198°) */
			for (let step = 0; step < 12; step += 1) {
				const elapsedMs = Math.round((periodMs * step) / 12);
				const painted = paintGlimmerSweepText(sample, { theme, elapsedMs });
				const inner = painted.endsWith("\x1b[39m") ? painted.slice(0, -5) : painted;
				expect(inner.includes("\x1b[39m")).toBe(false);

				const colorMatches = [...painted.matchAll(/\x1b\[38;2;\d+;\d+;\d+m/g)];
				expect(colorMatches.length).toBeGreaterThan(4);
				for (const m of colorMatches) {
					const rgb = parseAnsiColorRgb(m[0]);
					expect(rgb).toBeDefined();
					const { hue, saturation } = rgbHueDegrees(rgb!);
					if (saturation > 0.04) {
						const inTurquoise = hue >= 165 && hue <= 198;
						const inPurple = hue >= 255 && hue <= 320;
						expect(inTurquoise, `turquoise hue ${hue.toFixed(1)} for ${m[0]}`).toBe(false);
						expect(inPurple, `purple hue ${hue.toFixed(1)} for ${m[0]}`).toBe(false);
						expect(hue).toBeGreaterThan(198);
						expect(hue).toBeLessThan(255);
					}
				}
			}
		}

		const prevTrueColor = process.env.PI_TRUE_COLOR;
		process.env.PI_TRUE_COLOR = "0";
		try {
			for (const light of [false, true]) {
				for (let time = 0; time < periodMs; time += BREATHING_TICK_MS) {
					const painted = paintGlimmerSweepText(sample, { light, elapsedMs: time });
					expect(stripTerminalSequences(painted)).toBe(sample);
					expect(painted.match(/\x1b\[39m/g)).toHaveLength(1);
					const colors = [...painted.matchAll(/\x1b\[38;5;\d+m/g)];
					expect(colors.length).toBeGreaterThan(0);
					for (const [color] of colors) {
						const { saturation, hue } = rgbHueDegrees(parseAnsiColorRgb(color)!);
						if (saturation > 0.04) {
							expect(hue, `${light ? "light" : "dark"} ${color}`).toBeGreaterThan(198);
							expect(hue).toBeLessThan(255);
						}
					}
				}
			}
		} finally {
			if (prevTrueColor === undefined) delete process.env.PI_TRUE_COLOR;
			else process.env.PI_TRUE_COLOR = prevTrueColor;
		}
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

	it("samples 1 verb per turn, extracts thinking headings and toolSummary actions with anti-flicker holds, switches to Drafting…, and formats the x=4 working row with clickable [stop]", async () => {
		expect(WORKING_CONTEXTUAL_HOLD_MS).toBe(4500);
		expect(WORKING_TOOL_COMPLETION_HOLD_MS).toBe(1800);
		expect(WORKING_VERBS.length).toBeGreaterThanOrEqual(16);
		for (const verb of WORKING_VERBS) {
			expect(verb.endsWith("ing…")).toBe(true);
		}

		expect(extractThinkingHeading("Regular prose without a heading")).toBeUndefined();
		expect(extractThinkingHeading("**Inspecting layout hooks**\nChecking details")).toBe(
			"Inspecting layout hooks…",
		);
		expect(extractThinkingHeading("### Auditing wheel routing\nDetails\n```\n### Ignored fence\n```")).toBe(
			"Auditing wheel routing…",
		);

		expect(
			formatWorkingToolAction("bash", { command: "npm test", toolSummary: "Running unit tests" }, "/repo"),
		).toBe("Running unit tests…");
		expect(
			formatWorkingToolAction("read", { path: "/repo/src/shared/ansi.ts" }, "/repo"),
		).toBe("Reading src/shared/ansi.ts…");
		expect(
			formatWorkingToolAction("edit", { path: "/repo/src/index.ts" }, "/repo"),
		).toBe("Editing src/index.ts…");

		const ctrl = new WorkingStatusController();
		ctrl.beginTurn(1000);
		const snap0 = ctrl.snapshot(1000);
		expect(snap0.active).toBe(true);
		expect(WORKING_VERBS).toContain(snap0.label);

		/* Один глагол на ход во время TTFT и неразмеченного мышления */
		ctrl.onThinkingDelta("Plain untitled thought", 6000);
		expect(ctrl.snapshot(6000).label).toBe(snap0.label);

		/* Заголовок из thinking_delta удерживается минимум 4.5s */
		ctrl.onThinkingDelta("**Tracing animation timers**\nDetails", 7000);
		expect(ctrl.snapshot(7000).label).toBe("Tracing animation timers…");
		ctrl.onThinkingDelta("**Tracing animation timers**\n\n**Second heading too soon**", 9000);
		expect(ctrl.snapshot(9000).label).toBe("Tracing animation timers…");
		ctrl.onThinkingDelta("**Tracing animation timers**\n\n**Second heading after hold**", 11_600);
		expect(ctrl.snapshot(11_600).label).toBe("Second heading after hold…");

		/* Выполнение инструмента: >= 4.5s hold + 1.8s completion hold */
		ctrl.onToolStart("call-1", "read", { path: "/repo/src/a.ts", toolSummary: "Inspecting module A" }, "/repo", 16_500);
		expect(ctrl.snapshot(16_500).label).toBe("Inspecting module A…");
		ctrl.onToolStart("call-2", "read", { path: "/repo/src/b.ts" }, "/repo", 18_000);
		expect(ctrl.snapshot(18_000).label).toBe("Inspecting module A…");
		ctrl.onToolEnd("call-1", 19_000);
		ctrl.onToolEnd("call-2", 19_000);
		expect(ctrl.snapshot(20_000).label).toBe("Inspecting module A…");
		expect(ctrl.snapshot(20_900).label).toBe("Inspecting module A…");
		expect(ctrl.snapshot(21_000).label).toBe(snap0.label);

		/* Финальный текст немедленно переключается на Drafting… */
		ctrl.onTextStream(21_000);
		expect(ctrl.snapshot(21_000).label).toBe("Drafting…");

		/* Строка статуса: ✦ на x=4, справа <elapsed> [stop], без (esc to interrupt) и ↓tokens */
		const { dark: darkTheme } = await loadPackageThemes();
		const rendered = renderWorkingStatusRow(80, {
			theme: darkTheme,
			snapshot: ctrl.snapshot(22_400),
			animElapsedMs: 330,
		});
		const plain = stripTerminalSequences(rendered.line);
		expect(plain.indexOf("✦")).toBe(4);
		expect(plain).toContain("✦ Drafting…");
		expect(plain).toContain("21s [stop]");
		expect(plain).not.toContain("esc to interrupt");
		expect(plain).not.toContain("↓");
		expect(rendered.stopHit).toBeDefined();
		expect(plain.slice(rendered.stopHit!.xStart, rendered.stopHit!.xEnd)).toBe("[stop]");

		ctrl.endTurn();
		expect(ctrl.snapshot(23_000).active).toBe(false);
	});

	it("paginates streaming Thinking in 6-line windows with 3-line steps, handles wheel pause/resume, formats fence-stripped prose, and routes through ThinkingDisplayProvider", () => {
		expect(STREAMING_THINKING_PAGE_LINES).toBe(6);
		expect(STREAMING_THINKING_PAGE_STEP).toBe(3);

		/* 1..6 строк помещаются без сдвига */
		expect(computeThinkingWindow(4, 0)).toEqual({
			startIndex: 0,
			endIndex: 4,
			hiddenAbove: 0,
			scrollFromBottom: 0,
			isPaused: false,
		});
		expect(computeThinkingWindow(6, 0)).toEqual({
			startIndex: 0,
			endIndex: 6,
			hiddenAbove: 0,
			scrollFromBottom: 0,
			isPaused: false,
		});

		/* Шаг 3 строки: 7..9 скрывают ровно 3 строки, 10 скрывает 6 */
		expect(computeThinkingWindow(7, 0)).toEqual({
			startIndex: 3,
			endIndex: 7,
			hiddenAbove: 3,
			scrollFromBottom: 0,
			isPaused: false,
		});
		expect(computeThinkingWindow(9, 0)).toEqual({
			startIndex: 3,
			endIndex: 9,
			hiddenAbove: 3,
			scrollFromBottom: 0,
			isPaused: false,
		});
		expect(computeThinkingWindow(10, 0)).toEqual({
			startIndex: 6,
			endIndex: 10,
			hiddenAbove: 6,
			scrollFromBottom: 0,
			isPaused: false,
		});

		/* Колесо вверх ставит на паузу, вниз возвращает к живому хвосту на 0 */
		const afterUp1 = reduceThinkingWheelScroll({ totalLines: 12, scrollFromBottom: 0 }, -2);
		expect(afterUp1).toBe(2);
		expect(computeThinkingWindow(12, afterUp1)).toEqual({
			startIndex: 4,
			endIndex: 10,
			hiddenAbove: 4,
			scrollFromBottom: 2,
			isPaused: true,
		});
		const afterUpClamp = reduceThinkingWheelScroll({ totalLines: 12, scrollFromBottom: afterUp1 }, -20);
		expect(afterUpClamp).toBe(6);
		const afterDownResume = reduceThinkingWheelScroll({ totalLines: 12, scrollFromBottom: afterUpClamp }, 10);
		expect(afterDownResume).toBe(0);
		expect(computeThinkingWindow(12, afterDownResume).isPaused).toBe(false);

		/* Проза без code fences с мягкой подсветкой inline code */
		const prose = formatThinkingProseLines(
			"### Step\nCheck `parseToken` in **auth.ts**\n```ts\nconst x = 1;\n```",
			60,
			false,
		);
		const plainProse = prose.map((l) => stripTerminalSequences(l));
		expect(plainProse).toContain("Step");
		expect(plainProse).toContain("Check parseToken in auth.ts");
		expect(plainProse).toContain("const x = 1;");
		expect(plainProse.join("\n")).not.toContain("```");
		const codeLine = prose.find((l) => stripTerminalSequences(l).includes("parseToken"))!;
		expect(codeLine).toContain("\x1b[38;2;132;168;206mparseToken");

		/* ThinkingDisplayProvider без мутации исходных данных */
		try {
			registerThinkingDisplayProvider({
				transformStreaming: (raw, key) => `[stream:${key}] ${raw}`,
				transformCompleted: (raw, key) => `[done:${key}] ${raw}`,
			});
			expect(resolveThinkingDisplayText("raw thought", "100:0", true)).toBe("[stream:100:0] raw thought");
			expect(resolveThinkingDisplayText("raw thought", "100:0", false)).toBe("[done:100:0] raw thought");
		} finally {
			registerThinkingDisplayProvider(undefined);
		}
		expect(resolveThinkingDisplayText("raw thought", "100:0", true)).toBe("raw thought");
	});
});
