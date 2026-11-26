import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	resetCapabilitiesCache,
	setCapabilityOverrides,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeComposerMaxVisibleLines,
	getActiveComposerEditor,
} from "../src/features/chrome/composer.ts";
import { parseAnsiColorRgb, rgbHueDegrees } from "../src/shared/ansi.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import { updatePiUiUserConfig } from "../src/shared/pi-ui-config.ts";
import {
	contentText,
	createAssistantMessageEventStream,
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxToolCall,
	findComposerTopRow,
	makeAssistantEntry,
	makeUserEntry,
	waitForCondition,
	ZERO_USAGE,
	type AssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGOwbvpm3fSNAYUCAGbACjPC8yHSAAAAAElFTkSuQmCC";

describe("Issue #44 — Composer parity, popovers, Shortcuts Bar, queue, chips & cursors (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function allocateTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
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

	it("clamps multi-line Composer height to clamp(4, floor(termRows * 0.35), 10), scrolls via cursor/wheel (overscroll=contain) and clickable ↑ N / ↓ M indicators without narrowing inner text width", async () => {
		expect(computeComposerMaxVisibleLines(10)).toBe(4);
		expect(computeComposerMaxVisibleLines(12)).toBe(4);
		expect(computeComposerMaxVisibleLines(20)).toBe(7);
		expect(computeComposerMaxVisibleLines(26)).toBe(9);
		expect(computeComposerMaxVisibleLines(30)).toBe(10);
		expect(computeComposerMaxVisibleLines(60)).toBe(10);

		const t1 = new Date(2026, 4, 10, 12, 0).getTime();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 40,
			initialEntries: [
				makeUserEntry("u1", null, "Transcript scroll anchor", t1),
				makeAssistantEntry(
					"a1",
					"u1",
					Array.from({ length: 40 }, (_, i) => `transcript-row-${i + 1}`).join("\n"),
					t1 + 1000,
				),
			],
		});

		await harness.mouseWheel("up", 20, 10, 4);
		const longDraft = Array.from(
			{ length: 18 },
			(_, i) => `draft-${String(i + 1).padStart(2, "0")}-${"x".repeat(70)}`,
		);
		for (const [index, line] of longDraft.entries()) {
			if (index > 0) await harness.pressKey("\x1b[13;2u");
			await harness.paste(line);
		}

		const topRow40 = findComposerTopRow(harness);
		const screen40 = harness.screen();
		const transcriptRows = () => harness!.screen().text().match(/transcript-row-\d+/gu);
		const scrollBaseline = transcriptRows();
		expect(scrollBaseline?.length).toBeGreaterThan(0);
		/* При termRows=40 видимая область зажата до 10 строк, ширина контента не сужается */
		expect(screen40.rowText(topRow40 + 11)).toContain("╰");
		expect(screen40.rowText(topRow40)).toContain("↑ 8");
		expect(screen40.rowText(topRow40 + 11)).not.toContain("↓ ");
		for (let r = topRow40; r <= topRow40 + 11; r += 1) {
			expect(visibleWidth(harness.renderFrame()[r]!)).toBe(96);
		}
		/* Проверяем, что строка длиной 80 символов влезает в innerWidth = (96 - 4) - 6 = 86 без лишнего переноса */
		expect(screen40.rowText(topRow40 + 10)).toContain(`draft-18-${"x".repeat(70)}`);

		/* Клик по индикатору ↑ 8 в верхней рамке прокручивает черновик вверх и показывает ↓ M в нижней рамке */
		const upHit = screen40.findText("↑ 8")!;
		expect(upHit.row).toBe(topRow40);
		await harness.mouseClick(upHit.col + 1, upHit.row);
		const afterUpClick = harness.screen();
		const topAfterUp = findComposerTopRow(harness);
		expect(afterUpClick.rowText(topAfterUp + 11)).toContain("↓ ");
		expect(transcriptRows()).toEqual(scrollBaseline);

		/* Клик по индикатору ↓ M в нижней рамке прокручивает черновик обратно вниз */
		const downRow = topAfterUp + 11;
		const downCol = afterUpClick.rowText(downRow).indexOf("↓ ");
		expect(downCol).toBeGreaterThan(0);
		await harness.mouseClick(downCol + 1, downRow);
		expect(harness.screen().text()).toContain("draft-18-");
		expect(transcriptRows()).toEqual(scrollBaseline);

		/* Колесо мыши прокручивает черновик с overscroll = contain даже у границ */
		await harness.mouseWheel("up", 20, topAfterUp + 3, 12);
		expect(harness.screen().text()).toContain("draft-01-");
		expect(transcriptRows()).toEqual(scrollBaseline);
		await harness.mouseWheel("up", 20, topAfterUp + 3, 6);
		expect(transcriptRows()).toEqual(scrollBaseline);

		/* Навигация клавиатурой возвращает видимое окно к курсору */
		await harness.pressKey("\x1b[B");
		expect(harness.screen().text()).toContain("draft-18-");

		/* На компактном терминале (12 строк) высота черновика зажата до минимума 4 строк */
		await harness.resize(96, 12);
		expect(harness.screen().rowText(findComposerTopRow(harness) + 5)).toContain("╰");
		expect(harness.screen().rowText(findComposerTopRow(harness))).toContain("↑ ");
	});

	it("renders Model · (thinking) · mode on Composer bottom border, opens all 3 upward popovers via click/shortcuts/commands across RU/EN layouts, steps via Tab/←/→, and keeps Shift+Tab direct cycling", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 28,
			models: [
				{ id: "alpha-model", name: "Alpha Reasoner", reasoning: true },
				{ id: "beta-fast", name: "Beta Fast", reasoning: false },
			],
			thinkingLevel: "off",
		});

		const screen0 = harness.screen();
		const top0 = findComposerTopRow(harness);
		const bottomRowText = screen0.rowText(top0 + 2);
		expect(bottomRowText).toContain("Alpha Reasoner");
		expect(bottomRowText).toContain("(off)");
		expect(bottomRowText).toContain("Always-approve");

		/* Клик по зоне Model открывает поповер Model с поиском */
		const modelCol = bottomRowText.indexOf("Alpha Reasoner");
		await harness.mouseClick(modelCol + 2, top0 + 2);
		const modelPopText = harness.screen().text();
		expect(modelPopText).toContain("Alpha Reasoner");
		expect(modelPopText).toContain("Beta Fast");

		/* Фильтр type-to-search и выбор модели Enter */
		await harness.typeText("beta");
		expect(harness.screen().text()).toContain("Beta Fast");
		expect(harness.screen().text()).not.toContain("Alpha Reasoner\n");
		await harness.pressKey("\r");
		expect(harness.session.model?.id).toBe("beta-fast");

		/* Ctrl+L (RU Ctrl+Д) открывает Model и переключает обратно на Alpha Reasoner */
		await harness.pressKey("\x1b[1076;5u");
		await harness.typeText("alpha");
		await harness.pressKey("\r");
		expect(harness.session.model?.id).toBe("alpha-model");

		/* Переход между поповерами: Ctrl+L -> Tab (thinking) -> → (mode) -> ← (thinking) */
		await harness.pressKey("\x0c");
		expect(harness.screen().text()).toContain("Search models");
		await harness.pressKey("\t");
		const thinkingPop = harness.screen().text();
		expect(thinkingPop).toContain("Thinking");
		expect(thinkingPop).toContain("✓");
		expect(thinkingPop).toContain("high");

		await harness.pressKey("\x1b[C");
		const modePop = harness.screen().text();
		expect(modePop).toContain("Session Mode");
		expect(modePop).toContain("Always-approve");
		expect(modePop).toContain("Auto");
		expect(modePop).toContain("Plan");

		await harness.pressKey("\x1b[D");
		expect(harness.screen().text()).toContain("Thinking");

		/* Клик по пункту high в поповере thinking применяет уровень и закрывает поповер */
		const highHit = harness.screen().findText("high")!;
		await harness.mouseClick(highHit.col + 1, highHit.row);
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.screen().rowText(findComposerTopRow(harness) + 2)).toContain("(high)");

		/* Alt+T (RU Alt+Е и Option+T †) и /thinking открывают thinking popover */
		await harness.pressKey("\x1b[1077;3u");
		expect(harness.screen().text()).toContain("Thinking");
		await harness.pressKey("\x1b");
		await harness.pressKey("†");
		expect(harness.screen().text()).toContain("Thinking");
		await harness.pressKey("\x1b");
		await harness.submitInput("/thinking");
		expect(harness.screen().text()).toContain("Thinking");
		await harness.pressKey("\x1b");

		/* Alt+M (RU Alt+Ь и Option+M µ) и /mode открывают mode popover, а Shift+Tab циклически переключает напрямую */
		await harness.pressKey("\x1b[1100;3u");
		expect(harness.screen().text()).toContain("Session Mode");
		const planHit = harness.screen().findText("Plan")!;
		await harness.mouseClick(planHit.col + 1, planHit.row);
		expect(harness.screen().rowText(findComposerTopRow(harness) + 2)).toContain("Plan");

		await harness.pressKey("µ");
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("\x1b");

		await harness.submitInput("/mode");
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("\x1b");

		await harness.submitInput("/model");
		expect(harness.screen().text()).toContain("Search models");
		const popCloseHit = harness.screen().findText("[×]")!;
		expect(popCloseHit).toBeDefined();
		await harness.mouseClick(popCloseHit.col + 1, popCloseHit.row);
		expect(harness.screen().text()).not.toContain("Search models");

		/* Shift+Tab переключает режим напрямую без открытия поповера */
		await harness.pressKey("\x1b[Z");
		expect(harness.screen().text()).not.toContain("Session Mode");
		expect(harness.screen().rowText(findComposerTopRow(harness) + 2)).toContain("Auto");
	});

	it("uses blue-safe indexed backgrounds in Model search", async () => {
		harness = await createInteractiveHarness({ theme: "dark", trueColor: false, width: 100, height: 28 });
		await harness.pressKey("\x0c");
		const screen = harness.screen();
		const selected = screen.findText("✓ Faux Reasoning")!;
		const bg = screen.cellAt(selected.row, selected.col + 3)?.bg;
		expect(bg?.kind).toBe("palette256");
		expect(bg).not.toEqual({ kind: "palette256", index: 23 });
	});

	it("treats a split bracketed paste as literal Model search text", async () => {
		harness = await createInteractiveHarness({ width: 100, height: 28 });
		await harness.pressKey("\x0c");
		await harness.pressKey("\x1b[200~");
		await harness.pressKey("†");
		await harness.pressKey("\x1b[201~");
		expect(harness.screen().text()).toContain("No matching models");
		expect(harness.screen().text()).toContain("⌕ †");
	});

	it("handles single Esc without aborting active turn, Esc×2 draft+chip undoable clear, Esc×2 /tree on empty draft, and Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y Undo/Redo without SIGTSTP", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const agentDir = allocateTempDir("pi-ui-esc-undo-");
			harness = await createInteractiveHarness({
				agentDir,
				theme: "dark",
				width: 100,
				height: 28,
				responses: [fauxAssistantMessage("First completed reply.")],
			});
			updatePiUiUserConfig({ showShortcutsBar: false });

			const editor = getActiveComposerEditor()!;

			let activeStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
			let activeSignal: AbortSignal | undefined;
			harness.setStreamSimple((_m, _ctx, opts) => {
				activeSignal = opts?.signal;
				const st = createAssistantMessageEventStream();
				activeStream = st;
				opts?.signal?.addEventListener(
					"abort",
					() => {
						const abortedMsg: AssistantMessage = {
							role: "assistant",
							content: [],
							api: "faux",
							provider: "faux",
							model: "faux-1",
							usage: ZERO_USAGE,
							stopReason: "aborted",
							timestamp: Date.now(),
						};
						st.push({ type: "error", reason: "aborted", error: abortedMsg });
						st.end(abortedMsg);
					},
					{ once: true },
				);
				return st;
			});

			const pendingTurn = harness.submitInput("Start long turn");
			await waitForCondition(() => activeStream !== undefined);
			expect(harness.session.isStreaming).toBe(true);

			await harness.pressKey("\x1b[109;3u");
			expect(harness.screen().text()).toContain("Session Mode");
			await harness.pressKey("\x1b");
			expect(harness.screen().text()).not.toContain("Session Mode");
			expect(activeSignal?.aborted).toBe(false);
			expect(harness.session.isStreaming).toBe(true);

			/* Чистый Esc во время стрима показывает Press Ctrl+C to stop без прерывания */
			await harness.pressKey("\x1b");
			expect(activeSignal?.aborted).toBe(false);
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.screen().text()).toContain("Press Ctrl+C to stop");

			/* Ctrl+C прерывает активный ход */
			await harness.pressKey("\x03");
			await pendingTurn;
			expect(activeSignal?.aborted).toBe(true);
			expect(harness.session.isStreaming).toBe(false);
			harness.setStreamSimple(undefined);

			await harness.typeText("Inspect ");
			await harness.paste("line 1\nline 2\nline 3\nline 4", true);
			expect(editor.getText()).toContain("[📋 Pasted #1 · 4 lines]");

			await harness.pressKey("\x1b");
			expect(editor.getText()).toContain("[📋 Pasted #1 · 4 lines]");
			expect(harness.screen().text()).toContain("Esc again to clear");

			await harness.pressKey("\x1b");
			expect(editor.getText()).toBe("");

			/* Ctrl+Z восстанавливает черновик + Prompt Chip без SIGTSTP */
			await harness.pressKey("\x1a");
			expect(killSpy).not.toHaveBeenCalled();
			expect(editor.getText()).toContain("Inspect ");
			expect(editor.getText()).toContain("[📋 Pasted #1 · 4 lines]");

			/* Ctrl+Shift+Z (Redo) снова очищает, Ctrl+Z восстанавливает, Ctrl+Y (Redo) снова очищает */
			await harness.pressKey("\x1b[122;6u");
			expect(editor.getText()).toBe("");
			await harness.pressKey("\x1a");
			expect(editor.getText()).toContain("[📋 Pasted #1 · 4 lines]");
			await harness.pressKey("\x19");
			expect(editor.getText()).toBe("");
			expect(killSpy).not.toHaveBeenCalled();

			await harness.typeText("/");
			await harness.pressKey("\x1a");
			expect(killSpy).not.toHaveBeenCalled();
			expect(harness.screen().rowText(findComposerTopRow(harness) + 1)).toContain("Ask or describe");

			await harness.pressKey("\x1b");
			await harness.pressKey("\x1b");
			expect(harness.screen().text()).toMatch(/Session Tree|Tree|Start long turn/i);
			await harness.pressKey("\x1b");
		} finally {
			killSpy.mockRestore();
		}
	});

	it("supports mid-turn Enter queue/steer, Ctrl+Enter Send now, Alt+Enter steer/queue, 1s empty-composer double-tap guard, and clickable [Send now], [Edit · Alt+↑], [×] queue strip", async () => {
		const agentDir = allocateTempDir("pi-ui-midturn-queue-");
		harness = await createInteractiveHarness({
			agentDir,
			theme: "dark",
			width: 110,
			height: 28,
			extensionFactories: [(pi) => {
				pi.on("input", (event) => event.text === "Handled elsewhere" ? { action: "handled" } : undefined);
			}],
		});

		const editor = getActiveComposerEditor()!;
		let callCount = 0;
		const streams: Array<{
			stream: ReturnType<typeof createAssistantMessageEventStream>;
			signal?: AbortSignal;
			promptTexts: string[];
		}> = [];

		harness.setStreamSimple((_m, ctx, opts) => {
			callCount += 1;
			const st = createAssistantMessageEventStream();
			const promptTexts = ctx.messages
				.filter((m) => m.role === "user")
				.map((m) =>
					typeof m.content === "string"
						? m.content
						: m.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join(""),
				);
			streams.push({ stream: st, signal: opts?.signal, promptTexts });
			opts?.signal?.addEventListener(
				"abort",
				() => {
					const abortedMsg: AssistantMessage = {
						role: "assistant",
						content: [],
						api: "faux",
						provider: "faux",
						model: "faux-1",
						usage: ZERO_USAGE,
						stopReason: "aborted",
						timestamp: Date.now(),
					};
					st.push({ type: "error", reason: "aborted", error: abortedMsg });
					st.end(abortedMsg);
				},
				{ once: true },
			);
			return st;
		});

		const turn1 = harness.submitInput("Initial streaming turn");
		await waitForCondition(() => streams.length === 1);
		expect(harness.session.isStreaming).toBe(true);

		/* По умолчанию midTurnEnter = "queue": Enter ставит в follow-up очередь */
		await harness.typeText("Queued item alpha");
		await harness.pressKey("\r");
		await harness.flush();
		expect(harness.session.getFollowUpMessages()).toEqual(["Queued item alpha"]);
		expect(streams[0]!.signal?.aborted).toBe(false);

		const queueScreen = harness.screen();
		expect(queueScreen.text()).toContain("Queued item alpha");
		expect(queueScreen.text()).toContain("[Send now · Ctrl+Enter]");
		expect(queueScreen.text()).toContain("[Edit · Alt+↑]");
		expect(queueScreen.text()).toContain("[×]");
		expect(queueScreen.text()).toContain("Enter queue");
		expect(queueScreen.text()).toContain("Ctrl+Enter send now");
		expect(queueScreen.text()).toContain("Alt+Enter steer");
		expect(queueScreen.text()).toContain("Ctrl+C stop");
		expect(queueScreen.text()).toContain("Ctrl+K commands");

		/* 1s защита от двойного нажатия Enter на пустом Composer сразу после постановки в очередь */
		await harness.pressKey("\r");
		await harness.flush();
		expect(streams[0]!.signal?.aborted).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["Queued item alpha"]);

		/* Alt+Enter в режиме queue ставит steering-сообщение */
		await harness.typeText("Steer item beta");
		await harness.pressKey("\x1b\r");
		await harness.flush();
		expect(harness.session.getSteeringMessages()).toEqual(["Steer item beta"]);

		const queuedImage = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_BASE64 };
		await harness.session.steer("Steer item with image", [queuedImage]);
		await harness.flush();
		const betaHit = harness.screen().findText("Steer item beta")!;
		const removeCol = harness.screen().rowText(betaHit.row).indexOf("[×]");
		expect(removeCol).toBeGreaterThan(0);
		await harness.mouseClick(removeCol + 1, betaHit.row);
		await harness.flush();
		expect(harness.session.getSteeringMessages()).toEqual(["Steer item with image"]);
		expect(harness.session.agent.peekQueuedMessages()).toEqual([
			expect.objectContaining({ content: [{ type: "text", text: "Steer item with image" }, queuedImage] }),
		]);
		expect(harness.session.getFollowUpMessages()).toEqual(["Queued item alpha"]);
		await harness.pressKey("\x1b[1;3A");
		await harness.flush();
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual(["Queued item alpha"]);
		expect(harness.screen().findText("Steer item with image [🖼 Image #1]")).toBeDefined();
		await harness.pressKey("\x1b\r");
		expect(harness.session.agent.peekQueuedMessages()).toEqual([
			expect.objectContaining({ content: [expect.objectContaining({ text: expect.stringContaining("Steer item with image") }), queuedImage] }),
		]);
		const editedImageHit = harness.screen().findText("Steer item with image")!;
		await harness.mouseClick(harness.screen().rowText(editedImageHit.row).indexOf("[×]") + 1, editedImageHit.row);

		/* Клик по [Edit · Alt+↑] возвращает элемент в Composer для редактирования */
		const alphaHit = harness.screen().findText("Queued item alpha")!;
		const editCol = harness.screen().rowText(alphaHit.row).indexOf("[Edit · Alt+↑]");
		expect(editCol).toBeGreaterThan(0);
		await harness.mouseClick(editCol + 2, alphaHit.row);
		await harness.flush();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(editor.getText()).toBe("Queued item alpha");

		/* Повторно ставим в очередь и кликаем [Send now]: прерывает ход и запускает новый */
		await harness.pressKey("\r");
		await harness.flush();
		expect(harness.session.getFollowUpMessages()).toEqual(["Queued item alpha"]);
		const sendHit = harness.screen().findText("[Send now · Ctrl+Enter]")!;
		await harness.mouseClick(sendHit.col + 2, sendHit.row);
		await waitForCondition(() => streams.length === 2);
		expect(streams[0]!.signal?.aborted).toBe(true);
		expect(streams[1]!.promptTexts.at(-1)).toBe("Queued item alpha");

		/* Ctrl+Enter (Send now) с текстом в Composer прерывает активный ход и сразу отправляет новый */
		await harness.typeText("Urgent override gamma");
		await harness.pressKey("\x1b[13;5u");
		await waitForCondition(() => streams.length === 3);
		expect(streams[1]!.signal?.aborted).toBe(true);
		expect(streams[2]!.promptTexts.at(-1)).toBe("Urgent override gamma");

		/* Cmd+Enter (super+enter) также вызывает Send now на macOS */
		await harness.typeText("Mac super override omega");
		await harness.pressKey("\x1b[13;9u");
		await waitForCondition(() => streams.length === 4);
		expect(streams[2]!.signal?.aborted).toBe(true);
		expect(streams[3]!.promptTexts.at(-1)).toBe("Mac super override omega");

		/* Переключение midTurnEnter = "steer": Enter -> steer, Alt+Enter -> queue */
		updatePiUiUserConfig({ midTurnEnter: "steer" });
		await harness.typeText("Direct steer delta");
		await harness.pressKey("\r");
		await harness.flush();
		expect(harness.session.getSteeringMessages()).toEqual(["Direct steer delta"]);

		await harness.typeText("Alt queued epsilon");
		await harness.pressKey("\x1b\r");
		await harness.flush();
		expect(harness.session.getFollowUpMessages()).toEqual(["Alt queued epsilon"]);

		await harness.typeText("Handled elsewhere");
		await harness.pressKey("\x1b[13;5u");
		await waitForCondition(() => !harness!.session.isStreaming);
		await harness.flush();
		expect(harness.session.getSteeringMessages()).toEqual(["Direct steer delta"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["Alt queued epsilon"]);
		harness.session.clearQueue();
		await turn1;
		await harness.waitForIdle();
		expect(callCount).toBe(4);
	});

	it("restores a queued draft and its image into a third-party editor", async () => {
		harness = await createInteractiveHarness({ width: 104, height: 30, extensionFactories: [(pi) => {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.setEditorComponent((tui, theme, kb) => new CustomEditor(tui, theme, kb));
			});
		}] });
		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		await harness.pressKey("\r");
		await harness.submitInput("/slots editor inline-1");
		const stream = createAssistantMessageEventStream();
		const done = fauxAssistantMessage("Turn done");
		let firstCall = true;
		harness.setStreamSimple(() => {
			if (firstCall) {
				firstCall = false;
				return stream;
			}
			const next = createAssistantMessageEventStream();
			next.push({ type: "done", reason: "stop", message: done });
			next.end(done);
			return next;
		});
		const turn = harness.submitInput("Keep the turn open");
		const image = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_BASE64 };
		try {
			await waitForCondition(() => !firstCall);
			await harness.session.followUp("Restore this draft", [image]);
			const edit = harness.screen().findText("[Edit · Alt+↑]")!;
			await harness.mouseClick(edit.col + 2, edit.row);
			expect(harness.screen().text()).toContain("Restore this draft [🖼 Image #1]");
			expect(harness.session.getFollowUpMessages()).toEqual([]);
		} finally {
			stream.push({ type: "done", reason: "stop", message: done });
			stream.end(done);
			await turn;
		}
		await harness.submitDraft();
		await harness.waitForIdle();
		const user = harness.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
		expect(user).toMatchObject({ message: { content: expect.arrayContaining([image]) } });
	});

	it("mounts 1-row clickable Shortcuts Bar by default, accepts Prompt Suggestion on click, and collapses to 0 rows with inline zero-shift transient hints when showShortcutsBar = false", async () => {
		const agentDir = allocateTempDir("pi-ui-shortcuts-bar-");
		harness = await createInteractiveHarness({
			agentDir,
			theme: "dark",
			width: 110,
			height: 26,
			responses: [
				fauxAssistantMessage("First reply for suggestion."),
				fauxAssistantMessage("Second reply for inline Tab suffix."),
			],
			suggestionResponses: [
				fauxAssistantMessage("Run the verification suite"),
				fauxAssistantMessage("Check edge cases"),
			],
		});

		const editor = getActiveComposerEditor()!;
		const screenOn = harness.screen();
		const topOn = findComposerTopRow(harness);
		const bottomOn = topOn + 2;
		/* showShortcutsBar = true по умолчанию: ровно 1 строка под Composer */
		expect(bottomOn).toBe(26 - 2);
		const barRowText = screenOn.rowText(25);
		expect(barRowText).toContain("Shift+Tab mode");
		expect(barRowText).toContain("Ctrl+L model");
		expect(barRowText).toContain("Ctrl+K commands");

		/* Клик по Shift+Tab mode в Shortcuts Bar переключает Session Mode */
		const modeHintCol = barRowText.indexOf("Shift+Tab mode");
		await harness.mouseClick(modeHintCol + 2, 25);
		expect(harness.screen().rowText(findComposerTopRow(harness) + 2)).toContain("Plan");
		await harness.submitInput("/mode always-approve");

		/* Клик по Ctrl+L model открывает поповер Model */
		const modelHintCol = harness.screen().rowText(25).indexOf("Ctrl+L model");
		await harness.mouseClick(modelHintCol + 2, 25);
		expect(harness.screen().text()).toContain("Search models");
		await harness.pressKey("\x1b");

		/* Включаем Prompt Suggestion: клик по приглушённому тексту принимает подсказку */
		await harness.submitInput("/suggestions on");
		await harness.submitInput("Trigger suggestion one");
		await waitForCondition(() => harness!.screen().text().includes("Run the verification suite"));
		expect(harness.screen().rowText(25)).toContain("Tab accept");

		const sugHit = harness.screen().findText("Run the verification suite")!;
		await harness.mouseClick(sugHit.col + 3, sugHit.row);
		expect(editor.getText()).toBe("Run the verification suite");

		/* Esc на непустом черновике показывает Esc again to clear в Shortcuts Bar */
		await harness.pressKey("\x1b");
		expect(harness.screen().rowText(25)).toContain("Esc again to clear");
		await harness.pressKey("\x1b");
		expect(editor.getText()).toBe("");

		/* Отключаем Shortcuts Bar: 0 строк под Composer + inline [Tab] суффикс и inline подсказки в верхней рамке */
		await harness.submitInput("/shortcuts-bar off");
		const topOff = findComposerTopRow(harness);
		expect(topOff + 2).toBe(26 - 1);

		await harness.submitInput("Trigger suggestion two");
		await waitForCondition(() => harness!.screen().text().includes("Check edge cases"));
		const topOffSug = findComposerTopRow(harness);
		expect(topOffSug + 2).toBe(26 - 1);
		expect(harness.screen().rowText(topOffSug + 1)).toContain("Check edge cases [Tab]");

		await harness.typeText("keep");
		const topBeforeEsc = findComposerTopRow(harness);
		const bottomBeforeEsc = harness.screen().rowText(topBeforeEsc + 2);
		await harness.pressKey("\x1b");
		expect(findComposerTopRow(harness)).toBe(topBeforeEsc);
		expect(harness.screen().rowText(topBeforeEsc + 2)).toBe(bottomBeforeEsc);
		expect(harness.screen().rowText(topBeforeEsc)).toContain("Esc again to clear");
	});

	it("auto-spaces Prompt Chips, collapses duplicate spaces on atomic delete, renders Kitty thumbnails on mouse hover only, and wraps/scrolls Quote & Paste popups with [Remove]/[Edit]/[Copy]", async () => {
		const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64"));

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 104,
			height: 30,
			clipboard: {
				image: {
					bytes: TINY_PNG_BYTES,
					mimeType: "image/png",
					fileName: "thumb-shot.png",
				},
				text: "Quote line one with enough words to verify wrapping without horizontal ellipsis truncation across the popup width\nQuote line two",
			},
		});

		const draftBody = () => harness!.screen().rowText(findComposerTopRow(harness!) + 1);
		const clearDraft = async () => {
			await harness!.pressKey("\x1b");
			await harness!.pressKey("\x1b");
		};
		const flushClipboard = async () => {
			for (let i = 0; i < 6; i += 1) await Promise.resolve();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			harness!.flushFrame();
		};

		await harness.typeText("Look");
		await harness.pressKey("\x16");
		await flushClipboard();
		expect(draftBody()).toContain("Look [🖼 Image #1]");

		await harness.pressKey("\x16");
		await flushClipboard();
		expect(draftBody()).toContain("Look [🖼 Image #1] [🖼 Image #2]");

		await clearDraft();
		await harness.typeText("foobar");
		await harness.pressKey("\x1b[D");
		await harness.pressKey("\x1b[D");
		await harness.pressKey("\x1b[D");
		await harness.paste("row-1\nrow-2\nrow-3\nrow-4", true);
		expect(draftBody()).toContain("foo [📋 Pasted #1 · 4 lines] bar");
		await harness.pressKey("\x7f");
		expect(draftBody()).toContain("foo bar");

		await harness.paste("row-a\nrow-b\nrow-c\nrow-d", true);
		expect(draftBody()).toContain("foo [📋 Pasted #1 · 4 lines] bar");
		await harness.pressKey("\x1b[D");
		await harness.pressKey("\x1b[3~");
		expect(draftBody()).toContain("foo bar");

		await clearDraft();
		await harness.pressKey("\x16");
		await flushClipboard();
		expect(draftBody()).toContain("[🖼 Image #1]");

		try {
			setCapabilityOverrides({ images: "kitty" });
			harness.flushFrame(true);
			expect(harness.renderFrame().join("\n")).not.toContain("\x1b_G");

			const imgChip = harness.screen().findText("[🖼 Image #1]")!;
			await harness.mouseMove(imgChip.col + 2, imgChip.row);
			const kittyFrame = harness.renderFrame().join("\n");
			expect(kittyFrame).toContain("\x1b_G");
			expect(harness.screen().text()).toContain("thumb-shot.png");
			expect(harness.screen().text()).toContain("2×3");

			await harness.mouseMove(90, 2);
			expect(harness.renderFrame().join("\n")).not.toContain("\x1b_G");

			setCapabilityOverrides({ images: null });
			await harness.mouseMove(imgChip.col + 2, imgChip.row);
			const fallbackFrame = harness.renderFrame().join("\n");
			expect(fallbackFrame).not.toContain("\x1b_G");
			expect(fallbackFrame).not.toContain("\x1b]1337;File=");
			expect(harness.screen().text()).toContain("thumb-shot.png");
			await harness.mouseMove(90, 2);
		} finally {
			setCapabilityOverrides({});
			resetCapabilitiesCache();
		}

		await clearDraft();
		const longWrappedLine =
			"LONG_START alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho LONG_END";
		const twentyLines = [
			longWrappedLine,
			...Array.from({ length: 19 }, (_, i) => `paste-detail-line-${i + 2}`),
		].join("\n");
		await harness.paste(twentyLines, true);
		const pasteChipHit = harness.screen().findText("[📋 Pasted #1 · 20 lines]")!;
		await harness.mouseMove(pasteChipHit.col + 3, pasteChipHit.row);
		const pastePopup = harness.screen();
		expect(pastePopup.text()).toContain("LONG_START");
		expect(pastePopup.text()).toContain("LONG_END");
		expect(pastePopup.text()).toContain("paste-detail-line-12");
		expect(pastePopup.text()).toContain("[Copy]");
		expect(pastePopup.text()).toContain("[Remove]");

		const bodyInsidePopup = pastePopup.findText("paste-detail-line-5")!;
		await harness.mouseWheel("down", bodyInsidePopup.col + 2, bodyInsidePopup.row, 10);
		expect(harness.screen().text()).toContain("paste-detail-line-20");

		const quoteClipboardBackup = await getActiveHostRuntime()!.clipboard.readText?.();
		const copyBtn = harness.screen().findText("[Copy]")!;
		await harness.mouseClick(copyBtn.col + 1, copyBtn.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(twentyLines);

		await harness.mouseMove(pasteChipHit.col + 3, pasteChipHit.row);
		const removeBtn = harness.screen().findText("[Remove]")!;
		await harness.mouseClick(removeBtn.col + 2, removeBtn.row);
		expect(draftBody()).toContain("Ask or describe a task…");

		harness.setClipboard({ text: quoteClipboardBackup ?? null });
		await harness.pressKey("\x1b[113;3u");
		await flushClipboard();
		const quoteChipHit = harness.screen().findText("[❝ Quote #1 · 2 lines]")!;
		await harness.mouseMove(quoteChipHit.col + 3, quoteChipHit.row);
		const quotePopupText = harness.screen().text();
		expect(quotePopupText).toContain("truncation across the popup width");
		expect(quotePopupText).toContain("[Edit]");
		expect(quotePopupText).toContain("[Copy]");
		expect(quotePopupText).toContain("[Remove]");

		const editBtn = harness.screen().findText("[Edit]")!;
		await harness.mouseClick(editBtn.col + 1, editBtn.row);
		expect(harness.screen().text()).toContain("Quote #1");
		await harness.pressKey("\x1b");
	});

	it("copies a Prompt Chip through the terminal when the clipboard has no custom writer", async () => {
		harness = await createInteractiveHarness({ width: 104, height: 30, clipboard: { async readText() { return null; } } });
		const text = "first\nsecond\nthird\nfourth";
		await harness.paste(text, true);
		const pill = harness.screen().findText("Pasted #1")!;
		await harness.mouseMove(pill.col + 2, pill.row);
		const copy = harness.screen().findText("[Copy]")!;
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		try {
			Object.defineProperty(process, "platform", { value: "linux", configurable: true });
			await harness.mouseClick(copy.col + 2, copy.row);
		} finally {
			Object.defineProperty(process, "platform", originalPlatform);
		}
		expect(harness.terminal.writes.join("")).toContain(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	});

	it("renders explicit block cursors across all inputs with host Input editing/Undo and makes bottom-docked ask_user_question 100% mouse-operable with Esc park + Tab return", async () => {
		const agentDir = allocateTempDir("pi-ui-cursors-askuser-");
		const multiQuestionParams = {
			questions: [
				{
					header: "Storage",
					question: "Choose a storage engine",
					options: [
						{
							label: "SQLite",
							description: "Embedded local file",
							preview: Array.from({ length: 24 }, (_, i) => `SQL_LINE_${i + 1}`).join("\n"),
						},
						{ label: "PostgreSQL", description: "Client-server SQL" },
					],
				},
				{
					header: "Features",
					question: "Select optional capabilities",
					multiSelect: true,
					options: [
						{ label: "Metrics", description: "Emit telemetry" },
						{ label: "Backups", description: "Nightly snapshots" },
					],
				},
			],
		};

		const t1 = new Date(2026, 4, 12, 10, 0).getTime();
		harness = await createInteractiveHarness({
			agentDir,
			theme: "light",
			width: 112,
			height: 30,
			trueColor: false,
			initialEntries: [
				makeUserEntry("u0", null, "Transcript scroll anchor for ask_user park", t1),
				makeAssistantEntry(
					"a0",
					"u0",
					Array.from({ length: 40 }, (_, i) => `ask-transcript-row-${i + 1}`).join("\n"),
					t1 + 1000,
				),
			],
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall(
							"ask_user_question",
							JSON.parse(JSON.stringify(multiQuestionParams)),
							{ id: "ask-mouse-1" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Explanation: SQLite is embedded; PostgreSQL is client-server."),
				fauxAssistantMessage("Mouse questionnaire completed."),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"ask_user_question",
							{
								questions: [
									{
										header: "Confirm",
										question: "Proceed with cleanup?",
										options: [{ label: "Yes" }, { label: "No" }],
									},
								],
							},
							{ id: "ask-cancel-2" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Cancelled flow acknowledged."),
			],
		});

		const composerScreen = harness.screen();
		const placeholderHit = composerScreen.findText("Ask or describe")!;
		expect(composerScreen.cellAt(placeholderHit.row, placeholderHit.col)?.inverse).toBe(true);

		await harness.pressKey("\x0b");
		const palScreen = harness.screen();
		const searchHit = palScreen.findText("Search")!;
		expect(palScreen.cellAt(searchHit.row, searchHit.col)?.inverse).toBe(true);
		await harness.typeText("abc");
		await harness.pressKey("\x1b[D");
		await harness.typeText("X");
		expect(harness.screen().text()).toContain("abXc");
		await harness.pressKey("\x1a");
		expect(harness.screen().text()).toContain("abc");
		await harness.pressKey("\x1b[122;6u");
		expect(harness.screen().text()).toContain("abXc");
		await harness.pressKey("\x1b");

		const askTurn1 = harness.submitInput("Start mouse questionnaire");
		await waitForCondition(() => harness!.screen().text().includes("Choose a storage engine"));

		const scroll = getActiveHostRuntime()!.scroll!;
		const scrollBeforePark = scroll.scrollTop;

		/* Esc на пустом выборе паркует фокус в транскрипт, а Shortcuts Bar показывает Tab return to question */
		await harness.pressKey("\x1b");
		expect(harness.screen().text()).toContain("Tab return to question");
		expect(harness.screen().text()).toContain("Choose a storage engine");
		await harness.pressKey("\x1b[5~");
		expect(scroll.scrollTop).toBeLessThan(scrollBeforePark);

		/* При showShortcutsBar = false подсказка Tab return to question отображается в заголовке опросника */
		updatePiUiUserConfig({ showShortcutsBar: false });
		harness.flushFrame(true);
		expect(harness.screen().text()).toContain("Tab return to question");
		updatePiUiUserConfig({ showShortcutsBar: true });
		harness.flushFrame(true);

		/* Tab возвращает фокус в опросник */
		await harness.pressKey("\t");
		expect(harness.screen().text()).not.toContain("Tab return to question");

		/* Колесо над preview-панелью прокручивает превью SQL_LINE */
		const sqlHit = harness.screen().findText("SQL_LINE_1")!;
		await harness.mouseWheel("down", sqlHit.col + 2, sqlHit.row, 5);
		expect(harness.screen().text()).not.toContain("SQL_LINE_1\n");

		/* Клик по вкладке Features переключает вкладку, клик обратно по Storage возвращает */
		const featTab = harness.screen().findText("☐ Features")!;
		await harness.mouseClick(featTab.col + 2, featTab.row);
		expect(harness.screen().text()).toContain("Select optional capabilities");
		const storageTab = harness.screen().findText("☐ Storage")!;
		await harness.mouseClick(storageTab.col + 2, storageTab.row);
		expect(harness.screen().text()).toContain("Choose a storage engine");

		/* Клик по [Explain] запускает объяснение */
		const explainBtn = harness.screen().findText("[Explain]")!;
		await harness.mouseClick(explainBtn.col + 2, explainBtn.row);
		expect(harness.screen().text()).toMatch(/Explaining|Explanation/);

		/* Клик по варианту PostgreSQL выбирает ответ и переходит на Features */
		const pgHit = harness.screen().findText("2. PostgreSQL")!;
		await harness.mouseMove(pgHit.col + 3, pgHit.row);
		const hoverBg = harness.screen().cellAt(pgHit.row, pgHit.col + 3)?.bg;
		expect(hoverBg?.kind).toBe("palette256");
		if (hoverBg?.kind === "palette256") {
			const { hue, saturation } = rgbHueDegrees(parseAnsiColorRgb(`\x1b[48;5;${hoverBg.index}m`)!);
			expect(saturation < 0.04 || (hue > 198 && hue < 255)).toBe(true);
		}
		await harness.mouseClick(pgHit.col + 3, pgHit.row);
		expect(harness.screen().text()).toContain("Select optional capabilities");

		/* Клик по опции Metrics и по Other -> ввод кастомного текста */
		const metricsHit = harness.screen().findText("Metrics")!;
		await harness.mouseClick(metricsHit.col + 2, metricsHit.row);
		const otherHit = harness.screen().findText("Type something.")!;
		await harness.mouseClick(otherHit.col + 2, otherHit.row);
		expect(harness.screen().cellAt(otherHit.row, otherHit.col)?.inverse).toBe(true);
		await harness.typeText("Custom audit");

		/* Клик по [Note] открывает редактор заметки, ввод + клик по [Apply] сохраняет заметку */
		const noteBtn = harness.screen().findText("[Note]")!;
		await harness.mouseClick(noteBtn.col + 2, noteBtn.row);
		expect(harness.screen().text()).toContain("Question note");
		await harness.typeText("Keep latency low");
		const applyBtn = harness.screen().findText("[Apply]")!;
		await harness.mouseClick(applyBtn.col + 2, applyBtn.row);
		expect(harness.screen().text()).toContain("Keep latency low");

		/* Клик по [Next] / вкладке Submit -> клик по [Submit] отправляет все ответы мышью */
		const submitTab = harness.screen().findText("✔ Submit")!;
		await harness.mouseClick(submitTab.col + 2, submitTab.row);
		expect(harness.screen().text()).toContain("Review your answers");
		const submitBtn = harness.screen().findText("[Submit]")!;
		await harness.mouseClick(submitBtn.col + 2, submitBtn.row);
		await askTurn1;

		const allMsgs1 = harness.session.messages;
		const toolRes1 = allMsgs1.find(
			(m): m is Extract<(typeof allMsgs1)[number], { role: "toolResult" }> =>
				m.role === "toolResult" && m.toolCallId === "ask-mouse-1",
		);
		const parsed1 = JSON.parse(contentText(toolRes1!.content));
		expect(parsed1.cancelled).toBe(false);
		expect(parsed1.answers[0].selected).toEqual(["PostgreSQL"]);
		expect(parsed1.answers[1].selected).toEqual(["Metrics"]);
		expect(parsed1.answers[1].custom).toBe("Custom audit");
		expect(parsed1.answers[1].notes).toBe("Keep latency low");

		/* Клик по [Cancel] отменяет второй опросник мышью */
		const askTurn2 = harness.submitInput("Start cancel questionnaire");
		await waitForCondition(() => harness!.screen().text().includes("Proceed with cleanup?"));
		const cancelBtn = harness.screen().findText("[Cancel]")!;
		await harness.mouseClick(cancelBtn.col + 2, cancelBtn.row);
		await askTurn2;

		const allMsgs2 = harness.session.messages;
		const toolRes2 = allMsgs2.find(
			(m): m is Extract<(typeof allMsgs2)[number], { role: "toolResult" }> =>
				m.role === "toolResult" && m.toolCallId === "ask-cancel-2",
		);
		expect(JSON.parse(contentText(toolRes2!.content)).cancelled).toBe(true);
	});

	it("filters Thinking popover levels per model thinkingLevelMap and moves bottom-border highlight across Model -> Thinking -> Mode on Tab", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 28,
			models: [
				{ id: "gemini-carbon", name: "Gemini 4 Carbon", reasoning: true },
				{ id: "astra-max", name: "GPT-6.2 Astra", reasoning: true },
			],
			thinkingLevel: "high",
		});

		const allModels = getActiveHostRuntime()!.ctx.modelRegistry.getAll();
		const carbonModel = allModels.find((m) => m.id === "gemini-carbon")!;
		carbonModel.thinkingLevelMap = {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		};
		const astraModel = allModels.find((m) => m.id === "astra-max")!;
		astraModel.thinkingLevelMap = {
			xhigh: "xhigh",
			max: "max",
		};
		await harness.session.setModel(carbonModel, { persist: false });

		const topRow = findComposerTopRow(harness);
		const bottomRow = topRow + 2;
		const bottomText0 = harness.screen().rowText(bottomRow);
		const modelCol = bottomText0.indexOf("Gemini 4 Carbon");
		const thinkingCol = bottomText0.indexOf("(high)");
		const modeCol = bottomText0.indexOf("Always-approve");
		expect(modelCol).toBeGreaterThan(0);
		expect(thinkingCol).toBeGreaterThan(modelCol);
		expect(modeCol).toBeGreaterThan(thinkingCol);

		const idleModelFg = harness.screen().cellAt(bottomRow, modelCol + 1)?.fg;
		const idleThinkingFg = harness.screen().cellAt(bottomRow, thinkingCol + 1)?.fg;

		/* Открываем меню моделей кликом мыши: подсвечена только кнопка модели */
		await harness.mouseMove(modelCol + 2, bottomRow);
		await harness.mouseClick(modelCol + 2, bottomRow);
		expect(harness.screen().text()).toContain("Search models");
		const activeModelFg = harness.screen().cellAt(bottomRow, modelCol + 1)?.fg;
		expect(activeModelFg).not.toEqual(idleModelFg);
		expect(harness.screen().cellAt(bottomRow, thinkingCol + 1)?.fg).toEqual(idleThinkingFg);

		/* Нажимаем Tab: открывается Thinking, подсветка уходит с Model и переходит на (high) */
		await harness.pressKey("\t");
		const thinkingScreen = harness.screen();
		expect(thinkingScreen.text()).toContain("Thinking");
		expect(thinkingScreen.cellAt(bottomRow, modelCol + 1)?.fg).toEqual(idleModelFg);
		expect(thinkingScreen.cellAt(bottomRow, thinkingCol + 1)?.fg).toEqual(activeModelFg);

		/* Для Gemini 4 Carbon доступны только low, medium, high (без off, minimal, xhigh, max) */
		expect(thinkingScreen.text()).toContain("low");
		expect(thinkingScreen.text()).toContain("medium");
		expect(thinkingScreen.text()).toContain("high");
		expect(thinkingScreen.text()).not.toContain("minimal");
		expect(thinkingScreen.text()).not.toContain("xhigh");
		expect(thinkingScreen.text()).not.toContain("\n  off");

		/* Ещё один Tab переносит подсветку на кнопку режима (Always-approve) */
		await harness.pressKey("\t");
		const modeScreen = harness.screen();
		expect(modeScreen.text()).toContain("Session Mode");
		expect(modeScreen.cellAt(bottomRow, thinkingCol + 1)?.fg).toEqual(idleThinkingFg);
		expect(modeScreen.cellAt(bottomRow, modeCol + 1)?.fg).toEqual(activeModelFg);

		/* Переключаемся на GPT-6.2 Astra -> Thinking показывает xhigh и max */
		await harness.pressKey("\t");
		await harness.typeText("Astra");
		await harness.pressKey("\r");
		await harness.waitForIdle();
		expect(harness.session.model?.id).toBe("astra-max");

		await harness.pressKey("\x1b[1077;3u");
		const astraThinkingText = harness.screen().text();
		expect(astraThinkingText).toContain("xhigh");
		expect(astraThinkingText).toContain("max");
		await harness.pressKey("\x1b");
	});

	it("aligns custom aboveEditor and belowEditor widgets to symmetric x=4..width-5 dialogue margins and translates mouse clicks", async () => {
		let clickedLocalX = -1;
		const width = 90;
		harness = await createInteractiveHarness({
			theme: "dark",
			width,
			height: 28,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_ev, ctx) => {
						ctx.ui.setWidget("custom-above", () => ({
							invalidate() {},
							render(innerW: number): string[] {
								const left = "◆ 2 agy artifacts · /agy-artifacts";
								const right = "RIGHT_EDGE";
								const gap = " ".repeat(Math.max(1, innerW - visibleWidth(left) - right.length));
								return [`${left}${gap}${right}`];
							},
							handleMouse(event) {
								if (event.type === "click") {
									clickedLocalX = event.x;
									return { handled: true, render: false };
								}
								return undefined;
							},
						}));
						ctx.ui.setWidget("custom-below", ["Below status line"], { placement: "belowEditor" });
					});
				},
			],
		});

		const screen = harness.screen();
		const aboveHit = screen.findText("◆ 2 agy artifacts")!;
		expect(aboveHit).toBeDefined();
		expect(aboveHit.col).toBe(4);
		const aboveRow = screen.rowText(aboveHit.row);
		expect(aboveRow.slice(width - 4)).toBe("    ");
		expect(aboveRow.slice(width - 4 - "RIGHT_EDGE".length, width - 4)).toBe("RIGHT_EDGE");

		const belowHit = screen.findText("Below status line")!;
		expect(belowHit).toBeDefined();
		expect(belowHit.col).toBe(4);

		/* Клик по /agy-artifacts передаёт в виджет локальную координату x без 4-колоночного внешнего отступа */
		const cmdCol = screen.findText("/agy-artifacts")!.col;
		await harness.mouseClick(cmdCol + 2, aboveHit.row);
		expect(clickedLocalX).toBe(cmdCol + 2 - 4);
	});

	it("renders Skill Chips and Prompt Chips cleanly in mid-turn Steer/Queue strip, restores /skill:<name> + live chips on [Edit · Alt+↑], and hides raw <skill> XML in /tree, /fork, and reloaded history", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "pi-ui-queue-skill-"));
		let s1: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		let s1Ended = false;
		try {
			const skillDir = join(tmpCwd, ".agents", "skills", "retro");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				[
					"---",
					"name: retro",
					"description: Run sprint retrospective",
					"---",
					"# Retro Skill Body",
					"RETRO_SECRET_RULE_LINE_1",
				].join("\n"),
				"utf8",
			);
			let callCount = 0;
			harness = await createInteractiveHarness({
				theme: "dark",
				cwd: tmpCwd,
				additionalSkillPaths: [skillDir],
				width: 110,
				height: 30,
				persistSession: true,
				settings: { midTurnEnter: "steer" },
				streamSimple: () => {
					callCount += 1;
					if (callCount === 1) {
						s1 = createAssistantMessageEventStream();
						return s1;
					}
					const doneStream = createAssistantMessageEventStream();
					const msg = fauxAssistantMessage("Handled skill steer.");
					queueMicrotask(() => {
						doneStream.push({ type: "start", partial: msg });
						doneStream.push({ type: "done", reason: "stop", message: msg });
						doneStream.end(msg);
					});
					return doneStream;
				},
			});

			const firstTurn = harness.submitInput("Initial slow task");
			await waitForCondition(() => s1 !== undefined);
			s1!.push({ type: "start", partial: fauxAssistantMessage("") });
			await harness.flush();

			/* Отправляем во время хода /skill:retro + многострочную вставку в очередь Steer (пробел после чипа ставится автоматически) */
			await harness.typeText("/skill:retro ");
			await harness.paste("alpha1\nalpha2\nalpha3\nalpha4", true);
			await harness.typeText("review sprint");
			await harness.pressKey("\x1b\r");
			await harness.flush();

			const qScreen = harness.screen();
			expect(qScreen.text()).toContain("Steer:");
			expect(qScreen.text()).toContain("/retro");
			expect(qScreen.text()).toContain("[📋 Pasted #1 · 4 lines]");
			expect(qScreen.text()).toContain("review sprint");
			expect(qScreen.text()).not.toContain("<skill");
			expect(qScreen.text()).not.toContain("RETRO_SECRET_RULE_LINE_1");
			expect(qScreen.text()).not.toContain("alpha2");

			/* Клик по пилюле /retro прямо в строке очереди открывает превью SKILL.md */
			const queueSkillHit = qScreen.findText("/retro")!;
			expect(queueSkillHit).toBeDefined();
			await harness.mouseClick(queueSkillHit.col + 1, queueSkillHit.row);
			expect(harness.screen().text()).toContain("RETRO_SECRET_RULE_LINE_1");
			const closeSkillBtn = harness.screen().findText("[×]")!;
			await harness.mouseClick(closeSkillBtn.col + 1, closeSkillBtn.row);
			expect(harness.screen().text()).not.toContain("RETRO_SECRET_RULE_LINE_1");

			/* Клик по [Edit · Alt+↑] возвращает чистый /skill:retro + живой чип без 300 строк <skill> XML */
			const editBtn = harness.screen().findText("[Edit · Alt+↑]")!;
			await harness.mouseClick(editBtn.col + 2, editBtn.row);
			const restoredDraft = getActiveComposerEditor()!.getText();
			expect(restoredDraft).toContain("/skill:retro");
			expect(restoredDraft).toContain("[📋 Pasted #1 · 4 lines]");
			expect(restoredDraft).toContain("review sprint");
			expect(restoredDraft).not.toContain("<skill");

			/* Снова ставим в очередь и завершаем ход */
			await harness.pressKey("\x1b\r");
			await harness.flush();
			const msg1 = fauxAssistantMessage("First finished.");
			s1Ended = true;
			s1!.push({ type: "done", reason: "stop", message: msg1 });
			s1!.end(msg1);
			await firstTurn;
			await harness.waitForIdle();

			/* Проверяем /tree: показывает /retro · [📋 Pasted #1 · 4 lines] review sprint без <skill> */
			await harness.pressKey("\x1b");
			await harness.pressKey("\x1b");
			const treeText = harness.screen().text();
			expect(treeText).toContain("/retro · [📋 Pasted #1 · 4 lines] review sprint");
			expect(treeText).not.toContain("<skill");
			await harness.pressKey("\x1b");

			/* Проверяем /fork: также показывает очищенный текст промпта со скиллом и чипом */
			await harness.typeText("/fork");
			await harness.pressKey("\r");
			await harness.flush();
			const forkText = harness.screen().text();
			expect(forkText).toContain("/retro · [📋 Pasted #1 · 4 lines] review sprint");
			expect(forkText).not.toContain("<skill");
			await harness.pressKey("\x1b");
		} finally {
			if (s1 && !s1Ended) {
				const fallback = fauxAssistantMessage("Aborted cleanup.");
				s1.push({ type: "done", reason: "stop", message: fallback });
				s1.end(fallback);
			}
			rmSync(tmpCwd, { recursive: true, force: true });
		}
	});
});
