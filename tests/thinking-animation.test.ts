import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { Loader, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

function makeAssistantMessage(content: unknown[], extra: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	} as any;
}

describe("30 fps breathing animation & refined Thinking blocks", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.runCommand("silent", "off");
			await harness.shutdownSession();
			harness = undefined;
		}
		stopAllAnimations();
		vi.useRealTimers();
	});

	it("drives composer working indicator and streaming Thinking spines from a single 30 fps timer with zero Loader timers and zero leaked timers on idle or shutdown", async () => {
		vi.useFakeTimers();
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		const indicatorCalls: WorkingIndicatorOptions[] = [];
		vi.spyOn(harness.ctx.ui, "setWorkingIndicator").mockImplementation((opts) => {
			if (opts) indicatorCalls.push(opts);
		});

		harness.mount(conartiPiUi);
		await harness.startSession();

		expect(vi.getTimerCount()).toBe(0);
		expect(indicatorCalls.length).toBeGreaterThan(0);

		const initialIndicator = indicatorCalls.at(-1)!;
		expect(initialIndicator.frames?.length).toBe(1);
		expect(stripTerminalSequences(initialIndicator.frames?.[0] ?? "")).toBe("◆");

		const hostLoader = new Loader(
			harness.tui.asTui(),
			(s) => s,
			(s) => s,
			"Working...",
			initialIndicator,
		);
		expect(vi.getTimerCount()).toBe(0);

		await harness.emit("agent_start", {});

		const mdTheme = getMarkdownTheme();
		const streamingTurn = new AssistantMessageComponent(undefined, false, mdTheme);
		streamingTurn.updateContent(
			makeAssistantMessage([
				{
					type: "thinking",
					thinking: "Line one\nLine two\nLine three",
				},
			]),
			true,
		);

		const frame0Lines = streamingTurn.render(80);
		expect(vi.getTimerCount()).toBe(1);

		const extractFirstRgb = (line: string) => {
			const m = /\x1b\[38;2;(\d+;\d+;\d+)m/.exec(line);
			return m?.[1];
		};
		const row0RgbBefore = extractFirstRgb(frame0Lines[1] ?? "");
		const row1RgbBefore = extractFirstRgb(frame0Lines[2] ?? "");
		expect(row0RgbBefore).toBeDefined();
		expect(row1RgbBefore).toBeDefined();
		expect(row0RgbBefore).not.toBe(row1RgbBefore);

		vi.advanceTimersByTime(33 * 6);

		const latestIndicator = indicatorCalls.at(-1)!;
		expect(latestIndicator.frames?.length).toBe(1);
		expect(latestIndicator.frames?.[0]).not.toBe(initialIndicator.frames?.[0]);
		hostLoader.setIndicator(latestIndicator);
		expect(vi.getTimerCount()).toBe(1);

		const frame1Lines = streamingTurn.render(80);
		const row0RgbAfter = extractFirstRgb(frame1Lines[1] ?? "");
		expect(row0RgbAfter).not.toBe(row0RgbBefore);

		await harness.emit("agent_end", { messages: [] });
		expect(vi.getTimerCount()).toBe(0);

		await harness.emit("turn_start", {});
		expect(vi.getTimerCount()).toBe(1);
		await harness.emit("agent_settled", {});
		expect(vi.getTimerCount()).toBe(0);

		await harness.runCommand("silent", "on");
		await harness.emit("agent_start", {});
		expect(vi.getTimerCount()).toBe(1);
		await harness.shutdownSession();
		expect(vi.getTimerCount()).toBe(0);
		hostLoader.stop();
	});

	it("renders streaming Thinking… plus at most 3 softly formatted markdown tail lines preserving inline code and bold structure", async () => {
		vi.useFakeTimers();
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const mdTheme = getMarkdownTheme();
		const streamingTurn = new AssistantMessageComponent(undefined, false, mdTheme);
		streamingTurn.updateContent(
			makeAssistantMessage([
				{
					type: "thinking",
					thinking: [
						"### Audit Phase",
						"First line of earlier context",
						"Second line of earlier context",
						"- Inspect `validateSession` in **auth.ts**",
						"- Check `refreshToken` expiry window",
						"- Return `401` when token is stale",
					].join("\n"),
				},
			]),
			true,
		);

		const ansiLines = streamingTurn.render(90);
		const plainLines = ansiLines.map(stripTerminalSequences);
		const visibleRows = plainLines.map((l) => l.trim()).filter((l) => l.length > 0);

		expect(visibleRows).toHaveLength(4);
		expect(visibleRows[0]).toBe("┃ Thinking…");
		expect(visibleRows[1]).toBe("▎ - Inspect validateSession in auth.ts");
		expect(visibleRows[2]).toBe("▎ - Check refreshToken expiry window");
		expect(visibleRows[3]).toBe("▎ - Return 401 when token is stale");

		expect(plainLines.join("\n")).not.toContain("First line of earlier context");
		expect(plainLines.join("\n")).not.toContain("Second line of earlier context");
		expect(plainLines.join("\n")).not.toContain("`validateSession`");
		expect(plainLines.join("\n")).not.toContain("**auth.ts**");

		const inspectAnsiLine = ansiLines.find((l) =>
			stripTerminalSequences(l).includes("Inspect validateSession in auth.ts"),
		)!;
		expect(inspectAnsiLine).toContain("\x1b[1m");
		const rgbMatches = [...inspectAnsiLine.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
		expect(rgbMatches.length).toBeGreaterThanOrEqual(3);
		for (const m of rgbMatches) {
			const r = Number(m[1]);
			const g = Number(m[2]);
			const b = Number(m[3]);
			expect(r).toBeLessThan(g);
			expect(g).toBeLessThan(b);
		}
	});

	it("renders completed collapsed Thinking blocks as ❙ › Thought for Xs using per-block observed duration and ❙ › Thought for historical entries without clutter", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const mdTheme = getMarkdownTheme();
		const liveMsgTs = Date.now();
		const liveTurn = new AssistantMessageComponent(undefined, false, mdTheme);

		liveTurn.updateContent(
			makeAssistantMessage(
				[{ type: "thinking", thinking: "First reasoning block\nSecond line of first block" }],
				{ timestamp: liveMsgTs },
			),
			true,
		);
		vi.advanceTimersByTime(4200);

		liveTurn.updateContent(
			makeAssistantMessage(
				[
					{ type: "thinking", thinking: "First reasoning block\nSecond line of first block" },
					{ type: "text", text: "Interim check." },
					{ type: "thinking", thinking: "Second reasoning block" },
				],
				{ timestamp: liveMsgTs },
			),
			true,
		);
		vi.advanceTimersByTime(1800);

		const completedLiveMsg = makeAssistantMessage(
			[
				{ type: "thinking", thinking: "First reasoning block\nSecond line of first block" },
				{ type: "text", text: "Interim check." },
				{ type: "thinking", thinking: "Second reasoning block" },
				{ type: "text", text: "Final answer." },
			],
			{ timestamp: liveMsgTs },
		);
		liveTurn.updateContent(completedLiveMsg, false);

		const plainLiveRows = liveTurn
			.render(90)
			.map(stripTerminalSequences)
			.map((l) => l.trim())
			.filter((l) => l.length > 0);

		expect(plainLiveRows).toContain("❙ › Thought for 4s");
		expect(plainLiveRows).toContain("❙ › Thought for 2s");
		expect(plainLiveRows.join("\n")).not.toContain("First reasoning block");
		expect(plainLiveRows.join("\n")).not.toContain("Second reasoning block");
		expect(plainLiveRows.join("\n")).not.toContain("(2)");
		expect(plainLiveRows.join("\n")).not.toContain("\u2014");

		await harness.emit("session_start", { reason: "reload" });
		const reloadedTurn = new AssistantMessageComponent(completedLiveMsg, false, mdTheme);
		const plainReloaded = reloadedTurn
			.render(90)
			.map(stripTerminalSequences)
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		expect(plainReloaded).toContain("❙ › Thought for 4s");
		expect(plainReloaded).toContain("❙ › Thought for 2s");

		const historicalTurn = new AssistantMessageComponent(
			makeAssistantMessage(
				[
					{ type: "thinking", thinking: "Historical thought from disk\nExtra line" },
					{ type: "text", text: "Restored reply." },
				],
				{ timestamp: 1_700_000_000_000 },
			),
			false,
			mdTheme,
		);
		const plainHistorical = historicalTurn
			.render(90)
			.map(stripTerminalSequences)
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		expect(plainHistorical).toContain("❙ › Thought");
		expect(plainHistorical.join("\n")).not.toContain("Thought for");
		expect(plainHistorical.join("\n")).not.toContain("Historical thought from disk");
	});

	it("toggles Thinking expansion on click with │ ⌄ Thought for Xs, continuous │ guide, formatted markdown, no micro-hints or Copy badges, and silent mode hiding", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T13:00:00Z"));
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const mdTheme = getMarkdownTheme();
		const turn = new AssistantMessageComponent(undefined, false, mdTheme);
		const ts = Date.now();
		const thinkingMarkdown = [
			"### Verify Signature",
			"Check `parseToken` inside **jwt.ts**:",
			"",
			"```ts",
			"const verified = true;",
			"```",
		].join("\n");

		turn.updateContent(
			makeAssistantMessage([{ type: "thinking", thinking: thinkingMarkdown }], { timestamp: ts }),
			true,
		);
		vi.advanceTimersByTime(3100);
		turn.updateContent(
			makeAssistantMessage(
				[
					{ type: "thinking", thinking: thinkingMarkdown },
					{ type: "text", text: "Token verified." },
				],
				{ timestamp: ts },
			),
			false,
		);

		const collapsedLines = turn.render(90);
		const collapsedPlain = collapsedLines.map(stripTerminalSequences).join("\n");
		expect(collapsedPlain).toContain("❙ › Thought for 3s");
		expect(collapsedPlain).not.toContain("parseToken");

		const clickRow1 = (height: number) =>
			turn.handleMouse?.({
				type: "click",
				button: "left",
				x: 4,
				y: 1,
				width: 90,
				height,
				shift: false,
				alt: false,
				ctrl: false,
			} as any);

		expect(clickRow1(collapsedLines.length)?.handled).toBe(true);

		turn.handleMouse?.({
			type: "move",
			button: "none",
			x: 6,
			y: 1,
			width: 90,
			height: 20,
			shift: false,
			alt: false,
			ctrl: false,
		} as any);

		const expandedAnsi = turn.render(90);
		const expandedPlain = expandedAnsi.map(stripTerminalSequences);
		const expandedText = expandedPlain.join("\n");

		expect(expandedText).toContain("│ ⌄ Thought for 3s");
		expect(expandedText).not.toContain("клик свернуть");
		expect(expandedText).not.toContain("· клик");
		expect(expandedText).toContain("│ Verify Signature");
		expect(expandedText).toContain("│ Check parseToken inside jwt.ts:");
		expect(expandedText).not.toContain("`parseToken`");
		expect(expandedText).not.toContain("**jwt.ts**");
		expect(expandedText).toContain("const verified = true;");

		const answerIdx = expandedPlain.findIndex((l) => l.includes("Token verified."));
		expect(answerIdx).toBeGreaterThan(2);
		const thoughtSection = expandedPlain.slice(1, answerIdx - 1);
		expect(thoughtSection.length).toBeGreaterThanOrEqual(5);
		for (const row of thoughtSection) {
			expect(row.trimStart().startsWith("│")).toBe(true);
			expect(row).not.toContain("Copy");
		}

		await harness.runCommand("silent", "on");
		const silentText = turn.render(90).map(stripTerminalSequences).join("\n");
		expect(silentText).toContain("Token verified.");
		expect(silentText).not.toContain("Thought");
		expect(silentText).not.toContain("parseToken");

		await harness.runCommand("silent", "off");
		const restoredLines = turn.render(90);
		expect(restoredLines.map(stripTerminalSequences).join("\n")).toContain("│ ⌄ Thought for 3s");

		expect(clickRow1(restoredLines.length)?.handled).toBe(true);
		const recollapsedText = turn.render(90).map(stripTerminalSequences).join("\n");
		expect(recollapsedText).toContain("❙ › Thought for 3s");
		expect(recollapsedText).not.toContain("parseToken");

		const historicalTurn = new AssistantMessageComponent(
			makeAssistantMessage(
				[
					{ type: "thinking", thinking: "Restored historical reasoning" },
					{ type: "text", text: "Done." },
				],
				{ timestamp: 1_650_000_000_000 },
			),
			false,
			mdTheme,
		);
		const histCollapsed = historicalTurn.render(90);
		historicalTurn.handleMouse?.({
			type: "click",
			button: "left",
			x: 4,
			y: 1,
			width: 90,
			height: histCollapsed.length,
			shift: false,
			alt: false,
			ctrl: false,
		} as any);
		const histExpanded = historicalTurn.render(90).map(stripTerminalSequences).join("\n");
		expect(histExpanded).toContain("│ ⌄ Thought");
		expect(histExpanded).not.toContain("Thought for");
		expect(histExpanded).not.toContain("клик свернуть");
	});

	it("handles narrow widths without overflowing, adapts live between dark and light blue-slate palettes, and tracks event-streamed empty-start thinking runs", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T14:00:00Z"));
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const mdTheme = getMarkdownTheme();
		const msgTs = Date.now();
		const startMsg = makeAssistantMessage([{ type: "thinking", thinking: "" }], { timestamp: msgTs });
		await harness.emit("message_start", { message: startMsg });
		vi.advanceTimersByTime(1200);

		const deltaMsg = makeAssistantMessage(
			[{ type: "thinking", thinking: "Line A with `code`\r\nLine B" }],
			{ timestamp: msgTs },
		);
		await harness.emit("message_update", { message: deltaMsg });
		vi.advanceTimersByTime(3800);

		const endMsg = makeAssistantMessage(
			[
				{ type: "thinking", thinking: "Line A with `code`\r\nLine B" },
				{ type: "text", text: "Completed." },
			],
			{ timestamp: msgTs },
		);
		await harness.emit("message_end", { message: endMsg });

		const eventTurn = new AssistantMessageComponent(endMsg, false, mdTheme);
		expect(eventTurn.render(80).map(stripTerminalSequences).join("\n")).toContain(
			"❙ › Thought for 5s",
		);

		const streamingNarrow = new AssistantMessageComponent(undefined, false, mdTheme);
		streamingNarrow.updateContent(deltaMsg, true);
		for (const w of [1, 6, 10, 18, 48]) {
			for (const line of streamingNarrow.render(w)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(w);
			}
		}

		const darkHeader = streamingNarrow
			.render(80)
			.find((l) => stripTerminalSequences(l).includes("Thinking…"))!;
		harness.setTheme("light");
		const lightLines = streamingNarrow.render(80);
		const lightHeader = lightLines.find((l) => stripTerminalSequences(l).includes("Thinking…"))!;
		expect(lightHeader).not.toBe(darkHeader);
		const spineMatch = /\x1b\[38;2;(\d+);(\d+);(\d+)m┃/.exec(lightHeader);
		expect(spineMatch).not.toBeNull();
		const [r, g, b] = [Number(spineMatch![1]), Number(spineMatch![2]), Number(spineMatch![3])];
		expect(r).toBeLessThan(g);
		expect(g).toBeLessThan(b);
	});
});
