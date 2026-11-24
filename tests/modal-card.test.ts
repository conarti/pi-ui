import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_MARKER, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import { getSessionWorkflow } from "../src/shared/session-workflow.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function findTextCell(lines: readonly string[], needle: string, rowRange?: { start?: number; end?: number }): { x: number; y: number } {
	const start = rowRange?.start ?? 0;
	const end = rowRange?.end ?? lines.length;
	for (let y = start; y < end; y++) {
		const plain = stripAnsi(lines[y] ?? "");
		const idx = plain.indexOf(needle);
		if (idx !== -1) {
			const x = visibleWidth(plain.slice(0, idx));
			return { x, y };
		}
	}
	throw new Error(`Could not find "${needle}" in rendered lines:\n${lines.map((l, i) => `${i}: ${stripAnsi(l)}`).join("\n")}`);
}

function extractBgRgbColors(lines: readonly string[]): Array<[number, number, number]> {
	const found: Array<[number, number, number]> = [];
	const re = /\x1b\[48;2;(\d+);(\d+);(\d+)m/g;
	for (const line of lines) {
		for (const m of line.matchAll(re)) {
			found.push([Number(m[1]), Number(m[2]), Number(m[3])]);
		}
	}
	return found;
}

function luminance([r, g, b]: [number, number, number]): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

function mouseMove(x: number, y: number): TuiMouseEvent {
	return { type: "move", x, y } as TuiMouseEvent;
}

function leftClick(x: number, y: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y } as TuiMouseEvent;
}

