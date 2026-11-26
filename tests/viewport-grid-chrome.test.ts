import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveComposerEditor } from "../src/features/chrome/composer.ts";
import { getOutlineSettings } from "../src/features/outline-rail/index.ts";
import { getStickyConfig } from "../src/features/sticky-prompt/index.ts";
import { parseAnsiColorRgb, rgbHueDegrees } from "../src/shared/ansi.ts";
import { getActiveHostRuntime, unwrapHostTui } from "../src/shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import { updatePiUiUserConfig } from "../src/shared/pi-ui-config.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	makeAssistantEntry,
	makeUserEntry,
	type InteractiveHarness,
} from "./harness/index.ts";

function buildLines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, idx) => `${prefix}-${idx + 1}`).join("\n");
}

function findCardHorizontalSpan(
	harness: InteractiveHarness,
	row: number,
): { firstBgCol: number; lastBgCol: number } {
	const screen = harness.screen();
	let firstBgCol = -1;
	let lastBgCol = -1;
	for (let c = 0; c < screen.width; c += 1) {
		const cell = screen.cellAt(row, c);
		if (cell?.bg.kind === "rgb") {
			if (firstBgCol === -1) firstBgCol = c;
			lastBgCol = c;
		}
	}
	return { firstBgCol, lastBgCol };
}

