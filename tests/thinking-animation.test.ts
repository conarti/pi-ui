import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { clearRecordedThinkingTimings } from "../src/features/transcript/thinking-block.ts";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import {
	createAssistantMessageEventStream,
	createInteractiveHarness,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type InteractiveHarness,
} from "./harness/index.ts";

const ZERO_USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeStreamMessage(
	content: AssistantMessage["content"],
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux-thinking-stream",
		provider: "faux",
		model: "faux-1",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

function createDeferredStreamQueue() {
	const pending: AssistantMessageEventStream[] = [];
	const waiters: Array<(stream: AssistantMessageEventStream) => void> = [];

	return {
		handler(options?: { signal?: AbortSignal }): AssistantMessageEventStream {
			const stream = createAssistantMessageEventStream();
			let ended = false;
			const origEnd = stream.end.bind(stream);
			stream.end = (result?: AssistantMessage) => {
				if (ended) return;
				ended = true;
				origEnd(result);
			};
			options?.signal?.addEventListener(
				"abort",
				() => {
					if (!ended) {
						const aborted = makeStreamMessage([], {
							stopReason: "aborted",
							errorMessage: "Request was aborted",
						});
						stream.push({ type: "error", reason: "aborted", error: aborted });
						stream.end(aborted);
					}
				},
				{ once: true },
			);
			const waiter = waiters.shift();
			if (waiter) {
				waiter(stream);
			} else {
				pending.push(stream);
			}
			return stream;
		},
		nextStream(): Promise<AssistantMessageEventStream> {
			const ready = pending.shift();
			if (ready) {
				return Promise.resolve(ready);
			}
			return new Promise((resolve) => {
				waiters.push(resolve);
			});
		},
	};
}

function findGlyphRgb(
	harness: InteractiveHarness,
	rowNeedle: string,
	glyph: string,
): [number, number, number] | undefined {
	const screen = harness.screen();
	for (let r = 0; r < screen.height; r += 1) {
		const row = screen.rowText(r);
		if (!row.includes(rowNeedle)) continue;
		for (let c = 0; c < screen.width; c += 1) {
			const cell = screen.cellAt(r, c);
			if (cell?.char === glyph && cell.fg.kind === "rgb") {
				return [cell.fg.r, cell.fg.g, cell.fg.b];
			}
		}
	}
	return undefined;
}

describe("30 fps breathing animation & refined Thinking blocks (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		stopAllAnimations();
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		stopAllAnimations();
		clearRecordedThinkingTimings();
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("drives composer working indicator and streaming Thinking spines from a single 30 fps timer with zero Loader timers and zero leaked timers on idle or shutdown", async () => {
		vi.useFakeTimers();
		const queue = createDeferredStreamQueue();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 32,
			thinkingLevel: "medium",
			streamSimple: (_m, _c, opts) => queue.handler(opts),
		});
		vi.runOnlyPendingTimers();

		expect(vi.getTimerCount()).toBe(0);

		const turnPromise = harness.submitInput("Analyze session animation");
		const stream1 = await queue.nextStream();
		const ts1 = Date.now();
		const partial1 = makeStreamMessage(
			[{ type: "thinking", thinking: "Line one\nLine two\nLine three" }],
			{ timestamp: ts1 },
		);
		stream1.push({ type: "start", partial: makeStreamMessage([], { timestamp: ts1 }) });
		stream1.push({
			type: "thinking_start",
			contentIndex: 0,
			partial: makeStreamMessage([{ type: "thinking", thinking: "" }], { timestamp: ts1 }),
		});
		stream1.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Line one\nLine two\nLine three",
			partial: partial1,
		});
		await harness.flush();

		expect(vi.getTimerCount()).toBe(1);
		expect(harness.screen().text()).toContain("┃ Thinking…");
		expect(harness.screen().text()).toContain("◆");

		const spineTopBefore = findGlyphRgb(harness, "Thinking…", "┃");
		const spineRow1Before = findGlyphRgb(harness, "Line one", "▎");
		const spineRow2Before = findGlyphRgb(harness, "Line two", "▎");
		const workingDiamondBefore = findGlyphRgb(harness, "Working", "◆");
		expect(spineTopBefore).toBeDefined();
		expect(spineRow1Before).toBeDefined();
		expect(spineRow2Before).toBeDefined();
		expect(workingDiamondBefore).toBeDefined();
		expect(spineRow1Before).not.toEqual(spineRow2Before);

		vi.advanceTimersByTime(33 * 6);
		harness.flushFrame();
		expect(vi.getTimerCount()).toBe(1);

		const spineRow1After = findGlyphRgb(harness, "Line one", "▎");
		const workingDiamondAfter = findGlyphRgb(harness, "Working", "◆");
		expect(spineRow1After).not.toEqual(spineRow1Before);
		expect(workingDiamondAfter).not.toEqual(workingDiamondBefore);

		const done1 = makeStreamMessage(
			[
				{ type: "thinking", thinking: "Line one\nLine two\nLine three" },
				{ type: "text", text: "Animation verified." },
			],
			{ timestamp: ts1 },
		);
		stream1.push({
			type: "thinking_end",
			contentIndex: 0,
			content: "Line one\nLine two\nLine three",
			partial: partial1,
		});
		stream1.push({ type: "text_start", contentIndex: 1, partial: done1 });
		stream1.push({ type: "text_delta", contentIndex: 1, delta: "Animation verified.", partial: done1 });
		stream1.push({ type: "text_end", contentIndex: 1, content: "Animation verified.", partial: done1 });
		stream1.push({ type: "done", reason: "stop", message: done1 });
		stream1.end(done1);
		await turnPromise;

		expect(vi.getTimerCount()).toBe(0);

		await harness.submitInput("/silent on");
		const silentTurn = harness.submitInput("Silent background turn");
		const stream2 = await queue.nextStream();
		const ts2 = Date.now() + 100;
		stream2.push({ type: "start", partial: makeStreamMessage([], { timestamp: ts2 }) });
		await harness.flush();
		expect(vi.getTimerCount()).toBe(1);

		await harness.dispose();
		harness = undefined;
		expect(vi.getTimerCount()).toBe(0);

		const aborted = makeStreamMessage([], { stopReason: "aborted", timestamp: ts2 });
		stream2.end(aborted);
		await silentTurn.catch(() => {});
	});

	it("renders streaming Thinking… with at most 3 softly formatted markdown tail lines, applies strongFg to bold spans, and omits bare fence borders", async () => {
		vi.useFakeTimers();
		const queue = createDeferredStreamQueue();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 32,
			thinkingLevel: "medium",
			streamSimple: (_m, _c, opts) => queue.handler(opts),
		});
		vi.runOnlyPendingTimers();

		const turn1 = harness.submitInput("Audit auth session");
		const s1 = await queue.nextStream();
		const ts1 = Date.now();
		const md1 = [
			"### Audit Phase",
			"First line of earlier context",
			"Second line of earlier context",
			"- Inspect `validateSession` in **auth.ts**",
			"- Check `refreshToken` expiry window",
			"- Return `401` when token is stale",
		].join("\n");
		const partial1 = makeStreamMessage([{ type: "thinking", thinking: md1 }], { timestamp: ts1 });
		s1.push({ type: "start", partial: makeStreamMessage([], { timestamp: ts1 }) });
		s1.push({ type: "thinking_start", contentIndex: 0, partial: partial1 });
		s1.push({ type: "thinking_delta", contentIndex: 0, delta: md1, partial: partial1 });
		await harness.flush();

		const screen1 = harness.screen();
		const text1 = screen1.text();
		expect(text1).toContain("┃ Thinking…");
		expect(text1).toContain("▎ - Inspect validateSession in auth.ts");
		expect(text1).toContain("▎ - Check refreshToken expiry window");
		expect(text1).toContain("▎ - Return 401 when token is stale");
		expect(text1).not.toContain("First line of earlier context");
		expect(text1).not.toContain("Second line of earlier context");
		expect(text1).not.toContain("`validateSession`");
		expect(text1).not.toContain("**auth.ts**");

		const inspectPos = screen1.findText("auth.ts");
		expect(inspectPos).toBeDefined();
		const boldCell = screen1.cellAt(inspectPos!.row, inspectPos!.col);
		expect(boldCell?.bold).toBe(true);
		expect(boldCell?.fg).toEqual({ kind: "rgb", r: 156, g: 174, b: 200 });

		const md2 = [
			"Check **auth.ts** exports",
			"```ts",
			"const tokenValid = true;",
			"const sessionReady = true;",
		].join("\n");
		const partial2 = makeStreamMessage([{ type: "thinking", thinking: md2 }], { timestamp: ts1 });
		s1.push({ type: "thinking_delta", contentIndex: 0, delta: "\n", partial: partial2 });
		await harness.flush();

		const text2 = harness.screen().text();
		expect(text2).toContain("▎ Check auth.ts exports");
		expect(text2).toContain("▎   const tokenValid = true;");
		expect(text2).toContain("▎   const sessionReady = true;");
		expect(text2).not.toContain("```ts");

		const final1 = makeStreamMessage(
			[
				{ type: "thinking", thinking: md2 },
				{ type: "text", text: "Audit complete." },
			],
			{ timestamp: ts1 },
		);
		s1.push({ type: "thinking_end", contentIndex: 0, content: md2, partial: partial2 });
		s1.push({ type: "done", reason: "stop", message: final1 });
		s1.end(final1);
		await turn1;
	});

	it("renders completed collapsed Thinking blocks as ❙ › Thought for Xs per block, preserves timings across /reload, and shows ❙ › Thought for historical entries", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
		const queue = createDeferredStreamQueue();

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 32,
			thinkingLevel: "medium",
			streamSimple: (_m, _c, opts) => queue.handler(opts),
			setupSession(sm) {
				sm.appendMessage({
					role: "user",
					content: "Historical question",
					timestamp: 1_700_000_000_000,
				});
				sm.appendMessage(
					makeStreamMessage(
						[
							{ type: "thinking", thinking: "Historical thought from disk\nExtra line" },
							{ type: "text", text: "Restored reply." },
						],
						{ timestamp: 1_700_000_000_500 },
					),
				);
			},
		});

		const initialText = harness.screen().text();
		expect(initialText).toContain("❙ › Thought");
		expect(initialText).toContain("Restored reply.");
		expect(initialText).not.toContain("Thought for");
		expect(initialText).not.toContain("Historical thought from disk");

		const liveTurn = harness.submitInput("Run two-stage reasoning");
		const stream = await queue.nextStream();
		const liveTs = Date.now();

		const pBlock0 = makeStreamMessage(
			[{ type: "thinking", thinking: "First reasoning block\nSecond line of first block" }],
			{ timestamp: liveTs },
		);
		stream.push({ type: "start", partial: makeStreamMessage([], { timestamp: liveTs }) });
		stream.push({ type: "thinking_start", contentIndex: 0, partial: pBlock0 });
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "First reasoning block\nSecond line of first block",
			partial: pBlock0,
		});
		await harness.flush();

		vi.advanceTimersByTime(4200);
		stream.push({
			type: "thinking_end",
			contentIndex: 0,
			content: "First reasoning block\nSecond line of first block",
			partial: pBlock0,
		});

		const pBlock1 = makeStreamMessage(
			[
				{ type: "thinking", thinking: "First reasoning block\nSecond line of first block" },
				{ type: "text", text: "Interim check." },
				{ type: "thinking", thinking: "Second reasoning block" },
			],
			{ timestamp: liveTs },
		);
		stream.push({ type: "text_start", contentIndex: 1, partial: pBlock1 });
		stream.push({ type: "thinking_start", contentIndex: 2, partial: pBlock1 });
		stream.push({
			type: "thinking_delta",
			contentIndex: 2,
			delta: "Second reasoning block",
			partial: pBlock1,
		});
		await harness.flush();

		vi.advanceTimersByTime(1800);
		const completedMsg = makeStreamMessage(
			[
				{ type: "thinking", thinking: "First reasoning block\nSecond line of first block" },
				{ type: "text", text: "Interim check." },
				{ type: "thinking", thinking: "Second reasoning block" },
				{ type: "text", text: "Final answer." },
			],
			{ timestamp: liveTs },
		);
		stream.push({
			type: "thinking_end",
			contentIndex: 2,
			content: "Second reasoning block",
			partial: completedMsg,
		});
		stream.push({ type: "done", reason: "stop", message: completedMsg });
		stream.end(completedMsg);
		await liveTurn;

		const liveScreenText = harness.screen().text();
		expect(liveScreenText).toContain("❙ › Thought for 4s");
		expect(liveScreenText).toContain("❙ › Thought for 2s");
		expect(liveScreenText).not.toContain("First reasoning block");
		expect(liveScreenText).not.toContain("Second reasoning block");

		await harness.reload();
		const reloadedText = harness.screen().text();
		expect(reloadedText).toContain("❙ › Thought for 4s");
		expect(reloadedText).toContain("❙ › Thought for 2s");
	});

	it("toggles Thinking expansion via real mouse clicks with │ ⌄ Thought for Xs, continuous │ guide, hover preservation across text deltas, and /silent hiding", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T13:00:00Z"));
		const queue = createDeferredStreamQueue();

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 36,
			thinkingLevel: "medium",
			streamSimple: (_m, _c, opts) => queue.handler(opts),
			setupSession(sm) {
				sm.appendMessage({
					role: "user",
					content: "Earlier prompt",
					timestamp: 1_650_000_000_000,
				});
				sm.appendMessage(
					makeStreamMessage(
						[
							{ type: "thinking", thinking: "Restored historical reasoning" },
							{ type: "text", text: "Earlier done." },
						],
						{ timestamp: 1_650_000_000_500 },
					),
				);
			},
		});

		const histPos = harness.screen().findText("❙ › Thought");
		expect(histPos).toBeDefined();
		await harness.mouseClick(histPos!.col + 2, histPos!.row);
		const histExpandedText = harness.screen().text();
		expect(histExpandedText).toContain("│ ⌄ Thought");
		expect(histExpandedText).toContain("│ Restored historical reasoning");
		expect(histExpandedText).not.toContain("Thought for");

		vi.advanceTimersByTime(500);
		const histOpenPos = harness.screen().findText("│ ⌄ Thought");
		await harness.mouseClick(histOpenPos!.col + 2, histOpenPos!.row);
		expect(harness.screen().text()).toContain("❙ › Thought");

		const thinkingMarkdown = [
			"### Verify Signature",
			"Check `parseToken` inside **jwt.ts**:",
			"",
			"```ts",
			"const verified = true;",
			"```",
		].join("\n");

		const turnPromise = harness.submitInput("Verify JWT signature");
		const stream = await queue.nextStream();
		const ts = Date.now();
		const pThink = makeStreamMessage([{ type: "thinking", thinking: thinkingMarkdown }], {
			timestamp: ts,
		});
		stream.push({ type: "start", partial: makeStreamMessage([], { timestamp: ts }) });
		stream.push({ type: "thinking_start", contentIndex: 0, partial: pThink });
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinkingMarkdown, partial: pThink });
		await harness.flush();

		vi.advanceTimersByTime(3100);
		const pText1 = makeStreamMessage(
			[
				{ type: "thinking", thinking: thinkingMarkdown },
				{ type: "text", text: "Token " },
			],
			{ timestamp: ts },
		);
		stream.push({ type: "thinking_end", contentIndex: 0, content: thinkingMarkdown, partial: pThink });
		stream.push({ type: "text_start", contentIndex: 1, partial: pText1 });
		stream.push({ type: "text_delta", contentIndex: 1, delta: "Token ", partial: pText1 });
		await harness.flush();

		const liveCollapsedPos = harness.screen().findText("❙ › Thought for 3s");
		expect(liveCollapsedPos).toBeDefined();
		const spineBeforeHover = findGlyphRgb(harness, "Thought for 3s", "❙");
		await harness.mouseMove(liveCollapsedPos!.col + 2, liveCollapsedPos!.row);
		const spineHovered = findGlyphRgb(harness, "Thought for 3s", "❙");
		expect(spineHovered).toEqual([97, 175, 239]);
		expect(spineHovered).not.toEqual(spineBeforeHover);

		const pText2 = makeStreamMessage(
			[
				{ type: "thinking", thinking: thinkingMarkdown },
				{ type: "text", text: "Token verified." },
			],
			{ timestamp: ts },
		);
		stream.push({ type: "text_delta", contentIndex: 1, delta: "verified.", partial: pText2 });
		await harness.flush();
		expect(findGlyphRgb(harness, "Thought for 3s", "❙")).toEqual([97, 175, 239]);

		stream.push({ type: "done", reason: "stop", message: pText2 });
		stream.end(pText2);
		await turnPromise;

		vi.advanceTimersByTime(500);
		const clickExpandPos = harness.screen().findText("❙ › Thought for 3s");
		expect(clickExpandPos).toBeDefined();
		await harness.mouseClick(clickExpandPos!.col + 2, clickExpandPos!.row);

		const expandedScreen = harness.screen();
		const expandedText = expandedScreen.text();
		expect(expandedText).toContain("│ ⌄ Thought for 3s");
		expect(expandedText).not.toContain("клик свернуть");
		expect(expandedText).not.toContain("· клик");
		expect(expandedText).toContain("│ Verify Signature");
		expect(expandedText).toContain("│ Check parseToken inside jwt.ts:");
		expect(expandedText).not.toContain("`parseToken`");
		expect(expandedText).not.toContain("**jwt.ts**");
		expect(expandedText).toContain("const verified = true;");

		const hdrPos = expandedScreen.findText("│ ⌄ Thought for 3s")!;
		const ansPos = expandedScreen.findText("Token verified.")!;
		expect(ansPos.row).toBeGreaterThan(hdrPos.row + 3);
		for (let r = hdrPos.row; r < ansPos.row - 1; r += 1) {
			const rowText = expandedScreen.rowText(r);
			if (!rowText.trim()) continue;
			expect(rowText.trimStart().startsWith("│")).toBe(true);
			expect(rowText).not.toContain("Copy");
		}

		await harness.submitInput("/silent on");
		const silentText = harness.screen().text();
		expect(silentText).toContain("Token verified.");
		expect(silentText).not.toContain("Thought for 3s");
		expect(silentText).not.toContain("parseToken");

		await harness.submitInput("/silent off");
		expect(harness.screen().text()).toContain("│ ⌄ Thought for 3s");

		vi.advanceTimersByTime(500);
		const clickCollapsePos = harness.screen().findText("│ ⌄ Thought for 3s")!;
		await harness.mouseClick(clickCollapsePos.col + 2, clickCollapsePos.row);
		const recollapsedText = harness.screen().text();
		expect(recollapsedText).toContain("❙ › Thought for 3s");
		expect(recollapsedText).not.toContain("parseToken");
	});

	it("locks duration at thinking_end, renders Thinking… on empty start without timers on redacted blocks, adapts live dark/light palettes at narrow widths, and retains timings across 15+ turns", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T14:00:00Z"));
		const queue = createDeferredStreamQueue();

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 32,
			thinkingLevel: "medium",
			streamSimple: (_m, _c, opts) => queue.handler(opts),
		});
		vi.runOnlyPendingTimers();

		const redactedTurn = harness.submitInput("Redacted reasoning check");
		const sRedacted = await queue.nextStream();
		const tsRed = Date.now();
		const pRed = makeStreamMessage(
			[{ type: "thinking", thinking: "", redacted: true } as AssistantMessage["content"][number]],
			{ timestamp: tsRed },
		);
		sRedacted.push({ type: "start", partial: pRed });
		sRedacted.push({ type: "thinking_start", contentIndex: 0, partial: pRed });
		await harness.flush();
		expect(harness.screen().text()).not.toContain("Thinking…");
		expect(vi.getTimerCount()).toBe(1);

		const doneRed = makeStreamMessage(
			[
				{ type: "thinking", thinking: "", redacted: true } as AssistantMessage["content"][number],
				{ type: "text", text: "Redacted ok." },
			],
			{ timestamp: tsRed },
		);
		sRedacted.push({ type: "done", reason: "stop", message: doneRed });
		sRedacted.end(doneRed);
		await redactedTurn;
		expect(vi.getTimerCount()).toBe(0);

		const lockTurn = harness.submitInput("Early thinking_end lock");
		const sLock = await queue.nextStream();
		const tsLock = Date.now() + 100;
		const pEmpty = makeStreamMessage([{ type: "thinking", thinking: "" }], { timestamp: tsLock });
		sLock.push({ type: "start", partial: makeStreamMessage([], { timestamp: tsLock }) });
		sLock.push({ type: "thinking_start", contentIndex: 0, partial: pEmpty });
		await harness.flush();
		expect(harness.screen().text()).toContain("┃ Thinking…");

		const darkSpineRgb = findGlyphRgb(harness, "Thinking…", "┃");
		expect(darkSpineRgb).toBeDefined();
		harness.setTheme("light");
		const lightSpineRgb = findGlyphRgb(harness, "Thinking…", "┃");
		expect(lightSpineRgb).toBeDefined();
		expect(lightSpineRgb).not.toEqual(darkSpineRgb);
		expect(lightSpineRgb![0]).toBeLessThan(lightSpineRgb![1]);
		expect(lightSpineRgb![1]).toBeLessThan(lightSpineRgb![2]);

		for (const narrowW of [18, 48]) {
			const lines = harness.renderFrame(narrowW, 24);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(narrowW);
			}
		}
		await harness.resize(100, 32);
		harness.setTheme("dark");

		vi.advanceTimersByTime(3000);
		const pThinkDone = makeStreamMessage(
			[{ type: "thinking", thinking: "Finished reasoning early" }],
			{ timestamp: tsLock },
		);
		sLock.push({
			type: "thinking_end",
			contentIndex: 0,
			content: "Finished reasoning early",
			partial: pThinkDone,
		});
		await harness.flush();
		expect(harness.screen().text()).toContain("❙ › Thought for 3s");
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(5000);
		const doneLock = makeStreamMessage(
			[
				{ type: "thinking", thinking: "Finished reasoning early" },
				{ type: "text", text: "Delayed answer." },
			],
			{ timestamp: tsLock },
		);
		sLock.push({ type: "done", reason: "stop", message: doneLock });
		sLock.end(doneLock);
		await lockTurn;
		expect(harness.screen().text()).toContain("❙ › Thought for 3s");

		for (let t = 0; t < 15; t += 1) {
			const turnP = harness.submitInput(`Streamed turn #${t + 1}`);
			const st = await queue.nextStream();
			const turnTs = Date.now() + t + 1;
			const fullThought = `Turn ${t} detailed thought `.padEnd(170, "x");
			st.push({
				type: "start",
				partial: makeStreamMessage([{ type: "thinking", thinking: "" }], { timestamp: turnTs }),
			});
			st.push({
				type: "thinking_start",
				contentIndex: 0,
				partial: makeStreamMessage([{ type: "thinking", thinking: "" }], { timestamp: turnTs }),
			});
			let acc = "";
			for (let i = 0; i < fullThought.length; i += 25) {
				const chunk = fullThought.slice(i, i + 25);
				acc += chunk;
				st.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: chunk,
					partial: makeStreamMessage([{ type: "thinking", thinking: acc }], { timestamp: turnTs }),
				});
			}
			await harness.flush();
			vi.advanceTimersByTime(3000);
			const doneTurn = makeStreamMessage(
				[
					{ type: "thinking", thinking: fullThought },
					{ type: "text", text: `AnchorReply_${t}` },
				],
				{ timestamp: turnTs },
			);
			st.push({ type: "thinking_end", contentIndex: 0, content: fullThought, partial: doneTurn });
			st.push({ type: "done", reason: "stop", message: doneTurn });
			st.end(doneTurn);
			await turnP;
		}

		await harness.reload();
		await harness.mouseWheel("up", 40, 10, 40);
		const topReloaded = harness.screen().text();
		expect(topReloaded).toContain("❙ › Thought for 3s");
	});

	it("keeps ToolRuntime 30 fps diamond alive across turns under compact-tools working: true without 80ms Loader timers and restores ◆ indicator on /compact-tools off", async () => {
		vi.useFakeTimers();
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-ui-thinking-working-"));
		tempDirs.push(tempRoot);
		mkdirSync(join(tempRoot, ".pi"), { recursive: true });
		writeFileSync(
			join(tempRoot, ".pi", "compact-tools.json"),
			`${JSON.stringify({ style: "compact", working: true }, null, 2)}\n`,
			"utf8",
		);
		writeFileSync(join(tempRoot, "sample.ts"), "export const x = 1;\n", "utf8");

		let releaseToolGate: (() => void) | undefined;
		const gatedTool = defineTool({
			name: "gated_probe",
			label: "Gated Probe",
			description: "Pauses execution to inspect active tool animation under working: true",
			parameters: Type.Object({ label: Type.String() }),
			async execute() {
				await new Promise<void>((resolve) => {
					releaseToolGate = resolve;
				});
				return {
					content: [{ type: "text", text: "probe finished" }],
					details: {},
				};
			},
		});

		const queue = createDeferredStreamQueue();
		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: tempRoot,
			projectTrusted: true,
			width: 100,
			height: 32,
			customTools: [gatedTool],
			streamSimple: (_m, _c, opts) => queue.handler(opts),
		});
		vi.runOnlyPendingTimers();

		expect(vi.getTimerCount()).toBe(0);

		const t1 = harness.submitInput("Run gated tool 1");
		const s1 = await queue.nextStream();
		const callMsg1 = makeStreamMessage(
			[{ type: "toolCall", id: "gp-1", name: "gated_probe", arguments: { label: "alpha" } }],
			{ stopReason: "toolUse" },
		);
		s1.push({ type: "done", reason: "toolUse", message: callMsg1 });
		s1.end(callMsg1);
		await harness.flush();

		expect(releaseToolGate).toBeDefined();
		expect(vi.getTimerCount()).toBe(1);
		const diamondBefore = findGlyphRgb(harness, "gated_probe", "◆");
		vi.advanceTimersByTime(33 * 6);
		harness.flushFrame();
		const diamondAfter = findGlyphRgb(harness, "gated_probe", "◆");
		expect(diamondBefore).toBeDefined();
		expect(diamondAfter).toBeDefined();
		expect(diamondAfter).not.toEqual(diamondBefore);

		releaseToolGate!();
		releaseToolGate = undefined;
		const s1Reply = await queue.nextStream();
		const done1 = makeStreamMessage([{ type: "text", text: "First tool turn done." }]);
		s1Reply.push({ type: "done", reason: "stop", message: done1 });
		s1Reply.end(done1);
		await t1;
		expect(vi.getTimerCount()).toBe(0);

		await harness.submitInput("/compact-tools off");
		const t2 = harness.submitInput("Check restored composer working diamond");
		const s2 = await queue.nextStream();
		s2.push({ type: "start", partial: makeStreamMessage([]) });
		await harness.flush();

		expect(vi.getTimerCount()).toBe(1);
		expect(findGlyphRgb(harness, "Working", "◆")).toBeDefined();

		const done2 = makeStreamMessage([{ type: "text", text: "All good." }]);
		s2.push({ type: "done", reason: "stop", message: done2 });
		s2.end(done2);
		await t2;
		expect(vi.getTimerCount()).toBe(0);
	});
});
