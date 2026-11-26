import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPOSER_PLACEHOLDER } from "../src/features/chrome/composer.ts";
import {
	isSupersededExternalSuggestionExtension,
	MAX_PROMPT_SUGGESTION_LENGTH,
	sanitizePromptSuggestion,
} from "../src/features/prompt-suggestion/index.ts";
import { hasBlockingModalOverlay, registerBlockingDialog } from "../src/shared/modal-card.ts";
import {
	DEFAULT_PI_UI_USER_CONFIG,
	getPiUiConfigPath,
	loadPiUiUserConfig,
	updatePiUiUserConfig,
} from "../src/shared/pi-ui-config.ts";
import {
	createInteractiveHarness,
	DEFAULT_EXTENSION_ENTRY,
	fauxAssistantMessage,
	fauxThinking,
	type InteractiveHarness,
} from "./harness/index.ts";

async function waitForCondition(
	predicate: () => boolean,
	timeoutMs = 1500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

describe("Prompt Suggestion (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function allocateTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	function allocateEnabledAgentDir(prefix = "pi-ui-sug-enabled-"): string {
		const dir = allocateTempDir(prefix);
		writeFileSync(
			join(dir, "pi-ui.json"),
			`${JSON.stringify({ promptSuggestions: true }, null, 2)}\n`,
			"utf8",
		);
		return dir;
	}

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("persists /suggestions on, off, and no-arg toggle in agentDir/pi-ui.json across InteractiveMode restarts", async () => {
		const sharedAgentDir = allocateTempDir("pi-ui-sug-persist-");
		const configFile = join(sharedAgentDir, "pi-ui.json");

		harness = await createInteractiveHarness({
			agentDir: sharedAgentDir,
			width: 100,
			height: 28,
		});
		expect(existsSync(configFile)).toBe(false);

		await harness.submitInput("/suggestions off");
		expect(JSON.parse(readFileSync(configFile, "utf8"))).toMatchObject({
			promptSuggestions: false,
		});

		await harness.dispose();
		harness = undefined;

		harness = await createInteractiveHarness({
			agentDir: sharedAgentDir,
			width: 100,
			height: 28,
		});
		await harness.submitInput("/suggestions");
		expect(JSON.parse(readFileSync(configFile, "utf8"))).toMatchObject({
			promptSuggestions: true,
		});

		await harness.submitInput("/suggestions");
		expect(JSON.parse(readFileSync(configFile, "utf8"))).toMatchObject({
			promptSuggestions: false,
		});

		await harness.submitInput("/suggestions on");
		expect(JSON.parse(readFileSync(configFile, "utf8"))).toMatchObject({
			promptSuggestions: true,
		});

		await harness.typeText("/suggestions ");
		const completionText = harness.screen().text();
		expect(completionText).toContain("on");
		expect(completionText).toContain("off");
		expect(completionText).not.toContain("status");
		await harness.pressKey("\x15");

		await harness.submitInput("/suggestions status");
		expect(harness.screen().text()).toContain("Usage: /suggestions [on|off]");
	});

	it("disabling Prompt Suggestions in the Command Palette revokes the live token opt-in", async () => {
		const agentDir = allocateEnabledAgentDir();
		harness = await createInteractiveHarness({
			agentDir,
			width: 100,
			height: 28,
			responses: [fauxAssistantMessage("Reply after opting out.")],
			suggestionResponses: [fauxAssistantMessage("Should not run")],
		});

		await harness.pressKey("\x0b");
		await harness.typeText("disable prompt suggestions");
		expect(harness.screen().text()).toContain("Prompt Suggestion: disable");
		await harness.pressKey("\r");
		expect(loadPiUiUserConfig().promptSuggestions).toBe(false);
		await harness.submitInput("No background work please");
		await harness.flush();
		expect(harness.suggestionCalls).toHaveLength(0);
	});

	it("fires zero background Prompt Suggestion calls on fresh installs without explicit opt-in", async () => {
		harness = await createInteractiveHarness({
			width: 90,
			height: 26,
			responses: [fauxAssistantMessage("Fresh install reply.")],
			suggestionResponses: [fauxAssistantMessage("Should not run")],
		});

		await harness.submitInput("Hello fresh install");
		await new Promise<void>((resolve) => setTimeout(resolve, 35));
		expect(harness.calls).toHaveLength(1);
		expect(harness.suggestionCalls).toHaveLength(0);
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);
		expect(harness.screen().text()).not.toContain("Should not run");
	});

	it("predicts Prompt Suggestion in background reusing prompt-cache prefix, renders dimmed inside rounded composer frame with narrow truncation, and never keeps working indicator active", async () => {
		let releasePrediction!: () => void;
		const predictionGate = new Promise<void>((resolve) => {
			releasePrediction = resolve;
		});

		harness = await createInteractiveHarness({
			agentDir: allocateEnabledAgentDir(),
			width: 84,
			height: 26,
			thinkingLevel: "high",
			responses: [
				fauxAssistantMessage([
					fauxThinking("Inspecting test suite structure"),
					{ type: "text", text: "Готово, я обновил модуль composer.ts." },
				]),
				fauxAssistantMessage("Ок, проверил."),
			],
			suggestionResponses: [
				async () => {
					await predictionGate;
					return fauxAssistantMessage(
						'"Запусти полный набор интеграционных тестов и проверь отчёт покрытия"',
					);
				},
				fauxAssistantMessage("Короткая подсказка"),
			],
		});

		const startupScreen = harness.screen();
		const placeholderHit = startupScreen.findText(COMPOSER_PLACEHOLDER);
		expect(placeholderHit).toBeDefined();
		const dimFgColor = startupScreen.cellAt(placeholderHit!.row, placeholderHit!.col + 1)?.fg;
		expect(dimFgColor).toBeDefined();

		await harness.submitInput("Обнови composer.ts");

		expect(harness.session.isStreaming).toBe(false);
		expect(harness.calls).toHaveLength(1);
		expect(harness.suggestionCalls).toHaveLength(1);
		const midFlightText = harness.screen().text();
		expect(midFlightText).toContain(COMPOSER_PLACEHOLDER);
		expect(midFlightText).not.toContain("Thinking");

		const mainTurnCall = harness.calls[0]!;
		const suggestionCall = harness.suggestionCalls[0]!;
		expect(suggestionCall.model.id).toBe(mainTurnCall.model.id);
		expect(suggestionCall.options?.sessionId).toBe(harness.sessionManager.getSessionId());
		expect(suggestionCall.options?.reasoning).toBe("high");
		expect(suggestionCall.messages.length).toBe(mainTurnCall.messages.length + 2);
		expect(suggestionCall.messages.slice(0, mainTurnCall.messages.length)).toEqual(
			mainTurnCall.messages,
		);
		expect(suggestionCall.messages.at(-2)?.role).toBe("assistant");
		expect(JSON.stringify(suggestionCall.messages.at(-2))).toContain(
			"Готово, я обновил модуль composer.ts.",
		);
		expect(suggestionCall.messages.at(-1)?.role).toBe("user");

		releasePrediction();
		await waitForCondition(() =>
			harness!.screen().text().includes("Запусти полный набор интеграционных тестов"),
		);

		const readyScreen = harness.screen();
		expect(readyScreen.text()).not.toContain(COMPOSER_PLACEHOLDER);
		const sugHit = readyScreen.findText("Запусти полный набор");
		expect(sugHit).toBeDefined();
		expect(readyScreen.cellAt(sugHit!.row, 2)?.char).toBe("│");
		expect(readyScreen.cellAt(sugHit!.row, readyScreen.width - 3)?.char).toBe("│");
		expect(readyScreen.cellAt(sugHit!.row, sugHit!.col + 1)?.fg).toEqual(dimFgColor);

		await harness.resize(44, 26);
		const narrowScreen = harness.screen();
		const narrowHit = narrowScreen.findText("Запусти полный");
		expect(narrowHit).toBeDefined();
		const narrowRow = narrowScreen.rowText(narrowHit!.row);
		expect(narrowRow.startsWith("  │ › Запусти")).toBe(true);
		expect(narrowRow.endsWith("… │  ")).toBe(true);
		expect(narrowScreen.cellAt(narrowHit!.row, narrowScreen.width - 3)?.char).toBe("│");

		harness.session.setThinkingLevel("off");
		await harness.resize(84, 26);
		await harness.submitInput("Ещё один шаг");
		await waitForCondition(() => harness!.suggestionCalls.length >= 2);
		expect(harness.suggestionCalls[1]?.options?.reasoning).toBeUndefined();
	});

	it("silently ignores errored, multiline, empty, sentinel, and >100-char prediction responses without error toasts", async () => {
		harness = await createInteractiveHarness({
			agentDir: allocateEnabledAgentDir(),
			width: 90,
			height: 26,
			responses: [
				fauxAssistantMessage("Ответ 1"),
				fauxAssistantMessage("Ответ 2"),
				fauxAssistantMessage("Ответ 3"),
				fauxAssistantMessage("Ответ 4"),
			],
			suggestionResponses: [
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit 429" }),
				fauxAssistantMessage("Первая строка\nВторая строка"),
				fauxAssistantMessage("x".repeat(105)),
				fauxAssistantMessage("nothing"),
			],
		});

		for (const prompt of ["Шаг 1", "Шаг 2", "Шаг 3", "Шаг 4"]) {
			await harness.submitInput(prompt);
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			const frameText = harness.screen().text();
			expect(frameText).toContain(COMPOSER_PLACEHOLDER);
			expect(frameText).not.toContain("rate limit 429");
			expect(frameText).not.toContain("Первая строка");
			expect(frameText).not.toContain("xxxxx");
		}
		expect(harness.calls).toHaveLength(4);
		expect(harness.suggestionCalls).toHaveLength(4);
	});

	it("aborts in-flight prediction and clears stale suggestions on new user submission, /suggestions off, session_tree, and session_compact", async () => {
		let releaseFirstPrediction!: () => void;
		const firstPredictionGate = new Promise<void>((resolve) => {
			releaseFirstPrediction = resolve;
		});
		let releaseThirdPrediction!: () => void;
		const thirdPredictionGate = new Promise<void>((resolve) => {
			releaseThirdPrediction = resolve;
		});

		harness = await createInteractiveHarness({
			agentDir: allocateEnabledAgentDir(),
			width: 90,
			height: 26,
			settings: {
				compaction: { enabled: false, keepRecentTokens: 1 },
			},
			responses: [
				fauxAssistantMessage("Ответ A"),
				fauxAssistantMessage("Ответ B"),
				fauxAssistantMessage("Ответ C"),
				fauxAssistantMessage("Ответ D"),
				fauxAssistantMessage("Ответ E"),
				fauxAssistantMessage("Сводка после компакта"),
				fauxAssistantMessage("Ответ F"),
			],
			suggestionResponses: [
				async () => {
					await firstPredictionGate;
					return fauxAssistantMessage("Устаревшая подсказка A");
				},
				fauxAssistantMessage("Актуальная подсказка B"),
				async () => {
					await thirdPredictionGate;
					return fauxAssistantMessage("Отменённая подсказка C");
				},
				fauxAssistantMessage("Подсказка D для дерева"),
				fauxAssistantMessage("Подсказка E до компакта"),
				fauxAssistantMessage("Подсказка F до bash"),
			],
		});

		await harness.submitInput("Ход A");
		expect(harness.calls).toHaveLength(1);
		expect(harness.suggestionCalls).toHaveLength(1);
		const firstSuggestionCall = harness.suggestionCalls[0]!;
		expect(firstSuggestionCall.signal?.aborted).toBe(false);

		await harness.submitInput("Ход B");
		expect(firstSuggestionCall.signal?.aborted).toBe(true);
		expect(firstSuggestionCall.aborted).toBe(true);

		releaseFirstPrediction();
		await waitForCondition(() =>
			harness!.screen().text().includes("Актуальная подсказка B"),
		);
		expect(harness.screen().text()).not.toContain("Устаревшая подсказка A");

		await harness.submitInput("/suggestions off");
		expect(harness.screen().text()).not.toContain("Актуальная подсказка B");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);

		await harness.submitInput("/suggestions on");
		await harness.submitInput("Ход C");
		const thirdSuggestionCall = harness.suggestionCalls[2]!;
		expect(thirdSuggestionCall.signal?.aborted).toBe(false);

		await harness.submitInput("/suggestions off");
		expect(thirdSuggestionCall.signal?.aborted).toBe(true);
		releaseThirdPrediction();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(harness.screen().text()).not.toContain("Отменённая подсказка C");

		await harness.submitInput("/suggestions on");
		await harness.submitInput("Ход D");
		await waitForCondition(() =>
			harness!.screen().text().includes("Подсказка D для дерева"),
		);

		const entries = harness.sessionManager.getEntries();
		const firstUserEntry = entries.find(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		expect(firstUserEntry).toBeDefined();
		await harness.session.navigateTree(firstUserEntry!.id, { summarize: false });
		harness.flushFrame();
		expect(harness.screen().text()).not.toContain("Подсказка D для дерева");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);

		await harness.submitInput("Ход E");
		await waitForCondition(() =>
			harness!.screen().text().includes("Подсказка E до компакта"),
		);
		await harness.session.compact();
		harness.flushFrame();
		expect(harness.screen().text()).not.toContain("Подсказка E до компакта");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);

		await harness.submitInput("Ход F");
		await waitForCondition(() =>
			harness!.screen().text().includes("Подсказка F до bash"),
		);
		await harness.submitInput("!echo ok");
		expect(harness.screen().text()).not.toContain("Подсказка F до bash");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);
		await waitForCondition(() => !harness!.session.isBashRunning);
	});

	it("skips background prediction when /suggestions is off, stopReason !== stop, pending messages are queued, or a blocking Modal Card is open", async () => {
		let releaseTurnWithQueuedFollowUp!: () => void;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurnWithQueuedFollowUp = resolve;
		});

		harness = await createInteractiveHarness({
			width: 90,
			height: 26,
			responses: [
				fauxAssistantMessage("Ответ при выключенных подсказках"),
				fauxAssistantMessage("Обрезанный ответ", { stopReason: "length" }),
				fauxAssistantMessage("Ответ при открытом модальном окне"),
				async () => {
					await turnGate;
					return fauxAssistantMessage("Ответ перед очередью");
				},
				fauxAssistantMessage("Ответ на сообщение из очереди"),
			],
			suggestionResponses: [
				fauxAssistantMessage("Финальная подсказка после очереди"),
			],
		});

		await harness.submitInput("/suggestions off");
		await harness.submitInput("Проверка off");
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(harness.calls).toHaveLength(1);
		expect(harness.suggestionCalls).toHaveLength(0);

		await harness.submitInput("/suggestions on");
		await harness.submitInput("Проверка stopReason=length");
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(harness.calls).toHaveLength(2);
		expect(harness.suggestionCalls).toHaveLength(0);

		const releaseModalGuard = registerBlockingDialog();
		try {
			await harness.submitInput("Проверка модального блока");
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			expect(harness.calls).toHaveLength(3);
			expect(harness.suggestionCalls).toHaveLength(0);
		} finally {
			releaseModalGuard();
		}

		const streamingPromise = harness.prompt("Первый запрос с очередью");
		await waitForCondition(() => harness!.session.isStreaming);
		await harness.session.followUp("Второй запрос из очереди");
		releaseTurnWithQueuedFollowUp();
		await streamingPromise;
		await waitForCondition(() =>
			harness!.screen().text().includes("Финальная подсказка после очереди"),
		);
		expect(harness.calls).toHaveLength(5);
		expect(harness.suggestionCalls).toHaveLength(1);
	});

	it("skips Prompt Suggestion when a Plan turn ends by opening the Plan Approval Modal Card", async () => {
		harness = await createInteractiveHarness({
			width: 96,
			height: 28,
			responses: [
				fauxAssistantMessage("1. Update src/index.ts\n2. Verify tests pass"),
			],
			suggestionResponses: [
				fauxAssistantMessage("ЛИШНИЙ_ЗАПРОС_ВО_ВРЕМЯ_МОДАЛКИ"),
			],
		});

		await harness.submitInput("/mode plan");
		await harness.submitInput("Составь план правок");
		await waitForCondition(() => hasBlockingModalOverlay(harness!.tui));
		await new Promise<void>((resolve) => setTimeout(resolve, 30));

		expect(harness.calls).toHaveLength(1);
		expect(harness.suggestionCalls).toHaveLength(0);
		expect(harness.screen().text()).not.toContain("ЛИШНИЙ_ЗАПРОС_ВО_ВРЕМЯ_МОДАЛКИ");

		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
	});

	it("accepts Prompt Suggestion on Tab or Right arrow with Ctrl+Z and tui.editor.undo reversal, clearing the stored suggestion", async () => {
		harness = await createInteractiveHarness({
			agentDir: allocateEnabledAgentDir(),
			width: 92,
			height: 26,
			responses: [
				fauxAssistantMessage("Первый ответ"),
				fauxAssistantMessage("Второй ответ"),
				fauxAssistantMessage("Третий ответ"),
			],
			suggestionResponses: [
				fauxAssistantMessage("Запусти vitest для проверки"),
				fauxAssistantMessage("Покажи git diff"),
				fauxAssistantMessage("Проверь линт"),
			],
		});

		const initialPlaceholderHit = harness.screen().findText(COMPOSER_PLACEHOLDER);
		const dimFg = harness.screen().cellAt(initialPlaceholderHit!.row, initialPlaceholderHit!.col + 1)?.fg;

		await harness.submitInput("Старт 1");
		await waitForCondition(() =>
			harness!.screen().text().includes("Запусти vitest для проверки"),
		);

		await harness.pressKey("\t");
		const afterTabScreen = harness.screen();
		const acceptedHit = afterTabScreen.findText("Запусти vitest для проверки");
		expect(acceptedHit).toBeDefined();
		expect(afterTabScreen.cellAt(acceptedHit!.row, acceptedHit!.col + 1)?.fg).not.toEqual(dimFg);

		await harness.pressKey("\x1a");
		const afterCtrlZText = harness.screen().text();
		expect(afterCtrlZText).toContain(COMPOSER_PLACEHOLDER);
		expect(afterCtrlZText).not.toContain("Запусти vitest для проверки");

		await harness.submitInput("Старт 2");
		await waitForCondition(() => harness!.screen().text().includes("Покажи git diff"));

		await harness.pressKey("\x1b[C");
		expect(harness.screen().text()).toContain("Покажи git diff");
		await harness.typeText(" --stat");
		expect(harness.screen().text()).toContain("Покажи git diff --stat");

		await harness.pressKey("\x1f");
		await harness.pressKey("\x1f");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);
		expect(harness.screen().text()).not.toContain("Покажи git diff");

		await harness.submitInput("Старт 3");
		await waitForCondition(() => harness!.screen().text().includes("Проверь линт"));
		await harness.pressKey("\t");
		expect(harness.screen().text()).toContain("Проверь линт");
		await harness.pressKey("\x1b[1103;5u");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);
	});

	it("hides Prompt Suggestion while typing or holding paste/image/quote Prompt Chips, reveals it when deleted back to empty, and respects Esc, autocomplete, and Modal Card guards", async () => {
		const tinyPngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
		const tinyPngBytes = Uint8Array.from(Buffer.from(tinyPngBase64, "base64"));

		harness = await createInteractiveHarness({
			agentDir: allocateEnabledAgentDir(),
			width: 96,
			height: 28,
			settings: {
				doubleEscapeAction: "tree",
			},
			clipboard: {
				image: { bytes: tinyPngBytes, mimeType: "image/png" },
			},
			responses: [
				fauxAssistantMessage("Ответ с кодом для цитирования"),
			],
			suggestionResponses: [
				fauxAssistantMessage("Обнови снапшоты тестов"),
			],
		});

		await harness.submitInput("Посмотри модуль");
		await waitForCondition(() =>
			harness!.screen().text().includes("Обнови снапшоты тестов"),
		);

		await harness.typeText("Черновик");
		expect(harness.screen().text()).toContain("Черновик");
		expect(harness.screen().text()).not.toContain("Обнови снапшоты тестов");

		for (let i = 0; i < "Черновик".length; i += 1) {
			await harness.pressKey("\x7f");
		}
		expect(harness.screen().text()).toContain("Обнови снапшоты тестов");

		await harness.paste("line 1\nline 2\nline 3\nline 4");
		expect(harness.screen().text()).toContain("[📋 Pasted #1 · 4 lines]");
		expect(harness.screen().text()).not.toContain("Обнови снапшоты тестов");

		await harness.pressKey("\x7f");
		expect(harness.screen().text()).toContain("Обнови снапшоты тестов");

		await harness.pressKey("\x16");
		await waitForCondition(() => harness!.screen().text().includes("[🖼 Image #1]"));
		expect(harness.screen().text()).not.toContain("Обнови снапшоты тестов");

		/* Первое нажатие Backspace удаляет автоматически подставленный пробел, второе — сам чип картинки */
		await harness.pressKey("\x7f");
		await harness.pressKey("\x7f");
		expect(harness.screen().text()).toContain("Обнови снапшоты тестов");

		await harness.submitInput("/quote");
		expect(harness.screen().text()).toContain("[❝ Quote #1 · 1 line]");
		expect(harness.screen().text()).not.toContain("Обнови снапшоты тестов");

		await harness.pressKey("\x7f");
		expect(harness.screen().text()).toContain("Обнови снапшоты тестов");

		await harness.typeText("/suggest");
		expect(harness.screen().text()).toContain("suggestions");
		expect(harness.screen().text()).not.toContain("Обнови снапшоты тестов");

		await harness.pressKey("\x1b");
		for (let i = 0; i < "/suggest".length; i += 1) {
			await harness.pressKey("\x7f");
		}
		expect(harness.screen().text()).toContain("Обнови снапшоты тестов");

		await harness.typeText("/cont");
		expect(harness.screen().text()).toContain("context");
		await harness.pressKey("\t");
		expect(harness.screen().text()).toContain("/context");
		expect(harness.screen().text()).not.toContain("Обнови снапшоты тестов");
		await harness.sendInput("\r");
		await waitForCondition(() => harness!.screen().text().includes("Context Inspector"));
		await harness.pressKey("\t");
		await harness.pressKey("\x1b[C");
		await harness.pressKey("\x1b");
		await waitForCondition(() => !harness!.screen().text().includes("Context Inspector"));
		expect(harness.screen().text()).toContain("Обнови снапшоты тестов");

		await harness.pressKey("\x1b");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);
		expect(harness.screen().text()).not.toContain("Обнови снапшоты тестов");

		await harness.pressKey("\x1b");
		expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
	});

	it("automatically neutralizes superseded external Prompt Suggestion extensions loaded either before or after @conarti/pi-ui without duplicate LLM requests or double editor wrappers", async () => {
		const pkgRoot = allocateTempDir("pi-ui-ext-superseded-");
		const extDir = join(pkgRoot, "pi-next-prompt", "extensions");
		mkdirSync(extDir, { recursive: true });
		const externalEntry = join(extDir, "next-prompt.ts");
		writeFileSync(
			externalEntry,
			`
import { normalizeContext } from "@earendil-works/pi-ai";
import { convertToLlm, CustomEditor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const PROMPT = "[Suggestion mode] Predict what the user will type next in this conversation. Reply with only the suggestion, no quotes.";

export default function (pi) {
	let suggestion = "";
	let lastRequest = [];

	pi.on("context_with_system", async (event) => {
		lastRequest = event.messages;
	});

	pi.on("agent_end", async (event, ctx) => {
		const reply = event.messages.at(-1);
		if (ctx.mode !== "tui" || !ctx.model || reply?.role !== "assistant" || reply.stopReason !== "stop") return;
		const model = ctx.model;
		const ask = { role: "user", content: [{ type: "text", text: PROMPT }], timestamp: Date.now() };
		void (async () => {
			const answer = await ctx.modelRegistry
				.streamSimple(model, normalizeContext({ messages: convertToLlm([...lastRequest, reply, ask]) }), {
					maxTokens: 2000,
					sessionId: ctx.sessionManager.getSessionId(),
				})
				.result();
			suggestion = "EXTERNAL_SUGGESTION_SHOULD_NEVER_WIN";
			void answer;
		})();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
			const origInput = editor.handleInput.bind(editor);
			editor.handleInput = (data) => {
				if (suggestion && editor.getText() === "" && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
					editor.setText("HIJACKED_BY_EXTERNAL");
					suggestion = "";
					return;
				}
				origInput(data);
			};
			return editor;
		});
	});
}
`,
			"utf8",
		);

		for (const order of ["before", "after"] as const) {
			const extensionPaths =
				order === "before"
					? [externalEntry, DEFAULT_EXTENSION_ENTRY]
					: [DEFAULT_EXTENSION_ENTRY, externalEntry];

			harness = await createInteractiveHarness({
				agentDir: allocateEnabledAgentDir(),
				width: 92,
				height: 26,
				loadDefaultExtension: false,
				additionalExtensionPaths: extensionPaths,
				responses: [
					fauxAssistantMessage(`Ответ (${order})`),
					fauxAssistantMessage(`Второй ответ (${order})`),
				],
				suggestionResponses: [
					fauxAssistantMessage(`Нативная подсказка (${order})`),
					fauxAssistantMessage("ЛИШНИЙ_ВЫЗОВ"),
				],
			});

			await harness.submitInput(`Проверка порядка ${order}`);
			await waitForCondition(() =>
				harness!.screen().text().includes(`Нативная подсказка (${order})`),
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 25));

			expect(harness.calls).toHaveLength(1);
			expect(harness.suggestionCalls).toHaveLength(1);
			expect(JSON.stringify(harness.suggestionCalls[0]?.messages.at(-1))).toContain(
				"[Prompt suggestion]",
			);
			expect(JSON.stringify(harness.suggestionCalls[0]?.messages.at(-1))).not.toContain(
				"[Suggestion mode]",
			);

			await harness.pressKey("\t");
			expect(harness.screen().text()).toContain(`Нативная подсказка (${order})`);
			expect(harness.screen().text()).not.toContain("HIJACKED_BY_EXTERNAL");

			await harness.pressKey("\x1a");
			expect(harness.screen().text()).toContain(COMPOSER_PLACEHOLDER);

			await harness.submitInput("/suggestions off");
			await harness.submitInput("Ход при выключенных подсказках");
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			expect(harness.calls).toHaveLength(2);
			expect(harness.suggestionCalls).toHaveLength(1);

			await harness.dispose();
			harness = undefined;
		}
	});

	it("neutralizes inline or renamed external Prompt Suggestion extensions with module-scoped PROMPT constants", async () => {
		const extDir = allocateTempDir("pi-ui-ext-renamed-");
		const renamedEntry = join(extDir, "custom-inline-extension.ts");
		writeFileSync(
			renamedEntry,
			`
import { normalizeContext } from "@earendil-works/pi-ai";
import { convertToLlm, CustomEditor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROMPT = "[Suggestion mode] Predict what the user will type next in this conversation.";
const MAX_LENGTH = 100;

export default function (pi) {
	let suggestion = "";
	let lastRequest = [];
	let pending;
	let redraw = () => {};

	pi.on("context_with_system", async (event) => {
		lastRequest = event.messages;
	});

	pi.on("agent_end", async (event, ctx) => {
		const reply = event.messages.at(-1);
		if (ctx.mode !== "tui" || !ctx.model || reply?.role !== "assistant" || reply.stopReason !== "stop") return;
		if (ctx.hasPendingMessages()) return;
		const controller = new AbortController();
		pending = controller;
		const level = pi.getThinkingLevel();
		const model = ctx.model;
		const ask = { role: "user", content: [{ type: "text", text: PROMPT }], timestamp: Date.now() };
		void (async () => {
			const answer = await ctx.modelRegistry
				.streamSimple(model, normalizeContext({ messages: convertToLlm([...lastRequest, reply, ask]) }), {
					reasoning: model.reasoning && level !== "off" ? level : undefined,
					maxTokens: 2000,
					sessionId: ctx.sessionManager.getSessionId(),
					signal: controller.signal,
				})
				.result();
			if (controller.signal.aborted || answer.stopReason !== "stop") return;
			suggestion = "INLINE_EXTERNAL_SUGGESTION";
			void MAX_LENGTH;
			redraw();
		})();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			redraw = () => tui.requestRender();
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data) => {
				if (suggestion && editor.getText() === "" && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
					editor.setText("INLINE_HIJACKED");
					suggestion = "";
					return;
				}
				handleInput(data);
			};
			const render = editor.render.bind(editor);
			editor.render = (width) => {
				const lines = [...render(width)];
				const blank = suggestion && editor.getText() === "" ? lines[1]?.match(/ {3,}$/)?.[0] : undefined;
				if (blank) {
					const ghost = truncateToWidth(suggestion, blank.length - 2, "…");
					lines[1] = lines[1].slice(0, -blank.length) + ctx.ui.theme.fg("dim", ghost) + " ".repeat(blank.length - visibleWidth(ghost));
				}
				return lines;
			};
			return editor;
		});
	});
}
`,
			"utf8",
		);

		for (const order of ["before", "after"] as const) {
			const extensionPaths =
				order === "before"
					? [renamedEntry, DEFAULT_EXTENSION_ENTRY]
					: [DEFAULT_EXTENSION_ENTRY, renamedEntry];

			harness = await createInteractiveHarness({
				agentDir: allocateEnabledAgentDir(),
				width: 92,
				height: 26,
				loadDefaultExtension: false,
				additionalExtensionPaths: extensionPaths,
				responses: [fauxAssistantMessage(`Ответ переименованного (${order})`)],
				suggestionResponses: [
					fauxAssistantMessage(`Чистая подсказка (${order})`),
					fauxAssistantMessage("ДУБЛЬ_ОТ_ВНЕШНЕГО"),
				],
			});

			await harness.submitInput(`Проверка переименованного (${order})`);
			await waitForCondition(() =>
				harness!.screen().text().includes(`Чистая подсказка (${order})`),
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 25));

			expect(harness.calls).toHaveLength(1);
			expect(harness.suggestionCalls).toHaveLength(1);
			await harness.pressKey("\t");
			expect(harness.screen().text()).toContain(`Чистая подсказка (${order})`);
			expect(harness.screen().text()).not.toContain("INLINE_HIJACKED");

			await harness.dispose();
			harness = undefined;
		}
	});
});