describe("Symmetric Grok-grid viewport chrome, pinned Header, Outline Rail, wheel containment, and clean selection copy (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	afterEach(async () => {
		const stickyCfg = getStickyConfig();
		stickyCfg.enabled = true;
		stickyCfg.showTimestamp = true;
		stickyCfg.showNavigation = false;
		stickyCfg.mode = "auto";
		getOutlineSettings().enabled = true;
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("aligns fullscreen surfaces at x = 2 .. width - 3 and inner dialogue at x = 4 without decorative code rails or 1-column width jump between 1-turn and multi-turn transcripts", async () => {
		const t1 = new Date(2026, 3, 19, 10, 0).getTime();
		const width = 80;
		harness = await createInteractiveHarness({
			theme: "dark",
			width,
			height: 28,
			initialEntries: [
				makeUserEntry("u1", null, "First turn alignment check", t1),
				makeAssistantEntry(
					"a1",
					"u1",
					"Assistant prose starts cleanly.\n\n```ts\nconst alpha = 1;\nconst beta = 2;\n```",
					t1 + 1000,
				),
			],
		});

		const screen1 = harness.screen();
		const promptHit1 = screen1.findText("› First turn alignment check");
		expect(promptHit1).toBeDefined();
		expect(promptHit1!.col).toBe(4);
		const promptSpan1 = findCardHorizontalSpan(harness, promptHit1!.row);
		expect(promptSpan1).toEqual({ firstBgCol: 2, lastBgCol: width - 3 });

		const proseHit1 = screen1.findText("Assistant prose starts cleanly.");
		expect(proseHit1).toBeDefined();
		expect(proseHit1!.col).toBe(4);

		const codeHit1 = screen1.findText("const alpha = 1;");
		expect(codeHit1).toBeDefined();
		expect(screen1.rowText(codeHit1!.row)).not.toContain("▎");

		const composerTop1 = Array.from({ length: screen1.height }, (_, r) => r).find(
			(r) => screen1.cellAt(r, 2)?.char === "╭" && screen1.cellAt(r, width - 3)?.char === "╮",
		);
		expect(composerTop1).toBeDefined();
		expect(screen1.cellAt(composerTop1! + 1, 2)?.char).toBe("│");
		expect(screen1.cellAt(composerTop1! + 1, 4)?.char).toBe("›");
		expect(screen1.cellAt(composerTop1! + 1, width - 3)?.char).toBe("│");

		await harness.submitInput("Second turn causing scrollback overflow");
		const screen2 = harness.screen();
		const scroll = getActiveHostRuntime()!.scroll!;
		expect(scroll.scrollbar).toBe("hidden");
		await harness.mouseWheel("up", 12, 12, 30);
		const screen2Top = harness.screen();
		const promptHit2 = screen2Top.findText("› First turn alignment check");
		expect(promptHit2).toBeDefined();
		expect(promptHit2!.col).toBe(4);
		const promptSpan2 = findCardHorizontalSpan(harness, promptHit2!.row);
		expect(promptSpan2).toEqual(promptSpan1);
		expect(screen2.text()).not.toContain("Jump to latest message");

		await harness.resize(36, 28);
		const narrow = harness.screen();
		const prompt = narrow.findText("› First turn")!;
		expect(prompt.col).toBe(4);
		expect(findCardHorizontalSpan(harness, prompt.row)).toEqual({ firstBgCol: 2, lastBgCol: 33 });
		expect(narrow.rowText(1).search(/\S/u)).toBe(2);
	});

	it("renders Outline Rail inside width - 2 .. width - 1 with clean rounded Hover Popup (no Turn #N header) alongside centered ▲ and clickable ▼ scroll indicators", async () => {
		const t1 = new Date(2026, 3, 19, 10, 15).getTime();
		const t2 = new Date(2026, 3, 19, 10, 20).getTime();
		const width = 64;
		const height = 24;
		harness = await createInteractiveHarness({
			theme: "dark",
			width,
			height,
			initialEntries: [
				makeUserEntry("u1", null, "First turn topic alpha", t1),
				makeAssistantEntry("a1", "u1", buildLines("reply-one", 20), t1 + 1000),
				makeUserEntry("u2", "a1", "Second turn topic beta", t2),
				makeAssistantEntry("a2", "u2", buildLines("reply-two", 20), t2 + 1000),
			],
		});

		await harness.mouseWheel("up", 12, 12, 4);
		const scrolled = harness.screen();

		expect(scrolled.text()).not.toContain("Jump to latest message");

		const railSlices = Array.from({ length: scrolled.height }, (_, r) =>
			scrolled.sliceText(r, width - 2, width),
		);
		const upRow = railSlices.findIndex((s) => s === " ▲");
		const downRow = railSlices.findIndex((s) => s === " ▼");
		expect(upRow).toBeGreaterThanOrEqual(3);
		expect(downRow).toBeGreaterThan(upRow);
		expect(railSlices.slice(upRow + 1, downRow)).toContain("━━");
		expect(railSlices.slice(upRow + 1, downRow)).toContain(" ─");

		const centerCol = Math.floor((width - 1) / 2);
		const upIndicatorRow = Array.from({ length: scrolled.height }, (_, r) => r).find(
			(r) => r >= 3 && scrolled.cellAt(r, centerCol)?.char === "▲",
		);
		const downIndicatorRow = Array.from({ length: scrolled.height }, (_, r) => r).find(
			(r) => r >= 3 && scrolled.cellAt(r, centerCol)?.char === "▼",
		);
		expect(upIndicatorRow).toBeDefined();
		expect(downIndicatorRow).toBeDefined();

		await harness.mouseMove(width - 1, upRow + 1);
		const hovered = harness.screen();
		expect(hovered.text()).toContain("First turn topic alpha");
		expect(hovered.text()).not.toContain("Turn #1");
		expect(hovered.text()).toContain("│ First turn topic alpha");
		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("│ First turn topic alpha");
		await harness.mouseMove(width - 1, upRow + 1);
		expect(harness.screen().text()).toContain("│ First turn topic alpha");
		await harness.pressKey("\x1b[5~");
		expect(harness.screen().text()).not.toContain("│ First turn topic alpha");

		await harness.mouseClick(centerCol, downIndicatorRow!);
		expect(harness.screen().text()).toContain("reply-two-20");
	});

	it("pins a symmetric 3-row Header at y = 0..2 outside ScrollView, copies full cwd on click, morphs context usage into a fixed-width hover bar, and opens Context Inspector on click", async () => {
		const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-ui-hdr-git-"));
		tempDirs.push(gitRepoDir);
		execFileSync("git", ["init", "-b", "feature/grid"], { cwd: gitRepoDir, stdio: "ignore" });

		const agentDir = mkdtempSync(join(tmpdir(), "pi-ui-hdr-owner-"));
		tempDirs.push(agentDir);
		writeFileSync(join(agentDir, "pi-ui.json"), JSON.stringify({ slotOwners: { header: "removed-plugin" } }));
		const t1 = new Date(2026, 3, 19, 10, 0).getTime();
		const width = 110;
		harness = await createInteractiveHarness({
			agentDir,
			theme: "dark",
			cwd: gitRepoDir,
			width,
			height: 24,
			initialEntries: [
				makeUserEntry("u1", null, "First pinned header test prompt", t1),
				makeAssistantEntry("a1", "u1", buildLines("scrolled-body", 26), t1 + 1000),
			],
		});

		await harness.mouseWheel("up", 12, 12, 30);
		await harness.mouseWheel("down", 12, 12, 3);
		const screen = harness.screen();

		expect(screen.rowText(0).trim()).toBe("");
		expect(screen.rowText(2).trim()).toBe("");
		const headerRow = screen.rowText(1);
		expect(headerRow.startsWith("  feature/grid ")).toBe(true);
		expect(headerRow).toContain(gitRepoDir);
		expect(headerRow.slice(width - 2)).toBe("  ");

		const ctxMatch = /(\d+(?:\.\d+)?[kM]?\s*\/\s*\d+(?:\.\d+)?[kM]?)\s*$/.exec(
			headerRow.slice(0, width - 2),
		);
		expect(ctxMatch).toBeTruthy();
		const ctxRightEnd = width - 2;
		const slotWidth = Math.max(11, ctxMatch![1]!.length);
		const slotStartCol = ctxRightEnd - slotWidth;
		expect(slotStartCol).toBeGreaterThan(20);

		const leftPartBeforeHover = headerRow.slice(0, slotStartCol);

		await harness.mouseClick(4, 1);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(gitRepoDir);

		await harness.mouseMove(ctxRightEnd - 2, 1);
		const hoveredHeaderRow = harness.screen().rowText(1);
		expect(hoveredHeaderRow.slice(0, slotStartCol)).toBe(leftPartBeforeHover);
		expect(hoveredHeaderRow.slice(width - 2)).toBe("  ");
		expect(hoveredHeaderRow.slice(slotStartCol, ctxRightEnd)).toMatch(/\d+\.\d+%/);
		expect(hoveredHeaderRow.slice(slotStartCol, ctxRightEnd).length).toBe(slotWidth);

		await harness.mouseClick(ctxRightEnd - 2, 1);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Context Inspector");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
	});

	it("anchors Sticky Prompt at y = 3, expands truncated prompts via Alt+S (leaving Ctrl+O unbound), and jumps to Turn start when clicking an untruncated Sticky Prompt", async () => {
		const t1 = new Date(2026, 3, 19, 11, 0).getTime();
		const t2 = new Date(2026, 3, 19, 11, 5).getTime();
		const longPrompt = [
			"Long sticky line 1",
			"Long sticky line 2",
			"Long sticky line 3",
			"Long sticky line 4",
			"Long sticky line 5",
		].join("\n");

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 80,
			height: 26,
			initialEntries: [
				makeUserEntry("u1", null, longPrompt, t1),
				makeAssistantEntry("a1", "u1", buildLines("long-reply", 24), t1 + 1000),
				makeUserEntry("u2", "a1", "Short sticky prompt", t2),
				makeAssistantEntry("a2", "u2", buildLines("short-reply", 24), t2 + 1000),
			],
		});

		await harness.mouseWheel("up", 12, 12, 30);
		await harness.mouseWheel("down", 12, 12, 3);
		const stickyCollapsed = harness.screen();

		expect(stickyCollapsed.rowText(0).trim()).toBe("");
		expect(stickyCollapsed.rowText(2).trim()).toBe("");
		const stickySpan = findCardHorizontalSpan(harness, 3);
		expect(stickySpan).toEqual({ firstBgCol: 2, lastBgCol: 77 });
		expect(stickyCollapsed.rowText(4)).toContain("› Long sticky line 1");
		expect(stickyCollapsed.rowText(6)).toContain("+2 lines (Alt+s)");
		expect(stickyCollapsed.text()).not.toContain("Long sticky line 5");

		await harness.resize(23, 26);
		expect(harness.screen().rowText(1).search(/\S/u)).toBe(2);
		expect(findCardHorizontalSpan(harness, 3)).toEqual({ firstBgCol: 2, lastBgCol: 20 });
		expect(harness.screen().cellAt(4, 4)?.char).toBe("›");
		await harness.resize(80, 26);

		await harness.pressKey("\x1b[200~");
		await harness.pressKey("ß");
		await harness.pressKey("\x1b[201~");
		expect(harness.screen().text()).toContain("ß");
		expect(harness.screen().text()).not.toContain("Long sticky line 5");

		await harness.pressKey("\x0f");
		expect(harness.screen().text()).not.toContain("Long sticky line 5");

		await harness.pressKey("\x1bs");
		const stickyExpanded = harness.screen();
		expect(stickyExpanded.text()).toContain("Long sticky line 5");

		await harness.pressKey("\x1bs");
		expect(harness.screen().text()).not.toContain("Long sticky line 5");

		await harness.mouseWheel("down", 28, 16, 12);
		const shortSticky = harness.screen();
		expect(shortSticky.rowText(4)).toContain("› Short sticky prompt");
		expect(shortSticky.rowText(4)).not.toContain("(Alt+s)");

		await harness.mouseClick(10, 4);
		expect(harness.screen().findText("short-reply-1")?.row).toBeLessThan(12);
	});

	it("enforces overscroll = contain on active Modal Cards, scrollable Hover Popups, and overflowed Composer drafts, and dismisses Hover Popups when wheeling outside", async () => {
		const t1 = new Date(2026, 3, 19, 12, 0).getTime();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 26,
			initialEntries: [
				makeUserEntry("u1", null, "Scrollable transcript anchor", t1),
				makeAssistantEntry("a1", "u1", buildLines("wheel-body", 36), t1 + 1000),
			],
		});

		const visibleTranscript = () => harness!.screen().text().match(/wheel-body-\d+/g);
		await harness.mouseWheel("up", 30, 12, 4);
		const initialRows = visibleTranscript();
		expect(initialRows?.length).toBeGreaterThan(0);

		await harness.pressKey("\x0b");
		expect(harness.screen().text()).toContain("Command Palette");
		await harness.mouseWheel("down", 48, 12, 6);
		await harness.mouseWheel("up", 4, 4, 3);
		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("Command Palette");
		expect(visibleTranscript()).toEqual(initialRows);
		const longPaste = Array.from({ length: 18 }, (_, i) => `paste-row-${String(i + 1).padStart(2, "0")}`).join(
			"\n",
		);
		await harness.paste(longPaste, true);
		const chipHit = harness.screen().findText("[📋 Pasted #1");
		expect(chipHit).toBeDefined();
		await harness.mouseMove(chipHit!.col + 2, chipHit!.row);

		const popupBefore = harness.screen();
		const pasteRow01 = popupBefore.findText("paste-row-01");
		expect(pasteRow01).toBeDefined();
		expect(popupBefore.text()).not.toContain("paste-row-15");

		await harness.mouseWheel("down", pasteRow01!.col + 2, pasteRow01!.row, 8);
		expect(harness.screen().text()).toContain("paste-row-15");
		await harness.mouseWheel("down", pasteRow01!.col + 2, pasteRow01!.row, 10);
		const remove = harness.screen().findText("[Remove]")!;
		await harness.mouseMove(remove.col + 2, remove.row);
		await harness.mouseClick(remove.col + 2, remove.row);
		expect(visibleTranscript()).toEqual(initialRows);

		await harness.paste(longPaste, true);
		await harness.mouseMove(chipHit!.col + 2, chipHit!.row);
		await harness.mouseWheel("up", 90, 5, 3);
		expect(harness.screen().text()).not.toContain("paste-row-01");
		expect(visibleTranscript()).not.toEqual(initialRows);

		for (let line = 1; line <= 16; line++) {
			await harness.pressKey("\x1b[13;2u");
			await harness.typeText(`draft-line-${line}`);
		}
		const composerBodyHit = harness.screen().findText("draft-line-16")!;
		const rowsBeforeComposerWheel = visibleTranscript();
		await harness.mouseWheel("up", composerBodyHit.col + 2, composerBodyHit.row, 20);
		expect(visibleTranscript()).toEqual(rowsBeforeComposerWheel);
		expect(harness.screen().findText("draft-line-1")).toBeDefined();
	});

	it("copies star-prefixed prose and soft-wrapped code without losing indentation", async () => {
		const prose = "An ordinary paragraph.\n\n✦ This is assistant prose.";
		const long = `const value = "${"X".repeat(80)}END_OF_STRING";`;
		const indented = "    important()";
		harness = await createInteractiveHarness({
			width: 56, height: 28, clipboard: { text: "before" },
			responses: [fauxAssistantMessage(`${prose}\n\n\`\`\`js\n${long}\n${indented}\n\`\`\``)],
		});
		await harness.submitInput("Show code");
		const screen = harness.screen();
		const start = screen.findText("An ordinary paragraph.")!;
		const end = screen.findText("important()")!;
		await harness.mouseDrag(start.col, start.row, end.col + "important()".length, end.row, { steps: 5 });
		await harness.pressKey("\x03");
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(`${prose}\n\n${long}\n${indented}`);
		await harness.mouseDrag(end.col - 4, end.row, end.col + "important()".length, end.row, { steps: 3 });
		const copy = harness.screen().findText("[Copy]")!;
		await harness.mouseClick(copy.col + 2, copy.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(indented);
	});

	it("keeps assistant prose named Copy in a mouse selection", async () => {
		harness = await createInteractiveHarness({ responses: [fauxAssistantMessage("Copy\n\nthe file")] });
		await harness.submitInput("What should I do?");
		const start = harness.screen().findText("Copy")!;
		const end = harness.screen().findText("the file")!;
		await harness.mouseDrag(start.col, start.row, end.col + "the file".length, end.row);
		await harness.pressKey("\x03");
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe("Copy\n\nthe file");
	});

	it("defaults copyOnSelect to false, mounts [Copy] [Quote · Alt+Q], copies clean text via [Copy] and Ctrl+C/Ctrl+X with ✓ Copied flash, and supports copyOnSelect = true", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 68,
			height: 28,
			trueColor: false,
			clipboard: { text: "PRESERVED_CLIPBOARD" },
			responses: [
				fauxAssistantMessage([
					fauxThinking("Internal reasoning step"),
					fauxText(
						"Use `npm run check` to verify the full pipeline before merging changes into the integration branch.\n\n```ts\nconst one = 1;\nconst two = 2;\n```",
					),
				]),
			],
		});

		await harness.submitInput("How do I verify?");

		await harness.mouseWheel("up", 12, 12, 30);

		const screen = harness.screen();
		const thoughtHit = screen.findText("Thought");
		const codeEndHit = screen.findText("const two = 2;");
		expect(thoughtHit).toBeDefined();
		expect(codeEndHit).toBeDefined();

		await harness.mouseDrag(
			thoughtHit!.col,
			thoughtHit!.row - 1,
			codeEndHit!.col + "const two = 2;".length,
			codeEndHit!.row,
			{ steps: 4 },
		);

		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe("PRESERVED_CLIPBOARD");
		const popupScreen = harness.screen();
		const copyBtn = popupScreen.findText("[Copy]");
		expect(copyBtn).toBeDefined();
		expect(popupScreen.text()).toContain("[Quote · Alt+Q]");

		await harness.mouseClick(copyBtn!.col + 2, copyBtn!.row);
		const copiedViaBtn = await getActiveHostRuntime()!.clipboard.readText?.();
		expect(copiedViaBtn).toContain(
			"Use `npm run check` to verify the full pipeline before merging changes into the integration branch.",
		);
		expect(copiedViaBtn).toContain("const one = 1;\nconst two = 2;");
		expect(copiedViaBtn).not.toContain("Thought");
		expect(copiedViaBtn).not.toContain("Copy");

		const renderer = unwrapHostTui(harness.tui) as {
			getActiveSelectionText?: () => string | undefined;
		};
		expect(renderer.getActiveSelectionText?.()).toBeUndefined();
		expect(harness.screen().text()).toContain("✓ Copied");
		expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");

		const proseStart = harness.screen().findText("Use npm run check")!;
		await harness.mouseDrag(
			proseStart.col,
			proseStart.row,
			proseStart.col + 28,
			proseStart.row,
			{ steps: 2 },
		);
		expect(harness.screen().text()).toContain("[Copy]");
		await harness.pressKey("\x03");
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toContain("`npm run check`");
		expect(renderer.getActiveSelectionText?.()).toBeUndefined();
		expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");

		harness.setClipboard({ text: "BEFORE_CTRL_X" });
		await harness.mouseDrag(
			proseStart.col,
			proseStart.row,
			proseStart.col + 28,
			proseStart.row,
			{ steps: 2 },
		);
		await harness.pressKey("\x18");
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toContain("`npm run check`");
		expect(renderer.getActiveSelectionText?.()).toBeUndefined();

		updatePiUiUserConfig({ copyOnSelect: true });
		harness.setClipboard({ text: "BEFORE_AUTO_COPY" });
		await harness.mouseDrag(
			proseStart.col,
			proseStart.row,
			proseStart.col + 28,
			proseStart.row,
			{ steps: 2 },
		);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toContain("`npm run check`");
		expect(harness.screen().text()).toContain("✓ Copied · [Quote · Alt+Q]");
		const quoteBtn = harness.screen().findText("[Quote · Alt+Q]")!;
		await harness.mouseMove(quoteBtn.col + 2, quoteBtn.row);
		const hoverBg = harness.screen().cellAt(quoteBtn.row, quoteBtn.col + 2)?.bg;
		expect(hoverBg?.kind).toBe("palette256");
		if (hoverBg?.kind === "palette256") {
			const { hue, saturation } = rgbHueDegrees(parseAnsiColorRgb(`\x1b[48;5;${hoverBg.index}m`)!);
			expect(saturation < 0.04 || (hue > 198 && hue < 255)).toBe(true);
		}
		await harness.mouseMove(10, 1);
		expect(harness.screen().text()).not.toContain("[Quote · Alt+Q]");
		await harness.mouseDrag(proseStart.col, proseStart.row, proseStart.col + 28, proseStart.row, { steps: 2 });
		const reOpened = harness.screen().findText("[Quote · Alt+Q]")!;
		await harness.mouseClick(reOpened.col + 2, reOpened.row);
		expect(getActiveComposerEditor()!.getText()).toContain("[❝ Quote #1");
	});
});
