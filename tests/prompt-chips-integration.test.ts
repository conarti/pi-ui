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

function createValidBmpBytes(widthPx = 2, heightPx = 3): Uint8Array {
	const rowStride = Math.ceil((widthPx * 3) / 4) * 4;
	const pixelBytes = rowStride * heightPx;
	const buf = Buffer.alloc(54 + pixelBytes, 0);
	buf[0] = 0x42;
	buf[1] = 0x4d;
	buf.writeUInt32LE(54 + pixelBytes, 2);
	buf.writeUInt32LE(54, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(widthPx, 18);
	buf.writeInt32LE(heightPx, 22);
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(24, 28);
	buf.writeUInt32LE(pixelBytes, 34);
	for (let r = 0; r < heightPx; r++) {
		for (let c = 0; c < widthPx; c++) {
			const off = 54 + r * rowStride + c * 3;
			buf[off] = 0xd8;
			buf[off + 1] = 0x82;
			buf[off + 2] = 0x3b;
		}
	}
	return new Uint8Array(buf);
}

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

		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1]");
		expect(editor.getText()).not.toContain("/tmp");

		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[118;9u");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2]");

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

		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput("\x1b[200~\x1b[201~");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1]");

		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[200~");
		await harness.sendTerminalInput("\x1b[201~");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2]");

		clipboardState = {
			readFilePaths: async () => null,
			readImage: async () => null,
			readText: async () => "should-not-paste-on-empty-bracket",
		};
		await harness.sendTerminalInput("\x1b[200~\x1b[201~");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2]");

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

	it("converts >=4 line or >300 char text pastes into styled blue-slate pills while keeping <=3 line pastes editable, deletes/renumbers atomically on Backspace/Delete, and re-links on tui.editor.undo without hardcoding Ctrl+Z / Cmd+Z", async () => {
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

		await harness.sendTerminalInput("\x1b[200~row one\nrow two\nrow three\x1b[201~");
		expect(editor.getText()).toBe("row one\nrow two\nrow three");

		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1]");

		await harness.sendTerminalInput(" ");
		const fourLineSnippet = "fn main() {\n  let x = 1;\n  println!(\"{x}\");\n}";
		await harness.sendTerminalInput(`\x1b[200~${fourLineSnippet}\x1b[201~`);
		expect(editor.getText()).toBe("[🖼 Image #1] [📋 Pasted #2 · 4 lines]");

		clipboardImageBytes = null;
		clipboardTextValue = "L".repeat(312);
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput("\x1b[118;9u");
		await flushAsyncPaste();
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [📋 Pasted #2 · 4 lines] [📋 Pasted #3 · 312 chars]",
		);

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

		await harness.sendTerminalInput("\x01");
		await harness.sendTerminalInput("\x1b[3~");
		expect(editor.getText()).toBe(" [📋 Pasted #1 · 4 lines] [📋 Pasted #2 · 312 chars]");

		await harness.sendTerminalInput("\x1b[1103;9u");
		await harness.sendTerminalInput("\x1a");
		expect(editor.getText()).toBe(" [📋 Pasted #1 · 4 lines] [📋 Pasted #2 · 312 chars]");

		await harness.sendTerminalInput("\x1b[45;5u");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [📋 Pasted #2 · 4 lines] [📋 Pasted #3 · 312 chars]",
		);

		await harness.sendTerminalInput("\x05");
		await harness.sendTerminalInput("\x7f");
		expect(editor.getText()).toBe("[🖼 Image #1] [📋 Pasted #2 · 4 lines] ");

		await harness.sendTerminalInput("\x1f");
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

		await harness.sendTerminalInput(" notes");
		expect(getVisibleHoverOverlays()).toHaveLength(0);

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

		await harness.sendTerminalInput("\x0b");
		expect(harness.activeCustomModal).toBeDefined();
		expect(harness.tui.getTopmostVisibleOverlay()).toBeDefined();
		expect(getVisibleHoverOverlays()).toHaveLength(0);

		harness.activeCustomModal!.done(undefined);
		expect(harness.tui.getTopmostVisibleOverlay()).toBeUndefined();

		await harness.sendTerminalInput(" trailing");
		expect(getVisibleHoverOverlays()).toHaveLength(0);

		harness.tui.renderViewport(100, 28);
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

		const entry1 = { type: "message", id: "m1", message: userMsg1 };
		const longReply = Array.from({ length: 24 }, (_, idx) => `Assistant reply line ${idx + 1}`).join("\n");
		harness.tui.chatContainer.addChild(new Text(longReply, 0, 0));

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

		const imgPillCol = screenAtTop[cardRowIdx]!.indexOf("[🖼 Image #1]") + 2;
		harness.tui.clickMouse(imgPillCol, cardRowIdx);
		expect(getVisibleHoverOverlays()).toHaveLength(1);
		expect(
			stripTerminalSequences(getVisibleHoverOverlays()[0]!.component.render(52).join("\n")),
		).toContain("mockup-v2.png");
		expect(harness.tui.focusComponent).toBe(editor);

		const pastePillCol = screenAtTop[cardRowIdx]!.indexOf("[📋 Pasted #2 · 5 lines]") + 3;
		harness.tui.clickMouse(pastePillCol, cardRowIdx);
		expect(getVisibleHoverOverlays()).toHaveLength(1);
		expect(
			stripTerminalSequences(getVisibleHoverOverlays()[0]!.component.render(52).join("\n")),
		).toContain("ERROR 502 Bad Gateway");

		harness.tui.wheelMouse(20, 5, "down");
		expect(getVisibleHoverOverlays()).toHaveLength(0);

		harness.tui.scroll.scrollTo(6, { disableFollow: true });
		const screenScrolled = harness.tui.renderViewport(96, 22).map((l) => stripTerminalSequences(l));
		expect(screenScrolled[1]).toContain("Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]");
		expect(screenScrolled.slice(0, 4).join("\n")).not.toContain("[изображение]");

		const stickyPasteCol = screenScrolled[1]!.indexOf("[📋 Pasted #2 · 5 lines]") + 2;
		harness.tui.clickMouse(stickyPasteCol, 1);
		expect(getVisibleHoverOverlays()).toHaveLength(1);
		expect(
			stripTerminalSequences(getVisibleHoverOverlays()[0]!.component.render(52).join("\n")),
		).toContain("req-9912");

		await harness.sendTerminalInput("\x1b");
		expect(getVisibleHoverOverlays()).toHaveLength(0);

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

		await harness.sendTerminalInput("\x1b[200~/nonexistent/missing-logo.png\x1b[201~");
		expect(editor.getText()).toBe("/nonexistent/missing-logo.png");

		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput(`\x1b[200~${fileUrl}\x1b[201~`);
		expect(editor.getText()).toBe("[🖼 Image #1]");

		for (let w = 1; w <= 30; w++) {
			const lines = editor.render(w);
			for (const line of lines) {
				expect(visibleWidth(line), `width=${w}`).toBe(w);
			}
		}

		harness.ctx.ui.setEditorText("!ls ");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toContain("diagram with spaces.png");
		expect(editor.getText()).not.toContain("[🖼 Image");

		shouldThrow = true;
		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("");
		expect(harness.notifications.some((n) => n.message.includes("Clipboard locked"))).toBe(true);

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

		harness.tui.clickMouse(colIdx, rowIdx);
		expect(visiblePopups()).toHaveLength(0);

		harness.tui.clickMouse(colIdx, rowIdx);
		expect(visiblePopups()).toHaveLength(1);
		harness.tui.clickMouse(70, rowIdx + 4);
		expect(visiblePopups()).toHaveLength(0);
	});

	it("converts pasted BMP paths to PNG on real Enter submit (with BMP dimensions in preview), keeps !bash Ctrl+V text & tab-heavy inline pastes chip-free, syncs onChange on renumbering, and reconstructs ISO-timestamped /reload + /tree entries", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ui-chip-bmp-"));
		const bmpPath = join(tempDir, "diagram.bmp");
		writeFileSync(bmpPath, createValidBmpBytes(4, 3));

		let clipText: string | null = "echo one\necho two\necho three\necho four";
		setHostClipboardProvider({
			readFilePaths: async () => null,
			readImage: async () => null,
			readText: async () => clipText,
		});

		harness = createExtensionHarness({ theme: "dark", width: 96, height: 26 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		harness.tui.dock.addChild(editor);
		harness.tui.renderViewport(96, 26);

		let submittedFromEditor = "";
		editor.onSubmit = (val: string) => {
			submittedFromEditor = val;
		};

		harness.ctx.ui.setEditorText("!");
		await harness.sendTerminalInput("\x05");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).not.toContain("[📋 Pasted");
		expect(editor.getText()).toContain("echo four");

		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput(`\x1b[200~${"\t".repeat(260)}\x1b[201~`);
		expect(editor.getText()).not.toContain("[paste #");

		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput(`\x1b[200~${bmpPath}\x1b[201~`);
		await harness.sendTerminalInput(" ");
		await harness.sendTerminalInput(`\x1b[200~${bmpPath}\x1b[201~`);
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2]");

		await harness.sendTerminalInput("\x01");
		await harness.sendTerminalInput("\x1b[3~");
		expect(editor.getText()).toBe(" [🖼 Image #1]");
		expect(harness.editorText).toBe(" [🖼 Image #1]");

		const visibleHoverOverlays = () =>
			harness!.tui.overlayStack.filter(
				(e) => e.options?.nonCapturing === true && harness!.tui.isOverlayVisible(e),
			);
		await harness.sendTerminalInput("\x05");
		expect(visibleHoverOverlays()).toHaveLength(1);
		const bmpPreview = stripTerminalSequences(
			visibleHoverOverlays()[0]!.component.render(52).join("\n"),
		);
		expect(bmpPreview).toContain("diagram.bmp");
		expect(bmpPreview).toContain("4×3");

		await harness.sendTerminalInput("\r");
		expect(submittedFromEditor).toBe("[🖼 Image #1]");

		const bmpInputRes = await harness.emit("input", {
			type: "input",
			text: submittedFromEditor,
			source: "interactive",
		});
		const bmpTransformed = bmpInputRes.find((r: any) => r?.action === "transform") as {
			action: "transform";
			text: string;
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
		};
		expect(bmpTransformed).toBeDefined();
		expect(bmpTransformed.images).toHaveLength(1);
		expect(bmpTransformed.images![0]!.mimeType).toBe("image/png");
		const decodedPng = Buffer.from(bmpTransformed.images![0]!.data, "base64");
		expect(Array.from(decodedPng.subarray(0, 8))).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);

		const allSessionEntries = [
			{
				type: "custom",
				id: "c-b1",
				parentId: null,
				timestamp: "2026-05-10T12:00:00.100Z",
				customType: "conarti-prompt-chips",
				data: {
					timestamp: 1715342400000,
					displayText: "Fix [📋 Pasted #1 · 4 lines]",
					expandedText: "Fix a\nb\nc\nd",
					chips: [
						{
							id: "chip-b1",
							kind: "paste",
							number: 1,
							token: "[📋 Pasted #1 · 4 lines]",
							lineCount: 4,
							charCount: 7,
							metric: "lines",
							previewText: "a\nb\nc\nd",
						},
					],
				},
			},
			{
				type: "message",
				id: "m-b1",
				parentId: "c-b1",
				timestamp: "2026-05-10T12:00:00.101Z",
				message: {
					role: "user",
					timestamp: 1715342400000,
					content: [{ type: "text", text: "Fix a\nb\nc\nd" }],
				},
			},
			{
				type: "custom",
				id: "c-b2",
				parentId: null,
				timestamp: "2026-05-10T12:05:00.100Z",
				customType: "conarti-prompt-chips",
				data: {
					timestamp: 1715342700000,
					displayText: "Branch2 [📋 Pasted #1 · 4 lines]",
					expandedText: "Branch2 w\nx\ny\nz",
					chips: [
						{
							id: "chip-b2",
							kind: "paste",
							number: 1,
							token: "[📋 Pasted #1 · 4 lines]",
							lineCount: 4,
							charCount: 7,
							metric: "lines",
							previewText: "w\nx\ny\nz",
						},
					],
				},
			},
			{
				type: "message",
				id: "m-b2",
				parentId: "c-b2",
				timestamp: "2026-05-10T12:05:00.101Z",
				message: {
					role: "user",
					timestamp: 1715342700000,
					content: [{ type: "text", text: "Branch2 w\nx\ny\nz" }],
				},
			},
		];

		await harness.shutdownSession();
		harness = createExtensionHarness({
			theme: "dark",
			width: 96,
			height: 22,
			entries: allSessionEntries,
			branch: allSessionEntries.slice(0, 2),
		});
		harness.mount(conartiPiUi);

		/* Имитируем InteractiveMode.handleReloadCommand: rebuildChatFromMessages выполняется ДО session_start */
		const preStartCard = new UserMessageComponent(
			"Fix a\nb\nc\nd",
			{} as any,
			0,
			[],
			"m-b1",
			"2026-05-10T12:00:00.101Z" as any,
		);
		harness.tui.chatContainer.addChild(preStartCard);
		await harness.emit("session_start", { reason: "reload" });

		const reloadScreen = harness.tui.renderViewport(96, 22).map((l) => stripTerminalSequences(l));
		expect(reloadScreen.join("\n")).toContain("Fix [📋 Pasted #1 · 4 lines]");

		harness.tui.chatContainer.clear();
		harness.setEntries(allSessionEntries, allSessionEntries.slice(2, 4));
		await harness.emit("session_tree", {});
		const treeCard = new UserMessageComponent(
			"Branch2 w\nx\ny\nz",
			{} as any,
			0,
			[],
			"m-b2",
			"2026-05-10T12:05:00.101Z" as any,
		);
		harness.tui.chatContainer.addChild(treeCard);
		const treeScreen = harness.tui.renderViewport(96, 22).map((l) => stripTerminalSequences(l));
		expect(treeScreen.join("\n")).toContain("Branch2 [📋 Pasted #1 · 4 lines]");
	});

	it("aligns composer hover/caret previews and pill styling across wrapped lines (including innerWidth-1 wrap boundary), keeps hand-typed literal [🖼 Image #99] non-atomic, isolates adjacent chips on Ctrl+W, and consumes Esc when dismissing sent-pill popups", async () => {
		setHostClipboardProvider({
			readFilePaths: async () => null,
			readImage: async () => ({
				bytes: TINY_PNG_BYTES,
				mimeType: "image/png",
				fileName: "wrap-check.png",
			}),
			readText: async () => null,
		});

		harness = createExtensionHarness({ theme: "dark", width: 40, height: 24 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		harness.tui.dock.addChild(editor);

		const visibleHoverOverlays = () =>
			harness!.tui.overlayStack.filter(
				(e) => e.options?.nonCapturing === true && harness!.tui.isOverlayVisible(e),
			);

		const imgChipCols = visibleWidth("[🖼 Image #1]");
		await harness.sendTerminalInput(`${"x".repeat(34 - imgChipCols - 1)} `);
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		await harness.sendTerminalInput(" ok");
		harness.tui.renderViewport(40, 24);
		expect(visibleHoverOverlays()).toHaveLength(0);

		editor.handleMouse({
			type: "move",
			button: "none",
			x: 6,
			y: 2,
			screenX: 6,
			screenY: 20,
			width: 40,
			height: 4,
		} as any);
		expect(visibleHoverOverlays()).toHaveLength(1);
		expect(
			stripTerminalSequences(visibleHoverOverlays()[0]!.component.render(36).join("\n")),
		).toContain("wrap-check.png");

		editor.handleMouse({
			type: "move",
			button: "none",
			x: 35,
			y: 2,
			screenX: 35,
			screenY: 20,
			width: 40,
			height: 4,
		} as any);
		expect(visibleHoverOverlays()).toHaveLength(0);

		harness.tui.renderViewport(100, 24);
		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput(`${"a".repeat(86)} `);
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		harness.tui.renderViewport(100, 24);
		await harness.sendTerminalInput("\x1b[D");
		expect(visibleHoverOverlays()).toHaveLength(1);
		expect(visibleHoverOverlays()[0]!.options?.col).toBe(4);

		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput("\x1b[200~l1\nl2\nl3\nl4\nl5\x1b[201~");
		const narrowLines = editor.render(24);
		for (const line of narrowLines) {
			expect(visibleWidth(line)).toBe(24);
		}
		expect(narrowLines[1]).toContain("\x1b[48;2;");
		expect(narrowLines[2]).toContain("\x1b[48;2;");

		harness.ctx.ui.setEditorText("");
		for (const ch of "[🖼 Image #99]") {
			await harness.sendTerminalInput(ch);
		}
		await harness.sendTerminalInput("\x7f");
		expect(editor.getText()).toBe("[🖼 Image #99");

		harness.ctx.ui.setEditorText("");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		expect(editor.getText()).toBe("[🖼 Image #1][🖼 Image #2]");
		await harness.sendTerminalInput("\x17");
		expect(editor.getText()).toBe("[🖼 Image #1]");

		harness.ctx.ui.setEditorText("");
		(harness.keybindings as any).matches = (data: string, action: string) =>
			action === "app.interrupt" && data === "\x1b";
		let escapeCalled = 0;
		editor.onEscape = () => {
			escapeCalled += 1;
		};
		const card = new UserMessageComponent("Check [Image #1: /var/tmp/esc-test.png]");
		harness.tui.chatContainer.addChild(card);
		const screen = harness.tui.renderViewport(88, 24).map((l) => stripTerminalSequences(l));
		const rowIdx = screen.findIndex((r) => r.includes("[🖼 Image #1]"));
		const colIdx = screen[rowIdx]!.indexOf("[🖼 Image #1]") + 2;
		harness.tui.clickMouse(colIdx, rowIdx);
		expect(visibleHoverOverlays()).toHaveLength(1);

		await harness.sendTerminalInput("\x1b");
		expect(visibleHoverOverlays()).toHaveLength(0);
		expect(escapeCalled).toBe(0);

		await harness.sendTerminalInput("\x1b");
		expect(escapeCalled).toBe(1);
	});

	it("renders reconstructed Prompt Chip tokens in Outline Rail Hover Popup previews without leaking raw image paths, [изображение], pasted lines, or blockquotes", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ui-rail-chip-preview-"));
		const imgPath = join(tempDir, "secret-capture.png");
		writeFileSync(imgPath, TINY_PNG_BYTES);

		const clipboard: HostClipboardProvider = {
			readFilePaths: async () => [imgPath],
			readImage: async () => null,
			readText: async () => "quoted alpha\nquoted beta",
		};

		harness = createExtensionHarness({
			theme: "dark",
			width: 100,
			height: 24,
			clipboard,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editor = harness.editor as PiUiComposerEditor;
		await harness.sendTerminalInput("Check ");
		await harness.sendTerminalInput("\x16");
		await flushAsyncPaste();
		await harness.sendTerminalInput(" log ");
		await harness.sendTerminalInput(
			"\x1b[200~TRACE line 1\nTRACE line 2\nTRACE line 3\nTRACE line 4\x1b[201~",
		);
		await harness.sendTerminalInput(" ref ");
		await harness.sendTerminalInput("\x1b[113;3u");
		await flushAsyncPaste();

		const draftText = editor.getText();
		expect(draftText).toBe(
			"Check [🖼 Image #1] log [📋 Pasted #2 · 4 lines] ref [❝ Quote #3 · 2 lines]",
		);

		editor.setText("");
		const [tx] = (await harness.emit("input", {
			text: draftText,
			images: [],
			source: "interactive",
		})) as Array<{ action: string; text: string; images?: unknown[] }>;
		expect(tx!.action).toBe("transform");

		const ts1 = new Date(2026, 4, 10, 16, 5).getTime();
		const userMsg1 = {
			role: "user",
			content: [
				{ type: "text", text: tx!.text },
				{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
			],
			timestamp: ts1,
		};
		await harness.emit("message_start", { message: userMsg1 });
		harness.tui.chatContainer.addChild(new UserMessageComponent(tx!.text, {} as any, 0, [], "u1", ts1 as any));
		harness.tui.chatContainer.addChild(new Text(Array.from({ length: 14 }, (_, i) => `reply1 ${i}`).join("\n"), 0, 0));
		await harness.emit("message_end", { message: userMsg1 });

		const ts2 = new Date(2026, 4, 10, 16, 9).getTime();
		const userMsg2 = {
			role: "user",
			content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			timestamp: ts2,
		};
		harness.tui.chatContainer.addChild(new UserMessageComponent("[🖼 Image #1]", {} as any, 0, [], "u2", ts2 as any));
		harness.tui.chatContainer.addChild(new Text(Array.from({ length: 14 }, (_, i) => `reply2 ${i}`).join("\n"), 0, 0));

		const entries = [
			...harness.appendedEntries.map((e, idx) => ({
				type: "custom",
				id: `c-${idx + 1}`,
				customType: e.customType,
				data: e.data,
			})),
			{ type: "message", id: "u1", parentId: "c-1", message: userMsg1 },
			{ type: "message", id: "u2", message: userMsg2 },
		];
		harness.setEntries(entries, entries);

		const extractPreviewBody = (lines: readonly string[]) =>
			lines
				.filter((l) => l.startsWith("│") && l.endsWith("│"))
				.map((l) => l.slice(1, -1).trim())
				.join(" ");

		harness.tui.renderViewport(100, 12);
		harness.tui.moveMouse(97, 5);
		const hoverOverlays1 = harness.tui.overlayStack.filter(
			(e) => e.options?.nonCapturing === true && harness!.tui.isOverlayVisible(e),
		);
		expect(hoverOverlays1).toHaveLength(1);
		const preview1Lines = hoverOverlays1[0]!.component
			.render(Number(hoverOverlays1[0]!.options?.width ?? 44))
			.map((l) => stripTerminalSequences(l));
		const preview1 = preview1Lines.join("\n");
		const preview1Body = extractPreviewBody(preview1Lines);
		expect(preview1Lines[0]?.trim()).toBe("16:05");
		expect(preview1Body).toBe(
			"Check [🖼 Image #1] log [📋 Pasted #2 · 4 lines] ref [❝ Quote #3 · 2 lines]",
		);
		expect(preview1).not.toContain("secret-capture.png");
		expect(preview1).not.toContain("[Image #1:");
		expect(preview1).not.toContain("[изображение]");
		expect(preview1).not.toContain("TRACE line");
		expect(preview1).not.toContain("quoted alpha");

		harness.tui.moveMouse(97, 6);
		const hoverOverlays2 = harness.tui.overlayStack.filter(
			(e) => e.options?.nonCapturing === true && harness!.tui.isOverlayVisible(e),
		);
		expect(hoverOverlays2).toHaveLength(1);
		const preview2Lines = hoverOverlays2[0]!.component
			.render(Number(hoverOverlays2[0]!.options?.width ?? 44))
			.map((l) => stripTerminalSequences(l));
		const preview2 = preview2Lines.join("\n");
		expect(preview2Lines[0]?.trim()).toBe("16:09");
		expect(extractPreviewBody(preview2Lines)).toBe("[🖼 Image #1]");
		expect(preview2).not.toContain("[изображение]");

		await harness.shutdownSession();
		harness = createExtensionHarness({
			theme: "light",
			width: 100,
			height: 24,
			entries,
			branch: entries,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();
		harness.tui.chatContainer.addChild(new UserMessageComponent(tx!.text, {} as any, 0, [], "u1", ts1 as any));
		harness.tui.chatContainer.addChild(new Text(Array.from({ length: 14 }, (_, i) => `reply1 ${i}`).join("\n"), 0, 0));
		harness.tui.chatContainer.addChild(new UserMessageComponent("[🖼 Image #1]", {} as any, 0, [], "u2", ts2 as any));
		harness.tui.chatContainer.addChild(new Text(Array.from({ length: 14 }, (_, i) => `reply2 ${i}`).join("\n"), 0, 0));

		harness.tui.renderViewport(100, 12);
		harness.tui.moveMouse(97, 5);
		const reloadedOverlays = harness.tui.overlayStack.filter(
			(e) => e.options?.nonCapturing === true && harness!.tui.isOverlayVisible(e),
		);
		expect(reloadedOverlays).toHaveLength(1);
		const reloadedLines = reloadedOverlays[0]!.component
			.render(Number(reloadedOverlays[0]!.options?.width ?? 44))
			.map((l) => stripTerminalSequences(l));
		const reloadedPreview = reloadedLines.join("\n");
		expect(extractPreviewBody(reloadedLines)).toBe(
			"Check [🖼 Image #1] log [📋 Pasted #2 · 4 lines] ref [❝ Quote #3 · 2 lines]",
		);
		expect(reloadedPreview).not.toContain("secret-capture.png");
		expect(reloadedPreview).not.toContain("[изображение]");
		expect(reloadedPreview).not.toContain("TRACE line");
		expect(reloadedPreview).not.toContain("quoted alpha");
	});
});