describe("Modal Card dialogs and adaptive theme surfaces", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		if (harness) {
			harness.activeCustomModal?.done(undefined);
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("renders Context Inspector with light-appropriate surfaces and accurate close/pill hitboxes across narrow and wide widths", async () => {
		harness = createExtensionHarness({ theme: "light", width: 110, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const openPromise = harness.runCommand("context");
		expect(harness.activeCustomModal).toBeDefined();
		const comp = harness.activeCustomModal!.component;

		// Check narrow (44 cols) and wide (110 cols) widths
		for (const width of [44, 110]) {
			comp.handleMouse?.(mouseMove(0, 1));
			const initialLines = comp.render(width);
			const bgColors = extractBgRgbColors(initialLines);
			expect(bgColors.length).toBeGreaterThan(0);
			for (const rgb of bgColors) {
				expect(luminance(rgb), `dark bg rgb(${rgb.join(",")}) on light theme at width=${width}`).toBeGreaterThan(170);
			}

			// Top-right close target highlights on hover at the exact rendered ✕ cell
			const closePos = findTextCell(initialLines, "✕", { start: 0, end: 1 });
			const moveClose = comp.handleMouse?.(mouseMove(closePos.x, closePos.y));
			expect(moveClose?.render).toBe(true);
			const hoveredCloseLines = comp.render(width);
			expect(hoveredCloseLines[0]).not.toBe(initialLines[0]);

			// Footer action pill ("Закрыть") highlights on hover at its exact rendered cell
			const closePillPos = findTextCell(initialLines, "Закрыть", { start: 1 });
			const movePill = comp.handleMouse?.(mouseMove(closePillPos.x, closePillPos.y));
			expect(movePill?.render).toBe(true);
			const hoveredPillLines = comp.render(width);
			expect(hoveredPillLines[closePillPos.y]).not.toBe(initialLines[closePillPos.y]);
			for (const rgb of extractBgRgbColors(hoveredPillLines)) {
				expect(luminance(rgb), `dark hovered bg rgb(${rgb.join(",")}) on light theme at width=${width}`).toBeGreaterThan(170);
			}
		}

		// Click the top-right close button at narrow width (44 cols) -> closes modal
		const narrowLines = comp.render(44);
		const closePos = findTextCell(narrowLines, "✕", { start: 0, end: 1 });
		comp.handleMouse?.(leftClick(closePos.x, closePos.y));
		await openPromise;
		expect(harness.activeCustomModal).toBeUndefined();
	});

	it("renders Auto-Safe confirmation with light surfaces and accurate close + footer pill hitboxes at narrow width", async () => {
		harness = createExtensionHarness({ theme: "light", width: 46, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();
		await harness.runCommand("mode", "safe");

		const toolCallPromise = harness.emit("tool_call", {
			toolName: "write",
			input: { path: "src/demo.ts", content: "hello" },
		});
		expect(harness.activeCustomModal).toBeDefined();
		const comp = harness.activeCustomModal!.component;

		const narrowLines = comp.render(46);
		// Every background color on light theme must be light-appropriate
		const bgColors = extractBgRgbColors(narrowLines);
		expect(bgColors.length).toBeGreaterThan(0);
		for (const rgb of bgColors) {
			expect(luminance(rgb), `dark bg rgb(${rgb.join(",")}) in Auto-Safe on light theme`).toBeGreaterThan(170);
		}

		// Top-right close target is rendered and hoverable
		const topClosePos = findTextCell(narrowLines, "✕", { start: 0, end: 1 });
		expect(comp.handleMouse?.(mouseMove(topClosePos.x, topClosePos.y))?.render).toBe(true);

		// Footer "Отклонить" pill is visible even at narrow width (46 cols) and clicking it blocks the tool call
		const denyPos = findTextCell(narrowLines, "Отклонить", { start: 1 });
		expect(comp.handleMouse?.(mouseMove(denyPos.x, denyPos.y))?.render).toBe(true);
		comp.handleMouse?.(leftClick(denyPos.x, denyPos.y));

		const results = await toolCallPromise;
		expect(results.some((r) => (r as { block?: boolean } | undefined)?.block === true)).toBe(true);
		expect(harness.activeCustomModal).toBeUndefined();
	});

	it("renders Command Palette with light surfaces, accurate close hitboxes across widths, and grapheme-safe search input", async () => {
		harness = createExtensionHarness({ theme: "light", width: 110, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const openPromise = harness.triggerShortcut("ctrl+k");
		expect(harness.activeCustomModal).toBeDefined();
		const comp = harness.activeCustomModal!.component;

		// Placeholder and focus cursor marker present when query is empty
		const initialWide = comp.render(110);
		expect(initialWide.some((l) => l.includes(CURSOR_MARKER))).toBe(true);
		expect(stripAnsi(initialWide.join("\n"))).toContain("Поиск команд");

		// Light-appropriate selection and hover row backgrounds (no dark slate)
		comp.handleMouse?.(mouseMove(6, 4));
		const hoveredWide = comp.render(110);
		const bgColors = extractBgRgbColors(hoveredWide);
		expect(bgColors.length).toBeGreaterThan(0);
		for (const rgb of bgColors) {
			expect(luminance(rgb), `dark bg rgb(${rgb.join(",")}) in Command Palette on light theme`).toBeGreaterThan(170);
		}

		// Grapheme-safe backspace and Ctrl+U line clear
		comp.handleInput?.("a👨‍👩‍👧‍👦");
		expect(stripAnsi(comp.render(80).join("\n"))).toContain("a👨‍👩‍👧‍👦");
		comp.handleInput?.("\x7f"); // backspace removes entire emoji grapheme cluster
		const afterBackspace = stripAnsi(comp.render(80).join("\n"));
		expect(afterBackspace).not.toContain("👨‍👩‍👧‍👦");
		expect(afterBackspace).toContain("⌕ a");
		comp.handleInput?.("\x15"); // Ctrl+U clears line and restores placeholder
		expect(stripAnsi(comp.render(80).join("\n"))).toContain("Поиск команд");

		// Top-right close hover works across narrow (46 cols) and wide (110 cols) widths
		for (const width of [46, 110]) {
			comp.handleMouse?.(mouseMove(0, 1));
			const lines = comp.render(width);
			const closePos = findTextCell(lines, "✕", { start: 0, end: 1 });
			expect(comp.handleMouse?.(mouseMove(closePos.x, closePos.y))?.render).toBe(true);
			expect(comp.render(width)[0]).not.toBe(lines[0]);
		}

		// Clicking top-right close at narrow width closes palette
		const narrowLines = comp.render(46);
		const closePos = findTextCell(narrowLines, "✕", { start: 0, end: 1 });
		comp.handleMouse?.(leftClick(closePos.x, closePos.y));
		await openPromise;
		expect(harness.activeCustomModal).toBeUndefined();
	});

	it("renders Plan Studio with light surfaces, shared grapheme-safe inline comment input, and narrow/wide pill hitboxes", async () => {
		harness = createExtensionHarness({ theme: "light", width: 110, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const st = getSessionWorkflow();
		st.planLines = ["# Plan", "1. Refactor modal card", "2. Add tests"];
		st.planComments = { 1: "Existing note" };

		const openPromise = harness.runCommand("plan");
		expect(harness.activeCustomModal).toBeDefined();
		const comp = harness.activeCustomModal!.component;

		// Light-appropriate selection, hover, and comment-row surfaces
		comp.handleMouse?.(mouseMove(6, 4));
		const wideLines = comp.render(110);
		const wideBgs = extractBgRgbColors(wideLines);
		expect(wideBgs.length).toBeGreaterThan(0);
		for (const rgb of wideBgs) {
			expect(luminance(rgb), `dark bg rgb(${rgb.join(",")}) in Plan Studio on light theme`).toBeGreaterThan(170);
		}

		// Enter inline comment editing on line 0: shows focus cursor marker & placeholder when empty
		comp.handleInput?.("\r");
		const editEmptyLines = comp.render(90);
		expect(editEmptyLines.some((l) => l.includes(CURSOR_MARKER))).toBe(true);
		for (const rgb of extractBgRgbColors(editEmptyLines)) {
			expect(luminance(rgb), `dark edit bg rgb(${rgb.join(",")}) in Plan Studio on light theme`).toBeGreaterThan(170);
		}

		// Type text + multi-codepoint emoji, backspace deletes whole grapheme cluster, Ctrl+U clears line
		comp.handleInput?.("ok👨‍👩‍👧‍👦");
		expect(stripAnsi(comp.render(90).join("\n"))).toContain("ok👨‍👩‍👧‍👦");
		comp.handleInput?.("\x7f");
		const afterBs = stripAnsi(comp.render(90).join("\n"));
		expect(afterBs).not.toContain("👨‍👩‍👧‍👦");
		expect(afterBs).toContain("ok");
		comp.handleInput?.("\x15"); // Ctrl+U clears line while staying in edit mode
		expect(comp.render(90).some((l) => l.includes(CURSOR_MARKER))).toBe(true);
		comp.handleInput?.("Keep it simple");
		comp.handleInput?.("\r"); // save comment
		expect(st.planComments[0]).toBe("Keep it simple");

		// Top-right close and footer pills hover accurately across narrow (52 cols) and wide (110 cols) widths
		for (const width of [52, 110]) {
			comp.handleMouse?.(mouseMove(0, 1));
			const lines = comp.render(width);
			const closePos = findTextCell(lines, "✕", { start: 0, end: 1 });
			expect(comp.handleMouse?.(mouseMove(closePos.x, closePos.y))?.render).toBe(true);
			expect(comp.render(width)[0]).not.toBe(lines[0]);

			const clearPos = findTextCell(lines, "Сбросить комменты", { start: 1 });
			expect(comp.handleMouse?.(mouseMove(clearPos.x, clearPos.y))?.render).toBe(true);
			expect(comp.render(width)[clearPos.y]).not.toBe(lines[clearPos.y]);
		}

		// Click "Закрыть" pill at narrow width (52 cols) -> closes Plan Studio
		const narrowLines = comp.render(52);
		const closePillPos = findTextCell(narrowLines, "Закрыть", { start: 1 });
		comp.handleMouse?.(leftClick(closePillPos.x, closePillPos.y));
		await openPromise;
		expect(harness.activeCustomModal).toBeUndefined();
	});

	it("performs a quiet no-op when opening a Modal Card over another Modal Card, while ignoring non-capturing Hover Popups", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		// Mount a visible non-capturing Hover Popup (like OutlinePreviewPopup)
		const hoverHandle = harness.tui.showOverlay(
			{ invalidate() {}, render: () => ["Hover Preview"] },
			{ nonCapturing: true, anchor: "top-right" },
		);

		// Opening Command Palette while a non-capturing Hover Popup is visible MUST succeed
		const palettePromise = harness.triggerShortcut("ctrl+k");
		expect(harness.activeCustomModal).toBeDefined();
		const paletteModal = harness.activeCustomModal!;
		expect(harness.tui.overlayStack.filter((e) => !e.options?.nonCapturing)).toHaveLength(1);

		// Triggering Context Inspector or Plan Studio while Command Palette is visible is a quiet no-op
		const st = getSessionWorkflow();
		st.planLines = ["1. Step one"];
		const notifBefore = harness.notifications.length;

		await harness.runCommand("context");
		await harness.runCommand("plan");

		expect(harness.activeCustomModal).toBe(paletteModal);
		expect(harness.tui.overlayStack.filter((e) => !e.options?.nonCapturing)).toHaveLength(1);
		expect(harness.notifications.length).toBe(notifBefore);

		// Close Command Palette -> now Context Inspector can open
		paletteModal.done(null);
		await palettePromise;
		expect(harness.activeCustomModal).toBeUndefined();

		const contextPromise = harness.runCommand("context");
		expect(harness.activeCustomModal).toBeDefined();
		harness.activeCustomModal!.done("close");
		await contextPromise;
		hoverHandle.hide();
	});

	it("blocks ask_user_question with clear error over Modal Card, blocks Modal Card over active questionnaire, and preserves questionnaire layout", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 110, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const askTool = harness.tools.get("ask_user_question");
		expect(askTool).toBeDefined();

		const sampleParams = {
			questions: [
				{
					header: "Storage",
					question: "Choose a storage backend",
					options: [
						{ label: "SQLite", description: "Local embedded DB", preview: "CREATE TABLE items (id INT);" },
						{ label: "JSON", description: "Plain file" },
					],
				},
				{
					header: "Cache",
					question: "Enable caching?",
					options: [
						{ label: "Yes", description: "In-memory LRU" },
						{ label: "No", description: "Direct reads" },
					],
				},
			],
		};

		// 1. Open a Modal Card -> invoking ask_user_question returns the clear blocking-dialog error
		const contextPromise = harness.runCommand("context");
		expect(harness.activeCustomModal).toBeDefined();

		await expect(
			askTool!.execute("call-1", sampleParams as never, undefined, undefined as never, harness.ctx as never),
		).rejects.toThrow("Close the existing dialog before opening a questionnaire.");

		harness.activeCustomModal!.done("close");
		await contextPromise;

		// 2. Open ask_user_question when no modal is open -> preserves multi-tab split-preview layout
		const questionnairePromise = askTool!.execute(
			"call-2",
			sampleParams as never,
			undefined,
			undefined as never,
			harness.ctx as never,
		);
		expect(harness.activeCustomModal).toBeDefined();
		const qModal = harness.activeCustomModal!;
		const qRendered = stripAnsi(qModal.component.render(110).join("\n"));
		expect(qRendered).toContain("☐ Storage");
		expect(qRendered).toContain("☐ Cache");
		expect(qRendered).toContain("✔ Submit");
		expect(qRendered).toContain("CREATE TABLE items");
		expect(qRendered).not.toContain("╭─"); // preserves its own layout, not Modal Card frame

		// 3. Triggering a Modal Card while ask_user_question is visible performs a quiet no-op without stacking
		await harness.triggerShortcut("ctrl+k");
		await harness.runCommand("context");
		expect(harness.activeCustomModal).toBe(qModal);
		expect(harness.tui.overlayStack.filter((e) => !e.options?.nonCapturing)).toHaveLength(0);

		// Cancel questionnaire -> cleanup allows Modal Card to open again
		qModal.done({ cancelled: true, answers: [] });
		await questionnairePromise;

		const paletteAfter = harness.triggerShortcut("ctrl+k");
		expect(harness.activeCustomModal).toBeDefined();
		harness.activeCustomModal!.done(null);
		await paletteAfter;
	});
});
