import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	isKittyProtocolActive,
	setKittyProtocolActive,
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
import { getSessionWorkflow } from "../src/shared/session-workflow.ts";
import {
	createAssistantMessageEventStream,
	createInteractiveHarness,
	fauxAssistantMessage,
	findComposerTopRow,
	waitForCondition,
	ZERO_USAGE,
	type AssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

function readComposerBorderRgb(harness: InteractiveHarness): [number, number, number] {
	const topRow = findComposerTopRow(harness);
	const screen = harness.screen();
	const col = screen.cellAt(topRow, 2)?.char === "╭" ? 2 : 0;
	const fg = screen.cellAt(topRow, col)?.fg;
	if (!fg || fg.kind !== "rgb") {
		throw new Error("Expected truecolor RGB foreground on composer top-left corner");
	}
	return [fg.r, fg.g, fg.b];
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
		expect(wf.mode).toBe("always-approve");

		/* Alt+M across RU/EN/Option toggles the upward Session Mode popover */
		await harness.pressKey("\x1b[1100;3u");
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("\x1bь");
		expect(harness.screen().text()).not.toContain("Session Mode");
		await harness.pressKey("\x1b[27;3;1100~");
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("µ");
		expect(harness.screen().text()).not.toContain("Session Mode");
		await harness.pressKey("\x1b[181;1:3u");
		expect(harness.screen().text()).not.toContain("Session Mode");
		await harness.pressKey("\x1b[109;3u");
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("\x1b[1100::109;3u");
		expect(harness.screen().text()).not.toContain("Session Mode");

		await harness.pressKey("\x1b[1079;7u");
		expect(wf.mode).toBe("plan");
		await harness.pressKey("\x1b[27;7;1079~");
		expect(wf.mode).toBe("always-approve");
		await harness.pressKey("\x1b[960;5u");
		expect(wf.mode).toBe("plan");
		setKittyProtocolActive(true);
		await harness.pressKey("\x1b\x10");
		expect(wf.mode).toBe("always-approve");
		await harness.pressKey("\x1bm");
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("\x1bь");
		expect(harness.screen().text()).not.toContain("Session Mode");
		await harness.pressKey("\x1bm");
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("Session Mode");

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

		await harness.pressKey("\x1b[1083;5u");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Command Palette");
		await harness.pressKey("\x1b[1083;5u");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await harness.pressKey("\x1bн");
		await harness.pressKey("\x1b[1085;3u");
		await harness.pressKey("¥");
		await harness.pressKey("њ");
		expect(altYFires).toBe(4);

		for (const seq of ["\x1bй", "\x1b[1081;3u", "œ", "ј"]) {
			await harness.pressKey("\x15");
			await harness.pressKey(seq);
			await harness.waitForIdle();
			expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");
		}
		await harness.pressKey("\x15");

		await harness.pressKey("\x1b[1080;9u");
		await harness.pressKey("\x1b[27;9;1080~");
		expect(superBFires).toBe(2);

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
		expect(wf.mode).toBe("always-approve");
		expect(altYFires).toBe(4);
	});

	it("renders a 4-sided rounded composer box with › prefix, empty-draft placeholder, multiline alignment, and narrow-width wrap safety", async () => {
		harness = await createInteractiveHarness({ theme: "dark", width: 80, height: 24 });

		const editor = getActiveComposerEditor()!;
		expect(editor).toBeInstanceOf(CustomEditor);
		expect(editor.constructor.name).toBe("PiUiComposerEditor");

		editor.setPaddingX(4);
		expect(editor.getPaddingX()).toBe(0);

		const emptyScreen = harness.screen();
		const topRow = findComposerTopRow(harness);
		expect(emptyScreen.rowText(topRow)).toBe(`  ╭${"─".repeat(74)}╮  `);
		expect(emptyScreen.rowText(topRow + 1).startsWith("  │ › Ask or describe a task…")).toBe(true);
		expect(emptyScreen.rowText(topRow + 1).endsWith(" │  ")).toBe(true);
		const emptyBottom = emptyScreen.rowText(topRow + 2);
		expect(emptyBottom.startsWith("  ╰─")).toBe(true);
		expect(emptyBottom.endsWith("──╯  ")).toBe(true);
		expect(emptyBottom).toContain("(off)");
		expect(emptyBottom).toContain("Always-approve");

		await harness.typeText("Сделай рефакторинг");
		await harness.pressKey("\x1b[13;2u");
		await harness.typeText("второй строки");

		const typedScreen = harness.screen();
		const typedTop = findComposerTopRow(harness);
		expect(typedScreen.rowText(typedTop)).toBe(`  ╭${"─".repeat(74)}╮  `);
		expect(typedScreen.rowText(typedTop + 1).startsWith("  │ › Сделай рефакторинг")).toBe(true);
		expect(typedScreen.rowText(typedTop + 1).endsWith(" │  ")).toBe(true);
		expect(typedScreen.rowText(typedTop + 1)).not.toContain("Ask or describe a task");
		expect(typedScreen.rowText(typedTop + 2).startsWith("  │   второй строки")).toBe(true);
		expect(typedScreen.rowText(typedTop + 2).endsWith(" │  ")).toBe(true);
		const typedBottom = typedScreen.rowText(typedTop + 3);
		expect(typedBottom.startsWith("  ╰─")).toBe(true);
		expect(typedBottom.endsWith("──╯  ")).toBe(true);
		expect(typedScreen.text()).not.toContain("⌥↵");
		expect(typedScreen.text()).not.toContain("отправить");

		for (const w of [1, 2, 3, 7, 8, 12, 28, 44, 120]) {
			await harness.resize(w, 24);
			const top = findComposerTopRow(harness);
			expect(visibleWidth(harness.renderFrame()[top]!)).toBe(w);
		}

		for (const sample of ["🚀", "a🚀", "中文🚀"]) {
			await harness.resize(80, 24);
			editor.setText("");
			await harness.typeText(sample);
			for (const w of [1, 2, 3, 4, 5, 8, 12, 20]) {
				await harness.resize(w, 24);
				const top = findComposerTopRow(harness);
				expect(visibleWidth(harness.renderFrame()[top]!), `sample=${sample} width=${w}`).toBe(w);
			}
		}

		await harness.resize(80, 24);
		editor.setText("");
		await harness.typeText(" ");
		expect(harness.screen().rowText(findComposerTopRow(harness) + 1)).not.toContain(
			"Ask or describe a task",
		);

		await harness.pressKey("\x7f");
		expect(
			harness
				.screen()
				.rowText(findComposerTopRow(harness) + 1)
				.startsWith("  │ › Ask or describe a task…"),
		).toBe(true);
	});

	it("renders adaptive light/dark border tones without purple, clickable emoji-free Session Mode & Plan pills, mouse cursor positioning, and atomic Prompt Chip hooks", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 90,
			height: 28,
			responses: [fauxAssistantMessage("1. Normalize shortcuts\n2. Frame composer")],
		});

		const editor = getActiveComposerEditor()!;
		const wf = getSessionWorkflow();

		for (const themeMode of ["dark", "light"] as const) {
			harness.setTheme(themeMode);
			/* InteractiveMode.updateEditorBorderColor перезаписывает editor.borderColor при смене уровня мышления */
			editor.borderColor = (s: string) => `\x1b[38;2;210;20;220m${s}\x1b[39m`;

			await harness.mouseMove(10, 2);
			harness.tui.setFocus(null);
			harness.flushFrame();
			const unfocusedIdleRgb = readComposerBorderRgb(harness);

			harness.tui.setFocus(editor);
			harness.flushFrame();
			const focusedIdleRgb = readComposerBorderRgb(harness);

			const composerTop = findComposerTopRow(harness);
			harness.tui.setFocus(null);
			await harness.mouseMove(10, composerTop + 1);
			const unfocusedHoverRgb = readComposerBorderRgb(harness);

			harness.tui.setFocus(editor);
			harness.flushFrame();
			const hoverRgb = readComposerBorderRgb(harness);
			/* Единое спокойное состояние рамки инпута вне зависимости от наведения мыши или фокуса */
			expect(unfocusedIdleRgb).toEqual(focusedIdleRgb);
			expect(hoverRgb).toEqual(focusedIdleRgb);
			expect(unfocusedHoverRgb).toEqual(focusedIdleRgb);

			await harness.mouseMove(10, 2);

			let activeStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
			harness.setStreamSimple(() => {
				const st = createAssistantMessageEventStream();
				activeStream = st;
				return st;
			});
			const pendingTurn = harness.submitInput(`Stream probe ${themeMode}`);
			await waitForCondition(() => activeStream !== undefined);
			harness.flushFrame();
			const workingRowText = harness.screen().rowText(findComposerTopRow(harness));
			expect(workingRowText).toContain("╭─ ✦ ");
			expect(workingRowText).toContain("[stop]");
			expect(workingRowText).not.toContain("esc to interrupt");
			const streamingRgb = readComposerBorderRgb(harness);

			const doneMsg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Stream probe done." }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: Date.now(),
			};
			activeStream!.push({ type: "done", reason: "stop", message: doneMsg });
			activeStream!.end(doneMsg);
			await pendingTurn;
			harness.setStreamSimple(undefined);

			await harness.submitInput("/mode plan");
			const planRgb = readComposerBorderRgb(harness);

			await harness.submitInput("/mode safe");
			const safeRgb = readComposerBorderRgb(harness);

			const rgbs = [focusedIdleRgb, streamingRgb, planRgb, safeRgb];
			const unique = new Set(rgbs.map((c) => c.join(",")));
			expect(unique.size).toBe(4);
			for (const [r, g, b] of rgbs) {
				expect(r > g && b > g, `purple border rgb(${r},${g},${b}) in ${themeMode}`).toBe(false);
			}

			await harness.submitInput("/mode code");
			await harness.mouseMove(10, 2);
		}

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
		expect(plainTop.startsWith("  ╭")).toBe(true);
		expect(plainTop.endsWith("╮  ")).toBe(true);
		expect(plainTop).toContain(" Plan ");
		expect(plainTop).toContain(" Plan (1) ");
		expect(/\p{Extended_Pictographic}/u.test(plainTop)).toBe(false);
		expect(plainTop).not.toContain("◈");
		expect(plainTop).not.toContain("🛡");
		expect(plainTop).not.toContain("📋");

		const planPillCol = plainTop.indexOf("Plan (1)");
		expect(planPillCol).toBeGreaterThan(0);
		await harness.mouseClick(planPillCol + 2, topBorderRow);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Normalize shortcuts");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		const modePillCol = harness.screen().rowText(findComposerTopRow(harness)).indexOf("Plan");
		expect(modePillCol).toBeGreaterThan(0);
		await harness.mouseClick(modePillCol + 1, findComposerTopRow(harness));
		expect(wf.mode).toBe("always-approve");

		harness.setTheme("light");
		await harness.submitInput("/mode auto");
		const lightTopRow = findComposerTopRow(harness);
		const plainLightTop = harness.screen().rowText(lightTopRow);
		expect(plainLightTop).toContain(" Auto ");
		expect(plainLightTop).toContain(" Plan (1) ");
		expect(/\p{Extended_Pictographic}/u.test(plainLightTop)).toBe(false);
		const autoPillCol = plainLightTop.indexOf("Auto");
		await harness.mouseClick(autoPillCol + 2, lightTopRow);
		expect(wf.mode).toBe("always-approve");
		harness.setTheme("dark");

		editor.setText("abcdef");
		harness.flushFrame();
		const bodyRow = findComposerTopRow(harness) + 1;
		await harness.mouseClick(6 + 3, bodyRow);
		await harness.typeText("X");
		expect(editor.getText()).toBe("abcXdef");

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
		harness.flushFrame();
		const decoratedRow = harness.renderFrame()[findComposerTopRow(harness) + 1]!;
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

		harness.tui.setFocus(null);
		harness.flushFrame();
		const unfocusedIdleRgb = readComposerBorderRgb(harness);
		harness.tui.setFocus(editor);
		harness.flushFrame();
		const focusedIdleRgb = readComposerBorderRgb(harness);
		expect(focusedIdleRgb).toEqual(unfocusedIdleRgb);

		const topRow = findComposerTopRow(harness);
		await harness.mouseMove(6, topRow + 1);
		const hoverRgb = readComposerBorderRgb(harness);
		expect(hoverRgb).toEqual(focusedIdleRgb);

		harness.tui.setFocus(null);
		harness.flushFrame();
		expect(readComposerBorderRgb(harness)).toEqual(focusedIdleRgb);
		await harness.mouseMove(1, 1);
		expect(readComposerBorderRgb(harness)).toEqual(focusedIdleRgb);
		harness.tui.setFocus(editor);
		harness.flushFrame();

		await harness.typeText("/");
		await harness.waitForIdle();

		const acScreen = harness.screen();
		const acTopRow = findComposerTopRow(harness);
		const acBottomBorderRow = acTopRow + 2;
		expect(acScreen.rowText(acBottomBorderRow)).toBe(`  ╰${"─".repeat(10)}╯  `);
		const firstSuggestionRow = acBottomBorderRow + 1;
		expect(acScreen.rowText(firstSuggestionRow)).toContain("→");

		await harness.mouseMove(6, firstSuggestionRow);
		expect(readComposerBorderRgb(harness)).toEqual(focusedIdleRgb);

		await harness.mouseClick(1, firstSuggestionRow);
		expect(editor.getText()).toBe("/");
		await harness.mouseClick(15, firstSuggestionRow);
		expect(editor.getText()).toBe("/");

		await harness.mouseClick(6, firstSuggestionRow);
		expect(editor.getText().startsWith("/")).toBe(true);
		expect(editor.getText().length).toBeGreaterThan(2);

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
		harness.flushFrame(true);
		expect(wrapperRenderCalls).toBeGreaterThanOrEqual(1);
		const composerRow = harness.screen().rowText(findComposerTopRow(harness) + 1);
		expect(composerRow.endsWith(" │  ")).toBe(true);

		const wf = getSessionWorkflow();
		expect(wf.mode).toBe("always-approve");

		await harness.sendInput("\x1b[200~начало ");
		await harness.sendInput("\x1b[109;3u");
		await harness.sendInput("конец\x1b[201~");
		expect(wf.mode).toBe("always-approve");
		expect(editor.getText()).toContain("начало ");
		expect(editor.getText()).toContain("конец");

		editor.setText("");
		await harness.sendInput("\x1b[200~вставка\x1b[201~\x1b[109;3u");
		expect(editor.getText()).toBe("вставка");
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("\x1b");
		editor.setText("");
		await harness.submitInput("/mode always-approve");
		expect(wf.mode).toBe("always-approve");

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

	it("removes the instructional micro-hint from the inline Plan banner while keeping click-to-open Plan Approval intact", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 120,
			height: 26,
			responses: [fauxAssistantMessage("1. Normalize layouts\n2. Frame composer")],
		});

		await harness.submitInput("/mode plan");
		await harness.submitInput("Prepare implementation plan");

		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		const screenWithBanner = harness.screen();
		const openPos = screenWithBanner.findText("Open plan");
		expect(openPos).toBeDefined();

		const bannerRow = screenWithBanner.rowText(openPos!.row);
		expect(bannerRow).not.toContain("кликни");
		expect(bannerRow).not.toContain("click for line comments");

		await harness.mouseClick(openPos!.col + 2, openPos!.row);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Normalize layouts");

		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
	});
});
