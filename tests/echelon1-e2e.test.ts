import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { clearRecordedThinkingTimings } from "../src/features/transcript/thinking-block.ts";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import { loadPiUiUserConfig } from "../src/shared/pi-ui-config.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type InteractiveHarness,
} from "./harness/index.ts";

const CYRILLIC_RE = /[А-Яа-яЁё]/u;

async function waitForCondition(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

async function flushUi(harness: InteractiveHarness): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	await harness.flush();
	harness.flushFrame(true);
}

describe("Echelon 1 full cross-surface real-InteractiveMode E2E verification", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function allocateTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(async () => {
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

	it("verifies cross-feature Echelon 1 coexistence, 3-tab Context Inspector, clean selection, defaults, and zero-Cyrillic UI chrome across all surfaces", async () => {
		const projDir = allocateTempDir("pi-ui-e1-coexist-");
		mkdirSync(join(projDir, "src"), { recursive: true });
		const sampleFile = join(projDir, "src", "engine.ts");
		writeFileSync(sampleFile, "export const engineReady = true;\n", "utf8");
		const skillDoc = join(projDir, "SKILL.md");
		writeFileSync(skillDoc, "# Demo Skill\n\nVerifies Skill Chip rendering.\n", "utf8");

		let clipboardText = "UNCHANGED_CLIPBOARD";
		harness = await createInteractiveHarness({
			cwd: projDir,
			width: 116,
			height: 36,
			thinkingLevel: "medium",
			clipboard: {
				async readText() {
					return clipboardText;
				},
				writeText(next: string) {
					clipboardText = next;
				},
			},
			responses: [
				fauxAssistantMessage([
					fauxThinking("**Inspecting engine**\nChecking engine status before replying."),
					fauxToolCall("read", { path: sampleFile }, { id: "e1-read-1" }),
				]),
				fauxAssistantMessage([
					fauxText(
						[
							"Engine verification complete with `engineReady` flag.",
							"",
							"```ts",
							"export const status = 'green';",
							"export const version = 1;",
							"export const mode = 'balanced';",
							"```",
							"",
							"| Check | Status |",
							"| --- | --- |",
							"| Grid | OK |",
							"| Copy | OK |",
						].join("\n"),
					),
				]),
			],
		});

		await flushUi(harness);
		expect(loadPiUiUserConfig().promptSuggestions).toBe(false);
		expect(loadPiUiUserConfig().copyOnSelect).toBe(false);
		expect(harness.suggestionCalls.length).toBe(0);

		const bootScreen = harness.screen().text();
		expect(CYRILLIC_RE.test(bootScreen)).toBe(false);

		/* Отправляем промпт с тегом навыка <skill>, чтобы проверить Skill Chip + Thinking + Tool Density + Markdown actions + Response Metrics */
		const skillPrompt = `<skill name="demo-skill" location="${skillDoc}">\n# Demo Skill\n</skill>\n\nVerify engine status`;
		await harness.prompt(skillPrompt);
		await flushUi(harness);

		/* На Fresh install Prompt Suggestion выключен — фоновых запросов быть не должно */
		expect(harness.suggestionCalls.length).toBe(0);

		const transcriptText = harness.screen().text();
		expect(transcriptText).toContain("/demo-skill");
		expect(transcriptText).not.toContain("<skill name=");
		expect(transcriptText).toContain("Thought");
		expect(transcriptText).toContain("Copy");
		expect(transcriptText).toContain("Copy TSV");
		expect(transcriptText).toContain("Worked for");
		expect(CYRILLIC_RE.test(transcriptText)).toBe(false);

		/* Выделение текста мышкой при copyOnSelect = false не перезаписывает буфер до клика по [Copy] */
		const selectableHit = harness.screen().findText("Engine verification");
		expect(selectableHit).toBeDefined();
		await harness.mouseDrag(
			selectableHit!.col,
			selectableHit!.row,
			selectableHit!.col + 18,
			selectableHit!.row,
		);
		await flushUi(harness);
		const selectionScreen = harness.screen().text();
		expect(selectionScreen).toContain("[Copy]  [Quote · Alt+Q]");
		expect(CYRILLIC_RE.test(selectionScreen)).toBe(false);
		expect(clipboardText).toBe("UNCHANGED_CLIPBOARD");
		await harness.pressKey("\x1b");
		await flushUi(harness);

		/* Проверяем 3-вкладочный Context Inspector (все 3 вкладки на английском, без кириллицы) */
		const openCtx = harness.submitInput("/context");
		await waitForCondition(() => harness!.screen().text().includes("Context Inspector"));
		const tab1 = harness.screen().text();
		expect(tab1).toContain("Context usage");
		expect(tab1).toContain("Session usage");
		expect(tab1).toContain("Session info");
		expect(CYRILLIC_RE.test(tab1)).toBe(false);

		await harness.pressKey("\t");
		await flushUi(harness);
		const tab2 = harness.screen().text();
		expect(CYRILLIC_RE.test(tab2)).toBe(false);

		await harness.pressKey("\t");
		await flushUi(harness);
		const tab3 = harness.screen().text();
		expect(CYRILLIC_RE.test(tab3)).toBe(false);

		await harness.pressKey("\x1b");
		await openCtx;
		await flushUi(harness);

		/* Проверяем Command Palette и /slots (пустое состояние) — нулевая кириллица */
		await harness.pressKey("\x0b");
		await flushUi(harness);
		const paletteText = harness.screen().text();
		expect(paletteText).toContain("Command Palette");
		expect(paletteText).toContain("Slot Arbitration");
		expect(CYRILLIC_RE.test(paletteText)).toBe(false);
		await harness.pressKey("\x1b");
		await flushUi(harness);

		const openSlots = harness.submitInput("/slots");
		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		const emptySlotsText = harness.screen().text();
		expect(emptySlotsText).toContain("No contended capabilities");
		expect(CYRILLIC_RE.test(emptySlotsText)).toBe(false);
		await harness.pressKey("\x1b");
		await openSlots;
	});

	it("survives fullscreen <-> regular TUI mode transitions and repeated /reload idempotently without stuck popups or stacked chrome", async () => {
		harness = await createInteractiveHarness({
			width: 112,
			height: 26,
			responses: [
				fauxAssistantMessage([
					fauxText(
						Array.from({ length: 14 }, (_, i) => `Turn one detail line ${i + 1}`).join("\n"),
					),
				]),
				fauxAssistantMessage([
					fauxText(
						Array.from({ length: 14 }, (_, i) => `Turn two detail line ${i + 1}`).join("\n"),
					),
				]),
				fauxAssistantMessage([fauxText("Post-reload turn succeeded cleanly.")]),
			],
		});

		await harness.prompt("First long turn prompt");
		await harness.prompt("Second long turn prompt");
		await flushUi(harness);
		expect(getActiveHostRuntime()?.isFullscreen).toBe(true);

		/* Открываем транзиентный selection Hover Popup и проверяем, что он не блокирует switchTuiMode */
		const dragHit = harness.screen().findText("Turn two detail line");
		expect(dragHit).toBeDefined();
		await harness.mouseDrag(dragHit!.col, dragHit!.row, dragHit!.col + 14, dragHit!.row);
		await flushUi(harness);
		expect(harness.screen().text()).toContain("[Copy]  [Quote · Alt+Q]");

		expect(await harness.setTuiMode("regular")).toBe(true);
		await flushUi(harness);
		expect(getActiveHostRuntime()?.isFullscreen).toBe(false);
		expect(CYRILLIC_RE.test(harness.screen().text())).toBe(false);

		expect(await harness.setTuiMode("fullscreen")).toBe(true);
		await flushUi(harness);
		expect(getActiveHostRuntime()?.isFullscreen).toBe(true);
		expect(getActiveHostRuntime()?.viewportSlots?.rightRail).toBeDefined();
		expect(CYRILLIC_RE.test(harness.screen().text())).toBe(false);

		/* Два подряд /reload — проверяем идемпотентность хуков, шорткатов и рендеринга */
		await harness.reload();
		await flushUi(harness);
		await harness.reload();
		await flushUi(harness);

		expect(getActiveHostRuntime()?.isFullscreen).toBe(true);
		await harness.pressKey("\x0b");
		await flushUi(harness);
		expect(harness.screen().text()).toContain("Command Palette");
		await harness.pressKey("\x1b");
		await flushUi(harness);

		await harness.prompt("Check after two reloads");
		await flushUi(harness);
		const postReloadScreen = harness.screen().text();
		expect(postReloadScreen).toContain("Post-reload turn succeeded cleanly.");
		expect(postReloadScreen).toContain("Worked for");
		expect(CYRILLIC_RE.test(postReloadScreen)).toBe(false);
	});

	it("maintains RU/EN keyboard layout parity for shortcuts, popovers, and Ctrl+Z undo while preserving Cyrillic text entry", async () => {
		harness = await createInteractiveHarness({
			width: 112,
			height: 34,
			thinkingLevel: "low",
			models: [
				{
					id: "faux-1",
					name: "Faux Reasoning",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 128000,
					maxTokens: 16384,
				},
				{
					id: "faux-2",
					name: "Faux Fast",
					reasoning: false,
					input: ["text"],
					contextWindow: 64000,
					maxTokens: 8192,
				},
			],
		});

		await flushUi(harness);

		/* Обычный ввод кириллицы в Composer остаётся нетронутым */
		await harness.typeText("Привет мир");
		await flushUi(harness);
		expect(harness.screen().text()).toContain("Привет мир");

		/* Esc×2 очищает черновик, а Ctrl+Я (RU-раскладка для Ctrl+Z, CSI-u) возвращает текст */
		await harness.pressKey("\x1b");
		await harness.flush();
		await harness.pressKey("\x1b");
		await flushUi(harness);
		expect(harness.screen().text()).not.toContain("Привет мир");

		await harness.pressKey("\x1b[1103;5u");
		await flushUi(harness);
		expect(harness.screen().text()).toContain("Привет мир");

		/* Очищаем черновик перед проверкой RU-хоткеев поповеров и палитры */
		await harness.pressKey("\x1b");
		await harness.pressKey("\x1b");
		await flushUi(harness);

		/* Ctrl+Л (RU -> Ctrl+K) открывает Command Palette */
		await harness.pressKey("\x1b[1083;5u");
		await flushUi(harness);
		const paletteRu = harness.screen().text();
		expect(paletteRu).toContain("Command Palette");
		expect(CYRILLIC_RE.test(paletteRu)).toBe(false);
		await harness.pressKey("\x1b");
		await flushUi(harness);

		/* Ctrl+Д (RU -> Ctrl+L) открывает Model popover */
		await harness.pressKey("\x1b[1076;5u");
		await flushUi(harness);
		const modelRu = harness.screen().text();
		expect(modelRu).toContain("Model");
		expect(modelRu).toContain("Faux Fast");
		expect(CYRILLIC_RE.test(modelRu)).toBe(false);
		await harness.pressKey("\x1b");
		await flushUi(harness);

		/* Alt+Е (RU -> Alt+T) открывает Thinking popover */
		await harness.pressKey("\x1b[1077;3u");
		await flushUi(harness);
		const thinkingRu = harness.screen().text();
		expect(thinkingRu).toContain("Thinking");
		expect(CYRILLIC_RE.test(thinkingRu)).toBe(false);
		await harness.pressKey("\x1b");
		await flushUi(harness);

		/* Alt+Ь (RU -> Alt+M) открывает Session Mode popover */
		await harness.pressKey("\x1b[1100;3u");
		await flushUi(harness);
		const modeRu = harness.screen().text();
		expect(modeRu).toContain("Session Mode");
		expect(modeRu).toContain("Always-approve");
		expect(CYRILLIC_RE.test(modeRu)).toBe(false);
		await harness.pressKey("\x1b");
		await flushUi(harness);
	});

	it("keeps additive and contending third-party plugins stable across live Slot Arbitration swaps, fullscreen <-> regular transitions, and /reload", async () => {
		const agentDir = allocateTempDir("pi-ui-e1-slots-e2e-");
		let additiveCmdHits = 0;

		const additiveExt: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerCommand("e1-hello", {
				description: "Additive Echelon 1 test command",
				handler: async (_args, ctx) => {
					additiveCmdHits += 1;
					ctx.ui.notify("E1_ADDITIVE_OK", "info");
				},
			});
			pi.on("session_start", (_event, ctx) => {
				if (ctx.mode === "tui" && ctx.hasUI) {
					ctx.ui.setWidget("e1-additive-widget", ["E1_WIDGET_LIVE"]);
				}
			});
		};

		const contendingExt: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				if (ctx.mode !== "tui" || !ctx.hasUI) return;
				ctx.ui.setHeader(() => ({
					invalidate() {},
					render: (width: number) => [
						"E1_EXTERNAL_HEADER".padEnd(width, " ").slice(0, width),
					],
				}));
				ctx.ui.setFooter(() => ({
					invalidate() {},
					render: (width: number) => [
						"E1_EXTERNAL_FOOTER".padEnd(width, " ").slice(0, width),
					],
				}));
			});
		};

		harness = await createInteractiveHarness({
			agentDir,
			width: 112,
			height: 34,
			extensionFactories: [additiveExt, contendingExt],
		});

		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		const modalText = harness.screen().text();
		expect(modalText).toContain("2 slots");
		expect(modalText).toContain("Footer (footer)");
		expect(modalText).toContain("Header (header)");
		expect(CYRILLIC_RE.test(modalText)).toBe(false);

		/* Переключаем оба слота (footer и header) на сторонний плагин inline-2 с клавиатуры */
		await harness.pressKey("\x1b[C");
		await harness.pressKey("\x1b[B");
		await harness.pressKey("\x1b[C");
		await harness.pressKey("\r");
		await flushUi(harness);

		const swappedScreen = harness.screen().text();
		expect(swappedScreen).toContain("E1_EXTERNAL_HEADER");
		expect(swappedScreen).toContain("E1_EXTERNAL_FOOTER");
		expect(swappedScreen).toContain("E1_WIDGET_LIVE");
		expect(CYRILLIC_RE.test(swappedScreen)).toBe(false);

		/* Проверяем устойчивость через fullscreen <-> regular и /reload без повторной модалки */
		expect(await harness.setTuiMode("regular")).toBe(true);
		await flushUi(harness);
		expect(harness.screen().text()).toContain("E1_EXTERNAL_HEADER");
		expect(harness.screen().text()).toContain("E1_EXTERNAL_FOOTER");

		expect(await harness.setTuiMode("fullscreen")).toBe(true);
		await flushUi(harness);
		await harness.reload();
		await flushUi(harness);

		const afterReloadText = harness.screen().text();
		expect(afterReloadText).not.toContain("Slot Arbitration");
		expect(afterReloadText).toContain("E1_EXTERNAL_HEADER");
		expect(afterReloadText).toContain("E1_EXTERNAL_FOOTER");
		expect(afterReloadText).toContain("E1_WIDGET_LIVE");

		await harness.submitInput("/e1-hello");
		expect(additiveCmdHits).toBe(1);
		expect(harness.screen().text()).toContain("E1_ADDITIVE_OK");

		/* Живое возвращение header и footer в @conarti/pi-ui через /slots clear */
		await harness.submitInput("/slots clear");
		await flushUi(harness);
		const restoredScreen = harness.screen().text();
		expect(restoredScreen).not.toContain("E1_EXTERNAL_HEADER");
		expect(restoredScreen).not.toContain("E1_EXTERNAL_FOOTER");
		expect(restoredScreen).toContain("Shift+Tab mode");
		expect(CYRILLIC_RE.test(restoredScreen)).toBe(false);
	});
});
