import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiUiComposerEditor, registerComposerHooks } from "../src/features/chrome/composer.ts";
import { getOutlineSettings } from "../src/features/outline-rail/index.ts";
import conartiPiUi from "../src/index.ts";
import { bgRgb } from "../src/shared/ansi.ts";
import { beginHoverMovePass, finishHoverMovePass } from "../src/shared/runtime-hooks.ts";
import { getSessionWorkflow } from "../src/shared/session-workflow.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

function mouseEvent(type: "move" | "click", x: number, y: number, width = 80): TuiMouseEvent {
	return {
		type,
		button: type === "click" ? "left" : "none",
		x,
		y,
		width,
		height: 3,
	} as unknown as TuiMouseEvent;
}

function extractFirstFgRgb(ansi: string): [number, number, number] | undefined {
	const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
	if (!m) return undefined;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe("Composer & multi-layout shortcuts via ExtensionHarness", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		registerComposerHooks(undefined);
		getOutlineSettings().enabled = true;
		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("exposes a reusable editor factory and triggers Alt+M, Ctrl+Alt+P, Ctrl+Alt+O, Ctrl+K, Alt+<letter>, and Super+<letter> identically across Cyrillic, Latin, and macOS Option encodings without corrupting plain text or pastes", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		let altQFires = 0;
		let superVFires = 0;

		harness.mount(conartiPiUi);
		harness.pi.registerShortcut("alt+q", {
			description: "Test quote shortcut",
			handler: () => {
				altQFires += 1;
			},
		});
		harness.pi.registerShortcut("super+v", {
			description: "Test super paste shortcut",
			handler: () => {
				superVFires += 1;
			},
		});

		await harness.startSession();

		expect(typeof harness.ctx.ui.getEditorComponent()).toBe("function");
		await expect(harness.startSession()).resolves.toBeUndefined();

		const wf = getSessionWorkflow();
		expect(wf.mode).toBe("code");

		await harness.sendTerminalInput("\x1b[1100;3u");
		expect(wf.mode).toBe("plan");
		await harness.sendTerminalInput("\x1bь");
		expect(wf.mode).toBe("safe");
		await harness.sendTerminalInput("\x1b[27;3;1100~");
		expect(wf.mode).toBe("code");
		await harness.sendTerminalInput("µ");
		expect(wf.mode).toBe("plan");
		await harness.sendTerminalInput("\x1b[181;1:3u");
		expect(wf.mode).toBe("plan");
		await harness.sendTerminalInput("\x1b[109;3u");
		expect(wf.mode).toBe("safe");
		await harness.sendTerminalInput("\x1b[1100::109;3u");
		expect(wf.mode).toBe("code");

		await harness.sendTerminalInput("\x1b[1079;7u");
		expect(wf.mode).toBe("plan");
		await harness.sendTerminalInput("\x1b[27;7;1079~");
		expect(wf.mode).toBe("code");

		expect(getOutlineSettings().enabled).toBe(true);
		await harness.sendTerminalInput("\x1b[1097;7u");
		expect(getOutlineSettings().enabled).toBe(false);
		await harness.sendTerminalInput("\x1b[27;7;1097~");
		expect(getOutlineSettings().enabled).toBe(true);

		/* Ctrl+Л открывает и закрывает Command Palette идентично Ctrl+K */
		await harness.sendTerminalInput("\x1b[1083;5u");
		expect(harness.activeCustomModal).toBeDefined();
		await harness.sendTerminalInput("\x1b[1083;5u");
		expect(harness.activeCustomModal).toBeUndefined();

		await harness.sendTerminalInput("\x1bй");
		await harness.sendTerminalInput("\x1b[1081;3u");
		await harness.sendTerminalInput("œ");
		await harness.sendTerminalInput("ј");
		expect(altQFires).toBe(4);

		await harness.sendTerminalInput("\x1b[1084;9u");
		await harness.sendTerminalInput("\x1b[27;9;1084~");
		expect(superVFires).toBe(2);

		const editor = harness.editor as PiUiComposerEditor;
		const shortcutSpy = vi.spyOn(editor as { onExtensionShortcut: (data: string) => boolean }, "onExtensionShortcut");
		await harness.sendTerminalInput("п");
		expect(shortcutSpy).toHaveBeenCalledTimes(1);
		shortcutSpy.mockRestore();

		for (const ch of ["р", "и", "в", "е", "т", " ", "π", "©", " "]) {
			await harness.sendTerminalInput(ch);
		}
		await harness.sendTerminalInput("\x1b[200~µ œ\x1b[201~");
		expect(editor.getText()).toBe("привет π© µ œ");
		expect(wf.mode).toBe("code");
		expect(altQFires).toBe(4);
	});

	it("renders a 4-sided rounded composer box with › prefix, empty-draft placeholder, multiline alignment, and clean uninterrupted bottom border", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 80, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		expect(editor).toBeInstanceOf(CustomEditor);
		expect(editor).toBeInstanceOf(PiUiComposerEditor);

		editor.setPaddingX(4);
		expect(editor.getPaddingX()).toBe(0);

		const emptyLines = editor.render(80);
		expect(emptyLines).toHaveLength(3);
		for (const line of emptyLines) {
			expect(visibleWidth(line)).toBe(80);
		}

		const plainEmpty0 = stripTerminalSequences(emptyLines[0]!);
		const plainEmpty1 = stripTerminalSequences(emptyLines[1]!);
		const plainEmpty2 = stripTerminalSequences(emptyLines[2]!);
		expect(plainEmpty0).toBe(`╭${"─".repeat(78)}╮`);
		expect(plainEmpty1.startsWith("│ › Спроси или опиши задачу…")).toBe(true);
		expect(plainEmpty1.endsWith(" │")).toBe(true);
		expect(plainEmpty2).toBe(`╰${"─".repeat(78)}╯`);

		await harness.sendTerminalInput("Сделай рефакторинг");
		await harness.sendTerminalInput("\x1b\r");
		await harness.sendTerminalInput("второй строки");

		const typedLines = editor.render(80);
		expect(typedLines).toHaveLength(4);
		for (const line of typedLines) {
			expect(visibleWidth(line)).toBe(80);
		}

		const plainTyped = typedLines.map((l) => stripTerminalSequences(l));
		expect(plainTyped[0]).toBe(`╭${"─".repeat(78)}╮`);
		expect(plainTyped[1]!.startsWith("│ › Сделай рефакторинг")).toBe(true);
		expect(plainTyped[1]!.endsWith(" │")).toBe(true);
		expect(plainTyped[1]).not.toContain("Спроси или опиши задачу");
		expect(plainTyped[2]!.startsWith("│   второй строки")).toBe(true);
		expect(plainTyped[2]!.endsWith(" │")).toBe(true);
		expect(plainTyped[3]).toBe(`╰${"─".repeat(78)}╯`);
		expect(plainTyped.join("\n")).not.toContain("⌥↵");
		expect(plainTyped.join("\n")).not.toContain("отправить");

		for (const w of [1, 2, 3, 7, 8, 12, 28, 44, 120]) {
			const linesAtWidth = editor.render(w);
			for (const line of linesAtWidth) {
				expect(visibleWidth(line)).toBe(w);
			}
		}

		harness.ctx.ui.setEditorText("");
		const clearedPlain = stripTerminalSequences(editor.render(80)[1]!);
		expect(clearedPlain.startsWith("│ › Спроси или опиши задачу…")).toBe(true);
	});

	it("renders adaptive light/dark border tones without purple, clickable emoji-free Session Mode & Plan pills, mouse cursor positioning, and atomic Prompt Chip hooks", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 90, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		const wf = getSessionWorkflow();

		for (const themeMode of ["dark", "light"] as const) {
			harness.setTheme(themeMode);

			editor.borderColor = (s: string) => `\x1b[38;2;210;20;220m${s}\x1b[39m`;

			wf.setMode("code", harness.pi);
			wf.endAgentTurn();
			const idleRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			editor.handleMouse(mouseEvent("move", 10, 1, 90));
			const hoverRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			wf.beginAgentTurn();
			const streamingRgb = extractFirstFgRgb(editor.render(90)[0]!)!;
			wf.endAgentTurn();

			wf.setMode("plan", harness.pi);
			const planRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			wf.setMode("safe", harness.pi);
			const safeRgb = extractFirstFgRgb(editor.render(90)[0]!)!;

			const rgbs = [idleRgb, hoverRgb, streamingRgb, planRgb, safeRgb];
			const unique = new Set(rgbs.map((c) => c.join(",")));
			expect(unique.size).toBe(5);
			for (const [r, g, b] of rgbs) {
				expect(r > g && b > g, `purple border rgb(${r},${g},${b}) in ${themeMode}`).toBe(false);
			}

			wf.setMode("code", harness.pi);
			beginHoverMovePass();
			finishHoverMovePass();
		}

		harness.setTheme("dark");
		await harness.runCommand("mode", "plan");
		wf.capturePlan("1. Normalize shortcuts\n2. Frame composer");
		wf.setPlanComment(0, "Check bracketed paste");

		const topWithPills = editor.render(90)[0]!;
		expect(visibleWidth(topWithPills)).toBe(90);
		const plainTop = stripTerminalSequences(topWithPills);
		expect(plainTop.startsWith("╭")).toBe(true);
		expect(plainTop.endsWith("╮")).toBe(true);
		expect(plainTop).toContain(" Plan ");
		expect(plainTop).toContain(" План (1) ");
		expect(/\p{Extended_Pictographic}/u.test(plainTop)).toBe(false);
		expect(plainTop).not.toContain("◈");
		expect(plainTop).not.toContain("🛡");
		expect(plainTop).not.toContain("📋");

		const planPillX = plainTop.indexOf("План (1)");
		expect(planPillX).toBeGreaterThan(0);
		editor.handleMouse(mouseEvent("click", planPillX + 1, 0, 90));
		expect(harness.activeCustomModal).toBeDefined();
		harness.activeCustomModal!.done("close");

		const modePillX = plainTop.indexOf("Plan");
		editor.handleMouse(mouseEvent("click", modePillX + 1, 0, 90));
		expect(wf.mode).toBe("code");

		editor.setWorkingStatusIndicator({
			renderInBorder: () => "● Working…",
			renderSpinnerInBorder: () => "●",
		} as any);
		const workingTop = editor.render(90)[0]!;
		expect(visibleWidth(workingTop)).toBe(90);
		expect(stripTerminalSequences(workingTop)).toContain("● Working…");
		editor.setWorkingStatusIndicator(undefined);

		editor.setText("abcdef");
		editor.render(90);
		editor.handleMouse(mouseEvent("click", 4 + 3, 1, 90));
		await harness.sendTerminalInput("X");
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
		const decoratedRow = editor.render(90)[1]!;
		expect(visibleWidth(decoratedRow)).toBe(90);
		expect(decoratedRow).toContain("\x1b[48;2;36;43;56m");

		await harness.sendTerminalInput("\x1b[1;3D");
		await harness.sendTerminalInput("\x17");
		expect(editor.getText()).toBe("[Chip #2]");

		await harness.sendTerminalInput("\x1b[1;3C");
		await harness.sendTerminalInput("\x7f");
		expect(editor.getText()).toBe("");
	});

	it("removes the instructional micro-hint from the inline Plan banner while keeping click-to-open Plan Studio intact", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 120, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		await harness.runCommand("mode", "plan");
		await harness.emit("agent_end", {
			messages: [
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "1. Normalize layouts\n2. Frame composer" }],
				},
			],
		});

		expect(harness.activeCustomModal).toBeDefined();
		harness.activeCustomModal!.done("close");
		expect(harness.activeCustomModal).toBeUndefined();

		const widgetFactory = harness.widgets.get("conarti-plan") as
			| ((tui: unknown, theme: unknown) => Component)
			| undefined;
		expect(widgetFactory).toBeDefined();

		const widget = widgetFactory!(harness.tui, harness.ctx.ui.theme);
		const bannerLine = widget.render(120)[0]!;
		const plainBanner = stripTerminalSequences(bannerLine);

		expect(plainBanner).toContain("Открыть план");
		expect(plainBanner).not.toContain("кликни для построчных комментариев");
		expect(plainBanner).not.toContain("кликни");

		const openX = plainBanner.indexOf("Открыть план");
		expect(openX).toBeGreaterThan(0);
		widget.handleMouse?.(mouseEvent("click", openX + 1, 0, 120));
		expect(harness.activeCustomModal).toBeDefined();
		const studioPlain = stripTerminalSequences(harness.activeCustomModal!.component.render(100).join("\n"));
		expect(studioPlain).toContain("Normalize layouts");
		harness.activeCustomModal!.done("close");
	});
});
