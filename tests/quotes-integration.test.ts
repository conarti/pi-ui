import {
	ExtensionRunner,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Spacer, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { PiUiComposerEditor } from "../src/features/chrome/composer.ts";
import { QuoteSelectionPopup } from "../src/features/quotes/index.ts";
import conartiPiUi from "../src/index.ts";
import { setHostClipboardProvider } from "../src/shared/host-runtime.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

async function flushAsyncQuote(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Native Quote Prompt Chips, Alt+Q, /quote, /quotes, and Selection Hover Popup", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		setHostClipboardProvider(undefined);
		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("quotes active fullscreen selection or clipboard fallback into inline [❝ Quote #N · M lines] pills at the cursor across Latin Alt+Q, Cyrillic Alt+й, macOS Option+Q, and /quote [n] with no above-editor quote widget", async () => {
		let clipboardText: string | null = "Clipboard line 1\nClipboard line 2\nClipboard line 3";

		setHostClipboardProvider({
			readFilePaths: async () => null,
			readImage: async () => null,
			readText: async () => clipboardText,
		});

		const branch = [
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: "How should caching work?" },
			},
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "pondering ttl" },
						{ type: "text", text: "First reply line A\nFirst reply line B" },
					],
				},
			},
			{
				type: "message",
				id: "u2",
				message: { role: "user", content: "What about deployment?" },
			},
			{
				type: "message",
				id: "a2",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Latest reply single line" }],
				},
			},
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 100,
			height: 28,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		harness.tui.chatContainer.addChild(
			new Text("Transcript alpha line\nTranscript beta line", 0, 0),
		);
		harness.tui.renderViewport(100, 28);

		const editor = harness.editor as PiUiComposerEditor;

		/* 1. Активное выделение во fullscreen viewport + кириллический Alt+й (Kitty CSI-u без baseLayoutKey) */
		harness.tui.pressMouse(0, 0, "left");
		harness.tui.dragMouse(20, 1, "left");
		harness.tui.releaseMouse(20, 1, "left");
		expect(harness.tui.getActiveSelectionText()).toContain("Transcript alpha line");

		await harness.sendTerminalInput("\x1b[1081;3u");
		await flushAsyncQuote();

		expect(editor.getText()).toBe("[❝ Quote #1 · 2 lines]");
		expect(harness.tui.getActiveSelectionText()).toBeUndefined();
		expect(harness.widgets.has("quote-blocks")).toBe(false);

		/* 2. Нет активного выделения -> фоллбэк на HostRuntime.clipboard через все раскладки Alt+Q / Option+Q */
		const altQSequences = [
			"\x1bq",
			"\x1b[113;3u",
			"\x1b[27;3;113~",
			"\x1bй",
			"\x1b[1081::113;3u",
			"\x1b[27;3;1081~",
			"œ",
			"\x1b[339u",
			"ј",
		];

		for (let i = 0; i < altQSequences.length; i++) {
			harness.ctx.ui.setEditorText("Prefix  suffix");
			/* Поставим курсор ровно между двумя пробелами ("Prefix | suffix"), чтобы проверить вставку в позицию курсора */
			await harness.sendTerminalInput("\x05");
			for (let left = 0; left < 7; left++) {
				await harness.sendTerminalInput("\x1b[D");
			}
			clipboardText = i % 2 === 0 ? "Single clip" : "Clip A\nClip B\nClip C";
			await harness.sendTerminalInput(altQSequences[i]!);
			await flushAsyncQuote();

			const expectedToken =
				i % 2 === 0 ? "[❝ Quote #1 · 1 line]" : "[❝ Quote #1 · 3 lines]";
			expect(editor.getText(), `sequence index ${i}`).toBe(`Prefix ${expectedToken} suffix`);
			expect(editor.getText()).not.toContain("œ");
			expect(editor.getText()).not.toContain("ј");
		}

		/* 3. /quote (по умолчанию 1 = последний ответ ассистента) и /quote 2 (предпоследний ответ) */
		harness.ctx.ui.setEditorText("");
		await harness.runCommand("quote", "");
		expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");

		await harness.sendTerminalInput(" ");
		await harness.runCommand("quote", "2");
		expect(editor.getText()).toBe("[❝ Quote #1 · 1 line] [❝ Quote #2 · 2 lines]");
		expect(harness.widgets.has("quote-blocks")).toBe(false);

		/* Невалидный аргумент и выход за пределы истории не портят черновик */
		const countBeforeInvalid = harness.notifications.length;
		await harness.runCommand("quote", "99");
		expect(harness.notifications.length).toBeGreaterThan(countBeforeInvalid);
		expect(editor.getText()).toBe("[❝ Quote #1 · 1 line] [❝ Quote #2 · 2 lines]");
	});

	it("provides /quotes Modal Card inspection, multi-line editing, single removal, and full clearing while preserving non-quote chips and undo", async () => {
		const TINY_PNG_BYTES = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAADklEQVR4nGP4z8DAwMAAAwkB/7b5L2EAAAAASUVORK5CYII=",
				"base64",
			),
		);
		let clipImg: Uint8Array | null = TINY_PNG_BYTES;
		let clipTxt: string | null = null;

		setHostClipboardProvider({
			readFilePaths: async () => null,
			readImage: async () => (clipImg ? { bytes: clipImg, mimeType: "image/png" } : null),
			readText: async () => clipTxt,
		});

		harness = createExtensionHarness({ theme: "dark", width: 96, height: 28 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;

		/* Пустой черновик: /quotes уведомляет и не открывает пустую модалку */
		await harness.runCommand("quotes", "");
		expect(harness.activeCustomModal).toBeUndefined();
		expect(harness.notifications.length).toBeGreaterThan(0);

		/* Соберём смешанный черновик: [🖼 Image #1] + [❝ Quote #2 · 2 lines] + [❝ Quote #3 · 1 line] */
		await harness.sendTerminalInput("\x16");
		await flushAsyncQuote();
		expect(editor.getText()).toBe("[🖼 Image #1]");

		clipImg = null;
		clipTxt = "Original quote A\nOriginal quote B";
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[113;3u");
		await flushAsyncQuote();

		clipTxt = "Second quote line";
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[113;3u");
		await flushAsyncQuote();

		expect(editor.getText()).toBe(
			"[🖼 Image #1] [❝ Quote #2 · 2 lines] [❝ Quote #3 · 1 line]",
		);

		/* Откроем /quotes Modal Card (без await, т.к. openModalCard ждёт закрытия модалки) */
		let modalClosed = false;
		const modalPromise = harness.runCommand("quotes", "").then(() => {
			modalClosed = true;
		});
		await Promise.resolve();
		expect(harness.activeCustomModal).toBeDefined();

		/* Проверим рендер инспектора: обе цитаты и превью первой цитаты видны, ширина строк точная */
		const modalComp = harness.activeCustomModal!.component;
		const inspectLines = modalComp.render(76);
		for (const line of inspectLines) {
			expect(visibleWidth(line)).toBe(76);
		}
		const plainInspect = inspectLines.map((l) => stripTerminalSequences(l)).join("\n");
		expect(plainInspect).toContain("Quote #2 · 2 lines");
		expect(plainInspect).toContain("Quote #3 · 1 line");
		expect(plainInspect).toContain("Original quote A");

		/* Нажмём Enter (или 'e') для редактирования Quote #2, добавим третью строку через Alt+Enter и сохраним по Enter */
		await harness.sendTerminalInput("\r");
		await harness.sendTerminalInput("\x1b\rAdded third line");
		await harness.sendTerminalInput("\r");

		expect(editor.getText()).toBe(
			"[🖼 Image #1] [❝ Quote #2 · 3 lines] [❝ Quote #3 · 1 line]",
		);

		/* Перейдём стрелкой вниз на Quote #3 и удалим её клавишей 'd' */
		await harness.sendTerminalInput("\x1b[B");
		await harness.sendTerminalInput("d");
		expect(editor.getText()).toBe("[🖼 Image #1] [❝ Quote #2 · 3 lines]");

		/* Закроем модалку по Esc */
		await harness.sendTerminalInput("\x1b");
		await modalPromise;
		expect(modalClosed).toBe(true);
		expect(harness.activeCustomModal).toBeUndefined();

		/* Проверим очистку всех цитат через /quotes Modal Card ('c') при сохранении [🖼 Image #1] и текста */
		await harness.sendTerminalInput(" keep this text");
		const clearModalPromise = harness.runCommand("quotes", "");
		await Promise.resolve();
		expect(harness.activeCustomModal).toBeDefined();
		await harness.sendTerminalInput("c");
		await clearModalPromise;

		expect(editor.getText()).toBe("[🖼 Image #1] keep this text");

		/* Undo (Ctrl+Z) в композере восстанавливает удалённую цитату вместе с её обновлённым 3-строчным текстом */
		await harness.sendTerminalInput("\x1a");
		expect(editor.getText()).toBe("[🖼 Image #1] [❝ Quote #2 · 3 lines] keep this text");

		/* Подкоманда /quotes clear также очищает только цитаты */
		await harness.runCommand("quotes", "clear");
		expect(editor.getText()).toBe("[🖼 Image #1] keep this text");

		/* Проверим подкоманды /quotes edit и /quotes remove qN, а также клик мышью по кнопкам Modal Card */
		clipTxt = "Mouse editable quote";
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[113;3u");
		await flushAsyncQuote();
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 1 line]",
		);

		/* Правка цитаты без изменения числа строк (1 line -> 1 line) должна записывать Undo-шаг, не удаляя чип по Ctrl+Z */
		await harness.runCommand("quotes", "edit q2 Same-line replacement");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 1 line]",
		);
		await harness.sendTerminalInput("\x1a");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 1 line]",
		);
		const revertedPreview = harness.tui
			.renderViewport(96, 28)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(revertedPreview).toContain("Mouse editable quote");

		/* Вставка многострочного bracketed paste по чанкам в режиме редактирования Modal Card не завершает правку раньше времени */
		const pasteEditPromise = harness.runCommand("quotes", "edit 2");
		await Promise.resolve();
		expect(harness.activeCustomModal).toBeDefined();
		await harness.sendTerminalInput("\x1b[200~ multi A");
		await harness.sendTerminalInput("\n");
		await harness.sendTerminalInput("multi B\x1b[201~");
		expect(harness.activeCustomModal).toBeDefined();
		await harness.sendTerminalInput("\r");
		await harness.sendTerminalInput("\x1b");
		await pasteEditPromise;
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 2 lines]",
		);

		await harness.runCommand("quotes", "edit q2 Inline updated line 1\nInline updated line 2");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 2 lines]",
		);

		const mouseModalPromise = harness.runCommand("quotes", "");
		await Promise.resolve();
		const renderedModal = harness.tui
			.renderViewport(96, 28)
			.map((l) => stripTerminalSequences(l));
		const clearPillRow = renderedModal.findIndex((l) => l.includes("Очистить все"));
		expect(clearPillRow).toBeGreaterThan(0);
		const clearPillCol = renderedModal[clearPillRow]!.indexOf("Очистить все");
		harness.tui.clickMouse(clearPillCol + 2, clearPillRow, "left");
		await mouseModalPromise;
		expect(editor.getText()).toBe("[🖼 Image #1] keep this text");
	});

	it("cleanly supersedes external pi-quote-blocks whether loaded before or after @conarti/pi-ui in both ExtensionRunner and shared ExtensionAPI", async () => {
		const externalCalls: string[] = [];
		const fakePiQuoteBlocks = (pi: ExtensionAPI) => {
			pi.registerShortcut("alt+q", {
				description: "Quote selected text (or clipboard) as a block",
				handler: async () => {
					externalCalls.push("shortcut:alt+q");
				},
			});
			pi.registerShortcut("alt+h", {
				description: "Fold / expand quote blocks",
				handler: async () => {
					externalCalls.push("shortcut:alt+h");
				},
			});
			pi.registerShortcut("alt+e", {
				description: "Manage quote blocks: preview, edit, remove, re-insert marker, or clear all",
				handler: async () => {
					externalCalls.push("shortcut:alt+e");
				},
			});
			pi.registerCommand("quote", {
				description: "Quote a past assistant reply as a block",
				handler: async () => {
					externalCalls.push("cmd:quote");
				},
			});
			pi.registerCommand("quotes", {
				description: "Manage quote blocks",
				handler: async () => {
					externalCalls.push("cmd:quotes");
				},
			});
			pi.on("session_start", async (_ev, ctx) => {
				externalCalls.push("event:session_start");
				ctx.ui.setWidget("quote-blocks", () => ({
					render: () => ["❝ Q1 · external widget"],
					invalidate() {},
				}));
			});
			pi.on("input", async (ev: any) => {
				externalCalls.push("event:input");
				return { action: "transform", text: `CORRUPTED:${ev.text}` };
			});
		};

		/* A. Проверка настоящего ExtensionRunner при обоих порядках загрузки: до и после @conarti/pi-ui */
		const buildRunnerRecord = (path: string, init: (pi: ExtensionAPI) => void) => {
			const record: any = {
				path,
				resolvedPath: path,
				sourceInfo: { source: path },
				handlers: new Map<string, Array<(...args: any[]) => any>>(),
				tools: new Map(),
				commands: new Map(),
				flags: new Map(),
				shortcuts: new Map(),
				messageRenderers: new Map(),
				entryRenderers: new Map(),
				toolRenderers: [],
			};
			const api: any = {
				on(event: string, fn: (...args: any[]) => any) {
					const list = record.handlers.get(event) ?? [];
					list.push(fn);
					record.handlers.set(event, list);
				},
				registerCommand(name: string, opts: any) {
					record.commands.set(name, { name, ...opts, extensionPath: path });
				},
				registerShortcut(key: string, opts: any) {
					record.shortcuts.set(key.toLowerCase(), {
						key: key.toLowerCase(),
						...opts,
						extensionPath: path,
					});
				},
				registerFlag(name: string, opts: any) {
					record.flags.set(name, { name, ...opts, extensionPath: path });
				},
				getFlag: () => false,
				getCommands: () => [],
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools: () => {},
				appendEntry: () => {},
				sendUserMessage: () => {},
				getThinkingLevel: () => "medium",
				setThinkingLevel: () => {},
				getSettings: () => ({}),
				compact: () => {},
				registerMarkdownTransformer: (transformer: any) => {
					record.markdownTransformer = { transformer, messageTypes: new Set(["assistant"]) };
				},
				registerToolRenderer: (r: any) => {
					record.toolRenderers.push(r);
				},
				registerTool: (t: any) => {
					record.tools.set(t.name, { definition: t, extensionPath: path });
				},
			};
			init(api as ExtensionAPI);
			return record;
		};

		for (const order of ["before", "after"] as const) {
			externalCalls.length = 0;
			const extQuoteBlocks = buildRunnerRecord(
				"/Users/test/.pi/agent/npm/node_modules/pi-quote-blocks/quote-blocks.ts",
				fakePiQuoteBlocks,
			);
			const extConarti = buildRunnerRecord(
				"/Users/test/Projects/pi-ui/src/index.ts",
				conartiPiUi,
			);
			const extensions =
				order === "before" ? [extQuoteBlocks, extConarti] : [extConarti, extQuoteBlocks];

			const fakeRuntime: any = {
				flagValues: new Map(),
				pendingProviderRegistrations: [],
				pendingNativeProviderRegistrations: [],
				pendingVirtualModelRegistrations: [],
				mcpServers: { setChangeListener() {}, list: () => [] },
				invalidate() {},
			};
			const runner = new (ExtensionRunner as any)(
				extensions,
				fakeRuntime,
				process.cwd(),
				{ getEntries: () => [], getBranch: () => [] },
				{},
			);

			const registeredCmds = runner.getRegisteredCommands();
			const quoteCmds = registeredCmds.filter((c: any) => c.name === "quote" || c.invocationName.startsWith("quote"));
			expect(quoteCmds.map((c: any) => c.invocationName), `commands in ${order} order`).toEqual([
				"quote",
				"quotes",
			]);
			expect(runner.getCommand("quote")?.extensionPath).toContain("pi-ui");
			expect(runner.getCommand("quotes")?.extensionPath).toContain("pi-ui");

			const shortcuts = runner.getShortcuts({});
			expect(shortcuts.get("alt+q")?.extensionPath).toContain("pi-ui");
			expect(shortcuts.has("alt+h")).toBe(false);
			expect(shortcuts.has("alt+e")).toBe(false);
			expect(runner.getShortcutDiagnostics()).toEqual([]);

			const inputResult = await runner.emitInput("Plain prompt", undefined, "interactive");
			expect(inputResult).toEqual({ action: "continue" });
			expect(externalCalls).toEqual([]);
		}

		/* B. Проверка сосуществования на одном ExtensionHarness (включая стороннее расширение сразу после pi-quote-blocks) */
		for (const order of ["before", "after"] as const) {
			externalCalls.length = 0;
			const thirdPartyCalls: string[] = [];
			const innocentThirdExtension = (pi: ExtensionAPI) => {
				pi.on("session_start", async () => {
					thirdPartyCalls.push("third:session_start");
				});
				pi.on("input", async () => {
					thirdPartyCalls.push("third:input");
					return { action: "continue" };
				});
			};

			setHostClipboardProvider({
				readFilePaths: async () => null,
				readImage: async () => null,
				readText: async () => "Native chip text",
			});

			harness = createExtensionHarness({ theme: "dark", width: 92, height: 26 });
			if (order === "before") {
				harness.mount(fakePiQuoteBlocks);
				harness.mount(conartiPiUi);
				harness.mount(innocentThirdExtension);
			} else {
				harness.mount(conartiPiUi);
				harness.mount(fakePiQuoteBlocks);
				harness.mount(innocentThirdExtension);
			}
			await harness.startSession();
			expect(thirdPartyCalls, `thirdPartyCalls in ${order} order`).toEqual(["third:session_start"]);

			expect(harness.widgets.has("quote-blocks")).toBe(false);
			if (order === "after") {
				expect(harness.shortcuts.has("alt+h")).toBe(false);
				expect(harness.shortcuts.has("alt+e")).toBe(false);
				const inputRes = await harness.emit("input", {
					type: "input",
					text: "hello",
					source: "interactive",
				});
				expect(inputRes).not.toContainEqual(
					expect.objectContaining({ text: "CORRUPTED:hello" }),
				);
				expect(thirdPartyCalls).toEqual(["third:session_start", "third:input"]);
			}

			await harness.sendTerminalInput("\x1b[113;3u");
			await flushAsyncQuote();

			const editor = harness.editor as PiUiComposerEditor;
			expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");
			await harness.runCommand("quotes", "clear");
			expect(editor.getText()).toBe("");
			expect(externalCalls.filter((c) => c.startsWith("shortcut:") || c.startsWith("cmd:"))).toEqual([]);

			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("expands mixed image + paste + quote drafts into blank-line-padded Markdown blockquotes on submit while rendering clickable [❝ Quote #N · M lines] pills with preview popups in User Prompt and Sticky Prompt cards across /reload", async () => {
		const TINY_PNG_BASE64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAADklEQVR4nGP4z8DAwMAAAwkB/7b5L2EAAAAASUVORK5CYII=";
		const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64"));

		let clipImg: Uint8Array | null = TINY_PNG_BYTES;
		let clipTxt: string | null = null;

		setHostClipboardProvider({
			readFilePaths: async () => null,
			readImage: async () => (clipImg ? { bytes: clipImg, mimeType: "image/png" } : null),
			readText: async () => clipTxt,
		});

		harness = createExtensionHarness({ theme: "dark", width: 100, height: 26 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;

		/* 1. Соберём черновик: текст + [🖼 Image #1] + [📋 Pasted #2 · 4 lines] + [❝ Quote #3 · 3 lines] (с пустой строкой внутри!) */
		await harness.sendTerminalInput("Review ");
		await harness.sendTerminalInput("\x16");
		await flushAsyncQuote();

		clipImg = null;
		await harness.sendTerminalInput(" code ");
		await harness.sendTerminalInput("\x1b[200~const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\x1b[201~");

		clipTxt = "\tQuoted first line\n\n\t\tQuoted third line";
		await harness.sendTerminalInput(" against ");
		await harness.sendTerminalInput("\x1b[113;3u");
		await flushAsyncQuote();
		await harness.sendTerminalInput(" carefully");

		const rawDraft = editor.getText();
		expect(rawDraft).toBe(
			"Review [🖼 Image #1] code [📋 Pasted #2 · 4 lines] against [❝ Quote #3 · 3 lines] carefully",
		);

		/* Имитируем реальный submitValue композера (сначала очистка черновика, затем input event) */
		harness.ctx.ui.setEditorText("");
		const inputResults = await harness.emit("input", {
			type: "input",
			text: rawDraft,
			source: "interactive",
		});
		const transformRes = inputResults.find(
			(r: any) => r && typeof r === "object" && r.action === "transform",
		) as { action: "transform"; text: string; images?: any[] } | undefined;

		expect(transformRes).toBeDefined();
		expect(transformRes!.images).toHaveLength(1);
		expect(transformRes!.text).toBe(
			[
				"Review [Image #1: " + transformRes!.text.match(/\[Image #1: ([^\]]+)\]/)?.[1] + "] code const a = 1;",
				"const b = 2;",
				"const c = 3;",
				"const d = 4; against",
				"",
				"> \tQuoted first line",
				">",
				"> \t\tQuoted third line",
				"",
				"carefully",
			].join("\n"),
		);

		const msgTs = 1715900100000;
		await harness.emit("message_start", {
			type: "message_start",
			message: { role: "user", content: transformRes!.text, timestamp: msgTs },
		});
		await harness.emit("message_end", {
			type: "message_end",
			message: { role: "user", content: transformRes!.text, timestamp: msgTs },
		});

		const persisted = harness.appendedEntries.find((e) => e.customType === "conarti-prompt-chips");
		expect(persisted).toBeDefined();

		/* Добавим запись сообщения в ветку и смонтируем карточку промпта + длинный ответ, затем проверим /reload */
		const branchEntries = [
			{
				type: "custom",
				id: "c-chips-1",
				parentId: null,
				timestamp: "2026-05-17T10:00:00.000Z",
				customType: "conarti-prompt-chips",
				data: persisted!.data,
			},
			{
				type: "message",
				id: "u-turn-1",
				parentId: "c-chips-1",
				timestamp: "2026-05-17T10:00:00.010Z",
				message: {
					role: "user",
					timestamp: msgTs,
					content: [
						{ type: "text", text: transformRes!.text },
						{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
					],
				},
			},
		];
		harness.setEntries(branchEntries, branchEntries);
		await harness.emit("session_start", { reason: "reload" });

		const userCard = new UserMessageComponent(
			transformRes!.text,
			undefined,
			1,
			[],
			"u-turn-1",
			"2026-05-17T10:00:00.010Z",
		);
		harness.tui.chatContainer.addChild(userCard);
		harness.tui.chatContainer.addChild(new Spacer(40));

		/* В обычном положении (scrollTop = 0 после первичного layout) видна сама карточка UserMessageComponent с пилюлей [❝ Quote #3 · 3 lines] */
		harness.tui.renderViewport(100, 26);
		(harness.tui.scroll as any).scrollTo(0, { disableFollow: true });
		const topFrame = harness.tui.renderViewport(100, 26).map((l) => stripTerminalSequences(l));
		const quoteCardRow = topFrame.findIndex((l) => l.includes("[❝ Quote #3 · 3 lines]"));
		expect(quoteCardRow).toBeGreaterThanOrEqual(0);
		expect(topFrame.join("\n")).not.toContain("> Quoted first line");

		/* Клик по пилюле [❝ Quote #3 · 3 lines] в User Prompt открывает Hover Popup превью с текстом цитаты */
		const quoteCardCol = topFrame[quoteCardRow]!.indexOf("[❝ Quote #3 · 3 lines]");
		harness.tui.clickMouse(quoteCardCol + 3, quoteCardRow, "left");
		const withTranscriptPreview = harness.tui
			.renderViewport(100, 26)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(withTranscriptPreview).toContain("❝ Quote #3 · 3 lines");
		expect(withTranscriptPreview).toContain("│   Quoted first line");
		expect(withTranscriptPreview).toContain("│     Quoted third line");

		/* Прокрутка через scrollBy также закрывает открытое превью sent-pill */
		harness.tui.scroll.scrollBy(12);
		expect(
			harness.tui
				.renderViewport(100, 26)
				.map((l) => stripTerminalSequences(l))
				.join("\n"),
		).not.toContain("│   Quoted first line");

		const scrolledFrame = harness.tui.renderViewport(100, 26).map((l) => stripTerminalSequences(l));
		const stickyQuoteRow = scrolledFrame.findIndex(
			(l, idx) => idx < 5 && l.includes("[❝ Quote #3 · 3 lines]"),
		);
		expect(stickyQuoteRow).toBeGreaterThanOrEqual(0);
		const stickyQuoteCol = scrolledFrame[stickyQuoteRow]!.indexOf("[❝ Quote #3 · 3 lines]");

		harness.tui.clickMouse(stickyQuoteCol + 3, stickyQuoteRow, "left");
		const withStickyPreview = harness.tui
			.renderViewport(100, 26)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(withStickyPreview).toContain("❝ Quote #3 · 3 lines");
		expect(withStickyPreview).toContain("│   Quoted first line");
	});

	it.each(["dark", "light"] as const)(
		"lazily mounts nonCapturing ╭ ❝ Цитировать ╮ Hover Popup on drag and multi-click selection in %s theme (preserving copyOnSelect and respecting Modal Cards), quotes on click, and dismisses on Esc, scroll, or outside click without stealing focus",
		async (themeMode) => {
			harness = createExtensionHarness({ theme: themeMode, width: 100, height: 26 });
			(harness.tui as any).copyOnSelect = true;
			harness.mount(conartiPiUi);
			await harness.startSession();

			const editor = harness.editor as PiUiComposerEditor;
			harness.tui.setFocus(editor);

			harness.tui.chatContainer.addChild(
				new Text(
					[
						"Line zero intro",
						"Selectable alpha beta gamma delta",
						"Second quoted transcript line",
						"Third transcript line for scrolling",
					].join("\n"),
					0,
					0,
				),
			);
			harness.tui.chatContainer.addChild(new Spacer(35));
			harness.tui.scroll.scrollTo(0);

			/* До выделения (и при выделении пустых строк Spacer внизу) оверлей не монтируется */
			harness.tui.renderViewport(100, 26);
			harness.tui.pressMouse(0, 10, "left");
			harness.tui.dragMouse(15, 11, "left");
			harness.tui.releaseMouse(15, 11, "left");
			const initialVisibleNonCapturing = harness.tui.overlayStack.filter(
				(e) => e.options?.nonCapturing && harness!.tui.isOverlayVisible(e),
			);
			expect(initialVisibleNonCapturing).toHaveLength(0);

			/* Прокрутим к началу транскрипта, где находятся строки с текстом */
			(harness.tui.scroll as any).scrollTo(0, { disableFollow: true });
			harness.tui.renderViewport(100, 26);

			/* 1. Выделение перетаскиванием мыши (drag) монтирует ╭ ❝ Цитировать ╮ около конца выделения и сохраняет copyOnSelect */
			harness.tui.terminal.writes.length = 0;
			harness.tui.pressMouse(0, 1, "left");
			harness.tui.dragMouse(33, 2, "left");
			harness.tui.releaseMouse(33, 2, "left");

			/* Нативный copyOnSelect записал OSC 52 в терминал */
			const osc52Write = harness.tui.terminal.writes.find((w) => w.startsWith("\x1b]52;c;"));
			expect(osc52Write).toBeDefined();

			const dragPopupOverlays = harness.tui.overlayStack.filter(
				(e) => e.options?.nonCapturing && harness!.tui.isOverlayVisible(e),
			);
			expect(dragPopupOverlays).toHaveLength(1);
			expect(harness.tui.getTopmostVisibleOverlay()).toBeUndefined();
			expect(harness.tui.getFocusedComponent()).toBe(editor);

			const rawDragScreen = harness.tui.renderViewport(100, 26);
			const plainDragScreen = rawDragScreen.map((l) => stripTerminalSequences(l));
			const popupRow = plainDragScreen.findIndex((l) => l.includes("╭ ❝ Цитировать ╮"));
			expect(popupRow).toBe(3);
			const popupCol = plainDragScreen[popupRow]!.indexOf("╭ ❝ Цитировать ╮");
			expect(popupCol).toBeGreaterThanOrEqual(1);

			/* Проверка отсутствия фиолетовых оттенков (r > g && b > g) в строке попапа */
			for (const m of rawDragScreen[popupRow]!.matchAll(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/g)) {
				const r = Number(m[1]);
				const g = Number(m[2]);
				const b = Number(m[3]);
				expect(r > g && b > g, `purple rgb(${r},${g},${b}) in ${themeMode}`).toBe(false);
			}

			/* Клик по ╭ ❝ Цитировать ╮ вставляет чип цитаты (несмотря на clearTextSelection на press!), очищает выделение, скрывает попап и фокусирует композер */
			harness.tui.setFocus(null);
			harness.tui.clickMouse(popupCol + 4, popupRow, "left");

			expect(editor.getText()).toBe("[❝ Quote #1 · 2 lines]");
			expect(harness.tui.getActiveSelectionText()).toBeUndefined();
			expect(harness.tui.getFocusedComponent()).toBe(editor);
			expect(
				harness.tui.overlayStack.filter((e) => e.component instanceof QuoteSelectionPopup),
			).toHaveLength(0);
			const afterQuoteClickScreen = harness.tui
				.renderViewport(100, 26)
				.map((l) => stripTerminalSequences(l))
				.join("\n");
			expect(afterQuoteClickScreen).not.toContain("╭ ❝ Цитировать ╮");
			/* Так как композер получил фокус и курсор стоит у [❝ Quote #1 · 2 lines], показывается caret-превью этого чипа */
			expect(afterQuoteClickScreen).toContain("❝ Quote #1 · 2 lines");

			/* 2. Двойной клик (multi-click word selection) монтирует попап, а Esc мгновенно скрывает его без кражи фокуса */
			harness.ctx.ui.setEditorText("");
			harness.tui.renderViewport(100, 26);
			harness.tui.clickMouse(12, 1, "left");
			harness.tui.clickMouse(12, 1, "left");
			expect(harness.tui.getActiveSelectionText()).toBe("alpha");
			expect(
				harness.tui
					.renderViewport(100, 26)
					.map((l) => stripTerminalSequences(l))
					.join("\n"),
			).toContain("╭ ❝ Цитировать ╮");

			await harness.sendTerminalInput("\x1b");
			expect(harness.tui.getFocusedComponent()).toBe(editor);
			expect(
				harness.tui
					.renderViewport(100, 26)
					.map((l) => stripTerminalSequences(l))
					.join("\n"),
			).not.toContain("╭ ❝ Цитировать ╮");

			/* 3. Прокрутка колесом скрывает попап мгновенно без кражи фокуса */
			harness.tui.pressMouse(0, 1, "left");
			harness.tui.dragMouse(16, 1, "left");
			harness.tui.releaseMouse(16, 1, "left");
			expect(
				harness.tui
					.renderViewport(100, 26)
					.map((l) => stripTerminalSequences(l))
					.join("\n"),
			).toContain("╭ ❝ Цитировать ╮");

			harness.tui.wheelMouse(10, 5, "down");
			expect(harness.tui.getFocusedComponent()).toBe(editor);
			expect(
				harness.tui
					.renderViewport(100, 26)
					.map((l) => stripTerminalSequences(l))
					.join("\n"),
			).not.toContain("╭ ❝ Цитировать ╮");

			/* 4. Клик вне попапа скрывает его мгновенно без кражи фокуса */
			harness.tui.scroll.scrollTo(0);
			harness.tui.renderViewport(100, 26);
			harness.tui.pressMouse(0, 1, "left");
			harness.tui.dragMouse(16, 1, "left");
			harness.tui.releaseMouse(16, 1, "left");
			expect(
				harness.tui
					.renderViewport(100, 26)
					.map((l) => stripTerminalSequences(l))
					.join("\n"),
			).toContain("╭ ❝ Цитировать ╮");

			harness.tui.clickMouse(2, 6, "left");
			expect(harness.tui.getFocusedComponent()).toBe(editor);
			expect(
				harness.tui
					.renderViewport(100, 26)
					.map((l) => stripTerminalSequences(l))
					.join("\n"),
			).not.toContain("╭ ❝ Цитировать ╮");

			/* 5. Тройной клик (triple-click line selection) и лёгкий сдвиг мыши внутри ╭ ❝ Цитировать ╮ работают надёжно */
			harness.ctx.ui.setEditorText("");
			harness.tui.clickMouse(12, 1, "left");
			harness.tui.clickMouse(12, 1, "left");
			harness.tui.clickMouse(12, 1, "left");
			expect(harness.tui.getActiveSelectionText()).toBe("Selectable alpha beta gamma delta");
			const tripleScreen = harness.tui
				.renderViewport(100, 26)
				.map((l) => stripTerminalSequences(l));
			const triplePopupRow = tripleScreen.findIndex((l) => l.includes("╭ ❝ Цитировать ╮"));
			expect(triplePopupRow).toBeGreaterThanOrEqual(0);
			const triplePopupCol = tripleScreen[triplePopupRow]!.indexOf("╭ ❝ Цитировать ╮");

			/* Небольшой горизонтальный сдвиг внутри кнопки между press и release не теряет клик и не дублирует вставку */
			harness.tui.pressMouse(triplePopupCol + 2, triplePopupRow, "left");
			harness.tui.dragMouse(triplePopupCol + 7, triplePopupRow, "left");
			harness.tui.releaseMouse(triplePopupCol + 7, triplePopupRow, "left");
			expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");

			/* 6. Клавиатурная и программная прокрутка (scrollBy / scrollToStart / scrollToEnd / scrollTo) скрывает попап */
			for (const { startTop, scrollAction } of [
				{ startTop: 0, scrollAction: () => harness!.tui.scroll.scrollBy(3) },
				{ startTop: 0, scrollAction: () => harness!.tui.scroll.scrollToEnd() },
				{ startTop: 2, scrollAction: () => harness!.tui.scroll.scrollToStart() },
				{ startTop: 0, scrollAction: () => harness!.tui.scroll.scrollTo(4) },
			]) {
				(harness.tui.scroll as any).scrollTo(startTop, { disableFollow: true });
				harness.tui.renderViewport(100, 26);
				harness.tui.pressMouse(0, 0, "left");
				harness.tui.dragMouse(16, 0, "left");
				harness.tui.releaseMouse(16, 0, "left");
				expect(
					harness.tui
						.renderViewport(100, 26)
						.map((l) => stripTerminalSequences(l))
						.join("\n"),
				).toContain("╭ ❝ Цитировать ╮");
				scrollAction();
				expect(harness.tui.getFocusedComponent()).toBe(editor);
				expect(
					harness.tui
						.renderViewport(100, 26)
						.map((l) => stripTerminalSequences(l))
						.join("\n"),
				).not.toContain("╭ ❝ Цитировать ╮");
			}

			/* 7. При открытом блокирующем Modal Card (tui.getTopmostVisibleOverlay()) попап НЕ монтируется */
			(harness.tui.scroll as any).scrollTo(0, { disableFollow: true });
			harness.tui.renderViewport(100, 26);
			const blockingHandle = harness.tui.showOverlay(
				{ render: () => ["╭─ Modal ─╮", "╰─────────╯"], invalidate() {} },
				{ width: 20, anchor: "center" },
			);
			expect(harness.tui.getTopmostVisibleOverlay()).toBeDefined();
			harness.tui.pressMouse(0, 1, "left");
			harness.tui.dragMouse(16, 1, "left");
			harness.tui.releaseMouse(16, 1, "left");
			expect(
				harness.tui.overlayStack.filter(
					(e) => e.options?.nonCapturing && harness!.tui.isOverlayVisible(e),
				),
			).toHaveLength(0);
			blockingHandle.hide();
		},
	);

	it("preserves ScrollView selection, auto-scroll, and Sticky Prompt / Outline Rail drag-release when composer-caret Hover Popup and Sticky Prompt are active, while ignoring dock-originated drags", async () => {
		const branch = [
			{
				type: "message",
				id: "u1",
				message: { role: "user", timestamp: 1715900001000, content: "First user turn prompt" },
			},
			{
				type: "message",
				id: "a1",
				message: { role: "assistant", content: [{ type: "text", text: "First reply" }] },
			},
			{
				type: "message",
				id: "u2",
				message: { role: "user", timestamp: 1715900060000, content: "Second user turn prompt" },
			},
			{
				type: "message",
				id: "a2",
				message: { role: "assistant", content: [{ type: "text", text: "Second reply" }] },
			},
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 100,
			height: 26,
			entries: branch,
			branch,
		});
		(harness.tui as any).copyOnSelect = true;
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		harness.tui.dock.addChild(editor);
		harness.tui.setFocus(editor);

		harness.tui.chatContainer.addChild(
			new UserMessageComponent(
				"First user turn prompt",
				undefined,
				1,
				[],
				"u1",
				"2026-05-17T10:00:01.000Z",
			),
		);
		harness.tui.chatContainer.addChild(
			new Text(
				Array.from({ length: 14 }, (_, idx) => `Body turn one row ${idx} clean text`).join("\n"),
				0,
				0,
			),
		);
		harness.tui.chatContainer.addChild(
			new UserMessageComponent(
				"Second user turn prompt",
				undefined,
				1,
				[],
				"u2",
				"2026-05-17T10:01:00.000Z",
			),
		);
		harness.tui.chatContainer.addChild(new Spacer(30));

		/* Прокрутим так, чтобы Sticky Prompt (3 строки сверху) и Outline Rail (колонки 97..98) были одновременно активны */
		harness.tui.renderViewport(100, 26);
		(harness.tui.scroll as any).scrollTo(4, { disableFollow: true });
		harness.tui.renderViewport(100, 26);

		/* 1. Первое цитирование оставляет в композере [❝ Quote #1 · 1 line] и видимый nonCapturing composer-caret Hover Popup */
		harness.tui.pressMouse(0, 6, "left");
		harness.tui.dragMouse(20, 6, "left");
		harness.tui.releaseMouse(20, 6, "left");
		const firstScreen = harness.tui.renderViewport(100, 26).map((l) => stripTerminalSequences(l));
		const firstPopRow = firstScreen.findIndex((l) => l.includes("╭ ❝ Цитировать ╮"));
		expect(firstPopRow).toBeGreaterThanOrEqual(3);
		const firstPopCol = firstScreen[firstPopRow]!.indexOf("╭ ❝ Цитировать ╮");
		harness.tui.clickMouse(firstPopCol + 3, firstPopRow, "left");
		expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");

		/* Убедимся, что nonCapturing composer-caret превью действительно смонтировано поверх вьюпорта */
		harness.tui.renderViewport(100, 26);
		expect((harness.tui as any).hasOverlay()).toBe(true);
		expect(harness.tui.getTopmostVisibleOverlay()).toBeUndefined();

		/* Нативный скроллбар остаётся доступным несмотря на nonCapturing Hover Popup */
		expect((harness.tui as any).getScrollbarTargetAt(99, 6, true)).toBeDefined();

		/* 2. НЕ очищая композер, выделяем вторую строку тройным кликом -> привязка строго к ScrollView без захвата Outline Rail (`──` / `─`) */
		harness.tui.clickMouse(8, 7, "left");
		harness.tui.clickMouse(8, 7, "left");
		harness.tui.clickMouse(8, 7, "left");
		expect((harness.tui as any).getSelectionBounds()?.start?.scrollView).toBe(harness.tui.scroll);
		expect(harness.tui.getActiveSelectionText()).toBe("Body turn one row 8 clean text");

		/* 3. Перетаскивание выделения из транскрипта вверх внутрь Sticky Prompt (y = 0) включает auto-scroll и корректно завершает release без залипания */
		harness.tui.terminal.writes.length = 0;
		harness.tui.pressMouse(0, 8, "left");
		harness.tui.dragMouse(18, 0, "left");
		expect((harness.tui as any).selectionAutoScrollDirection).toBe(-1);
		harness.tui.releaseMouse(18, 1, "left");

		expect((harness.tui as any).selectionPressActive).toBe(false);
		expect(harness.tui.terminal.writes.some((w) => w.startsWith("\x1b]52;c;"))).toBe(true);
		const afterStickyDragScreen = harness.tui
			.renderViewport(100, 26)
			.map((l) => stripTerminalSequences(l));
		const stickySafePopupRow = afterStickyDragScreen.findIndex((l) =>
			l.includes("╭ ❝ Цитировать ╮"),
		);
		expect(stickySafePopupRow).toBeGreaterThanOrEqual(3);

		/* 4. Перетаскивание, начатое на рамке композера (dock, вне ScrollView), НЕ открывает ╭ ❝ Цитировать ╮ */
		await harness.sendTerminalInput("\x1b");
		harness.tui.renderViewport(100, 26);
		harness.tui.pressMouse(2, 24, "left");
		harness.tui.dragMouse(20, 12, "left");
		harness.tui.releaseMouse(20, 12, "left");
		expect(
			harness.tui
				.renderViewport(100, 26)
				.map((l) => stripTerminalSequences(l))
				.join("\n"),
		).not.toContain("╭ ❝ Цитировать ╮");
	});
});
