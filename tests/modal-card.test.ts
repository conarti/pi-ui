import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runQuestionnaire } from "../src/features/ask-user/questionnaire.ts";
import { showContextInspector } from "../src/features/context-inspector/index.ts";
import { showPlanStudio } from "../src/features/plan-studio/studio-overlay.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import { getSessionWorkflow } from "../src/shared/session-workflow.ts";
import {
	contentText,
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxToolCall,
	type InteractiveHarness,
	type TerminalScreenSnapshot,
} from "./harness/index.ts";

function luminance(r: number, g: number, b: number): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

function findModalBounds(screen: TerminalScreenSnapshot): {
	top: number;
	bottom: number;
	left: number;
	right: number;
} {
	let top = -1;
	let bottom = -1;
	let left = -1;
	let right = -1;
	for (let r = 0; r < screen.height; r += 1) {
		const row = screen.rowText(r);
		const tl = row.indexOf("╭─");
		if (tl !== -1 && top === -1) {
			top = r;
			left = tl;
			right = row.lastIndexOf("╮");
		}
		if (top !== -1 && row.indexOf("╰") === left) {
			bottom = r;
			break;
		}
	}
	if (top === -1 || bottom === -1 || right <= left) {
		throw new Error(`Modal Card bounds not found on screen:\n${screen.text()}`);
	}
	return { top, bottom, left, right };
}

function collectModalBgLuminances(screen: TerminalScreenSnapshot): number[] {
	const bounds = findModalBounds(screen);
	const values: number[] = [];
	for (let r = bounds.top; r <= bounds.bottom; r += 1) {
		for (let c = bounds.left; c <= bounds.right; c += 1) {
			const cell = screen.cellAt(r, c);
			if (cell?.bg.kind === "rgb") {
				values.push(luminance(cell.bg.r, cell.bg.g, cell.bg.b));
			}
		}
	}
	return values;
}

async function openSlashWithoutWaiting(harness: InteractiveHarness, cmd: string): Promise<void> {
	await harness.paste(cmd, true);
	await harness.pressKey("\r");
	await harness.flush();
}

