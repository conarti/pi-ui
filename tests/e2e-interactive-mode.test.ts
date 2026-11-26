import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AssistantMessageComponent,
	defineTool,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { COMPOSER_PLACEHOLDER, getActiveComposerEditor } from "../src/features/chrome/composer.ts";
import { clearRecordedThinkingTimings } from "../src/features/transcript/thinking-block.ts";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import { getActiveHostRuntime, unwrapHostTui } from "../src/shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import {
	contentText,
	createAssistantMessageEventStream,
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type InteractiveHarness,
} from "./harness/index.ts";

/* Валидный 2x3 PNG (75 байт) с корректными CRC32 и IDAT для декодера Photon в AgentSession */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGOwbvpm3fSNAYUCAGbACjPC8yHSAAAAAElFTkSuQmCC";
const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64"));

async function waitForCondition(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

async function flushUiAsync(harness: InteractiveHarness): Promise<void> {
	for (let i = 0; i < 6; i += 1) {
		await Promise.resolve();
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	harness.flushFrame();
}

const ZERO_USAGE = {
	input: 12,
	output: 24,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 36,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeStreamMessage(
	content: AssistantMessage["content"],
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux-e2e-stream",
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
			if (ready) return Promise.resolve(ready);
			return new Promise((resolve) => {
				waiters.push(resolve);
			});
		},
	};
}

function luminance(r: number, g: number, b: number): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

function findToolResult(harness: InteractiveHarness, toolCallId: string) {
	return harness.session.messages.find(
		(m): m is Extract<InteractiveHarness["session"]["messages"][number], { role: "toolResult" }> =>
			m.role === "toolResult" && m.toolCallId === toolCallId,
	);
}

function findRowGlyphRgb(
	harness: InteractiveHarness,
	rowNeedle: string,
	glyph: string,
): [number, number, number] | undefined {
	const screen = harness.screen();
	for (let r = 0; r < screen.height; r += 1) {
		if (!screen.rowText(r).includes(rowNeedle)) continue;
		for (let c = 0; c < screen.width; c += 1) {
			const cell = screen.cellAt(r, c);
			if (cell?.char === glyph && cell.fg.kind === "rgb") {
				return [cell.fg.r, cell.fg.g, cell.fg.b];
			}
		}
	}
	return undefined;
}

describe("End-to-end @conarti/pi-ui surfaces in real InteractiveMode", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function allocateTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

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

	it("renders transcript user/assistant/code cards with Copy affordances, Thinking duration & toggle, and 30 fps composer & tool wave animations", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 4, 12, 14, 35, 0));

		let releaseTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});

		const slowProbeTool = defineTool({
			name: "inspect_bundle",
			label: "Inspect bundle",
			description: "Inspects build bundle metrics",
			parameters: Type.Object({ entry: Type.String() }),
			async execute(_id, params) {
				await toolGate;
				return {
					content: [{ type: "text", text: `Bundle ${params.entry}: 18.4 kB gzip` }],
					details: {},
				};
			},
		});

		const streamQueue = createDeferredStreamQueue();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 108,
			height: 36,
			thinkingLevel: "high",
			clipboard: { text: "initial" },
			customTools: [slowProbeTool],
			streamSimple: (_m, _c, opts) => streamQueue.handler(opts),
		});
		vi.runOnlyPendingTimers();
		expect(vi.getTimerCount()).toBe(0);

		const turnDone = harness.submitInput("Audit src/entry.ts and show the helper");
		const stream1 = await streamQueue.nextStream();
		const tStart = Date.now();
		const thinkingBlock = {
			type: "thinking" as const,
			thinking: "Checking bundle tree\nVerifying tree-shaking boundaries",
		};
		const partialThinking = makeStreamMessage([thinkingBlock], { timestamp: tStart });
		stream1.push({ type: "start", partial: makeStreamMessage([], { timestamp: tStart }) });
		stream1.push({ type: "thinking_start", contentIndex: 0, partial: partialThinking });
		stream1.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: thinkingBlock.thinking,
			partial: partialThinking,
		});
		await harness.flush();

		expect(vi.getTimerCount()).toBe(1);
		const spineRgbFrame0 = findRowGlyphRgb(harness, "Thinking…", "┃");
		const workingRgbFrame0 = findRowGlyphRgb(harness, "Working", "◆");
		expect(spineRgbFrame0).toBeDefined();
		expect(workingRgbFrame0).toBeDefined();

		vi.advanceTimersByTime(33 * 6);
		harness.flushFrame();
		const spineRgbFrame1 = findRowGlyphRgb(harness, "Thinking…", "┃");
		const workingRgbFrame1 = findRowGlyphRgb(harness, "Working", "◆");
		expect(spineRgbFrame1).not.toEqual(spineRgbFrame0);
		expect(workingRgbFrame1).not.toEqual(workingRgbFrame0);

		vi.advanceTimersByTime(2200);
		const toolCallBlock = {
			type: "toolCall" as const,
			id: "call-bundle-1",
			name: "inspect_bundle",
			arguments: { entry: "src/entry.ts" },
		};
		const step1Msg = makeStreamMessage([thinkingBlock, toolCallBlock], {
			stopReason: "toolUse",
			timestamp: tStart,
		});
		stream1.push({
			type: "thinking_end",
			contentIndex: 0,
			content: thinkingBlock.thinking,
			partial: step1Msg,
		});
		stream1.push({ type: "toolcall_start", contentIndex: 1, partial: step1Msg });
		stream1.push({
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: toolCallBlock,
			partial: step1Msg,
		});
		stream1.push({ type: "done", reason: "toolUse", message: step1Msg });
		stream1.end(step1Msg);

		await harness.flush();

		const toolDiamondBefore = findRowGlyphRgb(harness, "inspect_bundle", "◆");
		expect(toolDiamondBefore).toBeDefined();
		vi.advanceTimersByTime(33 * 6);
		harness.flushFrame();
		const toolDiamondAfter = findRowGlyphRgb(harness, "inspect_bundle", "◆");
		expect(toolDiamondAfter).toBeDefined();
		expect(toolDiamondAfter).not.toEqual(toolDiamondBefore);

		releaseTool();
		const stream2 = await streamQueue.nextStream();
		const mdReply = [
			"## Bundle Summary",
			"",
			"Everything tree-shakes cleanly:",
			"",
			"```ts",
			"export const bundleAnswer = 42;",
			"```",
		].join("\n");
		const step2Msg = makeStreamMessage([{ type: "text", text: mdReply }]);
		stream2.push({ type: "start", partial: step2Msg });
		stream2.push({ type: "text_start", contentIndex: 0, partial: step2Msg });
		stream2.push({ type: "text_delta", contentIndex: 0, delta: mdReply, partial: step2Msg });
		stream2.push({ type: "text_end", contentIndex: 0, content: mdReply, partial: step2Msg });
		stream2.push({ type: "done", reason: "stop", message: step2Msg });
		stream2.end(step2Msg);

		await turnDone;
		vi.runOnlyPendingTimers();
		expect(vi.getTimerCount()).toBe(0);

		const settledText = harness.screen().text();
		expect(settledText).toContain("› Audit src/entry.ts and show the helper");
		expect(settledText).toContain("14:35");
		expect(settledText).toContain("Thought for 2s");
		expect(settledText).not.toContain("Verifying tree-shaking boundaries");
		expect(settledText).toContain("Bundle Summary");
		expect(settledText).toContain("export const bundleAnswer = 42;");

		const collapsedHit = harness.screen().findText("Thought for 2s");
		expect(collapsedHit).toBeDefined();
		await harness.mouseClick(collapsedHit!.col + 2, collapsedHit!.row);
		expect(harness.screen().text()).toContain("Verifying tree-shaking boundaries");

		const expandedHit = harness.screen().findText("Thought for 2s");
		expect(expandedHit).toBeDefined();
		await harness.mouseClick(expandedHit!.col + 2, expandedHit!.row);
		expect(harness.screen().text()).not.toContain("Verifying tree-shaking boundaries");
		expect(harness.screen().text()).not.toContain("Quote");

		const promptHit = harness.screen().findText("› Audit src/entry.ts and show the helper");
		expect(promptHit).toBeDefined();
		await harness.mouseMove(promptHit!.col + 4, promptHit!.row);
		const hoveredPromptScreen = harness.screen();
		expect(hoveredPromptScreen.rowText(promptHit!.row - 1)).toContain("Copy");
		const promptCopyPos = hoveredPromptScreen.findText("Copy");
		expect(promptCopyPos).toBeDefined();
		await harness.mouseClick(promptCopyPos!.col + 1, promptCopyPos!.row);
		expect(harness.screen().rowText(promptHit!.row - 1)).toContain("Copied");
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(
			"Audit src/entry.ts and show the helper",
		);

		harness.setTheme("light");
		const codeLineHit = harness.screen().findText("export const bundleAnswer = 42;");
		expect(codeLineHit).toBeDefined();
		const codeHeaderRow = codeLineHit!.row - 1;
		await harness.mouseMove(codeLineHit!.col + 2, codeHeaderRow);

		const hoveredCodeScreen = harness.screen();
		const headerCell = hoveredCodeScreen.cellAt(codeHeaderRow, codeLineHit!.col);
		expect(headerCell?.bg.kind).toBe("rgb");
		if (headerCell?.bg.kind === "rgb") {
			expect(luminance(headerCell.bg.r, headerCell.bg.g, headerCell.bg.b)).toBeGreaterThan(170);
		}

		const codeCopyCol = hoveredCodeScreen.rowText(codeHeaderRow).lastIndexOf("Copy");
		expect(codeCopyCol).toBeGreaterThan(10);
		await harness.mouseClick(codeCopyCol + 1, codeHeaderRow);
		expect(harness.screen().rowText(codeHeaderRow)).toContain("Copied");
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(
			"export const bundleAnswer = 42;",
		);

		await harness.dispose();
		harness = undefined;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("coordinates Sticky Prompt, Outline Rail, mouse-selection & Alt+Q quoting, paste/image/quote Prompt Chips, and Prompt Suggestion workflows", async () => {
		const sharedAgentDir = allocateTempDir("pi-ui-e2e-agent-");
		writeFileSync(
			join(sharedAgentDir, "pi-ui.json"),
			`${JSON.stringify({ promptSuggestions: true }, null, 2)}\n`,
			"utf8",
		);
		const buildReply = (tag: string, count: number) =>
			Array.from({ length: count }, (_, idx) => `${tag} line ${idx + 1}: cache invalidation detail`).join(
				"\n",
			);

		harness = await createInteractiveHarness({
			agentDir: sharedAgentDir,
			theme: "dark",
			width: 104,
			height: 26,
			clipboard: {
				image: { bytes: TINY_PNG_BYTES, mimeType: "image/png" },
				text: "Clipboard fallback snippet",
				filePaths: null,
			},
			responses: [
				fauxAssistantMessage(buildReply("TurnAlpha", 14)),
				fauxAssistantMessage(
					`${buildReply("TurnBeta", 10)}\nQuotable line one\nQuotable line two`,
				),
				fauxAssistantMessage(buildReply("TurnGamma", 24)),
				fauxAssistantMessage("Accepted suggestion executed."),
				fauxAssistantMessage("Final turn done."),
			],
			suggestionResponses: [
				fauxAssistantMessage(""),
				fauxAssistantMessage(""),
				fauxAssistantMessage("Запусти бенчмарк парсера"),
				fauxAssistantMessage("Проверь покрытие веток"),
				fauxAssistantMessage("Собери релизный архив"),
			],
		});

		await harness.submitInput("Design Turn One cache strategy");
		await harness.submitInput("Refine Turn Two eviction rules");

		await harness.mouseWheel("up", 30, 10, 5);
		const scrolledTopScreen = harness.screen();
		const topChromeRows = [1, 2, 3].map((r) => scrolledTopScreen.rowText(r)).join("\n");
		expect(topChromeRows).toContain("› Design Turn One cache strategy");

		const railColStart = harness.width - 3;
		const railColEnd = harness.width - 1;
		let secondTickRow = -1;
		const tickRows: number[] = [];
		for (let r = 0; r < harness.height - 6; r += 1) {
			const slice = scrolledTopScreen.sliceText(r, railColStart, railColEnd);
			if (slice === " ─" || slice === "──") {
				tickRows.push(r);
			}
		}
		expect(tickRows.length).toBeGreaterThanOrEqual(2);
		secondTickRow = tickRows[1]!;

		await harness.mouseMove(railColStart + 1, secondTickRow);
		expect(harness.screen().text()).toContain("Refine Turn Two eviction rules");

		await harness.mouseClick(railColStart + 1, secondTickRow);
		await harness.mouseMove(4, 12);

		await harness.mouseWheel("down", 30, 10, 12);
		const quoteLine1 = harness.screen().findText("Quotable line one");
		const quoteLine2 = harness.screen().findText("Quotable line two");
		expect(quoteLine1).toBeDefined();
		expect(quoteLine2).toBeDefined();

		await harness.mouseDrag(
			quoteLine1!.col,
			quoteLine1!.row,
			quoteLine2!.col + "Quotable line two".length,
			quoteLine2!.row,
			{ steps: 3 },
		);
		const popupPos = harness.screen().findText("Quote");
		expect(popupPos).toBeDefined();
		expect(harness.screen().cellAt(popupPos!.row, popupPos!.col)?.inverse).toBe(false);

		await harness.mouseClick(popupPos!.col + 2, popupPos!.row);
		await flushUiAsync(harness);

		const editor = getActiveComposerEditor()!;
		expect(editor.getText()).toBe("[❝ Quote #1 · 2 lines]");

		await harness.typeText(" ");
		await harness.pressKey("\x1bq");
		await flushUiAsync(harness);

		await harness.typeText(" ");
		await harness.paste("log-line-1\nlog-line-2\nlog-line-3\nlog-line-4", true);

		await harness.typeText(" ");
		await harness.pressKey("\x16");
		await flushUiAsync(harness);

		expect(editor.getText()).toBe(
			"[❝ Quote #1 · 2 lines] [❝ Quote #2 · 1 line] [📋 Pasted #3 · 4 lines] [🖼 Image #4]",
		);

		const draftPastePos = harness.screen().findText("[📋 Pasted #3 · 4 lines]");
		expect(draftPastePos).toBeDefined();
		await harness.mouseMove(draftPastePos!.col + 3, draftPastePos!.row);
		expect(harness.screen().text()).toContain("log-line-1");
		await harness.mouseMove(2, 2);

		await harness.submitDraft();
		const chipCall = harness.calls[2]!;
		const serializedChipTurn = JSON.stringify(chipCall.messages.at(-1));
		expect(serializedChipTurn).toContain("> Quotable line one");
		expect(serializedChipTurn).toContain("> Clipboard fallback snippet");
		expect(serializedChipTurn).toContain("log-line-4");
		expect(serializedChipTurn).toContain('"type":"image"');

		await harness.mouseWheel("up", 30, 10, 2);
		const stickyBand = [1, 2, 3].map((r) => harness!.screen().rowText(r)).join("\n");
		expect(stickyBand).toContain("[📋 Pasted #3 · 4 lines]");
		expect(stickyBand).not.toContain("log-line-4");
		await harness.mouseWheel("down", 30, 10, 6);

		await waitForCondition(() => harness!.screen().text().includes("Запусти бенчмарк парсера"));
		await harness.pressKey("\t");
		expect(editor.getText()).toBe("Запусти бенчмарк парсера");

		await harness.pressKey("\x1a");
		expect(editor.getText()).toBe("");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);

		await harness.submitInput("Trigger next prediction");
		await waitForCondition(() => harness!.screen().text().includes("Проверь покрытие веток"));
		await harness.pressKey("\x1b[C");
		expect(editor.getText()).toBe("Проверь покрытие веток");
		await harness.submitDraft();
		expect(harness.screen().text()).toContain("Final turn done.");

		await waitForCondition(() => harness!.screen().text().includes("Собери релизный архив"));
		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("Собери релизный архив");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);

		await harness.submitInput("/suggestions off");
		const persistedConfig = JSON.parse(
			readFileSync(join(sharedAgentDir, "pi-ui.json"), "utf8"),
		) as { promptSuggestions?: boolean };
		expect(persistedConfig.promptSuggestions).toBe(false);
	});

	it("exercises Tool Density presets & exploration grouping, Command Palette (Ctrl+K), ask_user_question questionnaire, and Plan Approval / Permission Prompt preflight confirmations", async () => {
		const projectDir = allocateTempDir("pi-ui-e2e-project-");
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(
			join(projectDir, "src", "service.ts"),
			"export const timeoutMs = 1000;\n",
			"utf8",
		);
		writeFileSync(
			join(projectDir, "src", "notes.md"),
			"serviceConfigMarker\n",
			"utf8",
		);

		harness = await createInteractiveHarness({
			cwd: projectDir,
			theme: "dark",
			width: 112,
			height: 36,
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("read", { path: "src/service.ts" }, { id: "exp-r1" }),
						fauxToolCall("read", { path: "src/notes.md" }, { id: "exp-r2" }),
						fauxToolCall(
							"bash",
							{ command: "grep -rn 'serviceConfigMarker' src" },
							{ id: "exp-s1" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"edit",
							{
								path: "src/service.ts",
								edits: [{ oldText: "1000", newText: "2500" }],
							},
							{ id: "dens-edit" },
						),
						fauxToolCall(
							"bash",
							{
								command:
									"printf 'out-1\\nout-2\\nout-3\\nout-4\\nout-5\\nout-6\\nout-7\\n'",
							},
							{ id: "dens-bash" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Updated timeout and ran diagnostics."),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"ask_user_question",
							{
								questions: [
									{
										header: "Target",
										question: "Select rollout environment",
										options: [
											{ label: "Staging", description: "Pre-prod cluster" },
											{ label: "Production", description: "Primary cluster" },
										],
									},
								],
							},
							{ id: "e2e-ask" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Rollout target recorded."),
				fauxAssistantMessage(
					[
						fauxToolCall("bash", { command: "ls src" }, { id: "plan-ro-bash" }),
						fauxToolCall(
							"bash",
							{ command: "echo forbidden > src/mutated.txt" },
							{ id: "plan-mut-bash" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("# Plan\n1. Increase timeout safely\n2. Verify healthchecks"),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"edit",
							{
								path: "src/service.ts",
								edits: [{ oldText: "2500", newText: "5000" }],
							},
							{ id: "safe-edit-1" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"bash",
							{ command: "rm -f src/notes.md" },
							{ id: "safe-bash-deny" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Auto-Safe governance complete."),
			],
		});

		await harness.submitInput("Inspect and update service timeout");
		const detailedText = harness.screen().text();
		expect(detailedText).toContain("◆ Explored 2 files, 1 search");
		expect(detailedText).not.toContain("◆ Read src/service.ts");
		expect(detailedText).toContain("◆ Edited src/service.ts");
		expect(detailedText).toContain("-export const timeoutMs = 1000;");
		expect(detailedText).toContain("+export const timeoutMs = 2500;");
		expect(detailedText).toContain("│ out-1");
		expect(detailedText).toContain("│ …");
		expect(detailedText).toContain("│ out-7");
		expect(detailedText).not.toContain("│ out-4");

		const exploredPos = harness.screen().findText("◆ Explored 2 files, 1 search");
		expect(exploredPos).toBeDefined();
		await harness.mouseClick(exploredPos!.col + 2, exploredPos!.row);
		expect(harness.screen().text()).toContain("◆ Read src/service.ts");
		const exploredOpenPos = harness.screen().findText("◆ Explored 2 files, 1 search");
		await harness.mouseClick(exploredOpenPos!.col + 2, exploredOpenPos!.row);
		expect(harness.screen().text()).not.toContain("◆ Read src/service.ts");

		await harness.submitInput("/density diff-focus");
		const diffFocusText = harness.screen().text();
		expect(diffFocusText).toContain("+export const timeoutMs = 2500;");
		expect(diffFocusText).not.toContain("│ out-7");

		await harness.submitInput("/density compact");
		const compactText = harness.screen().text();
		expect(compactText).toContain("◆ Edited src/service.ts");
		expect(compactText).not.toContain("+export const timeoutMs = 2500;");
		expect(compactText).not.toContain("│ out-7");

		await harness.submitInput("/density detailed");
		expect(harness.screen().text()).toContain("+export const timeoutMs = 2500;");

		const askPromise = harness.submitInput("Ask me where to deploy");
		await waitForCondition(() => harness!.screen().text().includes("Select rollout environment"));
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.pressKey("\x1b[B");
		/* Выдерживаем 400мс окно защиты от случайного type-ahead перед Enter */
		await new Promise<void>((resolve) => setTimeout(resolve, 420));
		await harness.pressKey("\r");
		await askPromise;
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		const askResultMsg = findToolResult(harness, "e2e-ask");
		expect(askResultMsg).toBeDefined();
		expect(JSON.parse(contentText(askResultMsg!.content))).toMatchObject({
			cancelled: false,
			answers: [{ selected: ["Production"] }],
		});

		await harness.pressKey("\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("⌘ Command Palette");
		await harness.typeText("Plan Mode");
		await harness.pressKey("\r");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(harness.session.getActiveToolNames()).not.toContain("edit");
		expect(harness.session.getActiveToolNames()).not.toContain("write");

		const suggestionCallsBeforePlan = harness.suggestionCalls.length;
		await harness.submitInput("Draft rollout plan");
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(existsSync(join(projectDir, "src", "mutated.txt"))).toBe(false);
		const roBashRes = findToolResult(harness, "plan-ro-bash");
		const mutBashRes = findToolResult(harness, "plan-mut-bash");
		expect(roBashRes?.isError).toBe(false);
		expect(mutBashRes?.isError).toBe(true);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Plan Studio");
		expect(harness.suggestionCalls).toHaveLength(suggestionCallsBeforePlan);

		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await harness.submitInput("/mode auto");
		expect(harness.session.getActiveToolNames()).toContain("edit");

		const safePromise = harness.submitInput("Apply governed changes");
		await waitForCondition(() => harness!.screen().text().includes("Auto Permission"));
		expect(harness.screen().text()).toContain("src/service.ts");
		await harness.pressKey("\r");

		await waitForCondition(() => harness!.screen().text().includes("rm -f src/notes.md"));
		expect(readFileSync(join(projectDir, "src", "service.ts"), "utf8")).toBe(
			"export const timeoutMs = 5000;\n",
		);
		await harness.pressKey("\x1b");

		await safePromise;
		expect(existsSync(join(projectDir, "src", "notes.md"))).toBe(true);
		expect(harness.screen().text()).toContain("Auto-Safe governance complete.");
	});

	it("preserves state, chrome compositing, quoting, shortcuts, and Prompt Suggestions across live fullscreen <-> regular TUI switches and /reload", async () => {
		const buildBlock = (prefix: string, lines: number) =>
			Array.from({ length: lines }, (_, i) => `${prefix} row ${i + 1}: durable session content`).join(
				"\n",
			);

		harness = await createInteractiveHarness({
			persistSession: true,
			theme: "dark",
			width: 108,
			height: 28,
			responses: [
				fauxAssistantMessage(buildBlock("ReloadTurn1", 16)),
				fauxAssistantMessage(
					`${buildBlock("ReloadTurn2", 12)}\nSelectable across mode switch`,
				),
				fauxAssistantMessage("Regular mode turn succeeded."),
				fauxAssistantMessage("Post-reload turn succeeded."),
			],
			suggestionResponses: [
				fauxAssistantMessage("Продолжи после перезагрузки"),
			],
		});

		const runtime = getActiveHostRuntime()!;
		const firstAltRenderer = unwrapHostTui(harness.tui);
		expect(firstAltRenderer).toBeInstanceOf(TuiAltScreen);
		expect(runtime.isFullscreen).toBe(true);

		await harness.typeText("Inspect ");
		await harness.paste("persist-log-1\npersist-log-2\npersist-log-3\npersist-log-4", true);
		await harness.submitDraft();
		await harness.submitInput("Prepare second turn");

		await harness.pressKey("\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("⌘ Command Palette");
		expect(await harness.setTuiMode("regular")).toBe(false);
		expect(runtime.isFullscreen).toBe(true);
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		const targetBeforeSwitch = harness.screen().findText("Selectable across mode switch");
		expect(targetBeforeSwitch).toBeDefined();
		await harness.mouseDrag(
			targetBeforeSwitch!.col,
			targetBeforeSwitch!.row,
			targetBeforeSwitch!.col + "Selectable across mode switch".length,
			targetBeforeSwitch!.row,
			{ steps: 3 },
		);
		expect(harness.screen().text()).toContain("Quote");

		expect(await harness.setTuiMode("regular")).toBe(true);
		expect(runtime.isFullscreen).toBe(false);
		expect(runtime.scroll).toBeUndefined();
		expect(runtime.viewportSlots).toBeUndefined();

		await harness.submitInput("Turn while in regular mode");
		expect(harness.screen().text()).toContain("Regular mode turn succeeded.");

		await harness.submitInput("/mode plan");
		expect(harness.session.getActiveToolNames()).not.toContain("edit");

		expect(await harness.setTuiMode("fullscreen")).toBe(true);
		const secondAltRenderer = unwrapHostTui(harness.tui);
		expect(secondAltRenderer).toBeInstanceOf(TuiAltScreen);
		expect(secondAltRenderer).not.toBe(firstAltRenderer);
		expect(runtime.isFullscreen).toBe(true);
		expect(runtime.scroll).toBeInstanceOf(ScrollView);
		expect(runtime.viewportSlots?.topSlot).toBeDefined();
		expect(runtime.viewportSlots?.rightRail).toBeDefined();

		const railStart = harness.width - 3;
		const railEnd = harness.width - 1;
		const hasRailAfterSwitch = Array.from({ length: harness.height - 6 }, (_, r) =>
			harness!.screen().sliceText(r, railStart, railEnd),
		).some((s) => /[▲▼─]/.test(s));
		expect(hasRailAfterSwitch).toBe(true);

		const targetAfterSwitch = harness.screen().findText("Selectable across mode switch");
		expect(targetAfterSwitch).toBeDefined();
		await harness.mouseDrag(
			targetAfterSwitch!.col,
			targetAfterSwitch!.row,
			targetAfterSwitch!.col + "Selectable across mode switch".length,
			targetAfterSwitch!.row,
			{ steps: 3 },
		);
		const quotePopupAfterSwitch = harness.screen().findText("Quote");
		expect(quotePopupAfterSwitch).toBeDefined();
		await harness.mouseClick(quotePopupAfterSwitch!.col + 2, quotePopupAfterSwitch!.row);
		await flushUiAsync(harness);
		expect(getActiveComposerEditor()!.getText()).toBe("[❝ Quote #1 · 1 line]");
		getActiveComposerEditor()!.setText("");

		const altProto = TuiAltScreen.prototype as unknown as { handleMouseEvent: unknown };
		const altMouseBeforeReload = altProto.handleMouseEvent;
		const userRenderBeforeReload = UserMessageComponent.prototype.render;
		const assistantUpdateBeforeReload = AssistantMessageComponent.prototype.updateContent;

		await harness.reload();

		expect(altProto.handleMouseEvent).toBe(altMouseBeforeReload);
		expect(UserMessageComponent.prototype.render).toBe(userRenderBeforeReload);
		expect(AssistantMessageComponent.prototype.updateContent).toBe(assistantUpdateBeforeReload);

		expect(harness.session.getActiveToolNames()).not.toContain("edit");

		await harness.mouseWheel("up", 30, 10, 10);
		const topAfterReload = [1, 2, 3].map((r) => harness!.screen().rowText(r)).join("\n");
		expect(topAfterReload).toContain("Inspect [📋 Pasted #1 · 4 lines]");
		expect(topAfterReload).not.toContain("persist-log-4");
		await harness.mouseWheel("down", 30, 10, 14);

		await harness.pressKey("\x0b");
		expect(harness.screen().text()).toContain("⌘ Command Palette");
		await harness.pressKey("\x1b");

		await harness.submitInput("/suggestions on");
		await harness.submitInput("/mode always-approve");
		expect(harness.session.getActiveToolNames()).toContain("edit");
		await harness.submitInput("Verify post-reload turn");
		expect(harness.screen().text()).toContain("Post-reload turn succeeded.");

		await waitForCondition(() =>
			harness!.screen().text().includes("Продолжи после перезагрузки"),
		);
		await harness.pressKey("\t");
		expect(getActiveComposerEditor()!.getText()).toBe("Продолжи после перезагрузки");
	});

	it("renders markdown headings, code cards, and Copy badges with 256color ANSI sequences when trueColor is disabled", async () => {
		harness = await createInteractiveHarness({
			theme: "light",
			trueColor: false,
			width: 96,
			height: 28,
			responses: [
				fauxAssistantMessage(
					"### Heading Three\n#### Heading Four\n\n```ts\nexport const answer = 42;\n```",
				),
			],
		});

		await harness.submitInput("Show 256color card");
		const headingHit = harness.screen().findText("Heading Three");
		const codeHeaderHit = harness.screen().findText("ts");
		expect(headingHit).toBeDefined();
		expect(codeHeaderHit).toBeDefined();

		await harness.mouseMove(codeHeaderHit!.col + 1, codeHeaderHit!.row);
		const hoveredFrame = harness.renderFrame();
		const headingAnsi = hoveredFrame[headingHit!.row] ?? "";
		const codeHeaderAnsi = hoveredFrame[codeHeaderHit!.row] ?? "";
		expect(headingAnsi).toContain("\x1b[38;5;");
		expect(headingAnsi).not.toContain("\x1b[38;2;");
		expect(codeHeaderAnsi).toContain("\x1b[48;5;");
		expect(codeHeaderAnsi).toContain("\x1b[38;5;");
		expect(codeHeaderAnsi).not.toContain("\x1b[48;2;");
		expect(codeHeaderAnsi).not.toContain("\x1b[38;2;");
	});
});