describe("Prompt Suggestion configuration, sanitization, and external superseder rules", () => {
	let tempRoot = "";
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempRoot = mkdtempSync(join(tmpdir(), "pi-ui-cfg-unit-"));
		process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent-a");
	});

	afterEach(() => {
		if (prevAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("resolves getAgentDir dynamically, defaults promptSuggestions to false, survives malformed JSON, and preserves symlinks and sibling keys", () => {
		expect(getPiUiConfigPath()).toBe(join(tempRoot, "agent-a", "pi-ui.json"));
		expect(loadPiUiUserConfig()).toEqual(DEFAULT_PI_UI_USER_CONFIG);
		expect(loadPiUiUserConfig().promptSuggestions).toBe(false);

		const secondDir = join(tempRoot, "agent-b");
		process.env.PI_CODING_AGENT_DIR = secondDir;
		expect(getPiUiConfigPath()).toBe(join(secondDir, "pi-ui.json"));

		updatePiUiUserConfig({ promptSuggestions: true });
		expect(loadPiUiUserConfig().promptSuggestions).toBe(true);

		writeFileSync(getPiUiConfigPath(), "{broken json", "utf8");
		expect(loadPiUiUserConfig()).toEqual(DEFAULT_PI_UI_USER_CONFIG);

		writeFileSync(getPiUiConfigPath(), JSON.stringify({ promptSuggestions: "invalid" }), "utf8");
		expect(loadPiUiUserConfig()).toEqual(DEFAULT_PI_UI_USER_CONFIG);

		const symlinkDir = join(tempRoot, "agent-symlink");
		process.env.PI_CODING_AGENT_DIR = symlinkDir;
		const realTargetPath = join(tempRoot, "linked-target.json");
		writeFileSync(
			realTargetPath,
			`${JSON.stringify({ appearanceMode: "auto", statusBar: true, promptSuggestions: true }, null, 2)}\n`,
			"utf8",
		);
		updatePiUiUserConfig({ promptSuggestions: true });
		rmSync(getPiUiConfigPath(), { force: true });
		symlinkSync(realTargetPath, getPiUiConfigPath());

		const updated = updatePiUiUserConfig({ promptSuggestions: false });
		expect(updated.promptSuggestions).toBe(false);
		expect(lstatSync(getPiUiConfigPath()).isSymbolicLink()).toBe(true);
		expect(existsSync(realTargetPath)).toBe(true);
		expect(JSON.parse(readFileSync(realTargetPath, "utf8"))).toEqual({
			appearanceMode: "auto",
			statusBar: true,
			promptSuggestions: false,
		});
	});

	it("sanitizes single-line Prompt Suggestions and rejects sentinels, multiline outputs, and strings over 100 chars", () => {
		expect(MAX_PROMPT_SUGGESTION_LENGTH).toBe(100);
		expect(sanitizePromptSuggestion('  "Запусти тесты и покажи отчёт"  ')).toBe(
			"Запусти тесты и покажи отчёт",
		);
		expect(sanitizePromptSuggestion("`'npm run check'`")).toBe("npm run check");
		expect(sanitizePromptSuggestion("«Покажи diff для composer.ts»")).toBe(
			"Покажи diff для composer.ts",
		);
		expect(sanitizePromptSuggestion("Run `npm test` on the worktree")).toBe(
			"Run `npm test` on the worktree",
		);
		expect(sanitizePromptSuggestion("Нет")).toBe("Нет");
		expect(sanitizePromptSuggestion("x".repeat(100))).toBe("x".repeat(100));

		expect(sanitizePromptSuggestion("")).toBeUndefined();
		expect(sanitizePromptSuggestion("   ")).toBeUndefined();
		expect(sanitizePromptSuggestion('""')).toBeUndefined();
		expect(sanitizePromptSuggestion("nothing")).toBeUndefined();
		expect(sanitizePromptSuggestion("(Nothing)")).toBeUndefined();
		expect(sanitizePromptSuggestion("[none]")).toBeUndefined();
		expect(sanitizePromptSuggestion("N/A")).toBeUndefined();
		expect(sanitizePromptSuggestion("Line one\nLine two")).toBeUndefined();
		expect(sanitizePromptSuggestion("Line one\rLine two")).toBeUndefined();
		expect(sanitizePromptSuggestion("x".repeat(101))).toBeUndefined();
	});

	it("identifies superseded external suggestion extensions by package path, sourceInfo, and handler signatures without false positives", () => {
		expect(
			isSupersededExternalSuggestionExtension({
				path: "/Users/dev/.pi/agent/npm/node_modules/pi-next-prompt/extensions/next-prompt.ts",
			}),
		).toBe(true);
		expect(
			isSupersededExternalSuggestionExtension({
				path: "<inline:0>",
				sourceInfo: { source: "npm:pi-next-prompt" },
			}),
		).toBe(true);
		expect(
			isSupersededExternalSuggestionExtension({
				path: "<inline:1>",
				handlers: new Map([
					[
						"agent_end",
						[
							function inlineLiteralHandler() {
								return "[Suggestion mode] Predict what the user will type next in this conversation.";
							},
						],
					],
				]),
			}),
		).toBe(true);
		expect(
			isSupersededExternalSuggestionExtension({
				path: "<inline:2>",
				handlers: new Map([
					[
						"session_start",
						[
							function editorWrapperHandler(ctx: { ui: { setEditorComponent: (fn: unknown) => void } }) {
								ctx.ui.setEditorComponent((lines: string[]) => lines[1]?.match(/ {3,}$/)?.[0]);
							},
						],
					],
				]),
			}),
		).toBe(true);
		expect(
			isSupersededExternalSuggestionExtension({
				path: "/Users/dev/Projects/pi-ui/src/index.ts",
				handlers: new Map([["session_start", [() => {}]]]),
			}),
		).toBe(false);
	});
});

