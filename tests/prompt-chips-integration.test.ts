import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Spacer, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { PiUiComposerEditor } from "../src/features/chrome/composer.ts";
import conartiPiUi from "../src/index.ts";
import { setHostClipboardProvider, type HostClipboardProvider } from "../src/shared/host-runtime.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

function extractAllAnsiRgbs(lines: readonly string[]): Array<[number, number, number]> {
	const out: Array<[number, number, number]> = [];
	const re = /\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/g;
	for (const line of lines) {
		for (const m of line.matchAll(re)) {
			out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
		}
	}
	return out;
}

/* Валидный 2x3 PNG (71 байт) с корректным IHDR для проверки чтения размеров и сигнатуры */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAADklEQVR4nGP4z8DAwMAAAwkB/7b5L2EAAAAASUVORK5CYII=";
const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64"));

async function flushAsyncPaste(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Prompt Chips end-to-end via ExtensionHarness + HostRuntime", () => {
	let harness: ExtensionHarness | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		setHostClipboardProvider(undefined);
		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("inserts path-free atomic [🖼 Image #N] Prompt Chips across Ctrl+V, Cmd+V, Cyrillic Super+м / Ctrl+м, empty bracketed paste, clipboard file paths, and pasted image paths", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ui-chip-test-"));
		const copiedFileImg = join(tempDir, "copied-from-finder.png");
		const spacedDir = join(tempDir, "with space");
		rmSync(spacedDir, { recursive: true, force: true });
		const { mkdirSync } = await import("node:fs");
		mkdirSync(spacedDir, { recursive: true });
		const pastedPathImg = join(spacedDir, "dragged screen.png");
		writeFileSync(copiedFileImg, TINY_PNG_BYTES);
		writeFileSync(pastedPathImg, TINY_PNG_BYTES);

		let clipboardState: HostClipboardProvider = {
			readFilePaths: async () => null,
			readImage: async () => ({
				bytes: TINY_PNG_BYTES,
				mimeType: "image/png",
			}),
			readText: async () => null,
		};

		const proxyClipboard: HostClipboardProvider = {
			readFilePaths: () => clipboardState.readFilePaths?.() ?? Promise.resolve(null),
			readImage: () => clipboardState.readImage?.() ?? Promise.resolve(null),
			readText: () => clipboardState.readText?.() ?? Promise.resolve(null),
		};

		setHostClipboardProvider(proxyClipboard);
		harness = createExtensionHarness({ theme: "dark", width: 96, height: 28 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;

		/* 1. Ctrl+V (\x16) */
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1]");
		expect(editor.getText()).not.toContain("/tmp");

		/* 2. Cmd+V (super+v Kitty CSI-u \x1b[118;9u) */
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[118;9u");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2]");

		/* 3. Кириллический Super+м (\x1b[1084;9u) и modifyOtherKeys (\x1b[27;9;1084~) + Ctrl+м (\x1b[1084;5u) */
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[1084;9u");
		await flushAsyncPaste();
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[27;9;1084~");
		await flushAsyncPaste();
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[1084;5u");
		await flushAsyncPaste();
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [🖼 Image #2] [🖼 Image #3] [🖼 Image #4] [🖼 Image #5]",
		);

		/* 4. Пустой bracketed paste (\x1b[200~\x1b[201~) одним и двумя чанками при картинке в буфере */
		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput("\x1b[200~\x1b[201~");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1]");

		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[200~");
		await harness.sendTerminalInput("\x1b[201~");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2]");

		/* Пустой bracketed paste при отсутствии картинки НЕ вставляет обычный текст буфера */
		clipboardState = {
			readFilePaths: async () => null,
			readImage: async () => null,
			readText: async () => "should-not-paste-on-empty-bracket",
		};
		await harness.sendTerminalInput("\x1b[200~\x1b[201~");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2]");

		/* 5. Скопированный файл изображения через readFilePaths на Cmd+V */
		harness.ctx.ui.setEditorText("");
		clipboardState = {
			readFilePaths: async () => [copiedFileImg],
			readImage: async () => null,
			readText: async () => null,
		};
		await harness.sendTerminalInput("\x1b[27;9;118~");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1]");
		expect(editor.getText()).not.toContain("copied-from-finder.png");

		/* 6. Bracketed paste экранированного пути к изображению с пробелом */
		const escapedPath = pastedPathImg.replace(/ /g, "\\ ");
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput(`\x1b[200~${escapedPath}\x1b[201~`);
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2]");

		const renderedPlain = editor
			.render(96)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(renderedPlain).toContain("[🖼 Image #1] [🖼 Image #2]");
		expect(renderedPlain).not.toContain(tempDir);
	});

	it("converts >=4 line or >300 char text pastes into styled blue-slate pills while keeping <=3 line pastes editable, deletes/renumbers atomically on Backspace/Delete, and re-links on Ctrl+Z / Cmd+Z / Cyrillic Super+я undo", async () => {
		let clipboardImageBytes: Uint8Array | null = TINY_PNG_BYTES;
		let clipboardTextValue: string | null = null;

		setHostClipboardProvider({
			readFilePaths: async () => null,
			readImage: async () =>
				clipboardImageBytes ? { bytes: clipboardImageBytes, mimeType: "image/png" } : null,
			readText: async () => clipboardTextValue,
		});

		harness = createExtensionHarness({ theme: "dark", width: 92, height: 28 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;

		/* Короткая 3-строчная вставка <= 300 символов остаётся обычным редактируемым текстом */
		await harness.sendTerminalInput("\x1b[200~row one\nrow two\nrow three\x1b[201~");
		expect(editor.getText()).toBe("row one\nrow two\nrow three");

		/* Очистим черновик и проверим пороги >= 4 строк и > 300 символов */
		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1]");

		await harness.sendTerminalInput(" ");
		const fourLineSnippet = "fn main() {\n  let x = 1;\n  println!(\"{x}\");\n}";
		await harness.sendTerminalInput(`\x1b[200~${fourLineSnippet}\x1b[201~`);
		expect(editor.getText()).toBe("[🖼 Image #1] [📋 Pasted #2 · 4 lines]");

		/* Cmd+V фоллбэк на длинный однострочный текст > 300 символов */
		clipboardImageBytes = null;
		clipboardTextValue = "L".repeat(312);
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[118;9u");
		await flushAsyncPaste();
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [📋 Pasted #2 · 4 lines] [📋 Pasted #3 · 312 chars]",
		);

		/* Проверим инлайновую стилизацию пилюль (фон 48;2 + цвет текста 38;2, без фиолетового, точная ширина, сохранение курсора на чипе) */
		await harness.sendTerminalInput("\x1b[D");
		for (const mode of ["dark", "light"] as const) {
			harness.setTheme(mode);
			const lines = editor.render(92);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(92);
			}
			expect(lines[1]).toContain("\x1b[48;2;");
			expect(lines[1]).toContain("\x1b_pi:c\x07\x1b_pi:fc\x07");
			const rgbs = extractAllAnsiRgbs(lines);
			expect(rgbs.length).toBeGreaterThan(4);
			for (const [r, g, b] of rgbs) {
				expect(r > g && b > g, `purple rgb(${r},${g},${b}) in ${mode}`).toBe(false);
			}
		}

		/* Перейдём в начало строки (Ctrl+A) и нажмём Delete (\x1b[3~) на первом чипе [🖼 Image #1] */
		await harness.sendTerminalInput("\x01");
		await harness.sendTerminalInput("\x1b[3~");
		expect(editor.getText()).toBe(" [📋 Pasted #1 · 4 lines] [📋 Pasted #2 · 312 chars]");

		/* Undo через кириллический Super+я (\x1b[1103;9u) возвращает [🖼 Image #1] и старые номера #2, #3 */
		await harness.sendTerminalInput("\x1b[1103;9u");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [📋 Pasted #2 · 4 lines] [📋 Pasted #3 · 312 chars]",
		);

		/* Перейдём в конец строки (Ctrl+E), одиночный Backspace (\x7f) атомарно удаляет #3 */
		await harness.sendTerminalInput("\x05");
		await harness.sendTerminalInput("\x7f");
		expect(editor.getText()).toBe("[🖼 Image #1] [📋 Pasted #2 · 4 lines] ");

		/* Undo через Ctrl+Z (\x1a) восстанавливает #3 и перепривязывает все три вложения при отправке */
		await harness.sendTerminalInput("\x1a");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [📋 Pasted #2 · 4 lines] [📋 Pasted #3 · 312 chars]",
		);

		const inputResults = await harness.emit("input", {
			type: "input",
			text: editor.getText(),
			source: "interactive",
		});
		const transformed = inputResults.find(
			(r: any) => r && typeof r === "object" && r.action === "transform",
		) as { action: "transform"; text: string; images?: Array<{ type: string; data: string; mimeType: string }> } | undefined;

		expect(transformed).toBeDefined();
		expect(transformed?.images).toHaveLength(1);
		expect(transformed?.images?.[0]?.data).toBe(TINY_PNG_BASE64);
		expect(transformed?.text).toContain("[Image #1: ");
		expect(transformed?.text).toContain(fourLineSnippet);
		expect(transformed?.text).toContain("L".repeat(312));
	});

	it("lazily mounts a nonCapturing Hover Popup preview on adjacent/on-chip caret or mouse hover, hides it via handle.hide() on leave, and guards against blocking Modal Card overlays", async () => {
		setHostClipboardProvider({
			readFilePaths: async () => null,
			readImage: async () => ({
				bytes: TINY_PNG_BYTES,
				mimeType: "image/png",
				fileName: "architecture-shot.png",
			}),
			readText: async () => null,
		});

		harness = createExtensionHarness({ theme: "dark", width: 100, height: 28 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		harness.tui.dock.addChild(editor);
		harness.tui.renderViewport(100, 28);

		const getVisibleHoverOverlays = () =>
			harness!.tui.overlayStack.filter(
				(e) => e.options?.nonCapturing === true && harness!.tui.isOverlayVisible(e),
			);

		expect(getVisibleHoverOverlays()).toHaveLength(0);

		/* 1. Вставка картинки ставит каретку вплотную к [🖼 Image #1] -> лениво монтируется nonCapturing Hover Popup */
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();

		const afterImageOverlays = getVisibleHoverOverlays();
		expect(afterImageOverlays).toHaveLength(1);
		const imgPopupText = stripTerminalSequences(
			afterImageOverlays[0]!.component.render(52).join("\n"),
		);
		expect(imgPopupText).toContain("architecture-shot.png");
		expect(imgPopupText).toContain("2×3");
		expect(imgPopupText).toContain("71B");
		expect(imgPopupText).toContain("Path: ");

		/* Увод каретки от чипа (ввод пробела и обычного слова) скрывает попап через handle.hide() */
		await harness.sendTerminalInput(" notes");
		expect(getVisibleHoverOverlays()).toHaveLength(0);

		/* 2. Добавим многострочную вставку [📋 Pasted #2 · 6 lines] -> превью показывает многострочный фрагмент */
		await harness.sendTerminalInput(" ");
		const sixLinePaste = [
			"SELECT id, email",
			"FROM users",
			"WHERE active = true",
			"ORDER BY created_at DESC",
			"LIMIT 25",
			"OFFSET 0;",
		].join("\n");
		await harness.sendTerminalInput(`\x1b[200~${sixLinePaste}\x1b[201~`);

		const afterPasteOverlays = getVisibleHoverOverlays();
		expect(afterPasteOverlays).toHaveLength(1);
		const pastePopupText = stripTerminalSequences(
			afterPasteOverlays[0]!.component.render(56).join("\n"),
		);
		expect(pastePopupText).toContain("Pasted #2 · 6 lines");
		expect(pastePopupText).toContain("SELECT id, email");
		expect(pastePopupText).toContain("WHERE active = true");

		/* 3. Открытие блокирующей Modal Card (Command Palette по Ctrl+K) скрывает Hover Popup */
		await harness.sendTerminalInput("\x0b");
		expect(harness.activeCustomModal).toBeDefined();
		expect(harness.tui.getTopmostVisibleOverlay()).toBeDefined();
		expect(getVisibleHoverOverlays()).toHaveLength(0);

		/* Закрываем модалку */
		harness.activeCustomModal!.done(undefined);
		expect(harness.tui.getTopmostVisibleOverlay()).toBeUndefined();

		/* 4. Уведём каретку в конец за обычный текст, затем наведём мышь на [🖼 Image #1] */
		await harness.sendTerminalInput(" trailing");
		expect(getVisibleHoverOverlays()).toHaveLength(0);

		harness.tui.renderViewport(100, 28);
		/* На строке контента редактора (y = 1) префикс "│ › " занимает 4 колонки, [🖼 Image #1] начинается с x = 4 */
		editor.handleMouse({
			type: "move",
			button: "none",
			x: 6,
			y: 1,
			screenX: 6,
			screenY: 25,
			width: 100,
			height: 3,
		} as any);
		const mouseHoverOverlays = getVisibleHoverOverlays();
		expect(mouseHoverOverlays).toHaveLength(1);
		const hoveredImgText = stripTerminalSequences(
			mouseHoverOverlays[0]!.component.render(52).join("\n"),
		);
		expect(hoveredImgText).toContain("architecture-shot.png");

		/* Увод мыши за пределы чипа скрывает Hover Popup через handle.hide() */
		editor.handleMouse({
			type: "move",
			button: "none",
			x: 80,
			y: 1,
			screenX: 80,
			screenY: 25,
			width: 100,
			height: 3,
		} as any);
		expect(getVisibleHoverOverlays()).toHaveLength(0);
	});

	it("expands chips on Enter submission, renders compact clickable Prompt Chip pills with preview popups in both User Prompt and Sticky Prompt cards, and persists across steer/followUp and /reload", async () => {
		setHostClipboardProvider({
			readFilePaths: async () => null,
			readImage: async () => ({
				bytes: TINY_PNG_BYTES,
				mimeType: "image/png",
				fileName: "mockup-v2.png",
			}),
			readText: async () => null,
		});

		harness = createExtensionHarness({ theme: "dark", width: 96, height: 22 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		harness.tui.dock.addChild(editor);

		let submittedFromEditor = "";
		editor.onSubmit = (val: string) => {
			submittedFromEditor = val;
		};

		/* Сформируем первый промпт: "Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]" и отправим по Enter */
		await harness.sendTerminalInput("Review ");
		await harness.sendTerminalInput("\x1b[118;9u");
		await flushAsyncPaste();
		await harness.sendTerminalInput(" and ");
		const fiveLineLog = [
			"ERROR 502 Bad Gateway",
			"upstream: 10.0.4.12:8080",
			"request_id: req-9912",
			"latency_ms: 15004",
			"retryable: true",
		].join("\n");
		await harness.sendTerminalInput(`\x1b[200~${fiveLineLog}\x1b[201~`);
		expect(editor.getText()).toBe("Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]");

		await harness.sendTerminalInput("\r");
		expect(editor.getText()).toBe("");
		expect(submittedFromEditor).toBe("Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]");

		/* Эмитим pi.on("input") так же, как AgentSession._preparePrompt */
		const inputRes = await harness.emit("input", {
			type: "input",
			text: submittedFromEditor,
			source: "interactive",
		});
		const tx1 = inputRes.find((r: any) => r?.action === "transform") as {
			action: "transform";
			text: string;
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
		};
		expect(tx1).toBeDefined();
		expect(tx1.images).toEqual([
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		]);
		expect(tx1.text).toContain("[Image #1: ");
		expect(tx1.text).toContain("ERROR 502 Bad Gateway");
		expect(tx1.text).toContain("retryable: true");

		/* Жизненный цикл доставки user message в чат (message_start -> UserMessageComponent -> message_end) */
		const ts1 = new Date(2026, 4, 10, 14, 25).getTime();
		const userMsg1 = {
			role: "user",
			content: [{ type: "text", text: tx1.text }, ...(tx1.images ?? [])],
			timestamp: ts1,
		};
		await harness.emit("message_start", { message: userMsg1 });
		const userCard1 = new UserMessageComponent(tx1.text);
		harness.tui.chatContainer.addChild(userCard1);
		await harness.emit("message_end", { message: userMsg1 });

		/* Запишем сообщение и ответ в ветку сессии, чтобы проверить Sticky Prompt и Outline Rail */
		const entry1 = { type: "message", id: "m1", message: userMsg1 };
		const longReply = Array.from({ length: 24 }, (_, idx) => `Assistant reply line ${idx + 1}`).join("\n");
		harness.tui.chatContainer.addChild(new Text(longReply, 0, 0));

		/* Пока идёт стриминг ответа, проверим очередь steer + followUp (appendEntry вызывается только на их message_end!) */
		const entriesCountAfterTurn1 = harness.appendedEntries.filter(
			(e) => e.customType === "conarti-prompt-chips",
		).length;
		expect(entriesCountAfterTurn1).toBe(1);

		const steerPaste = "step A\nstep B\nstep C\nstep D";
		await harness.sendTerminalInput("Steer with ");
		await harness.sendTerminalInput(`\x1b[200~${steerPaste}\x1b[201~`);
		await harness.sendTerminalInput("\r");
		const steerInputRes = await harness.emit("input", {
			type: "input",
			text: submittedFromEditor,
			source: "interactive",
			streamingBehavior: "steer",
		});
		const txSteer = steerInputRes.find((r: any) => r?.action === "transform") as {
			text: string;
		};
		expect(txSteer.text).toBe(`Steer with ${steerPaste}`);
		/* Во время очереди steer новый customEntry ещё НЕ записан до наступления message_end */
		expect(
			harness.appendedEntries.filter((e) => e.customType === "conarti-prompt-chips"),
		).toHaveLength(1);

		const ts2 = new Date(2026, 4, 10, 14, 26).getTime();
		const userMsg2 = {
			role: "user",
			content: [{ type: "text", text: txSteer.text }],
			timestamp: ts2,
		};
		await harness.emit("message_start", { message: userMsg2 });
		harness.tui.chatContainer.addChild(new Spacer(1));
		const userCard2 = new UserMessageComponent(txSteer.text);
		harness.tui.chatContainer.addChild(userCard2);
		await harness.emit("message_end", { message: userMsg2 });
		expect(
			harness.appendedEntries.filter((e) => e.customType === "conarti-prompt-chips"),
		).toHaveLength(2);

		const branchWithMessages = [
			...harness.ctx.sessionManager.getEntries(),
			entry1,
			{ type: "message", id: "m2", message: userMsg2 },
		];
		harness.setEntries(branchWithMessages, branchWithMessages);

		/* Проверим рендер отправленной карточки UserMessageComponent: компактные пилюли вместо сырого пути и 5 строк лога */
		harness.tui.scroll.scrollTo(0, { disableFollow: true });
		const screenAtTop = harness.tui.renderViewport(96, 22).map((l) => stripTerminalSequences(l));
		const cardRowIdx = screenAtTop.findIndex((row) => row.includes("Review [🖼 Image #1]"));
		expect(cardRowIdx).toBeGreaterThanOrEqual(0);
		expect(screenAtTop[cardRowIdx]).toContain("[📋 Pasted #2 · 5 lines]");
		expect(screenAtTop.join("\n")).not.toContain("ERROR 502 Bad Gateway");
		expect(screenAtTop.join("\n")).not.toContain("mockup-v2.png");

		const getVisibleHoverOverlays = () =>
			harness!.tui.overlayStack.filter(
				(e) => e.options?.nonCapturing === true && harness!.tui.isOverlayVisible(e),
			);

		/* Клик по пилюле [🖼 Image #1] в отправленной карточке открывает попап превью без потери фокуса редактора */
		const imgPillCol = screenAtTop[cardRowIdx]!.indexOf("[🖼 Image #1]") + 2;
		harness.tui.clickMouse(imgPillCol, cardRowIdx);
		expect(getVisibleHoverOverlays()).toHaveLength(1);
		expect(
			stripTerminalSequences(getVisibleHoverOverlays()[0]!.component.render(52).join("\n")),
		).toContain("mockup-v2.png");
		expect(harness.tui.focusComponent).toBe(editor);

		/* Клик по второй пилюле [📋 Pasted #2 · 5 lines] переключает превью на вставленный текст */
		const pastePillCol = screenAtTop[cardRowIdx]!.indexOf("[📋 Pasted #2 · 5 lines]") + 3;
		harness.tui.clickMouse(pastePillCol, cardRowIdx);
		expect(getVisibleHoverOverlays()).toHaveLength(1);
		expect(
			stripTerminalSequences(getVisibleHoverOverlays()[0]!.component.render(52).join("\n")),
		).toContain("ERROR 502 Bad Gateway");

		/* Скролл колесом мыши мгновенно закрывает попап */
		harness.tui.wheelMouse(20, 5, "down");
		expect(getVisibleHoverOverlays()).toHaveLength(0);

		/* Прокрутим вниз так, чтобы карточка Turn 1 закрепилась в Sticky Prompt поверх вьюпорта */
		harness.tui.scroll.scrollTo(6, { disableFollow: true });
		const screenScrolled = harness.tui.renderViewport(96, 22).map((l) => stripTerminalSequences(l));
		expect(screenScrolled[1]).toContain("Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]");
		expect(screenScrolled.slice(0, 4).join("\n")).not.toContain("[изображение]");

		/* Клик по пилюле внутри Sticky Prompt открывает попап превью, а Esc закрывает его */
		const stickyPasteCol = screenScrolled[1]!.indexOf("[📋 Pasted #2 · 5 lines]") + 2;
		harness.tui.clickMouse(stickyPasteCol, 1);
		expect(getVisibleHoverOverlays()).toHaveLength(1);
		expect(
			stripTerminalSequences(getVisibleHoverOverlays()[0]!.component.render(52).join("\n")),
		).toContain("req-9912");

		await harness.sendTerminalInput("\x1b");
		expect(getVisibleHoverOverlays()).toHaveLength(0);

		/* Проверим восстановление пилюль после /reload на новом экземпляре сессии из сохранённых записей */
		const persistedSnapshot = [...harness.ctx.sessionManager.getEntries()];
		await harness.shutdownSession();

		harness = createExtensionHarness({
			theme: "light",
			width: 96,
			height: 22,
			entries: persistedSnapshot,
			branch: persistedSnapshot,
		});
		harness.mount(conartiPiUi);
		await harness.emit("session_start", { reason: "reload" });

		const reloadedCard1 = new UserMessageComponent(tx1.text, {} as any, 0, [], "m1", ts1 as any);
		const reloadedCard2 = new UserMessageComponent(txSteer.text, {} as any, 0, [], "m2", ts2 as any);
		const legacyCard = new UserMessageComponent("Old [Image #1: /var/tmp/legacy-diagram.png] ref");
		harness.tui.chatContainer.addChild(reloadedCard1);
		harness.tui.chatContainer.addChild(reloadedCard2);
		harness.tui.chatContainer.addChild(legacyCard);

		const reloadedScreen = harness.tui.renderViewport(96, 22).map((l) => stripTerminalSequences(l));
		const joinedReloaded = reloadedScreen.join("\n");
		expect(joinedReloaded).toContain("Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]");
		expect(joinedReloaded).toContain("Steer with [📋 Pasted #1 · 4 lines]");
		expect(joinedReloaded).toContain("Old [🖼 Image #1] ref");
		expect(joinedReloaded).not.toContain("legacy-diagram.png");
	});

	it("handles edge cases: file:// URLs, nonexistent .png paths, !bash mode paths, clipboard errors, narrow widths 1..30, and pill toggle/outside-click dismissal", async () => {
		const { pathToFileURL } = await import("node:url");
		tempDir = mkdtempSync(join(tmpdir(), "pi-ui-chip-edge-"));
		const urlImgPath = join(tempDir, "diagram with spaces.png");
		writeFileSync(urlImgPath, TINY_PNG_BYTES);
		const fileUrl = pathToFileURL(urlImgPath).href;

		let shouldThrow = false;
		setHostClipboardProvider({
			readFilePaths: async () => {
				if (shouldThrow) throw new Error("Clipboard locked");
				return [urlImgPath];
			},
			readImage: async () => null,
			readText: async () => null,
		});

		harness = createExtensionHarness({ theme: "dark", width: 88, height: 22 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		harness.tui.dock.addChild(editor);

		/* 1. Несуществующий путь .png вставляется как обычный текст, а file:// URL существующего файла - как чип */
		await harness.sendTerminalInput("\x1b[200~/nonexistent/missing-logo.png\x1b[201~");
		expect(editor.getText()).toBe("/nonexistent/missing-logo.png");

		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput(`\x1b[200~${fileUrl}\x1b[201~`);
		expect(editor.getText()).toBe("[🖼 Image #1]");

		/* 2. Узкие ширины 1..30 с активной пилюлей никогда не ломают visibleWidth === w */
		for (let w = 1; w <= 30; w++) {
			const lines = editor.render(w);
			for (const line of lines) {
				expect(visibleWidth(line), `width=${w}`).toBe(w);
			}
		}

		/* 3. В режиме !bash вставка пути из буфера вставляет экранированный путь вместо чипа */
		harness.ctx.ui.setEditorText("!ls ");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toContain("diagram with spaces.png");
		expect(editor.getText()).not.toContain("[🖼 Image");

		/* 4. Ошибка чтения буфера обмена не роняет процесс и показывает предупреждение */
		shouldThrow = true;
		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("");
		expect(harness.notifications.some((n) => n.message.includes("Clipboard locked"))).toBe(true);

		/* 5. Повторный клик по той же пилюле и клик мимо закрывают попап превью отправленной карточки */
		const card = new UserMessageComponent(" Solo [Image #1: /var/tmp/solo.png] ");
		harness.tui.chatContainer.addChild(card);
		const screen = harness.tui.renderViewport(88, 22).map((l) => stripTerminalSequences(l));
		const rowIdx = screen.findIndex((r) => r.includes("[🖼 Image #1]"));
		const colIdx = screen[rowIdx]!.indexOf("[🖼 Image #1]") + 2;

		const visiblePopups = () =>
			harness!.tui.overlayStack.filter(
				(e) => e.options?.nonCapturing === true && harness!.tui.isOverlayVisible(e),
			);

		harness.tui.clickMouse(colIdx, rowIdx);
		expect(visiblePopups()).toHaveLength(1);

		/* Повторный клик по той же пилюле закрывает попап */
		harness.tui.clickMouse(colIdx, rowIdx);
		expect(visiblePopups()).toHaveLength(0);

		/* Открываем снова и кликаем в пустую область вьюпорта -> закрывается */
		harness.tui.clickMouse(colIdx, rowIdx);
		expect(visiblePopups()).toHaveLength(1);
		harness.tui.clickMouse(70, rowIdx + 4);
		expect(visiblePopups()).toHaveLength(0);
	});
});
