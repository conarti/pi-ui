import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
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
		expect(label1?.startsWith("▍▎ ")).toBe(true);
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

	it("renders hybrid Worked-for + full date-time metrics bar with zero character shift on hover", async () => {
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
		expect(restPlain).toContain("✓ Worked for 4.2s");
		expect(restPlain).toMatch(/\d{4}-\d{2}-\d{2} · \d{2}:\d{2}/u);

		/* Intermediate toolUse steps also render their metrics stamp instead of returning empty */
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
		const stepLines = stepRow.render(100);
		expect(stepLines.length).toBe(1);
		const stepPlain = stripTerminalSequences(stepLines[0]!);
		expect(stepPlain).toContain("ttft 0.5s");
		expect(stepPlain).toContain("total 1.9s");
		expect(stepPlain).toMatch(/\d{4}-\d{2}-\d{2} · \d{2}:\d{2}/u);
	});

	it("supports mouse-wheel scrolling inside Variant B streaming Thinking window via SGR wheel input", async () => {
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

		/* SGR buttonCode 64 = wheel up over ThinkingBlock */
		harness.terminal.sendInput(formatSgrMouse(64, 6, 3, false));
		expect(slot.scrollFromBottom).toBe(2);
		const scrolledHdr = stripTerminalSequences(tb.render(90)[0]!);
		expect(scrolledHdr).toContain("⏸ -2 lines");
	});
});
