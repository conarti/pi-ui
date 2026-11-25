import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { renderDensityCall, renderDensityResult } from "../src/features/tool-calls/density.ts";
import {
	buildPrototypeStepHeaderParts,
	resolveExternalToolSummary,
	summarizeCodemodeIntentFallback,
} from "../src/features/tool-calls/step-summaries.ts";
import {
	beginWorkingTurn,
	markWorkingPhase,
	renderPrototypeBorderWorkingStatus,
	setPrototypeVariant,
} from "../src/features/transcript/prototype-state.ts";
import { ResponseMetricsRowComponent } from "../src/features/transcript/response-metrics.ts";
import { ThinkingBlock } from "../src/features/transcript/thinking-block.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import { createInteractiveHarness, formatSgrMouse, type InteractiveHarness } from "./harness/index.ts";

describe("prototype v3: glimmer sweep, 30s verb stability, step summaries, and hybrid metrics", () => {
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		setPrototypeVariant("off");
		markWorkingPhase("idle");
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
	});

	it("sweeps 30fps glimmer across stationary brand mark and label while holding verb steady for 30s", () => {
		setPrototypeVariant("B");
		beginWorkingTurn(1_000_000);

		const frame1 = renderPrototypeBorderWorkingStatus(54, {
			now: 1_001_000,
			animElapsedMs: 120,
			theme: { name: "one-blue-light" },
		});
		const frame2 = renderPrototypeBorderWorkingStatus(54, {
			now: 1_180_000,
			animElapsedMs: 420,
			theme: { name: "one-blue-light" },
		});

		expect(frame1).not.toBe(frame2);
		const label1 = stripTerminalSequences(frame1).split(" · ")[0];
		const label2 = stripTerminalSequences(frame2).split(" · ")[0];
		expect(label1).toBe(label2);
		expect(label1?.startsWith("✦ ")).toBe(true);
	});

	it("debounces rapid contextual tool/heading updates so labels do not flicker", () => {
		setPrototypeVariant("B");
		beginWorkingTurn(1_000_000);
		markWorkingPhase("tool", { now: 1_002_000, summary: "Inspect repo state…" });
		markWorkingPhase("tool", { now: 1_002_400, summary: "Read another file…" });

		const rendered = stripTerminalSequences(
			renderPrototypeBorderWorkingStatus(60, { now: 1_002_800, animElapsedMs: 300 }),
		);
		expect(rendered).toContain("Inspect repo state…");
	});

	it("resolves pi-agy-tool-summaries captions and formats relative paths and codemode fallbacks", () => {
		setPrototypeVariant("B");
		const entries = [
			{
				type: "custom",
				customType: "pi-agy-tool-summaries",
				data: {
					version: 1,
					summaries: {
						call_42: "Inspect Claude Code verb timing",
					},
				},
			},
		];

		const summary = resolveExternalToolSummary("call_42", {}, entries);
		expect(summary).toBe("Inspect Claude Code verb timing");

		const codemodeHdr = buildPrototypeStepHeaderParts({
			name: "codemode",
			args: { code: 'const x = await tools.bash({ command: "ls" });' },
			status: "success",
			rawPath: "",
			stepSummary: summary,
			cwd: "/Users/macbook/Projects/pi-ui",
			summarizeCustomArgs: () => "",
		});
		expect(codemodeHdr).toEqual({
			verb: "Inspect Claude Code verb timing",
			target: "",
		});

		const readHdr = buildPrototypeStepHeaderParts({
			name: "read",
			args: { offset: 10, limit: 40 },
			status: "success",
			rawPath: "/Users/macbook/Projects/pi-ui/src/features/chrome/composer.ts",
			cwd: "/Users/macbook/Projects/pi-ui",
			summarizeCustomArgs: () => "",
		});
		expect(readHdr).toEqual({
			verb: "Read",
			target: "src/features/chrome/composer.ts:10-49",
		});

		const fallback = summarizeCodemodeIntentFallback(
			{
				code: 'await Promise.all([tools.read({ path: "src/a.ts" }), tools.read({ path: "src/b.ts" })]);',
			},
			"success",
			"/Users/macbook/Projects/pi-ui",
		);
		expect(fallback).toEqual({
			verb: "Read",
			target: "a.ts, b.ts",
		});
	});

	it("renders quiet final Worked-for line with zero character shift on hover and hides intermediate toolUse clutter", async () => {
		harness = await createInteractiveHarness();
		setPrototypeVariant("B");
		const mockTheme = {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
			name: "one-blue-light",
		} as any;
		const row = new ResponseMetricsRowComponent(
			{
				version: 1,
				timestamp: 1764075000000,
				completedAt: 1764075004200,
				firstContentAt: 1764075000600,
				timeSinceUserMs: 4200,
				outputTokens: 360,
				stopReason: "stop",
			},
			false,
			mockTheme,
			() => {},
		);

		const chat = getActiveHostRuntime()?.chatContainer as { clear(): void; addChild(c: unknown): void };
		chat.clear();
		chat.addChild(row);
		harness.renderFrame();

		const restRaw = row.render(100)[0]!;
		const restPlain = stripTerminalSequences(restRaw);
		harness.terminal.sendInput(formatSgrMouse(35, 10, 2, false));
		harness.renderFrame();
		const hoverRaw = row.render(100)[0]!;
		const hoverPlain = stripTerminalSequences(hoverRaw);

		expect(hoverPlain).toBe(restPlain);
		expect(restPlain.trim()).toBe("Worked for 4.2s");

		/* Intermediate toolUse steps stay completely quiet between tool calls */
		const stepRow = new ResponseMetricsRowComponent(
			{
				version: 1,
				timestamp: 1764075000000,
				completedAt: 1764075001900,
				firstContentAt: 1764075000500,
				outputTokens: 120,
				stopReason: "toolUse",
			},
			false,
			mockTheme,
			() => {},
		);
		expect(stepRow.render(100)).toEqual([]);
	});

	it("supports mouse-wheel scrolling inside streaming Thinking window via SGR wheel input", async () => {
		harness = await createInteractiveHarness();
		setPrototypeVariant("B");
		const mockTheme = {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
			italic: (t: string) => t,
			underline: (t: string) => t,
			strikethrough: (t: string) => t,
			name: "one-blue-light",
		} as any;
		const slot = { hovered: false, scrollFromBottom: 0 };
		const longThought = Array.from({ length: 14 }, (_, i) => `Thought step line ${i + 1}`).join("\n");
		const tb = new ThinkingBlock(
			longThought,
			true,
			false,
			() => {},
			mockTheme,
			undefined,
			undefined,
			slot,
			Date.now() - 3000,
		);

		const chat = getActiveHostRuntime()?.chatContainer as { clear(): void; addChild(c: unknown): void };
		chat.clear();
		chat.addChild(tb);
		harness.renderFrame();

		const screen = harness.screen();
		const tbRow =
			Array.from({ length: 24 }, (_, r) => r).find((r) =>
				screen.rowText(r).includes("Thinking"),
			) ?? 3;
		expect(tbRow).toBeGreaterThanOrEqual(2);

		/* SGR buttonCode 64 = wheel up over ThinkingBlock */
		harness.terminal.sendInput(formatSgrMouse(64, 6, tbRow + 1, false));
		expect(slot.scrollFromBottom).toBe(2);
		const scrolledHdr = stripTerminalSequences(tb.render(90)[0]!);
		expect(scrolledHdr).toContain("⏸ -2 lines");
	});

	it("shows the full untruncated wrapped command when expanded both while running and after completion", () => {
		setPrototypeVariant("B");
		const mockTheme = {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
			name: "one-blue-light",
		} as any;
		const longCommand =
			'agy --print "Дай развернутый архитектурный анализ всех модулей проекта без потери единого флага --verbose --json-stream"';

		/* 1. While still running (before any result exists) */
		const runningState: any = { expanded: true };
		const callComp = renderDensityCall({
			name: "bash",
			args: { command: longCommand },
			theme: mockTheme,
			state: runningState,
			getStatus: () => "running",
			syncRunning: () => {},
			getStepSummary: () => "Run agy architectural analysis",
		});
		const callPlain = callComp
			.render(64)
			.map((line) => stripTerminalSequences(line))
			.join("\n");
		expect(callPlain).toContain("--verbose --json-stream");

		/* 2. After completion (single-line bash command with stepSummary header) */
		const settledState: any = { expanded: true, finished: true };
		const resComp = renderDensityResult({
			name: "bash",
			args: { command: longCommand },
			result: { content: [{ type: "text", text: "Analysis complete" }], details: {} },
			output: "Analysis complete",
			theme: mockTheme,
			state: settledState,
			isError: false,
			isPartial: false,
			getDensity: () => "balanced",
			canRun: () => false,
			syncRunning: () => {},
		});
		const resPlain = resComp
			.render(64)
			.map((line) => stripTerminalSequences(line))
			.join("\n");
		expect(resPlain).toContain("$ agy --print");
		expect(resPlain).toContain("--verbose --json-stream");
		expect(resPlain).toContain("Analysis complete");
	});
});
