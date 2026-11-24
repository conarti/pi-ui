import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AssistantMessageComponent,
	CustomEditor,
	ToolExecutionComponent,
	getMarkdownTheme,
	type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { Loader, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

	it("keeps ToolRuntime indicators alive after agent_settled, respects compact-tools working flag without restoring 80ms Loader timers, and coexists with top-border editor wrappers", async () => {
		vi.useFakeTimers();
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-ui-ticket12-"));
		try {
			const piDir = join(tempRoot, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "compact-tools.json"),
				JSON.stringify({ style: "compact", working: true }),
				"utf8",
			);

			harness = createExtensionHarness({
				theme: "dark",
				width: 100,
				height: 32,
				cwd: tempRoot,
				projectTrusted: true,
			});

			const indicatorLog: Array<WorkingIndicatorOptions | undefined> = [];
			vi.spyOn(harness.ctx.ui, "setWorkingIndicator").mockImplementation((opts) => {
				indicatorLog.push(opts);
			});

			harness.mount(conartiPiUi);
			await harness.startSession();

			expect(indicatorLog.at(-1)).toEqual({ frames: [] });

			await harness.emit("agent_start", {});
			await harness.emit("tool_execution_start", {
				toolCallId: "tc-a",
				toolName: "read",
				args: { path: "src/index.ts" },
			});
			const rowA = new ToolExecutionComponent(
				"read",
				"tc-a",
				{ path: "src/index.ts" },
				undefined,
				undefined,
				harness.tui.asTui(),
				harness.ctx.cwd,
			);
			(rowA as any).markExecutionStarted();
			rowA.render(80);

			vi.advanceTimersByTime(33 * 5);
			expect(indicatorLog.at(-1)).toEqual({ frames: [] });

			await harness.emit("agent_settled", {});
			expect(vi.getTimerCount()).toBe(0);

			await harness.emit("agent_start", {});
			await harness.emit("tool_execution_start", {
				toolCallId: "tc-b",
				toolName: "read",
				args: { path: "src/shared/ansi.ts" },
			});
			const rowB = new ToolExecutionComponent(
				"read",
				"tc-b",
				{ path: "src/shared/ansi.ts" },
				undefined,
				undefined,
				harness.tui.asTui(),
				harness.ctx.cwd,
			);
			(rowB as any).markExecutionStarted();
			const beforeTick = rowB.render(80).join("\n");
			vi.advanceTimersByTime(33 * 6);
			const afterTick = rowB.render(80).join("\n");
			expect(afterTick).not.toBe(beforeTick);

			writeFileSync(join(piDir, "compact-tools.json"), JSON.stringify({ style: "off" }), "utf8");
			await harness.runCommand("compact-tools", "off");
			const restoredIndicator = indicatorLog.at(-1);
			expect(restoredIndicator?.frames?.length).toBe(1);
			expect(stripTerminalSequences(restoredIndicator?.frames?.[0] ?? "")).toBe("◆");

			const prevFactory = harness.ctx.ui.getEditorComponent();
			harness.ctx.ui.setEditorComponent((t, editorTheme, kb) => {
				const ed =
					prevFactory?.(t as any, editorTheme, kb) ??
					new CustomEditor(t as any, editorTheme, kb, { embedWorkingStatus: true });
				(ed as any).embedWorkingStatus = true;
				return ed;
			});

			class HostBorderStatusShim extends Loader {
				renderInBorder(width: number): string {
					const line = super.render(width + 2)[1] ?? "";
					return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
				}
				renderSpinnerInBorder(width: number): string {
					return truncateToWidth((this as any).getRenderedIndicator(), width, "");
				}
			}

			const borderStatus = new HostBorderStatusShim(
				harness.tui.asTui(),
				(s) => s,
				(s) => s,
				"Working... (esc to interrupt)",
				restoredIndicator,
			);
			(harness.editor as any).setWorkingStatusIndicator(borderStatus);
			for (const w of [14, 30, 64, 100]) {
				const topLine = harness.editor!.render(w)[0]!;
				expect(visibleWidth(topLine)).toBe(w);
				expect(stripTerminalSequences(topLine)).toContain("◆");
			}
			borderStatus.stop();

			await harness.emit("agent_end", { messages: [] });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("locks thinking duration at thinking_end / empty text_start, renders Thinking… on empty non-redacted start without leaking timers on redacted blocks, and retains session timings across 15+ char-by-char streamed turns", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T15:00:00Z"));
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const mdTheme = getMarkdownTheme();

		const redactedTurn = new AssistantMessageComponent(undefined, false, mdTheme);
		redactedTurn.updateContent(
			makeAssistantMessage([{ type: "thinking", thinking: "", redacted: true }], {
				timestamp: Date.now(),
			}),
			true,
		);
		expect(redactedTurn.render(80)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);

		const tsEndLock = Date.now() + 100;
		const lockTurn = new AssistantMessageComponent(undefined, false, mdTheme);
		const emptyStartMsg = makeAssistantMessage([{ type: "thinking", thinking: "" }], {
			timestamp: tsEndLock,
		});
		await harness.emit("message_start", { message: emptyStartMsg });
		lockTurn.updateContent(emptyStartMsg, true);
		expect(lockTurn.render(80).map(stripTerminalSequences).join("\n")).toContain("┃ Thinking…");

		vi.advanceTimersByTime(3000);
		const thinkingEndMsg = makeAssistantMessage(
			[{ type: "thinking", thinking: "Finished reasoning early" }],
			{ timestamp: tsEndLock },
		);
		await harness.emit("message_update", {
			message: thinkingEndMsg,
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: "Finished reasoning early",
				partial: thinkingEndMsg,
			},
		});
		lockTurn.updateContent(thinkingEndMsg, true);
		expect(lockTurn.render(80).map(stripTerminalSequences).join("\n")).toContain(
			"❙ › Thought for 3s",
		);
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(5000);
		const finalLockMsg = makeAssistantMessage(
			[
				{ type: "thinking", thinking: "Finished reasoning early" },
				{ type: "text", text: "Delayed answer." },
			],
			{ timestamp: tsEndLock },
		);
		await harness.emit("message_end", { message: finalLockMsg });
		lockTurn.updateContent(finalLockMsg, false);
		expect(lockTurn.render(80).map(stripTerminalSequences).join("\n")).toContain(
			"❙ › Thought for 3s",
		);

		const completedTurns: any[] = [];
		for (let t = 0; t < 15; t++) {
			const turnTs = Date.now() + t + 1;
			let acc = "";
			const baseText = `Turn ${t} detailed thought `.padEnd(170, "x");
			await harness.emit("message_start", {
				message: makeAssistantMessage([{ type: "thinking", thinking: "" }], { timestamp: turnTs }),
			});
			for (let ch = 0; ch < baseText.length; ch++) {
				acc += baseText[ch]!;
				await harness.emit("message_update", {
					message: makeAssistantMessage([{ type: "thinking", thinking: acc }], {
						timestamp: turnTs,
					}),
				});
			}
			vi.advanceTimersByTime(3000);
			const doneMsg = makeAssistantMessage(
				[
					{ type: "thinking", thinking: acc },
					{ type: "text", text: `Reply ${t}` },
				],
				{ timestamp: turnTs },
			);
			await harness.emit("message_end", { message: doneMsg });
			completedTurns.push(doneMsg);
		}

		await harness.emit("session_start", { reason: "reload" });
		const reloadedFirst = new AssistantMessageComponent(completedTurns[0], false, mdTheme);
		expect(reloadedFirst.render(80).map(stripTerminalSequences).join("\n")).toContain(
			"❙ › Thought for 3s",
		);
	});

	it("applies strongFg color directly to bold spans, omits bare fence borders from the 3-line streaming tail, and preserves Thinking hover state across streaming text deltas", async () => {
		vi.useFakeTimers();
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const mdTheme = getMarkdownTheme();
		const streamingCode = new AssistantMessageComponent(undefined, false, mdTheme);
		streamingCode.updateContent(
			makeAssistantMessage([
				{
					type: "thinking",
					thinking: [
						"Check **auth.ts** exports",
						"```ts",
						"const tokenValid = true;",
						"const sessionReady = true;",
					].join("\n"),
				},
			]),
			true,
		);

		const codeAnsi = streamingCode.render(80);
		const codePlain = codeAnsi.map(stripTerminalSequences).map((l) => l.trim()).filter(Boolean);
		expect(codePlain).toEqual([
			"┃ Thinking…",
			"▎ Check auth.ts exports",
			"▎   const tokenValid = true;",
			"▎   const sessionReady = true;",
		]);

		const boldLine = codeAnsi.find((l) => stripTerminalSequences(l).includes("Check auth.ts exports"))!;
		expect(boldLine).toContain("\x1b[38;2;156;174;200mauth.ts");

		const hoverTurn = new AssistantMessageComponent(undefined, false, mdTheme);
		const hoverTs = Date.now();
		hoverTurn.updateContent(
			makeAssistantMessage(
				[
					{ type: "thinking", thinking: "Initial reasoning" },
					{ type: "text", text: "Part 1" },
				],
				{ timestamp: hoverTs },
			),
			true,
		);

		const beforeHoverLine = hoverTurn.render(80)[1]!;
		hoverTurn.handleMouse?.({
			type: "move",
			button: "none",
			x: 4,
			y: 1,
			width: 80,
			height: 6,
			shift: false,
			alt: false,
			ctrl: false,
		} as any);
		const hoveredLine = hoverTurn.render(80)[1]!;
		expect(hoveredLine).not.toBe(beforeHoverLine);

		hoverTurn.updateContent(
			makeAssistantMessage(
				[
					{ type: "thinking", thinking: "Initial reasoning" },
					{ type: "text", text: "Part 1 and Part 2" },
				],
				{ timestamp: hoverTs },
			),
			true,
		);
		const afterDeltaLine = hoverTurn.render(80)[1]!;
		expect(afterDeltaLine).toBe(hoveredLine);
	});
});
