import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	isKittyProtocolActive,
	setKittyProtocolActive,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getActiveComposerEditor,
	registerComposerHooks,
} from "../src/features/chrome/composer.ts";
import { getOutlineSettings } from "../src/features/outline-rail/index.ts";
import { bgRgb } from "../src/shared/ansi.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import { beginHoverMovePass, finishHoverMovePass } from "../src/shared/runtime-hooks.ts";
import { getSessionWorkflow } from "../src/shared/session-workflow.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

function extractFirstFgRgb(ansi: string): [number, number, number] | undefined {
	const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
	if (!m) return undefined;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function findComposerTopRow(harness: InteractiveHarness): number {
	const screen = harness.screen();
	for (let r = screen.height - 1; r >= 0; r -= 1) {
		const row = screen.rowText(r);
		if (row.startsWith("╭") && row.endsWith("╮")) {
			return r;
		}
	}
	throw new Error("Expected rounded composer top border on terminal screen");
}

describe("Composer & multi-layout shortcuts (real InteractiveMode)", () => {
	const initialKitty = isKittyProtocolActive();
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		setKittyProtocolActive(initialKitty);
		registerComposerHooks(undefined);
		getOutlineSettings().enabled = true;
		getSessionWorkflow().restore([], false);
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
	});

	it("triggers Alt+M, Ctrl+Alt+P, Ctrl+Alt+O, Ctrl+K, Alt+<letter>, and Super+<letter> identically across Cyrillic, Latin, and macOS Option encodings without corrupting plain text or pastes", async () => {
		let altYFires = 0;
		let superBFires = 0;

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 28,
			clipboard: { text: "Clipped quote sample" },
			extensionFactories: [
				(pi) => {
					pi.registerShortcut("alt+y", {
						description: "Test Option/Alt shortcut",
						handler: () => {
							altYFires += 1;
						},
					});
					pi.registerShortcut("super+b", {
						description: "Test Super shortcut",
						handler: () => {
							superBFires += 1;
						},
					});
				},
			],
		});

		const editor = getActiveComposerEditor()!;
		expect(editor).toBeInstanceOf(CustomEditor);
		expect(editor.constructor.name).toBe("PiUiComposerEditor");

		const wf = getSessionWorkflow();
		expect(wf.mode).toBe("code");

		/* Alt+M в русской раскладке (Kitty CSI-u, ESC+ь, modifyOtherKeys, macOS Option µ, игнор отпускания клавиши, baseLayoutKey) */
		await harness.pressKey("\x1b[1100;3u");
		expect(wf.mode).toBe("plan");
		await harness.pressKey("\x1bь");
		expect(wf.mode).toBe("safe");
		await harness.pressKey("\x1b[27;3;1100~");
		expect(wf.mode).toBe("code");
		await harness.pressKey("µ");
		expect(wf.mode).toBe("plan");
		await harness.pressKey("\x1b[181;1:3u");
		expect(wf.mode).toBe("plan");
		await harness.pressKey("\x1b[109;3u");
		expect(wf.mode).toBe("safe");
		await harness.pressKey("\x1b[1100::109;3u");
		expect(wf.mode).toBe("code");

		/* Ctrl+Alt+P в русской и macOS Option раскладках */
		await harness.pressKey("\x1b[1079;7u");
		expect(wf.mode).toBe("plan");
		await harness.pressKey("\x1b[27;7;1079~");
		expect(wf.mode).toBe("code");
		await harness.pressKey("\x1b[960;5u");
		expect(wf.mode).toBe("plan");
		setKittyProtocolActive(true);
		await harness.pressKey("\x1b\x10");
		expect(wf.mode).toBe("code");
		await harness.pressKey("\x1bm");
		expect(wf.mode).toBe("plan");
		await harness.pressKey("\x1bь");
		expect(wf.mode).toBe("safe");
		await harness.pressKey("\x1bm");
		expect(wf.mode).toBe("code");

		/* Ctrl+Alt+O переключает Outline Rail в любой раскладке */
		expect(getOutlineSettings().enabled).toBe(true);
		await harness.pressKey("\x1b[1097;7u");
		expect(getOutlineSettings().enabled).toBe(false);
		await harness.pressKey("\x1b[27;7;1097~");
		expect(getOutlineSettings().enabled).toBe(true);
		await harness.pressKey("\x1b[248;5u");
		expect(getOutlineSettings().enabled).toBe(false);
		await harness.pressKey("\x1b\x0f");
		expect(getOutlineSettings().enabled).toBe(true);
		setKittyProtocolActive(initialKitty);

		/* Ctrl+K в русской раскладке (\x1b[1083;5u) открывает и закрывает Command Palette в реальном InteractiveMode */
		await harness.pressKey("\x1b[1083;5u");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Command Palette");
		await harness.pressKey("\x1b[1083;5u");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		/* Пользовательские Alt+<letter> (Alt+Y / Alt+н / ¥ / њ) и нативный Alt+Q (ESC+й, œ, ј) */
		await harness.pressKey("\x1bн");
		await harness.pressKey("\x1b[1085;3u");
		await harness.pressKey("¥");
		await harness.pressKey("њ");
		expect(altYFires).toBe(4);

		for (const seq of ["\x1bй", "\x1b[1081;3u", "œ", "ј"]) {
			editor.setText("");
			await harness.pressKey(seq);
			await harness.waitForIdle();
			expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");
		}
		editor.setText("");

		/* Super+<letter> в русской раскладке (Super+и -> super+b) */
		await harness.pressKey("\x1b[1080;9u");
		await harness.pressKey("\x1b[27;9;1080~");
		expect(superBFires).toBe(2);

		/* Обычный кириллический текст и bracketed paste с символами µ / œ не перехватываются хоткеями */
		const shortcutSpy = vi.spyOn(
			editor as unknown as { onExtensionShortcut: (data: string) => boolean },
			"onExtensionShortcut",
		);
		await harness.pressKey("п");
		expect(shortcutSpy).toHaveBeenCalledTimes(1);
		shortcutSpy.mockRestore();

		for (const ch of ["р", "и", "в", "е", "т", " ", "π", "©", " "]) {
			await harness.pressKey(ch);
		}
		await harness.paste("µ œ", true);
		expect(editor.getText()).toBe("привет π© µ œ");
		expect(wf.mode).toBe("code");
		expect(altYFires).toBe(4);
	});

	it("renders a 4-sided rounded composer box with › prefix, empty-draft placeholder, multiline alignment, and clean uninterrupted bottom border", async () => {
		harness = await createInteractiveHarness({ theme: "dark", width: 80, height: 24 });

		const editor = getActiveComposerEditor()!;
		expect(editor).toBeInstanceOf(CustomEditor);
		expect(editor.constructor.name).toBe("PiUiComposerEditor");

		editor.setPaddingX(4);
		expect(editor.getPaddingX()).toBe(0);

		const emptyScreen = harness.screen();
		const topRow = findComposerTopRow(harness);
		expect(emptyScreen.rowText(topRow)).toBe(`╭${"─".repeat(78)}╮`);
		expect(emptyScreen.rowText(topRow + 1).startsWith("│ › Спроси или опиши задачу…")).toBe(true);
		expect(emptyScreen.rowText(topRow + 1).endsWith(" │")).toBe(true);
		expect(emptyScreen.rowText(topRow + 2)).toBe(`╰${"─".repeat(78)}╯`);

		await harness.typeText("Сделай рефакторинг");
		await harness.pressKey("\x1b[13;2u");
		await harness.typeText("второй строки");

		const typedScreen = harness.screen();
		const typedTop = findComposerTopRow(harness);
		expect(typedScreen.rowText(typedTop)).toBe(`╭${"─".repeat(78)}╮`);
		expect(typedScreen.rowText(typedTop + 1).startsWith("│ › Сделай рефакторинг")).toBe(true);
		expect(typedScreen.rowText(typedTop + 1).endsWith(" │")).toBe(true);
		expect(typedScreen.rowText(typedTop + 1)).not.toContain("Спроси или опиши задачу");
		expect(typedScreen.rowText(typedTop + 2).startsWith("│   второй строки")).toBe(true);
		expect(typedScreen.rowText(typedTop + 2).endsWith(" │")).toBe(true);
		expect(typedScreen.rowText(typedTop + 3)).toBe(`╰${"─".repeat(78)}╯`);
		expect(typedScreen.text()).not.toContain("⌥↵");
		expect(typedScreen.text()).not.toContain("отправить");

		for (const w of [1, 2, 3, 7, 8, 12, 28, 44, 120]) {
			const linesAtWidth = editor.render(w);
			for (const line of linesAtWidth) {
				expect(visibleWidth(line)).toBe(w);
			}
		}

		for (const sample of ["🚀", "a🚀", "中文🚀"]) {
			editor.setText(sample);
			for (let w = 1; w <= 20; w += 1) {
				const linesAtWidth = editor.render(w);
				expect(linesAtWidth.length).toBeGreaterThanOrEqual(3);
				for (const line of linesAtWidth) {
					expect(visibleWidth(line), `sample=${sample} width=${w}`).toBe(w);
				}
			}
		}

		editor.setText(" ");
		expect(stripTerminalSequences(editor.render(80)[1]!)).not.toContain("Спроси или опиши задачу");

		editor.setText("");
		expect(stripTerminalSequences(editor.render(80)[1]!).startsWith("│ › Спроси или опиши задачу…")).toBe(
			true,
		);
	});

	it("renders adaptive light/dark border tones without purple, clickable emoji-free Session Mode & Plan pills, mouse cursor positioning, and atomic Prompt Chip hooks", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 90,
			height: 26,
			responses: [fauxAssistantMessage("1. Normalize shortcuts\n2. Frame composer")],
		});

		const editor = getActiveComposerEditor()!;
		const wf = getSessionWorkflow();

		for (const themeMode of ["dark", "light"] as const) {
			harness.setTheme(themeMode);

			/* Внешняя перезапись borderColor (как в InteractiveMode.updateEditorBorderColor) не ломает сине-сланцевую рамку */
			editor.borderColor = (s: string) => `\x1b[38;2;210;20;220m${s}\x1b[39m`;

			wf.setMode("code");
			wf.endAgentTurn();
			await harness.mouseMove(10, 2);

			editor.focused = false;
			const unfocusedIdleRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			editor.focused = true;
			const focusedIdleRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			const composerTop = findComposerTopRow(harness);
			editor.focused = false;
			await harness.mouseMove(10, composerTop + 1);
			const unfocusedHoverRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			editor.focused = true;
			const hoverRgb = extractFirstFgRgb(editor.render(90)[0]!)!;
			expect(unfocusedHoverRgb).toEqual(hoverRgb);

			wf.beginAgentTurn();
			const streamingRgb = extractFirstFgRgb(editor.render(90)[0]!)!;
			wf.endAgentTurn();

			wf.setMode("plan");
			const planRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			wf.setMode("safe");
			const safeRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			const rgbs = [unfocusedIdleRgb, focusedIdleRgb, hoverRgb, streamingRgb, planRgb, safeRgb];
			const unique = new Set(rgbs.map((c) => c.join(",")));
			expect(unique.size).toBe(6);
			for (const [r, g, b] of rgbs) {
				expect(r > g && b > g, `purple border rgb(${r},${g},${b}) in ${themeMode}`).toBe(false);
			}

			wf.setMode("code");
			await harness.mouseMove(10, 2);
		}

		/* Переходим в Plan Mode и получаем реальный план через fauxProvider, затем закрываем стартовую модалку Esc */
		harness.setTheme("dark");
		await harness.submitInput("/mode plan");
		await harness.submitInput("Build the two-step plan");
		if (hasBlockingModalOverlay(harness.tui)) {
			await harness.pressKey("\x1b");
		}
		wf.setPlanComment(0, "Check bracketed paste");
		harness.flushFrame();

		const darkScreen = harness.screen();
		const topBorderRow = findComposerTopRow(harness);
		const plainTop = darkScreen.rowText(topBorderRow);
		expect(plainTop.startsWith("╭")).toBe(true);
		expect(plainTop.endsWith("╮")).toBe(true);
		expect(plainTop).toContain(" Plan ");
		expect(plainTop).toContain(" План (1) ");
		expect(/\p{Extended_Pictographic}/u.test(plainTop)).toBe(false);
		expect(plainTop).not.toContain("◈");
		expect(plainTop).not.toContain("🛡");
		expect(plainTop).not.toContain("📋");

		/* Клик мышью по пилюле «План (1)» в верхней рамке композера открывает Plan Studio */
		const planPillCol = plainTop.indexOf("План (1)");
		expect(planPillCol).toBeGreaterThan(0);
		await harness.mouseClick(planPillCol + 2, topBorderRow);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Normalize shortcuts");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		/* Клик мышью по пилюле «Plan» переключает режим обратно в Code */
		const modePillCol = harness.screen().rowText(findComposerTopRow(harness)).indexOf("Plan");
		expect(modePillCol).toBeGreaterThan(0);
		await harness.mouseClick(modePillCol + 1, findComposerTopRow(harness));
		expect(wf.mode).toBe("code");

		/* В светлой теме в режиме Auto-Safe клик по пилюле «Auto-Safe» также переключает в Code */
		harness.setTheme("light");
		await harness.submitInput("/mode safe");
		const lightTopRow = findComposerTopRow(harness);
		const plainLightTop = harness.screen().rowText(lightTopRow);
		expect(plainLightTop).toContain(" Auto-Safe ");
		expect(plainLightTop).toContain(" План (1) ");
		expect(/\p{Extended_Pictographic}/u.test(plainLightTop)).toBe(false);
		const safePillCol = plainLightTop.indexOf("Auto-Safe");
		await harness.mouseClick(safePillCol + 2, lightTopRow);
		expect(wf.mode).toBe("code");
		harness.setTheme("dark");

		editor.setWorkingStatusIndicator({
			renderInBorder: () => "● Working…",
			renderSpinnerInBorder: () => "●",
		} as never);
		const workingTop = editor.render(90)[0]!;
		expect(visibleWidth(workingTop)).toBe(90);
		expect(stripTerminalSequences(workingTop)).toContain("● Working…");
		editor.setWorkingStatusIndicator(undefined);

		/* Позиционирование курсора реальным SGR-кликом мыши внутри рамки композера */
		editor.setText("abcdef");
		harness.flushFrame();
		const bodyRow = findComposerTopRow(harness) + 1;
		await harness.mouseClick(4 + 3, bodyRow);
		await harness.typeText("X");
		expect(editor.getText()).toBe("abcXdef");

		/* Атомарная навигация и удаление пилюль через ComposerHooks */
		const chipRe = /\[Chip #\d+\]/g;
		registerComposerHooks({
			findAtomicTokenSpans(text) {
				return [...text.matchAll(chipRe)].map((m) => ({
					start: m.index!,
					end: m.index! + m[0].length,
				}));
			},
			decorateRenderedLine(line) {
				return line.replace(chipRe, (tok) => bgRgb(36, 43, 56, tok));
			},
		});

		editor.setText("[Chip #1][Chip #2]");
		const decoratedRow = editor.render(90)[1]!;
		expect(visibleWidth(decoratedRow)).toBe(90);
		expect(decoratedRow).toContain("\x1b[48;2;36;43;56m");

		await harness.pressKey("\x1b[1;3D");
		await harness.pressKey("\x17");
		expect(editor.getText()).toBe("[Chip #2]");

		await harness.pressKey("\x1b[1;3C");
		await harness.pressKey("\x7f");
		expect(editor.getText()).toBe("");
	});

	it("handles slash-command autocomplete mouse bounds, narrow-width cursor clicks, and unfocused hover border styling", async () => {
		harness = await createInteractiveHarness({ theme: "dark", width: 16, height: 24 });

		const editor = getActiveComposerEditor()!;
		const wf = getSessionWorkflow();
		wf.setMode("code");
		wf.endAgentTurn();

		editor.focused = false;
		const unfocusedIdleRgb = extractFirstFgRgb(editor.render(16)[0]!)!;
		editor.focused = true;
		const focusedIdleRgb = extractFirstFgRgb(editor.render(16)[0]!)!;
		expect(focusedIdleRgb).not.toEqual(unfocusedIdleRgb);

		const topRow = findComposerTopRow(harness);
		await harness.mouseMove(6, topRow + 1);
		const hoverRgb = extractFirstFgRgb(editor.render(16)[0]!)!;
		expect(hoverRgb).not.toEqual(focusedIdleRgb);
		expect(hoverRgb).not.toEqual(unfocusedIdleRgb);

		editor.focused = false;
		expect(extractFirstFgRgb(editor.render(16)[0]!)).toEqual(hoverRgb);
		beginHoverMovePass();
		finishHoverMovePass();
		expect(extractFirstFgRgb(editor.render(16)[0]!)).toEqual(unfocusedIdleRgb);
		editor.focused = true;

		/* Ввод «/» открывает реальное автодополнение слэш-команд InteractiveMode */
		await harness.typeText("/");
		await harness.waitForIdle();

		const acScreen = harness.screen();
		const acTopRow = findComposerTopRow(harness);
		const acBottomBorderRow = acTopRow + 2;
		expect(acScreen.rowText(acBottomBorderRow)).toBe(`╰${"─".repeat(14)}╯`);
		const firstSuggestionRow = acBottomBorderRow + 1;
		expect(acScreen.rowText(firstSuggestionRow)).toContain("→");

		/* Наведение на список автодополнения сбрасывает hover-подсветку рамки композера */
		await harness.mouseMove(6, firstSuggestionRow);
		expect(extractFirstFgRgb(editor.render(16)[0]!)).toEqual(focusedIdleRgb);

		/* Клики в левое и правое поля вне внутреннего прямоугольника автодополнения игнорируются */
		await harness.mouseClick(1, firstSuggestionRow);
		expect(editor.getText()).toBe("/");
		await harness.mouseClick(15, firstSuggestionRow);
		expect(editor.getText()).toBe("/");

		/* Клик внутри строки автодополнения применяет выбранную слэш-команду */
		await harness.mouseClick(6, firstSuggestionRow);
		expect(editor.getText().startsWith("/")).toBe(true);
		expect(editor.getText().length).toBeGreaterThan(2);

		/* Узкий экран width=7 корректно переводит клик мыши в позицию курсора */
		await harness.resize(7, 20);
		editor.setText("abcd");
		harness.flushFrame();
		const narrowBodyRow = findComposerTopRow(harness) + 1;
		await harness.mouseClick(1 + 2, narrowBodyRow);
		await harness.typeText("Z");
		expect(editor.getText()).toBe("abZcd");
	});

	it("guards multi-chunk bracketed paste in handleInput, syncs undoSnapshots across submissions with onDraftChanged, and coexists cleanly with downstream editor wrappers across /reload", async () => {
		let wrapperRenderCalls = 0;

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 80,
			height: 24,
			responses: [fauxAssistantMessage("Ack submission.")],
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						const prev = ctx.ui.getEditorComponent();
						ctx.ui.setEditorComponent((tui, theme, kb) => {
							const ed = prev!(tui, theme, kb);
							const origRender = ed.render.bind(ed);
							ed.render = (w: number) => {
								wrapperRenderCalls += 1;
								return [...origRender(w)];
							};
							return ed;
						});
					});
				},
			],
		});

		await harness.reload();

		const editor = getActiveComposerEditor()!;
		expect(editor).toBeInstanceOf(CustomEditor);
		expect(editor.constructor.name).toBe("PiUiComposerEditor");

		wrapperRenderCalls = 0;
		const linesAfterReload = editor.render(80);
		expect(wrapperRenderCalls).toBe(1);
		for (const line of linesAfterReload) {
			expect(visibleWidth(line)).toBe(80);
		}
		expect(stripTerminalSequences(linesAfterReload[1]!).endsWith(" │")).toBe(true);

		const wf = getSessionWorkflow();
		expect(wf.mode).toBe("code");

		/* Многочастная bracketed paste не активирует Alt+M внутри потока вставки */
		await harness.sendInput("\x1b[200~начало ");
		await harness.sendInput("\x1b[109;3u");
		await harness.sendInput("конец\x1b[201~");
		expect(wf.mode).toBe("code");
		expect(editor.getText()).toContain("начало ");
		expect(editor.getText()).toContain("конец");

		editor.setText("");
		await harness.sendInput("\x1b[200~вставка\x1b[201~\x1b[109;3u");
		expect(editor.getText()).toBe("вставка");
		expect(wf.mode).toBe("plan");
		editor.setText("");
		await harness.submitInput("/mode code");
		expect(wf.mode).toBe("code");

		const observedDrafts: string[] = [];
		let chipCounterState = 0;
		const restoredStates: number[] = [];
		registerComposerHooks({
			onDraftChanged(text) {
				observedDrafts.push(text);
			},
			captureUndoState() {
				return chipCounterState;
			},
			restoreUndoState(snap) {
				restoredStates.push(snap as number);
			},
		});

		editor.setText("");
		chipCounterState = 111;
		await harness.typeText("a");
		await harness.submitDraft();
		expect(observedDrafts).toContain("a");
		expect(observedDrafts.at(-1)).toBe("");

		chipCounterState = 222;
		await harness.typeText("b");
		chipCounterState = 333;
		await harness.pressKey("\x1f");
		expect(editor.getText()).toBe("");
		expect(restoredStates).toEqual([222]);
	});

	it("removes the instructional micro-hint from the inline Plan banner while keeping click-to-open Plan Studio intact", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 120,
			height: 26,
			responses: [fauxAssistantMessage("1. Normalize layouts\n2. Frame composer")],
		});

		await harness.submitInput("/mode plan");
		await harness.submitInput("Prepare implementation plan");

		/* Закрываем автоматически открытую модалку Plan Studio клавишей Esc */
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		const screenWithBanner = harness.screen();
		const openPos = screenWithBanner.findText("Открыть план");
		expect(openPos).toBeDefined();

		const bannerRow = screenWithBanner.rowText(openPos!.row);
		expect(bannerRow).not.toContain("кликни для построчных комментариев");
		expect(bannerRow).not.toContain("кликни");

		await harness.mouseClick(openPos!.col + 2, openPos!.row);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Normalize layouts");

		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
	});
});