describe("Modal Card dialogs and adaptive theme surfaces (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
	});

	it("renders Context Inspector with light-appropriate surfaces and accurate close/pill hitboxes across narrow and wide widths", async () => {
		harness = await createInteractiveHarness({
			theme: "light",
			width: 110,
			height: 32,
		});

		await openSlashWithoutWaiting(harness, "/context");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Context Inspector");

		for (const termWidth of [48, 110]) {
			await harness.resize(termWidth, 32);
			await harness.mouseMove(2, 2);

			const baseScreen = harness.screen();
			const bounds = findModalBounds(baseScreen);
			const bgLums = collectModalBgLuminances(baseScreen);
			expect(bgLums.length).toBeGreaterThan(0);
			for (const lum of bgLums) {
				expect(lum).toBeGreaterThan(170);
			}

			let closeCol = -1;
			for (let c = bounds.left; c <= bounds.right; c += 1) {
				if (baseScreen.cellAt(bounds.top, c)?.char === "✕") {
					closeCol = c;
					break;
				}
			}
			expect(closeCol).toBeGreaterThan(bounds.left);
			const closeFgBefore = baseScreen.cellAt(bounds.top, closeCol)?.fg;
			await harness.mouseMove(closeCol, bounds.top);
			const closeFgAfter = harness.screen().cellAt(bounds.top, closeCol)?.fg;
			expect(closeFgAfter).not.toEqual(closeFgBefore);

			const pillPos = baseScreen.findText("Закрыть");
			expect(pillPos).toBeDefined();
			const pillBgBefore = baseScreen.cellAt(pillPos!.row, pillPos!.col)?.bg;
			await harness.mouseMove(pillPos!.col + 1, pillPos!.row);
			const hoveredPillScreen = harness.screen();
			const pillBgAfter = hoveredPillScreen.cellAt(pillPos!.row, pillPos!.col)?.bg;
			expect(pillBgAfter).not.toEqual(pillBgBefore);
			for (const lum of collectModalBgLuminances(hoveredPillScreen)) {
				expect(lum).toBeGreaterThan(170);
			}
		}

		await harness.resize(48, 32);
		const narrowScreen = harness.screen();
		const narrowBounds = findModalBounds(narrowScreen);
		let narrowCloseCol = -1;
		for (let c = narrowBounds.left; c <= narrowBounds.right; c += 1) {
			if (narrowScreen.cellAt(narrowBounds.top, c)?.char === "✕") {
				narrowCloseCol = c;
				break;
			}
		}
		await harness.mouseClick(narrowCloseCol, narrowBounds.top);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(harness.screen().text()).not.toContain("Context Inspector");
	});

	it("renders Permission Prompt confirmation with light surfaces and accurate close + footer pill hitboxes at narrow width", async () => {
		harness = await createInteractiveHarness({
			theme: "light",
			width: 50,
			height: 32,
			responses: [
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "src/demo.ts", content: "hello" }, { id: "mc-safe-1" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Denied cleanly."),
			],
		});

		await harness.submitInput("/mode safe");
		const turn = harness.submitInput("Write demo file");
		await harness.flush();

		const screen0 = harness.screen();
		expect(screen0.text()).toContain("Auto-Safe Confirmation");
		const bgLums = collectModalBgLuminances(screen0);
		expect(bgLums.length).toBeGreaterThan(0);
		for (const lum of bgLums) {
			expect(lum).toBeGreaterThan(170);
		}

		const bounds = findModalBounds(screen0);
		let closeCol = -1;
		for (let c = bounds.left; c <= bounds.right; c += 1) {
			if (screen0.cellAt(bounds.top, c)?.char === "✕") {
				closeCol = c;
				break;
			}
		}
		const closeBefore = screen0.cellAt(bounds.top, closeCol)?.fg;
		await harness.mouseMove(closeCol, bounds.top);
		expect(harness.screen().cellAt(bounds.top, closeCol)?.fg).not.toEqual(closeBefore);

		const denyPos = harness.screen().findText("Отклонить");
		expect(denyPos).toBeDefined();
		await harness.mouseClick(denyPos!.col + 2, denyPos!.row);
		await turn;

		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(existsSync(join(harness.cwd, "src", "demo.ts"))).toBe(false);
		expect(harness.screen().text()).toContain("Denied cleanly.");
	});

	it("opens Command Palette via Ctrl+K without deleting composer draft, renders light surfaces, and handles grapheme-safe search + narrow/wide close hitboxes", async () => {
		harness = await createInteractiveHarness({
			theme: "light",
			width: 110,
			height: 32,
		});

		await harness.typeText("keep my draft");
		await harness.pressKey("\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("⌘ Command Palette");
		expect(harness.screen().text()).toContain("Поиск команд");

		const boundsWide = findModalBounds(harness.screen());
		await harness.mouseMove(boundsWide.left + 6, boundsWide.top + 4);
		const bgLums = collectModalBgLuminances(harness.screen());
		expect(bgLums.length).toBeGreaterThan(0);
		for (const lum of bgLums) {
			expect(lum).toBeGreaterThan(170);
		}

		await harness.sendInput("a👨‍👩‍👧‍👦");
		expect(harness.screen().text()).toContain("a👨‍👩‍👧‍👦");
		await harness.pressKey("\x7f");
		const afterBs = harness.screen().text();
		expect(afterBs).not.toContain("👨‍👩‍👧‍👦");
		expect(afterBs).toContain("⌕");
		await harness.pressKey("\x15");
		expect(harness.screen().text()).toContain("Поиск команд");

		for (const termW of [50, 110]) {
			await harness.resize(termW, 32);
			await harness.mouseMove(1, 1);
			const s = harness.screen();
			const b = findModalBounds(s);
			let xCol = -1;
			for (let c = b.left; c <= b.right; c += 1) {
				if (s.cellAt(b.top, c)?.char === "✕") {
					xCol = c;
					break;
				}
			}
			const fg0 = s.cellAt(b.top, xCol)?.fg;
			await harness.mouseMove(xCol, b.top);
			expect(harness.screen().cellAt(b.top, xCol)?.fg).not.toEqual(fg0);
		}

		await harness.resize(50, 32);
		const narrow = harness.screen();
		const nb = findModalBounds(narrow);
		let nxCol = -1;
		for (let c = nb.left; c <= nb.right; c += 1) {
			if (narrow.cellAt(nb.top, c)?.char === "✕") {
				nxCol = c;
				break;
			}
		}
		await harness.mouseClick(nxCol, nb.top);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(harness.screen().text()).not.toContain("⌘ Command Palette");
		expect(harness.screen().text()).toContain("keep my draft");
	});

	it("tracks split-chunk and back-to-back bracketed pastes statefully and opens Command Palette on post-paste Ctrl+K", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 28,
		});

		await harness.sendInput("\x1b[20");
		await harness.sendInput("0~alpha");
		await harness.sendInput("\x0b");
		await harness.sendInput("beta\x1b[2");
		await harness.sendInput("01~");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(harness.screen().text()).not.toContain("⌘ Command Palette");

		await harness.sendInput("\x1b[200~ first");
		await harness.sendInput("!\x1b[201~\x1b[200~ second");
		await harness.sendInput("\x0b");
		await harness.sendInput("!\x1b[201~");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(harness.screen().text()).not.toContain("⌘ Command Palette");

		await harness.sendInput("\x1b[200~ tail\x1b[201~\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("⌘ Command Palette");

		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(harness.screen().text()).toContain("tail");
	});

	it("renders Plan Approval Modal Card with light surfaces, grapheme-safe inline comment input, and narrow/wide pill hitboxes", async () => {
		harness = await createInteractiveHarness({
			theme: "light",
			width: 110,
			height: 34,
			responses: [fauxAssistantMessage("# Plan\n1. Refactor modal card\n2. Add tests")],
		});

		await harness.submitInput("/mode plan");
		await harness.submitInput("Create modal plan");

		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Plan Studio");

		const b0 = findModalBounds(harness.screen());
		await harness.mouseMove(b0.left + 8, b0.top + 4);
		const wideLums = collectModalBgLuminances(harness.screen());
		expect(wideLums.length).toBeGreaterThan(0);
		for (const lum of wideLums) {
			expect(lum).toBeGreaterThan(170);
		}

		await harness.pressKey("\r");
		for (const lum of collectModalBgLuminances(harness.screen())) {
			expect(lum).toBeGreaterThan(170);
		}
		await harness.sendInput("ok👨‍👩‍👧‍👦");
		expect(harness.screen().text()).toContain("ok👨‍👩‍👧‍👦");
		await harness.pressKey("\x7f");
		expect(harness.screen().text()).not.toContain("👨‍👩‍👧‍👦");
		await harness.pressKey("\x15");
		await harness.typeText("Keep it simple");
		await harness.pressKey("\r");
		expect(getSessionWorkflow().planComments[0]).toBe("Keep it simple");
		expect(harness.screen().text()).toContain("Keep it simple");

		for (const termW of [56, 110]) {
			await harness.resize(termW, 34);
			await harness.mouseMove(1, 1);
			const s = harness.screen();
			const clearPos = s.findText("Сбросить комменты");
			expect(clearPos).toBeDefined();
			const bgBefore = s.cellAt(clearPos!.row, clearPos!.col)?.bg;
			await harness.mouseMove(clearPos!.col + 2, clearPos!.row);
			expect(harness.screen().cellAt(clearPos!.row, clearPos!.col)?.bg).not.toEqual(bgBefore);
		}

		await harness.resize(56, 34);
		const closePill = harness.screen().findText("Закрыть");
		expect(closePill).toBeDefined();
		await harness.mouseClick(closePill!.col + 1, closePill!.row);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(harness.screen().text()).not.toContain("Plan Studio");
	});

	it("performs a quiet no-op when opening a Modal Card over another Modal Card, while ignoring non-capturing Hover Popups", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 110,
			height: 32,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_ev, ctx) => {
						ctx.ui.onTerminalInput((data) => {
							if (data === "\x1b[105;7u") {
								void showContextInspector(pi, ctx);
								return { consume: true };
							}
							if (data === "\x1b[112;7u") {
								void showPlanStudio(pi, ctx);
								return { consume: true };
							}
							return undefined;
						});
					});
				},
			],
			responses: [
				fauxAssistantMessage(
					Array.from({ length: 18 }, (_, i) => `Turn 1 line ${i + 1}`).join("\n"),
				),
				fauxAssistantMessage(
					Array.from({ length: 14 }, (_, i) => `Turn 2 line ${i + 1}`).join("\n"),
				),
			],
		});

		await harness.submitInput("First turn for rail hover");
		await harness.submitInput("Second turn for rail hover");

		const baseScreen = harness.screen();
		let tickRow = -1;
		for (let r = 0; r < baseScreen.height; r += 1) {
			if (/[●○─━]/.test(baseScreen.sliceText(r, 107, 109))) {
				tickRow = r;
				break;
			}
		}
		expect(tickRow).toBeGreaterThanOrEqual(0);
		await harness.mouseMove(107, tickRow);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await harness.pressKey("\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("⌘ Command Palette");

		getSessionWorkflow().planLines = ["1. Step one"];
		await harness.pressKey("\x1b[105;7u");
		await harness.pressKey("\x1b[112;7u");
		expect(harness.screen().text()).toContain("⌘ Command Palette");
		expect(harness.screen().text()).not.toContain("◐ Context Inspector");
		expect(harness.screen().text()).not.toContain("╭─ 📋 Plan Studio");

		await harness.pressKey("\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await openSlashWithoutWaiting(harness, "/context");
		expect(harness.screen().text()).toContain("Context Inspector");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
	});

	it("blocks ask_user_question with clear error over Modal Card, suppresses Modal Cards and Hover Popups over active questionnaire, and supports wheel/preview navigation", async () => {
		const sampleParams = {
			questions: [
				{
					header: "Storage",
					question: "Choose a storage backend",
					options: [
						{
							label: "SQLite",
							description: "Local embedded DB",
							preview: Array.from(
								{ length: 18 },
								(_, i) => `CREATE TABLE items_${i + 1} (id INT);`,
							).join("\n"),
						},
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

		let probeError: string | undefined;
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 110,
			height: 32,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_ev, ctx) => {
						ctx.ui.onTerminalInput((data) => {
							if (data === "\x1b[117;7u") {
								void runQuestionnaire(ctx, sampleParams).catch((err) => {
									probeError = err instanceof Error ? err.message : String(err);
								});
								return { consume: true };
							}
							return undefined;
						});
					});
				},
			],
			responses: [
				fauxAssistantMessage(
					Array.from({ length: 16 }, (_, i) => `Context row ${i + 1}`).join("\n"),
				),
				fauxAssistantMessage(
					[fauxToolCall("ask_user_question", JSON.parse(JSON.stringify(sampleParams)), { id: "ask-q1" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Questionnaire turn finished."),
			],
		});

		await openSlashWithoutWaiting(harness, "/context");
		expect(harness.screen().text()).toContain("Context Inspector");
		await harness.pressKey("\x1b[117;7u");
		expect(probeError).toBe("Close the existing dialog before opening a questionnaire.");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await harness.submitInput("Seed first turn");
		await harness.paste("chip-1\nchip-2\nchip-3\nchip-4", true);
		const askTurn = harness.submitInput("");
		await harness.flush();

		const qScreen = harness.screen();
		const qText = qScreen.text();
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(qText).toContain("☐ Storage");
		expect(qText).toContain("☐ Cache");
		expect(qText).toContain("✔ Submit");
		expect(qText).toContain("CREATE TABLE items_1");

		await harness.pressKey("\x1b[6~");
		expect(harness.screen().text()).toContain("CREATE TABLE items_18");

		await harness.mouseMove(107, 5);
		expect(harness.screen().text()).not.toContain("Ход 1");

		await harness.pressKey("\x0b");
		expect(harness.screen().text()).not.toContain("⌘ Command Palette");
		expect(harness.screen().text()).toContain("☐ Storage");

		await harness.pressKey("\x1b");
		await askTurn;

		const allMsgs = harness.session.messages;
		const askToolRes = allMsgs.find(
			(m): m is Extract<(typeof allMsgs)[number], { role: "toolResult" }> =>
				m.role === "toolResult" && m.toolCallId === "ask-q1",
		);
		expect(JSON.parse(contentText(askToolRes!.content)).cancelled).toBe(true);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await harness.pressKey("\x0b");
		expect(harness.screen().text()).toContain("⌘ Command Palette");
		await harness.pressKey("\x1b");
	});
});
