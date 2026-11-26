import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveComposerEditor } from "../src/features/chrome/composer.ts";
import type { PersistedPromptChipsPayload } from "../src/features/prompt-chips/registry.ts";
import type { OutlineRailComponent } from "../src/features/outline-rail/rail-view.ts";
import { getActiveHostRuntime, type HostClipboardProvider } from "../src/shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxToolCall,
	findComposerTopRow,
	makeAssistantEntry,
	type InteractiveHarness,
	type SessionEntry,
} from "./harness/index.ts";

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

/* Валидный 2x3 PNG (75 байт) с корректными CRC32 и IDAT для декодера Photon в AgentSession */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGOwbvpm3fSNAYUCAGbACjPC8yHSAAAAAElFTkSuQmCC";
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
	for (let r = 0; r < heightPx; r += 1) {
		for (let c = 0; c < widthPx; c += 1) {
			const off = 54 + r * rowStride + c * 3;
			buf[off] = 0xd8;
			buf[off + 1] = 0x82;
			buf[off + 2] = 0x3b;
		}
	}
	return new Uint8Array(buf);
}

async function flushClipboardAction(harness: InteractiveHarness): Promise<void> {
	for (let i = 0; i < 6; i += 1) {
		await Promise.resolve();
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	harness.flushFrame();
}

describe("Prompt Chips end-to-end (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
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
		mkdirSync(spacedDir, { recursive: true });
		const pastedPathImg = join(spacedDir, "dragged screen.png");
		writeFileSync(copiedFileImg, TINY_PNG_BYTES);
		writeFileSync(pastedPathImg, TINY_PNG_BYTES);

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 28,
			clipboard: {
				image: { bytes: TINY_PNG_BYTES, mimeType: "image/png" },
				filePaths: null,
				text: null,
			},
		});

		const editor = getActiveComposerEditor()!;

		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] ");
		expect(editor.getText()).not.toContain("/tmp");

		await harness.pressKey("\x1b[118;9u");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2] ");

		await harness.pressKey("\x1b[1084;9u");
		await flushClipboardAction(harness);
		await harness.pressKey("\x1b[27;9;1084~");
		await flushClipboardAction(harness);
		await harness.pressKey("\x1b[1084;5u");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [🖼 Image #2] [🖼 Image #3] [🖼 Image #4] [🖼 Image #5] ",
		);

		editor.setText("");
		await harness.sendInput("\x1b[200~\x1b[201~");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] ");

		await harness.sendInput("\x1b[200~");
		await harness.sendInput("\x1b[201~");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2] ");

		harness.setClipboard({
			image: null,
			filePaths: null,
			text: "should-not-paste-on-empty-bracket",
		});
		await harness.sendInput("\x1b[200~\x1b[201~");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2] ");

		editor.setText("");
		harness.setClipboard({
			filePaths: [copiedFileImg],
			image: null,
			text: null,
		});
		await harness.pressKey("\x1b[27;9;118~");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] ");
		expect(editor.getText()).not.toContain("copied-from-finder.png");

		const escapedPath = pastedPathImg.replace(/ /g, "\\ ");
		await harness.paste(escapedPath, true);
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2] ");

		const screenText = harness.screen().text();
		expect(screenText).toContain("[🖼 Image #1] [🖼 Image #2]");
		expect(screenText).not.toContain(tempDir);
	});

	it("converts >=4 line or >300 char text pastes into styled blue-slate pills while keeping <=3 line pastes editable, deletes/renumbers atomically on Backspace/Delete, and re-links on tui.editor.undo without hardcoding Ctrl+Z / Cmd+Z", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 92,
			height: 28,
			clipboard: {
				image: { bytes: TINY_PNG_BYTES, mimeType: "image/png" },
				text: null,
				filePaths: null,
			},
			responses: [fauxAssistantMessage("Processed expanded prompt.")],
		});

		const editor = getActiveComposerEditor()!;

		await harness.paste("row one\nrow two\nrow three", true);
		expect(editor.getText()).toBe("row one\nrow two\nrow three");

		editor.setText("");
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] ");

		const fourLineSnippet = 'fn main() {\n  let x = 1;\n  println!("{x}");\n}';
		await harness.paste(fourLineSnippet, true);
		expect(editor.getText()).toBe("[🖼 Image #1] [📋 Pasted #2 · 4 lines]");

		harness.setClipboard({
			image: null,
			text: "L".repeat(312),
		});
		await harness.typeText(" ");
		await harness.pressKey("\x1b[118;9u");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [📋 Pasted #2 · 4 lines] [📋 Pasted #3 · 312 chars]",
		);

		await harness.pressKey("\x1b[D");
		for (const mode of ["dark", "light"] as const) {
			harness.setTheme(mode);
			const top = findComposerTopRow(harness);
			const lines = harness.renderFrame().slice(top, top + 3);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(92);
			}
			expect(lines[1]).toContain("\x1b[48;2;");
			expect(lines[1]).toContain("\x1b[7m");
			const rgbs = extractAllAnsiRgbs(lines);
			expect(rgbs.length).toBeGreaterThan(4);
			for (const [r, g, b] of rgbs) {
				expect(r > g && b > g, `purple rgb(${r},${g},${b}) in ${mode}`).toBe(false);
			}
		}
		harness.setTheme("dark");

		await harness.pressKey("\x01");
		await harness.pressKey("\x1b[3~");
		expect(editor.getText()).toBe(" [📋 Pasted #1 · 4 lines] [📋 Pasted #2 · 312 chars]");

		await harness.pressKey("\x1b[1103;9u");
		expect(editor.getText()).toBe(" [📋 Pasted #1 · 4 lines] [📋 Pasted #2 · 312 chars]");

		await harness.pressKey("\x1b[45;5u");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [📋 Pasted #2 · 4 lines] [📋 Pasted #3 · 312 chars]",
		);

		await harness.pressKey("\x05");
		await harness.pressKey("\x7f");
		expect(editor.getText()).toBe("[🖼 Image #1] [📋 Pasted #2 · 4 lines] ");

		await harness.pressKey("\x1f");
		expect(editor.getText()).toBe(
			"[🖼 Image #1] [📋 Pasted #2 · 4 lines] [📋 Pasted #3 · 312 chars]",
		);

		await harness.submitDraft();
		expect(harness.calls).toHaveLength(1);
		const sentUserMsg = harness.calls[0]!.messages.find((m) => m.role === "user");
		expect(sentUserMsg).toBeDefined();
		const contentBlocks = Array.isArray(sentUserMsg!.content) ? sentUserMsg!.content : [];
		const textBlock = contentBlocks.find((b) => b.type === "text") as { text: string } | undefined;
		const imgBlock = contentBlocks.find((b) => b.type === "image") as
			| { data: string; mimeType: string }
			| undefined;

		expect(imgBlock).toEqual({
			type: "image",
			data: TINY_PNG_BASE64,
			mimeType: "image/png",
		});
		expect(textBlock?.text).toContain("[Image #1: ");
		expect(textBlock?.text).toContain(fourLineSnippet);
		expect(textBlock?.text).toContain("L".repeat(312));
	});

	it("lazily mounts a nonCapturing Hover Popup preview on adjacent/on-chip caret or mouse hover, hides it on leave, and guards against blocking Modal Card overlays", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 28,
			clipboard: {
				image: {
					bytes: TINY_PNG_BYTES,
					mimeType: "image/png",
					fileName: "architecture-shot.png",
				},
			},
		});

		expect(harness.screen().text()).not.toContain("architecture-shot.png");

		await harness.pressKey("\x16");
		await flushClipboardAction(harness);

		expect(harness.screen().text()).not.toContain("architecture-shot.png");
		const chip = harness.screen().findText("[🖼 Image #1]")!;
		await harness.mouseMove(chip.col + 2, chip.row);
		const afterImageText = harness.screen().text();
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(afterImageText).toContain("architecture-shot.png");
		expect(afterImageText).toContain("2×3");
		expect(afterImageText).toContain("75B");
		expect(afterImageText).toContain("Path: ");

		await harness.mouseMove(85, chip.row);
		await harness.typeText(" notes");
		expect(harness.screen().text()).not.toContain("architecture-shot.png");

		await harness.typeText(" ");
		const sixLinePaste = [
			"SELECT id, email",
			"FROM users",
			"WHERE active = true",
			"ORDER BY created_at DESC",
			"LIMIT 25",
			"OFFSET 0;",
		].join("\n");
		await harness.paste(sixLinePaste, true);

		const afterPasteText = harness.screen().text();
		expect(afterPasteText).toContain("Pasted #2 · 6 lines");
		expect(afterPasteText).toContain("SELECT id, email");
		expect(afterPasteText).toContain("WHERE active = true");

		await harness.pressKey("\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Command Palette");
		expect(harness.screen().text()).not.toContain("SELECT id, email");

		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await harness.typeText(" trailing");
		expect(harness.screen().text()).not.toContain("SELECT id, email");

		const composerBodyRow = findComposerTopRow(harness) + 1;
		const imgPos = harness.screen().findText("[🖼 Image #1]");
		expect(imgPos).toBeDefined();
		await harness.mouseMove(imgPos!.col + 2, composerBodyRow);
		expect(harness.screen().text()).toContain("architecture-shot.png");

		/* Перевод мыши с чипа через верхнюю рамку Composer внутрь самого попапа не закрывает превью */
		const composerTop = findComposerTopRow(harness);
		await harness.mouseMove(imgPos!.col + 2, composerTop);
		expect(harness.screen().text()).toContain("architecture-shot.png");
		const removeBtn = harness.screen().findText("[Remove]");
		expect(removeBtn).toBeDefined();
		await harness.mouseMove(removeBtn!.col + 2, removeBtn!.row);
		expect(harness.screen().text()).toContain("architecture-shot.png");

		await harness.mouseMove(85, 1);
		expect(harness.screen().text()).not.toContain("architecture-shot.png");
	});

	it("expands chips on Enter submission, renders compact clickable Prompt Chip pills with preview popups in both User Prompt and Sticky Prompt cards, and persists across steer and /reload", async () => {
		let releaseToolGate: (() => void) | undefined;
		let notifyToolEntered: (() => void) | undefined;
		const toolEnteredPromise = new Promise<void>((resolve) => {
			notifyToolEntered = resolve;
		});
		const holdTurnTool = defineTool({
			name: "hold_turn",
			label: "Hold Turn",
			description: "Holds turn active while user submits a steer prompt with a chip",
			parameters: Type.Object({}),
			async execute() {
				notifyToolEntered?.();
				await new Promise<void>((resolve) => {
					releaseToolGate = resolve;
				});
				return { content: [{ type: "text", text: "gate released" }], details: {} };
			},
		});

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 22,
			persistSession: true,
			customTools: [holdTurnTool],
			clipboard: {
				image: {
					bytes: TINY_PNG_BYTES,
					mimeType: "image/png",
					fileName: "mockup-v2.png",
				},
			},
			responses: [
				fauxAssistantMessage(
					[
						{
							type: "text",
							text: Array.from({ length: 20 }, (_, idx) => `Assistant reply line ${idx + 1}`).join("\n"),
						},
						fauxToolCall("hold_turn", {}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Steer acknowledged."),
			],
		});

		const editor = getActiveComposerEditor()!;

		await harness.typeText("Review ");
		await harness.pressKey("\x1b[118;9u");
		await flushClipboardAction(harness);
		await harness.typeText("and ");
		const fiveLineLog = [
			"ERROR 502 Bad Gateway",
			"upstream: 10.0.4.12:8080",
			"request_id: req-9912",
			"latency_ms: 15004",
			"retryable: true",
		].join("\n");
		await harness.paste(fiveLineLog, true);
		expect(editor.getText()).toBe("Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]");

		await harness.pressKey("\r");
		await toolEnteredPromise;
		expect(editor.getText()).toBe("");

		const steerPaste = "step A\nstep B\nstep C\nstep D";
		await harness.typeText("Steer with ");
		await harness.paste(steerPaste, true);
		expect(editor.getText()).toBe("Steer with [📋 Pasted #1 · 4 lines]");
		await harness.pressKey("\r");
		await flushClipboardAction(harness);

		releaseToolGate?.();
		await harness.waitForIdle();

		const persistedChipEntries = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === "conarti-prompt-chips");
		expect(persistedChipEntries).toHaveLength(2);

		const scroll = getActiveHostRuntime()!.scroll!;
		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		scroll.scrollTo(rail.offsetOf(0), { disableFollow: true });

		const topScreen = harness.screen();
		const cardHit = topScreen.findText("Review [🖼 Image #1]");
		expect(cardHit).toBeDefined();
		expect(topScreen.rowText(cardHit!.row)).toContain("[📋 Pasted #2 · 5 lines]");
		expect(topScreen.text()).not.toContain("ERROR 502 Bad Gateway");
		expect(topScreen.text()).not.toContain("mockup-v2.png");

		const imgPillHit = topScreen.findText("[🖼 Image #1]");
		expect(imgPillHit).toBeDefined();
		await harness.mouseMove(imgPillHit!.col + 2, imgPillHit!.row);
		expect(harness.screen().text()).toContain("mockup-v2.png");
		await harness.mouseMove(0, 0);
		expect(harness.screen().text()).not.toContain("mockup-v2.png");
		await harness.mouseClick(imgPillHit!.col + 2, imgPillHit!.row);
		expect(harness.screen().text()).toContain("mockup-v2.png");

		const pastePillHit = harness.screen().findText("[📋 Pasted #2 · 5 lines]");
		expect(pastePillHit).toBeDefined();
		await harness.mouseClick(pastePillHit!.col + 3, pastePillHit!.row);
		expect(harness.screen().text()).toContain("ERROR 502 Bad Gateway");

		await harness.mouseWheel("down", 20, 6, 2);
		expect(harness.screen().text()).not.toContain("ERROR 502 Bad Gateway");

		scroll.scrollTo(rail.offsetOf(0) + 6, { disableFollow: true });
		const scrolledScreen = harness.screen();
		expect(scrolledScreen.rowText(4)).toContain("Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]");
		expect(scrolledScreen.text()).not.toContain("[изображение]");

		const stickyPasteCol = scrolledScreen.rowText(4).indexOf("[📋 Pasted #2 · 5 lines]");
		expect(stickyPasteCol).toBeGreaterThan(0);
		await harness.mouseClick(stickyPasteCol + 2, 4);
		expect(harness.screen().text()).toContain("req-9912");

		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("req-9912");

		await harness.reload();
		const postReloadScroll = getActiveHostRuntime()!.scroll!;
		const postReloadRail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;

		postReloadScroll.scrollTo(postReloadRail.offsetOf(0), { disableFollow: true });
		expect(harness.screen().text()).toContain("Review [🖼 Image #1] and [📋 Pasted #2 · 5 lines]");

		postReloadScroll.scrollTo(postReloadRail.offsetOf(1), { disableFollow: true });
		expect(harness.screen().text()).toContain("Steer with [📋 Pasted #1 · 4 lines]");
	});

	it.each(["current", "legacy"])("copies the full original paste from a reopened %s session despite draft chip ID reuse", async (format) => {
		let copied = "";
		const original = "original ".repeat(500).trimEnd() + " SENT END";
		harness = await createInteractiveHarness({ responses: [fauxAssistantMessage("Got it.")] });
		await harness.paste(original, true);
		await harness.submitDraft();
		await harness.waitForIdle();
		const initialEntries = harness.sessionManager.getEntries().map((entry) => {
			if (format !== "legacy" || entry.type !== "custom" || entry.customType !== "conarti-prompt-chips") return entry;
			const data = entry.data as PersistedPromptChipsPayload;
			return { ...entry, data: { ...data, chips: data.chips.map((chip) => chip.kind === "image"
				? chip : { ...chip, previewText: chip.previewText.slice(0, 4000) }) } };
		});
		await harness.dispose();
		harness = await createInteractiveHarness({
			initialEntries, persistSession: true,
			clipboard: { async readText() { return copied; }, async writeText(text) { copied = text; } },
		});
		const copyOriginal = async () => {
			const pill = harness!.screen().findText(`Pasted #1 · ${original.length} chars`)!;
			await harness!.mouseClick(pill.col + 2, pill.row);
			const copy = harness!.screen().findText("[Copy]")!;
			await harness!.mouseClick(copy.col + 1, copy.row);
			expect(copied).toBe(original);
			await harness!.pressKey("\x1b");
		};
		await copyOriginal();
		await harness.paste("New draft ".repeat(40), true);
		await copyOriginal();
	});

	it("renders the saved image thumbnail when hovering a reopened clipboard-image Prompt Chip", async () => {
		harness = await createInteractiveHarness({
			clipboard: { image: { bytes: TINY_PNG_BYTES, mimeType: "image/png", fileName: "clipboard.png" } },
			responses: [fauxAssistantMessage("Got it.")],
		});
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		await harness.submitDraft();
		await harness.waitForIdle();
		const initialEntries = harness.sessionManager.getEntries();
		for (const entry of initialEntries) {
			if (entry.type === "custom" && entry.customType === "conarti-prompt-chips") {
				for (const chip of (entry.data as PersistedPromptChipsPayload).chips) {
					if (chip.kind === "image" && chip.filePath) rmSync(chip.filePath, { force: true });
				}
			}
		}
		await harness.dispose();
		harness = await createInteractiveHarness({ initialEntries, persistSession: true });
		const capabilities = getCapabilities();
		try {
			setCapabilities({ ...capabilities, images: "kitty" });
			const pill = harness.screen().findText("Image #1")!;
			await harness.mouseMove(pill.col + 2, pill.row);
			const previewScreen = harness.screen();
			expect(previewScreen.text()).toContain("File: clipboard.png");
			expect(harness.terminal.writes.join("")).toContain(`;${TINY_PNG_BASE64}\x1b\\`);

			/* Строка 1 попапа с Kitty-миниатюрой окрашена тем же popupSurfaceBg без тёмной полосы */
			const fileHit = previewScreen.findText("File: clipboard.png")!;
			let popupTop = fileHit.row;
			while (popupTop > 0 && !previewScreen.rowText(popupTop).includes("╭─")) {
				popupTop -= 1;
			}
			let popupLeft = -1;
			let popupRight = -1;
			for (let c = 0; c < previewScreen.width; c += 1) {
				const ch = previewScreen.cellAt(popupTop, c)?.char;
				if (ch === "╭" && popupLeft === -1) popupLeft = c;
				if (ch === "╮") popupRight = c;
			}
			expect(popupLeft).toBeGreaterThanOrEqual(0);
			expect(popupRight).toBeGreaterThan(popupLeft + 10);
			const expectedBg = previewScreen.cellAt(popupTop, popupLeft + 1)?.bg;
			expect(expectedBg?.kind).toBe("rgb");
			for (let r = popupTop + 1; r <= fileHit.row; r += 1) {
				for (let c = popupLeft; c <= popupRight; c += 1) {
					expect(previewScreen.cellAt(r, c)?.bg).toEqual(expectedBg);
				}
			}
		} finally {
			setCapabilities(capabilities);
		}
	});

	it("contains wheel scrolling inside a sent Prompt Chip preview", async () => {
		harness = await createInteractiveHarness({
			width: 96, height: 25,
			responses: [fauxAssistantMessage(Array.from({ length: 26 }, (_, i) => `Reply line ${i + 1}`).join("\n"))],
		});
		await harness.paste(Array.from({ length: 20 }, (_, i) => `sent-paste-row-${i + 1}`).join("\n"), true);
		await harness.submitDraft();
		await harness.waitForIdle();
		const scroll = getActiveHostRuntime()!.scroll!;
		scroll.scrollToStart();
		const chip = harness.screen().findText("Pasted #1")!;
		await harness.mouseClick(chip.col + 1, chip.row);
		const first = harness.screen().findText("sent-paste-row-1")!;
		expect(first).toBeDefined();
		const top = scroll.scrollTop;
		await harness.mouseWheel("down", first.col + 1, first.row, 10);
		expect(harness.screen().text()).toContain("sent-paste-row-20");
		expect(scroll.scrollTop).toBe(top);
		await harness.mouseWheel("down", 94, 5);
		expect(harness.screen().text()).not.toContain("sent-paste-row-20");
	});

	it("handles edge cases: file:// URLs, nonexistent .png paths, !bash mode paths, clipboard errors, narrow widths 1..30, legacy [Image #1: path] cards, and pill toggle/outside-click dismissal", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ui-chip-edge-"));
		const urlImgPath = join(tempDir, "diagram with spaces.png");
		writeFileSync(urlImgPath, TINY_PNG_BYTES);
		const fileUrl = pathToFileURL(urlImgPath).href;

		let shouldThrow = false;
		const customClipboard: HostClipboardProvider = {
			readFilePaths: async () => {
				if (shouldThrow) throw new Error("Clipboard locked");
				return [urlImgPath];
			},
			readImage: async () => null,
			readText: async () => null,
		};

		const legacyTs = new Date(2026, 4, 10, 12, 0).getTime();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 88,
			height: 22,
			clipboard: customClipboard,
			initialEntries: [
				{
					type: "message",
					id: "leg-1",
					parentId: null,
					timestamp: new Date(legacyTs).toISOString(),
					message: {
						role: "user",
						content: "Old [Image #1: /var/tmp/legacy-diagram.png] ref",
						timestamp: legacyTs,
					},
				},
				makeAssistantEntry("leg-a1", "leg-1", "Legacy reply.", legacyTs + 1000),
			],
		});

		const editor = getActiveComposerEditor()!;

		await harness.paste("/nonexistent/missing-logo.png", true);
		expect(editor.getText()).toBe("/nonexistent/missing-logo.png");

		editor.setText("");
		await harness.paste(fileUrl, true);
		expect(editor.getText()).toBe("[🖼 Image #1] ");

		for (const w of [1, 2, 3, 8, 16, 24, 30]) {
			await harness.resize(w, 28);
			const top = findComposerTopRow(harness);
			expect(visibleWidth(harness.renderFrame()[top]!), `width=${w}`).toBe(w);
		}
		await harness.resize(88, 28);

		editor.setText("!ls ");
		await harness.pressKey("\x05");
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		expect(editor.getText()).toContain("diagram with spaces.png");
		expect(editor.getText()).not.toContain("[🖼 Image");

		shouldThrow = true;
		editor.setText("");
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("");
		expect(harness.screen().text()).toContain("Clipboard locked");

		getActiveHostRuntime()!.scroll!.scrollTo(0, { disableFollow: true });
		const topScreen = harness.screen();
		expect(topScreen.text()).toContain("Old [🖼 Image #1] ref");
		expect(topScreen.text()).not.toContain("legacy-diagram.png");

		const legPillPos = topScreen.findText("[🖼 Image #1]");
		expect(legPillPos).toBeDefined();

		await harness.mouseClick(legPillPos!.col + 2, legPillPos!.row);
		expect(harness.screen().text()).toContain("legacy-diagram.png");

		await harness.mouseClick(legPillPos!.col + 2, legPillPos!.row);
		expect(harness.screen().text()).not.toContain("legacy-diagram.png");

		await harness.mouseClick(legPillPos!.col + 2, legPillPos!.row);
		expect(harness.screen().text()).toContain("legacy-diagram.png");
		await harness.mouseClick(75, legPillPos!.row + 3);
		expect(harness.screen().text()).not.toContain("legacy-diagram.png");

		/* Суффиксы AgentSession._normalizePromptImages ([Image: original WxH, displayed at ...]) не должны ломать реконструкцию чипов */
		const resizedTs = new Date(2026, 4, 10, 12, 30).getTime();
		await harness.dispose();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 88,
			height: 22,
			initialEntries: [
				{
					type: "custom",
					id: "c-resized",
					parentId: null,
					timestamp: new Date(resizedTs - 10).toISOString(),
					customType: "conarti-prompt-chips",
					data: {
						timestamp: resizedTs,
						displayText: "Inspect [🖼 Image #1] and [📋 Pasted #2 · 4 lines]",
						expandedText: "Inspect [Image #1: /tmp/retina.png] and l1\nl2\nl3\nl4",
						chips: [
							{
								id: "img-r1",
								kind: "image",
								number: 1,
								token: "[🖼 Image #1]",
								filePath: "/tmp/retina.png",
								fileName: "retina.png",
								mimeType: "image/png",
								byteLength: 1024,
							},
							{
								id: "paste-r2",
								kind: "paste",
								number: 2,
								token: "[📋 Pasted #2 · 4 lines]",
								lineCount: 4,
								charCount: 11,
								metric: "lines",
								previewText: "l1\nl2\nl3\nl4",
							},
						],
					},
				},
				{
					type: "message",
					id: "u-resized",
					parentId: "c-resized",
					timestamp: new Date(resizedTs).toISOString(),
					message: {
						role: "user",
						timestamp: resizedTs,
						content: [
							{
								type: "text",
								text: "Inspect [Image #1: /tmp/retina.png] and l1\nl2\nl3\nl4\n\n[Image: original 3024x1964, displayed at 2000x1299. Multiply coordinates by 1.51 to map to original image.]",
							},
							{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
						],
					},
				},
				makeAssistantEntry("a-resized", "u-resized", "Retina checked.", resizedTs + 1000),
			],
		});
		getActiveHostRuntime()!.scroll!.scrollTo(0, { disableFollow: true });
		const resizedScreen = harness.screen().text();
		expect(resizedScreen).toContain("Inspect [🖼 Image #1] and [📋 Pasted #2 · 4 lines]");
		expect(resizedScreen).not.toContain("Multiply coordinates");
		expect(resizedScreen).not.toContain("retina.png");
	});

	it("converts pasted BMP paths to PNG on real Enter submit (with BMP dimensions in preview), keeps !bash Ctrl+V text & tab-heavy inline pastes chip-free, and reconstructs ISO-timestamped /reload + /tree entries", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ui-chip-bmp-"));
		const bmpPath = join(tempDir, "diagram.bmp");
		writeFileSync(bmpPath, createValidBmpBytes(4, 3));

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 26,
			clipboard: {
				text: "echo one\necho two\necho three\necho four",
			},
			responses: [fauxAssistantMessage("BMP inspected.")],
		});

		const editor = getActiveComposerEditor()!;

		editor.setText("!");
		await harness.pressKey("\x05");
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		expect(editor.getText()).not.toContain("[📋 Pasted");
		expect(editor.getText()).toContain("echo four");

		editor.setText("");
		await harness.paste("\t".repeat(260), true);
		expect(editor.getText()).not.toContain("[paste #");

		editor.setText("");
		await harness.paste(bmpPath, true);
		await harness.paste(bmpPath, true);
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2] ");

		await harness.pressKey("\x01");
		await harness.pressKey("\x1b[3~");
		expect(editor.getText()).toBe(" [🖼 Image #1] ");

		await harness.pressKey("\x05");
		const bmpChip = harness.screen().findText("[🖼 Image #1]")!;
		await harness.mouseMove(bmpChip.col + 2, bmpChip.row);
		const bmpPreviewText = harness.screen().text();
		expect(bmpPreviewText).toContain("diagram.bmp");
		expect(bmpPreviewText).toContain("4×3");

		await harness.submitDraft();
		expect(harness.calls).toHaveLength(1);
		const sentMsg = harness.calls[0]!.messages.find((m) => m.role === "user");
		const sentImages = Array.isArray(sentMsg?.content)
			? sentMsg.content.filter((b) => b.type === "image")
			: [];
		expect(sentImages).toHaveLength(1);
		const firstImg = sentImages[0] as { data: string; mimeType: string };
		expect(firstImg.mimeType).toBe("image/png");
		const decodedPng = Buffer.from(firstImg.data, "base64");
		expect(Array.from(decodedPng.subarray(0, 8))).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);

		await harness.dispose();
		const branchedEntries: SessionEntry[] = [
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
			makeAssistantEntry("a-b1", "m-b1", "Branch 1 reply.", 1715342401000),
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
			makeAssistantEntry("a-b2", "m-b2", "Branch 2 reply.", 1715342701000),
		];

		let switchToBranch2: (() => Promise<void>) | undefined;
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 22,
			persistSession: true,
			initialEntries: branchedEntries,
			initialLeafId: "a-b1",
			extensionFactories: [
				(pi) => {
					pi.registerCommand("test-jump-b2", {
						description: "Navigate session tree to a-b2 via real CommandContext.navigateTree",
						handler: async (_args, ctx) => {
							await ctx.navigateTree("a-b2");
						},
					});
					switchToBranch2 = async () => {
						await harness!.submitInput("/test-jump-b2");
					};
				},
			],
		});

		getActiveHostRuntime()!.scroll!.scrollTo(0, { disableFollow: true });
		expect(harness.screen().text()).toContain("Fix [📋 Pasted #1 · 4 lines]");

		await harness.reload();
		getActiveHostRuntime()!.scroll!.scrollTo(0, { disableFollow: true });
		expect(harness.screen().text()).toContain("Fix [📋 Pasted #1 · 4 lines]");

		await switchToBranch2!();
		getActiveHostRuntime()!.scroll!.scrollTo(0, { disableFollow: true });
		expect(harness.screen().text()).toContain("Branch2 [📋 Pasted #1 · 4 lines]");
	});

	it("aligns composer hover/caret previews and pill styling across wrapped lines (including innerWidth-1 wrap boundary), keeps hand-typed literal [🖼 Image #99] non-atomic, isolates adjacent chips on Ctrl+W, and consumes Esc when dismissing sent-pill popups", async () => {
		const legacyTs = new Date(2026, 4, 10, 15, 0).getTime();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 40,
			height: 24,
			clipboard: {
				image: {
					bytes: TINY_PNG_BYTES,
					mimeType: "image/png",
					fileName: "wrap-check.png",
				},
			},
			initialEntries: [
				{
					type: "message",
					id: "esc-u1",
					parentId: null,
					timestamp: new Date(legacyTs).toISOString(),
					message: {
						role: "user",
						content: "Check [Image #1: /var/tmp/esc-test.png]",
						timestamp: legacyTs,
					},
				},
				makeAssistantEntry("esc-a1", "esc-u1", "Checked.", legacyTs + 1000),
			],
		});

		const editor = getActiveComposerEditor()!;
		const imgChipCols = visibleWidth("[🖼 Image #1]");
		await harness.typeText(`${"x".repeat(34 - imgChipCols - 1)} `);
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		await harness.typeText(" ok");
		expect(harness.screen().text()).not.toContain("wrap-check.png");

		const composerTop = findComposerTopRow(harness);
		const wrappedChipRow = composerTop + 2;
		const wrappedChipCol = harness.screen().rowText(wrappedChipRow).indexOf("[🖼 Image #1]");
		expect(wrappedChipCol).toBeGreaterThanOrEqual(2);

		await harness.mouseMove(wrappedChipCol + 2, wrappedChipRow);
		expect(harness.screen().text()).toContain("wrap-check.png");

		await harness.mouseMove(36, wrappedChipRow);
		expect(harness.screen().text()).not.toContain("wrap-check.png");

		await harness.resize(100, 24);
		editor.setText("");
		await harness.typeText(`${"a".repeat(86)} `);
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		await harness.pressKey("\x1b[D");
		const boundaryRow = findComposerTopRow(harness) + 2;
		const boundaryCol = harness.screen().rowText(boundaryRow).indexOf("[🖼 Image #1]");
		expect(boundaryCol).toBeGreaterThanOrEqual(0);
		await harness.mouseMove(boundaryCol + 2, boundaryRow);
		const boundaryScreen = harness.screen();
		const wrapHit = boundaryScreen.findText("wrap-check.png");
		expect(wrapHit).toBeDefined();
		expect(wrapHit!.col).toBeLessThan(20);

		await harness.resize(24, 24);
		editor.setText("");
		await harness.paste("l1\nl2\nl3\nl4\nl5", true);
		const narrowTop = findComposerTopRow(harness);
		const narrowFrame = harness.renderFrame();
		expect(visibleWidth(narrowFrame[narrowTop]!)).toBe(24);
		expect(narrowFrame[narrowTop + 1]).toContain("\x1b[48;2;");
		expect(narrowFrame[narrowTop + 2]).toContain("\x1b[48;2;");

		await harness.resize(88, 24);
		editor.setText("");
		await harness.typeText("[🖼 Image #99]");
		await harness.pressKey("\x7f");
		expect(editor.getText()).toBe("[🖼 Image #99");

		editor.setText("");
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		expect(editor.getText()).toBe("[🖼 Image #1] [🖼 Image #2] ");
		await harness.pressKey("\x17");
		expect(editor.getText()).toBe("[🖼 Image #1] ");
		editor.setText("");

		getActiveHostRuntime()!.scroll!.scrollTo(0, { disableFollow: true });
		const origOnEscape = editor.onEscape;
		let escapeCalled = 0;
		editor.onEscape = () => {
			escapeCalled += 1;
			origOnEscape?.();
		};

		const sentScreen = harness.screen();
		const sentPillHit = sentScreen.findText("[🖼 Image #1]");
		expect(sentPillHit).toBeDefined();
		await harness.mouseClick(sentPillHit!.col + 2, sentPillHit!.row);
		expect(harness.screen().text()).toContain("esc-test.png");

		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("esc-test.png");
		expect(escapeCalled).toBe(0);

		await harness.pressKey("\x1b");
		expect(escapeCalled).toBe(1);
	});

	it("renders reconstructed Prompt Chip tokens in Outline Rail Hover Popup previews without leaking raw image paths, [изображение], pasted lines, or blockquotes", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ui-rail-chip-preview-"));
		const imgPath = join(tempDir, "secret-capture.png");
		writeFileSync(imgPath, TINY_PNG_BYTES);

		const ts2 = new Date(2026, 4, 10, 16, 9).getTime();
		const ts3 = new Date(2026, 4, 10, 16, 12).getTime();
		const ts4 = new Date(2026, 4, 10, 16, 15).getTime();

		const initialEntries: SessionEntry[] = [
			{
				type: "message",
				id: "u-img-only",
				parentId: null,
				timestamp: new Date(ts2).toISOString(),
				message: {
					role: "user",
					timestamp: ts2,
					content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
				},
			},
			makeAssistantEntry(
				"a-img-only",
				"u-img-only",
				Array.from({ length: 14 }, (_, i) => `reply2 ${i}`).join("\n"),
				ts2 + 1000,
			),
			{
				type: "custom",
				id: "c-inc-3",
				parentId: "a-img-only",
				timestamp: new Date(ts3 - 10).toISOString(),
				customType: "conarti-prompt-chips",
				data: {
					timestamp: ts3,
					displayText: "[❝ Quote #1 · 2 lines] Compare screenshot",
					expandedText: "> quoted one\n> quoted two\n\nCompare screenshot",
					chips: [
						{
							id: "q-inc-3",
							kind: "quote",
							number: 1,
							token: "[❝ Quote #1 · 2 lines]",
							lineCount: 2,
							charCount: 21,
							previewText: "quoted one\nquoted two",
						},
					],
				},
			},
			{
				type: "message",
				id: "u3",
				parentId: "c-inc-3",
				timestamp: new Date(ts3).toISOString(),
				message: {
					role: "user",
					timestamp: ts3,
					content: [
						{ type: "text", text: "> quoted one\n> quoted two\n\nCompare screenshot\n\n[изображение]" },
						{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
					],
				},
			},
			makeAssistantEntry(
				"a3",
				"u3",
				Array.from({ length: 14 }, (_, i) => `reply3 ${i}`).join("\n"),
				ts3 + 1000,
			),
			{
				type: "message",
				id: "u4",
				parentId: "a3",
				timestamp: new Date(ts4).toISOString(),
				message: {
					role: "user",
					timestamp: ts4,
					content: "Mounted fallback\n\n[изображение]",
				},
			},
			makeAssistantEntry(
				"a4",
				"u4",
				Array.from({ length: 14 }, (_, i) => `reply4 ${i}`).join("\n"),
				ts4 + 1000,
			),
		];

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 22,
			persistSession: true,
			initialEntries,
			clipboard: {
				filePaths: [imgPath],
				image: null,
				text: "quoted alpha\nquoted beta",
			},
			responses: [
				fauxAssistantMessage(Array.from({ length: 14 }, (_, i) => `reply5 ${i}`).join("\n")),
			],
		});

		await harness.typeText("Check ");
		await harness.pressKey("\x16");
		await flushClipboardAction(harness);
		await harness.typeText("log ");
		await harness.paste("TRACE line 1\nTRACE line 2\nTRACE line 3\nTRACE line 4", true);
		await harness.typeText(" ref ");
		await harness.pressKey("\x1b[113;3u");
		await flushClipboardAction(harness);
		expect(getActiveComposerEditor()!.getText()).toBe(
			"Check [🖼 Image #1] log [📋 Pasted #2 · 4 lines] ref [❝ Quote #3 · 2 lines]",
		);
		await harness.submitDraft();

		const checkRailPreviews = async () => {
			const headerRows = 3;
			const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
			const geo = rail.geometry!;
			expect(geo.windowEnd - geo.windowStart).toBe(4);

			await harness!.mouseMove(99, headerRows + geo.ticksY);
			const p1 = harness!.screen().text();
			expect(p1).toContain("[🖼 Image #1]");
			expect(p1).not.toContain("[изображение]");

			await harness!.mouseMove(99, headerRows + geo.ticksY + 1);
			const p2 = harness!.screen().text();
			expect(p2).toContain("[❝ Quote #1 · 2 lines]");
			expect(p2).toContain("Compare");
			expect(p2).toContain("screenshot [🖼 Image #1]");
			expect(p2).not.toContain("quoted one");

			await harness!.mouseMove(99, headerRows + geo.ticksY + 2);
			const p3 = harness!.screen().text();
			expect(p3).toContain("Mounted fallback [🖼 Image #1]");
			expect(p3).not.toContain("[изображение]");

			await harness!.mouseMove(99, headerRows + geo.ticksY + 3);
			const p4 = harness!.screen().text();
			expect(p4).toContain("Check [🖼 Image #1]");
			expect(p4).toContain("[📋 Pasted #2 · 4 lines]");
			expect(p4).toContain("[❝ Quote #3 · 2 lines]");
			expect(p4).not.toContain("secret-capture.png");
			expect(p4).not.toContain("[Image #1:");
			expect(p4).not.toContain("TRACE line");
			expect(p4).not.toContain("quoted alpha");
		};

		await checkRailPreviews();

		harness.setTheme("light");
		await harness.reload();
		await checkRailPreviews();
	});

	it("renders formatted Markdown (GFM tables, headings, lists, and inline code) inside Paste, Quote, and Skill preview popups", async () => {
		const tmpCwd = mkdtempSync(join(tmpdir(), "pi-ui-popup-md-"));
		try {
			const skillDir = join(tmpCwd, ".agents", "skills", "md-demo");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				[
					"---",
					"name: md-demo",
					"description: Demo skill with Markdown",
					"---",
					"# Skill Heading",
					"",
					"| Metric | Budget |",
					"|---|---|",
					"| Latency | 12ms |",
					"",
					"- **Bold rule** with `inline_helper()`",
				].join("\n"),
				"utf8",
			);

			harness = await createInteractiveHarness({
				theme: "dark",
				cwd: tmpCwd,
				additionalSkillPaths: [skillDir],
				width: 110,
				height: 30,
				clipboard: {
					image: null,
					text: "**Quoted bold** with `quoted_fn()`\nand second line",
				},
				responses: [fauxAssistantMessage("Markdown popups verified.")],
			});

			const mdTablePaste = [
				"| Model | Calls | Stream tok/s |",
				"|---|---:|---:|",
				"| gpt-6.2-astra | 299 | 52.6 |",
				"| gemini-4-carbon | 504 | 84.5 |",
			].join("\n");

			await harness.typeText("/skill:md-demo ");
			await harness.paste(mdTablePaste, true);

			/* Сразу после вставки каретка стоит у чипа Paste: попап рисует GFM-таблицу с рамками вместо сырого |---| */
			const pastePopupText = harness.screen().text();
			expect(pastePopupText).toContain("Pasted #1 · 4 lines");
			expect(pastePopupText).toContain("gpt-6.2-astra");
			expect(pastePopupText).toContain("84.5");
			expect(pastePopupText).toContain("┼");
			expect(pastePopupText).not.toContain("|---|");

			/* Добавляем цитату с Markdown через Alt+Q и проверяем рендер **bold** и `code` без сырых звёздочек */
			await harness.typeText(" ");
			await harness.pressKey("\x1b[113;3u");
			await flushClipboardAction(harness);
			const quotePopupText = harness.screen().text();
			expect(quotePopupText).toContain("Quote #2 · 2 lines");
			expect(quotePopupText).toContain("Quoted bold");
			expect(quotePopupText).toContain("quoted_fn()");
			expect(quotePopupText).not.toContain("**Quoted bold**");

			/* Отправляем промпт со скиллом и открываем попап /md-demo: frontmatter скрыт, а заголовок и таблица отформатированы */
			await harness.submitDraft();
			const sentScreen = harness.screen();
			const skillPill = sentScreen.findText("/md-demo");
			expect(skillPill).toBeDefined();
			await harness.mouseClick(skillPill!.col + 2, skillPill!.row);

			const skillPopupText = harness.screen().text();
			expect(skillPopupText).toContain("✦ /md-demo");
			expect(skillPopupText).toContain("Skill Heading");
			expect(skillPopupText).toContain("Latency");
			expect(skillPopupText).toContain("12ms");
			expect(skillPopupText).toContain("Bold rule");
			expect(skillPopupText).toContain("inline_helper()");
			expect(skillPopupText).not.toContain("description: Demo skill with Markdown");
			expect(skillPopupText).not.toContain("# Skill Heading");
			expect(skillPopupText).not.toContain("|---|");
			expect(skillPopupText).not.toContain("**Bold rule**");
		} finally {
			rmSync(tmpCwd, { recursive: true, force: true });
		}
	});
});
