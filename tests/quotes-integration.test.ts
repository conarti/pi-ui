import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveComposerEditor } from "../src/features/chrome/composer.ts";
import type { OutlineRailComponent } from "../src/features/outline-rail/rail-view.ts";
import { getActiveHostRuntime, unwrapHostTui } from "../src/shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import { updatePiUiUserConfig } from "../src/shared/pi-ui-config.ts";
import {
	createInteractiveHarness,
	DEFAULT_EXTENSION_ENTRY,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	findComposerTopRow,
	type InteractiveHarness,
} from "./harness/index.ts";

/* Валидный 2x3 PNG (75 байт) с корректными CRC32 и IDAT для декодера Photon в AgentSession */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGOwbvpm3fSNAYUCAGbACjPC8yHSAAAAAElFTkSuQmCC";
const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64"));

async function flushAsyncQuote(harness?: InteractiveHarness): Promise<void> {
	for (let i = 0; i < 6; i += 1) {
		await Promise.resolve();
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	harness?.flushFrame();
}

function getSelectionText(harness: InteractiveHarness): string | undefined {
	const renderer = unwrapHostTui(harness.tui) as {
		getActiveSelectionText?: () => string | undefined;
	};
	return renderer.getActiveSelectionText?.();
}

describe("Native Quote Prompt Chips, Alt+Q, /quote, /quotes, and Selection Hover Popup (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("quotes active fullscreen selection or clipboard fallback into inline [❝ Quote #N · M lines] pills at the cursor across Latin Alt+Q, Cyrillic Alt+й, macOS Option+Q, and /quote [n] with no above-editor quote widget", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 28,
			clipboard: {
				text: "Clipboard line 1\nClipboard line 2\nClipboard line 3",
			},
			responses: [
				fauxAssistantMessage([
					fauxThinking("pondering ttl"),
					fauxText("First reply line A\nFirst reply line B"),
				]),
				fauxAssistantMessage("Latest reply single line"),
			],
		});

		await harness.submitInput("How should caching work?");
		await harness.submitInput("What about deployment?");

		const editor = getActiveComposerEditor()!;
		const scroll = getActiveHostRuntime()!.scroll!;
		scroll.scrollTo(0, { disableFollow: true });

		const screenAtTop = harness.screen();
		const lineAHit = screenAtTop.findText("First reply line A");
		const lineBHit = screenAtTop.findText("First reply line B");
		expect(lineAHit).toBeDefined();
		expect(lineBHit).toBeDefined();

		await harness.mouseDrag(
			lineAHit!.col,
			lineAHit!.row,
			lineBHit!.col + "First reply line B".length,
			lineBHit!.row,
			{ steps: 3 },
		);
		expect(getSelectionText(harness)).toContain("First reply line A");

		await harness.pressKey("\x1b[1081;3u");
		await flushAsyncQuote(harness);

		expect(editor.getText()).toBe("[❝ Quote #1 · 2 lines]");
		expect(getSelectionText(harness)).toBeUndefined();
		const widgetAbove = (harness.tui as unknown as { children?: Array<{ children?: unknown[] }> })
			.children?.[3];
		expect((widgetAbove?.children ?? []).every((child) => child instanceof Spacer)).toBe(true);

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

		for (let i = 0; i < altQSequences.length; i += 1) {
			editor.setText("Prefix  suffix");
			await harness.pressKey("\x05");
			for (let left = 0; left < 7; left += 1) {
				await harness.pressKey("\x1b[D");
			}
			harness.setClipboard({
				text: i % 2 === 0 ? "Single clip" : "Clip A\nClip B\nClip C",
			});
			await harness.pressKey(altQSequences[i]!);
			await flushAsyncQuote(harness);

			const expectedToken =
				i % 2 === 0 ? "[❝ Quote #1 · 1 line]" : "[❝ Quote #1 · 3 lines]";
			expect(editor.getText(), `sequence index ${i}`).toBe(`Prefix ${expectedToken} suffix`);
			expect(editor.getText()).not.toContain("œ");
			expect(editor.getText()).not.toContain("ј");
		}

		editor.setText("");
		await harness.prompt("/quote");
		expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");

		await harness.typeText(" ");
		await harness.prompt("/quote 2");
		expect(editor.getText()).toBe("[❝ Quote #1 · 1 line] [❝ Quote #2 · 2 lines]");

		await harness.prompt("/quote 99");
		scroll.scrollToEnd();
		expect(editor.getText()).toBe("[❝ Quote #1 · 1 line] [❝ Quote #2 · 2 lines]");
		expect(harness.screen().text()).toContain("Available assistant replies in this session: 2");
	});

	it("provides /quotes Modal Card inspection, multi-line editing, single removal, and full clearing while preserving non-quote chips and undo", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 28,
			clipboard: {
				image: { bytes: TINY_PNG_BYTES, mimeType: "image/png" },
				text: null,
			},
		});

		const editor = getActiveComposerEditor()!;

		await harness.prompt("/quotes");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(harness.screen().text()).toContain("No active quotes in the draft");

		await harness.pressKey("\x16");
		await flushAsyncQuote(harness);
		expect(editor.getText()).toBe("[🖼 Image #1]");

		harness.setClipboard({
			image: null,
			text: "Original quote A\nOriginal quote B",
		});
		await harness.typeText(" ");
		await harness.pressKey("\x1b[113;3u");
		await flushAsyncQuote(harness);

		harness.setClipboard({
			image: null,
			text: "Second quote line",
		});
		await harness.typeText(" ");
		await harness.pressKey("\x1b[113;3u");
		await flushAsyncQuote(harness);

		expect(editor.getText()).toBe(
			"[🖼 Image #1] [❝ Quote #2 · 2 lines] [❝ Quote #3 · 1 line]",
		);

		let modalClosed = false;
		const modalPromise = harness.prompt("/quotes").then(() => {
			modalClosed = true;
		});
		await flushAsyncQuote(harness);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);

		const inspectText = harness.screen().text();
		expect(inspectText).toContain("Quote #2 · 2 lines");
		expect(inspectText).toContain("Quote #3 · 1 line");
		expect(inspectText).toContain("Original quote A");

		await harness.pressKey("\r");
		await harness.pressKey("\x1b[13;2u");
		await harness.typeText("Added third line");
		await harness.pressKey("\r");

		expect(editor.getText()).toBe(
			"[🖼 Image #1] [❝ Quote #2 · 3 lines] [❝ Quote #3 · 1 line]",
		);

		await harness.pressKey("\x1b[B");
		await harness.pressKey("d");
		expect(editor.getText()).toBe("[🖼 Image #1] [❝ Quote #2 · 3 lines]");

		await harness.pressKey("\x1b");
		await modalPromise;
		expect(modalClosed).toBe(true);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await harness.typeText(" keep this text");
		const clearModalPromise = harness.prompt("/quotes");
		await flushAsyncQuote(harness);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.pressKey("c");
		await clearModalPromise;

		expect(editor.getText()).toBe("[🖼 Image #1] keep this text");

		await harness.pressKey("\x1f");
		expect(editor.getText()).toBe("[🖼 Image #1] [❝ Quote #2 · 3 lines] keep this text");

		await harness.pressKey("\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.typeText("цитат");
		const paletteText = harness.screen().text();
		expect(paletteText).not.toContain("Процитировать последний ответ");
		expect(paletteText).not.toContain("Управление цитатами черновика");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await harness.prompt("/quotes clear");
		expect(editor.getText()).toBe("[🖼 Image #1] keep this text");

		harness.setClipboard({ text: "Mouse editable quote" });
		await harness.typeText(" ");
		await harness.pressKey("\x1b[113;3u");
		await flushAsyncQuote(harness);
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 1 line]",
		);

		await harness.prompt("/quotes edit q2 Same-line replacement");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 1 line]",
		);
		await harness.pressKey("\x1f");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 1 line]",
		);
		expect(harness.screen().text()).toContain("Mouse editable quote");

		const pasteEditPromise = harness.prompt("/quotes edit 2");
		await flushAsyncQuote(harness);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.sendInput("\x1b[200~ multi A");
		await harness.sendInput("\n");
		await harness.sendInput("multi B\x1b[201~");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.pressKey("\r");
		await harness.pressKey("\x1b");
		await pasteEditPromise;
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 2 lines]",
		);

		await harness.prompt("/quotes edit q2 Inline updated line 1\nInline updated line 2");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] keep this text [❝ Quote #2 · 2 lines]",
		);

		const mouseModalPromise = harness.prompt("/quotes");
		await flushAsyncQuote(harness);
		const modalScreen = harness.screen();
		const clearPillHit = modalScreen.findText("Clear all");
		expect(clearPillHit).toBeDefined();
		await harness.mouseClick(clearPillHit!.col + 2, clearPillHit!.row);
		await mouseModalPromise;
		expect(editor.getText()).toBe("[🖼 Image #1] keep this text");
	});

	it("cleanly supersedes external pi-quote-blocks whether loaded before or after @conarti/pi-ui in real InteractiveMode", async () => {
		const extDir = mkdtempSync(join(tmpdir(), "pi-ui-ext-supersede-"));
		tempDirs.push(extDir);
		const pkgDir = join(extDir, "node_modules", "pi-quote-blocks");
		mkdirSync(pkgDir, { recursive: true });
		const externalExtFile = join(pkgDir, "quote-blocks.ts");

		writeFileSync(
			externalExtFile,
			[
				"export default function fakePiQuoteBlocks(pi) {",
				"  const log = (globalThis.__externalQuoteBlocksCalls ??= []);",
				"  pi.registerShortcut('alt+q', {",
				"    description: 'Quote selected text (or clipboard) as a block',",
				"    handler: async () => { log.push('shortcut:alt+q'); },",
				"  });",
				"  pi.registerShortcut('alt+h', {",
				"    description: 'Fold / expand quote blocks',",
				"    handler: async () => { log.push('shortcut:alt+h'); },",
				"  });",
				"  pi.registerShortcut('alt+e', {",
				"    description: 'Manage quote blocks: preview, edit, remove, re-insert marker, or clear all',",
				"    handler: async () => { log.push('shortcut:alt+e'); },",
				"  });",
				"  pi.registerCommand('quote', {",
				"    description: 'Quote a past assistant reply as a block',",
				"    handler: async () => { log.push('cmd:quote'); },",
				"  });",
				"  pi.registerCommand('quotes', {",
				"    description: 'Manage quote blocks',",
				"    handler: async () => { log.push('cmd:quotes'); },",
				"  });",
				"  pi.on('session_start', async (_ev, ctx) => {",
				"    log.push('event:session_start');",
				"    ctx.ui.setWidget('quote-blocks', () => ({ render: () => ['external widget'], invalidate() {} }));",
				"  });",
				"  pi.on('input', async (ev) => {",
				"    log.push('event:input');",
				"    return { action: 'transform', text: 'CORRUPTED:' + ev.text };",
				"  });",
				"}",
			].join("\n"),
			"utf8",
		);

		for (const order of ["before", "after"] as const) {
			(globalThis as Record<string, unknown>).__externalQuoteBlocksCalls = [];
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

			const additionalExtensionPaths =
				order === "before"
					? [externalExtFile, DEFAULT_EXTENSION_ENTRY]
					: [DEFAULT_EXTENSION_ENTRY, externalExtFile];

			harness = await createInteractiveHarness({
				theme: "dark",
				width: 96,
				height: 26,
				loadDefaultExtension: false,
				additionalExtensionPaths,
				extensionFactories: [innocentThirdExtension],
				clipboard: { text: "Native chip text" },
				responses: [fauxAssistantMessage("Clean reply.")],
			});

			const runner = harness.session.extensionRunner!;
			const quoteCmd = runner.getCommand("quote") as
				| { extensionPath?: string; sourceInfo?: { path?: string } }
				| undefined;
			const quotesCmd = runner.getCommand("quotes") as
				| { extensionPath?: string; sourceInfo?: { path?: string } }
				| undefined;
			expect(
				quoteCmd?.extensionPath ?? quoteCmd?.sourceInfo?.path,
				`quote owner in ${order} order`,
			).toContain("pi-ui");
			expect(
				quotesCmd?.extensionPath ?? quotesCmd?.sourceInfo?.path,
				`quotes owner in ${order} order`,
			).toContain("pi-ui");

			const shortcuts = runner.getShortcuts({});
			expect(shortcuts.get("alt+q")?.extensionPath).toContain("pi-ui");
			expect(shortcuts.has("alt+h")).toBe(false);
			expect(shortcuts.has("alt+e")).toBe(false);

			expect(thirdPartyCalls, `thirdPartyCalls in ${order} order`).toEqual([
				"third:session_start",
			]);
			expect(harness.screen().text()).not.toContain("external widget");

			await harness.submitInput("Plain prompt");
			expect(thirdPartyCalls).toEqual(["third:session_start", "third:input"]);
			const sentUser = harness.calls[0]!.messages.find((m) => m.role === "user");
			const sentText =
				typeof sentUser?.content === "string"
					? sentUser.content
					: Array.isArray(sentUser?.content)
						? sentUser.content
								.filter((b) => b.type === "text")
								.map((b) => (b as { text: string }).text)
								.join("")
						: "";
			expect(sentText).toBe("Plain prompt");
			expect(sentText).not.toContain("CORRUPTED:");

			await harness.pressKey("\x1b[113;3u");
			await flushAsyncQuote(harness);

			const editor = getActiveComposerEditor()!;
			expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");
			await harness.prompt("/quotes clear");
			expect(editor.getText()).toBe("");
			expect(
				(globalThis as unknown as Record<string, string[]>).__externalQuoteBlocksCalls,
			).toEqual([]);

			await harness.dispose();
			harness = undefined;
		}
	});

	it("expands mixed image + paste + quote drafts into blank-line-padded Markdown blockquotes on submit while rendering clickable [❝ Quote #N · M lines] pills with preview popups in User Prompt and Sticky Prompt cards across /reload", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 24,
			persistSession: true,
			clipboard: {
				image: { bytes: TINY_PNG_BYTES, mimeType: "image/png" },
				text: null,
			},
			responses: [
				fauxAssistantMessage(
					Array.from({ length: 24 }, (_, idx) => `Detailed reply line ${idx + 1}`).join("\n"),
				),
				fauxAssistantMessage("Second turn reply."),
			],
		});

		const editor = getActiveComposerEditor()!;

		await harness.typeText("Review ");
		await harness.pressKey("\x16");
		await flushAsyncQuote(harness);

		harness.setClipboard({ image: null, text: null });
		await harness.typeText(" code ");
		await harness.paste("const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;", true);

		harness.setClipboard({
			image: null,
			text: "\tQuoted first line\n\n\t\tQuoted third line",
		});
		await harness.typeText(" against ");
		await harness.pressKey("\x1b[113;3u");
		await flushAsyncQuote(harness);
		await harness.typeText(" carefully");

		expect(editor.getText()).toBe(
			"Review [🖼 Image #1] code [📋 Pasted #2 · 4 lines] against [❝ Quote #3 · 3 lines] carefully",
		);

		await harness.submitDraft();
		await harness.submitInput("Follow-up anchor turn");

		expect(harness.calls.length).toBeGreaterThanOrEqual(2);
		const firstCallUser = harness.calls[0]!.messages.find((m) => m.role === "user");
		expect(firstCallUser).toBeDefined();
		const blocks = Array.isArray(firstCallUser!.content) ? firstCallUser!.content : [];
		const textPart = (blocks.find((b) => b.type === "text") as { text: string } | undefined)?.text ?? "";
		const imgParts = blocks.filter((b) => b.type === "image");
		expect(imgParts).toHaveLength(1);
		expect(textPart).toBe(
			[
				`Review [Image #1: ${textPart.match(/\[Image #1: ([^\]]+)\]/)?.[1]}] code const a = 1;`,
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

		await harness.reload();

		const scroll = getActiveHostRuntime()!.scroll!;
		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		scroll.scrollTo(rail.offsetOf(0), { disableFollow: true });

		const topScreen = harness.screen();
		const quoteCardHit = topScreen.findText("[❝ Quote #3 · 3 lines]");
		expect(quoteCardHit).toBeDefined();
		expect(topScreen.text()).not.toContain("> Quoted first line");

		await harness.mouseClick(quoteCardHit!.col + 3, quoteCardHit!.row);
		const withTranscriptPreview = harness.screen().text();
		expect(withTranscriptPreview).toContain("❝ Quote #3 · 3 lines");
		expect(withTranscriptPreview).toContain("│   Quoted first line");
		expect(withTranscriptPreview).toContain("│     Quoted third line");

		await harness.mouseWheel("down", 20, 6, 3);
		expect(harness.screen().text()).not.toContain("│   Quoted first line");

		scroll.scrollTo(rail.offsetOf(0) + 8, { disableFollow: true });
		const scrolledScreen = harness.screen();
		const stickyRow = scrolledScreen.rowText(4);
		expect(stickyRow).toContain("[❝ Quote #3 · 3 lines]");
		const stickyQuoteCol = stickyRow.indexOf("[❝ Quote #3 · 3 lines]");

		await harness.mouseClick(stickyQuoteCol + 3, 4);
		const withStickyPreview = harness.screen().text();
		expect(withStickyPreview).toContain("❝ Quote #3 · 3 lines");
		expect(withStickyPreview).toContain("│   Quoted first line");
	});

	it.each(["dark", "light"] as const)(
		"lazily mounts nonCapturing selection Hover Popup on drag and multi-click selection in %s theme (preserving copyOnSelect and respecting Modal Cards), quotes on click, and dismisses on Esc, scroll, or outside click without stealing focus",
		async (themeMode) => {
			harness = await createInteractiveHarness({
				theme: themeMode,
				width: 100,
				height: 26,
				responses: [
					fauxAssistantMessage(
						[
							"Line zero intro",
							"Selectable alpha beta gamma delta",
							"Second quoted transcript line",
							"Third transcript line for scrolling",
							...Array.from({ length: 24 }, (_, idx) => `Filler scroll line ${idx + 1}`),
						].join("\n"),
					),
				],
			});
			updatePiUiUserConfig({ copyOnSelect: true });

			await harness.submitInput("Generate quotable text");

			const editor = getActiveComposerEditor()!;
			const scroll = getActiveHostRuntime()!.scroll!;
			const renderer = unwrapHostTui(harness.tui) as {
				getFocusedComponent?: () => unknown;
				setFocus?: (comp: unknown) => void;
			};

			const railTestTop = 0;
			scroll.scrollTo(railTestTop, { disableFollow: true });
			const baseScreen = harness.screen();
			const alphaHit = baseScreen.findText("Selectable alpha beta gamma delta");
			const secondHit = baseScreen.findText("Second quoted transcript line");
			expect(alphaHit).toBeDefined();
			expect(secondHit).toBeDefined();

			await harness.mouseDrag(80, alphaHit!.row, 90, alphaHit!.row, { steps: 2 });
			expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");

			harness.terminal.writes.length = 0;
			await harness.mouseDrag(
				alphaHit!.col,
				alphaHit!.row,
				secondHit!.col + "Second quoted transcript line".length,
				secondHit!.row,
				{ steps: 3 },
			);

			expect(harness.terminal.writes.some((w) => w.startsWith("\x1b]52;c;"))).toBe(true);
			expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
			expect(renderer.getFocusedComponent?.()).toBe(editor);

			const dragScreen = harness.screen();
			const popupHit = dragScreen.findText("[Quote · Alt+Q]");
			expect(popupHit).toBeDefined();
			expect(popupHit!.col).toBeGreaterThanOrEqual(1);
			expect(dragScreen.text()).toContain("✓ Copied · [Quote · Alt+Q]");

			const rawPopupLine = harness.renderFrame()[popupHit!.row]!;
			for (const m of rawPopupLine.matchAll(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/g)) {
				const r = Number(m[1]);
				const g = Number(m[2]);
				const b = Number(m[3]);
				expect(r > g && b > g, `purple rgb(${r},${g},${b}) in ${themeMode}`).toBe(false);
			}

			renderer.setFocus?.(null);
			await harness.mouseClick(popupHit!.col + 4, popupHit!.row);

			expect(editor.getText()).toBe("[❝ Quote #1 · 2 lines]");
			expect(getSelectionText(harness)).toBeUndefined();
			expect(renderer.getFocusedComponent?.()).toBe(editor);
			expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");
			expect(harness.screen().text()).toContain("❝ Quote #1 · 2 lines");

			editor.setText("");
			scroll.scrollTo(railTestTop, { disableFollow: true });
			const wordCol = harness.screen().findText("alpha")!;
			await harness.mouseClick(wordCol.col + 1, wordCol.row);
			await harness.mouseClick(wordCol.col + 1, wordCol.row);
			expect(getSelectionText(harness)).toBe("alpha");
			expect(harness.screen().text()).toContain("[Quote · Alt+Q]");

			await harness.pressKey("\x1b");
			expect(renderer.getFocusedComponent?.()).toBe(editor);
			expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");

			await harness.mouseDrag(alphaHit!.col, alphaHit!.row, alphaHit!.col + 16, alphaHit!.row);
			expect(harness.screen().text()).toContain("[Quote · Alt+Q]");
			await harness.mouseWheel("down", 10, 8, 1);
			expect(renderer.getFocusedComponent?.()).toBe(editor);
			expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");

			scroll.scrollTo(railTestTop, { disableFollow: true });
			await harness.mouseDrag(alphaHit!.col, alphaHit!.row, alphaHit!.col + 16, alphaHit!.row);
			expect(harness.screen().text()).toContain("[Quote · Alt+Q]");
			await harness.mouseClick(2, alphaHit!.row + 4);
			expect(renderer.getFocusedComponent?.()).toBe(editor);
			expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");

			editor.setText("");
			await harness.mouseClick(wordCol.col + 1, wordCol.row);
			await harness.mouseClick(wordCol.col + 1, wordCol.row);
			await harness.mouseClick(wordCol.col + 1, wordCol.row);
			expect(getSelectionText(harness)?.trim()).toBe("Selectable alpha beta gamma delta");
			const triplePopup = harness.screen().findText("[Quote · Alt+Q]")!;
			expect(triplePopup).toBeDefined();

			await harness.mouseDrag(
				triplePopup.col + 2,
				triplePopup.row,
				triplePopup.col + 7,
				triplePopup.row,
				{ steps: 1 },
			);
			expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");
			editor.setText("");

			for (const { startTop, scrollAction } of [
				{ startTop: 0, scrollAction: () => scroll.scrollBy(3) },
				{ startTop: 0, scrollAction: () => scroll.scrollToEnd() },
				{ startTop: 2, scrollAction: () => scroll.scrollToStart() },
				{ startTop: 0, scrollAction: () => scroll.scrollTo(4) },
			]) {
				scroll.scrollTo(startTop, { disableFollow: true });
				const rowForDrag = harness.screen().findText("Selectable alpha")!.row;
				await harness.mouseDrag(4, rowForDrag, 20, rowForDrag);
				expect(harness.screen().text()).toContain("[Quote · Alt+Q]");
				scrollAction();
				expect(renderer.getFocusedComponent?.()).toBe(editor);
				expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");
			}

			scroll.scrollTo(railTestTop, { disableFollow: true });
			const modalTestRow = harness.screen().findText("Selectable alpha")!.row;
			await harness.pressKey("\x0b");
			expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
			await harness.mouseDrag(4, modalTestRow, 20, modalTestRow);
			expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");
			await harness.pressKey("\x1b");
		},
	);

	it("preserves ScrollView selection, auto-scroll, and Sticky Prompt / Outline Rail drag-release when composer-caret Hover Popup and Sticky Prompt are active, while ignoring dock-originated drags", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 26,
			responses: [
				fauxAssistantMessage(
					Array.from({ length: 18 }, (_, idx) => `Body turn one row ${idx} clean text`).join("\n"),
				),
				fauxAssistantMessage(
					Array.from({ length: 16 }, (_, idx) => `Body turn two row ${idx} clean text`).join("\n"),
				),
			],
		});
		updatePiUiUserConfig({ copyOnSelect: true });

		await harness.submitInput("First user turn prompt");
		await harness.submitInput("Second user turn prompt");

		const editor = getActiveComposerEditor()!;
		const scroll = getActiveHostRuntime()!.scroll!;
		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		scroll.scrollTo(rail.offsetOf(0) + 4, { disableFollow: true });

		const bodyRowHit = harness.screen().findText("Body turn one row");
		expect(bodyRowHit).toBeDefined();
		await harness.mouseDrag(bodyRowHit!.col, bodyRowHit!.row, bodyRowHit!.col + 20, bodyRowHit!.row);

		const firstPop = harness.screen().findText("[Quote · Alt+Q]");
		expect(firstPop).toBeDefined();
		expect(firstPop!.row).toBeGreaterThanOrEqual(6);
		await harness.mouseClick(firstPop!.col + 3, firstPop!.row);
		expect(editor.getText()).toBe("[❝ Quote #1 · 1 line]");

		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		const rawRenderer = unwrapHostTui(harness.tui) as {
			getSelectionBounds?: () => { start?: { scrollView?: unknown } } | undefined;
			selectionAutoScrollDirection?: number;
			selectionPressActive?: boolean;
		};

		const tripleTarget = harness.screen().findText("clean text")!;
		await harness.mouseClick(tripleTarget.col + 2, tripleTarget.row);
		await harness.mouseClick(tripleTarget.col + 2, tripleTarget.row);
		await harness.mouseClick(tripleTarget.col + 2, tripleTarget.row);
		expect(rawRenderer.getSelectionBounds?.()?.start?.scrollView).toBe(scroll);
		expect(getSelectionText(harness)).toContain("Body turn one row");

		harness.terminal.writes.length = 0;
		await harness.mouseDown(4, tripleTarget.row, "left");
		await harness.sendInput("\x1b[<32;19;4M");
		expect(rawRenderer.selectionAutoScrollDirection).toBe(-1);
		await harness.mouseUp(18, 4, "left");

		expect(rawRenderer.selectionPressActive).toBe(false);
		expect(harness.terminal.writes.some((w) => w.startsWith("\x1b]52;c;"))).toBe(true);
		const stickySafePopup = harness.screen().findText("[Quote · Alt+Q]");
		expect(stickySafePopup).toBeDefined();
		expect(stickySafePopup!.row).toBeGreaterThanOrEqual(6);

		await harness.pressKey("\x1b");
		const composerBodyRow = findComposerTopRow(harness) + 1;
		await harness.mouseDrag(4, composerBodyRow, 20, 10, { steps: 2 });
		expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");
	});
});
