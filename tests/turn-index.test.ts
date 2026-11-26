import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { getOutlineSettings } from "../src/features/outline-rail/index.ts";
import type { OutlineRailComponent } from "../src/features/outline-rail/rail-view.ts";
import { getStickyConfig } from "../src/features/sticky-prompt/index.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	makeAssistantEntry,
	makeUserEntry,
	type InteractiveHarness,
	type SessionEntry,
} from "./harness/index.ts";

function buildResponseText(prefix: string, lineCount: number): string {
	return Array.from({ length: lineCount }, (_, idx) => `${prefix} line ${idx + 1}`).join("\n");
}

function findFirstMountedUserCard(root: Component | undefined): UserMessageComponent | undefined {
	if (!root) return undefined;
	if (root instanceof UserMessageComponent) return root;
	if (root instanceof Container) {
		for (const child of root.children) {
			const found = findFirstMountedUserCard(child);
			if (found) return found;
		}
	}
	return undefined;
}

function getRailGeometry(): NonNullable<OutlineRailComponent["geometry"]> {
	const rail = getActiveHostRuntime()?.viewportSlots?.rightRail as OutlineRailComponent | undefined;
	if (!rail?.geometry) {
		throw new Error("Expected OutlineRail geometry to be computed in fullscreen viewport");
	}
	return rail.geometry;
}

describe("Transcript Turn Index (Sticky Prompt + Outline Rail in real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
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
	});

	it("reports identical Turn counts, sanitized titles, timestamps, and scroll offsets across Sticky Prompt and Outline Rail after compaction", async () => {
		const t1 = new Date(2026, 0, 15, 9, 0).getTime();
		const t2 = new Date(2026, 0, 15, 9, 5).getTime();
		const t3 = new Date(2026, 0, 15, 9, 10).getTime();
		const t4 = new Date(2026, 0, 15, 9, 15).getTime();
		const t5 = new Date(2026, 0, 15, 9, 20).getTime();

		const initialEntries: SessionEntry[] = [
			makeUserEntry("u1", null, "First compacted prompt", t1),
			makeAssistantEntry("a1", "u1", "Early reply 1", t1 + 1000),
			makeUserEntry("u2", "a1", "Second compacted prompt", t2),
			makeAssistantEntry("a2", "u2", "Early reply 2", t2 + 1000),
			makeUserEntry("u3", "a2", "Third compacted prompt", t3),
			makeAssistantEntry("a3", "u3", "Early reply 3", t3 + 1000),
			{
				type: "compaction",
				id: "cmp-1",
				parentId: "a3",
				timestamp: new Date(t3 + 2000).toISOString(),
				summary: "Compacted earlier turns\nSummary line 2\nSummary line 3",
				firstKeptEntryId: "u4",
				tokensBefore: 32000,
			},
			makeUserEntry("u4", "cmp-1", "Inspect \x1b[31mcompacted\x1b[0m   turn\x07 four", t4),
			makeAssistantEntry("a4", "u4", buildResponseText("resp4", 18), t4 + 1000),
			makeUserEntry("u5", "a4", "Final prompt five", t5),
			makeAssistantEntry("a5", "u5", buildResponseText("resp5", 18), t5 + 1000),
		];

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 120,
			height: 22,
			initialEntries,
		});

		const runtime = getActiveHostRuntime()!;
		const scroll = runtime.scroll!;

		await harness.mouseWheel("up", 40, 8, 8);
		const midScreen = harness.screen();
		const stickyBand = [3, 4, 5].map((r) => midScreen.sliceText(r, 0, 120)).join("\n");

		expect(stickyBand).not.toContain("#4/5");
		expect(stickyBand).toContain("09:15");
		expect(stickyBand).not.toContain("\x07");
		expect(stickyBand).toContain("Inspect compacted");
		expect(stickyBand).toContain("turn four");

		const headerRows = 3;
		const geo = getRailGeometry();
		expect(geo.windowEnd - geo.windowStart).toBe(5);

		const turn4TickRow = headerRows + geo.ticksY + 3;
		await harness.mouseMove(119, turn4TickRow);

		const hoverScreen = harness.screen();
		const hoverText = hoverScreen.text();
		expect(hoverText).not.toContain("Реплика");
		expect(hoverText).not.toContain("Turn #4");
		expect(hoverText).toContain("Inspect compacted turn four");

		const prevScrollTop = scroll.scrollTop;
		await harness.mouseClick(119, turn4TickRow);
		expect(scroll.scrollTop).not.toBe(prevScrollTop);
		expect(scroll.isFollowingEnd).toBe(false);

		const jumpedScreen = harness.screen();
		expect(jumpedScreen.rowText(4)).toContain("Inspect compacted");
	});

	it("computes structural Turn offsets without full-document ANSI matching and stays stable across hover, copy badge, OSC markers, and duplicate prompts", async () => {
		const t1 = new Date(2026, 0, 15, 10, 0).getTime();
		const t2 = new Date(2026, 0, 15, 10, 5).getTime();
		const t3 = new Date(2026, 0, 15, 10, 10).getTime();
		const initialEntries: SessionEntry[] = [
			makeUserEntry("u1", null, "continue", t1),
			makeAssistantEntry("a1", "u1", buildResponseText("resp1", 16), t1 + 1000),
			makeUserEntry("u2", "a1", "continue", t2),
			makeAssistantEntry("a2", "u2", buildResponseText("resp2", 18), t2 + 1000),
			makeUserEntry("u3", "a2", "summary check", t3),
			makeAssistantEntry("a3", "u3", buildResponseText("resp3", 16), t3 + 1000),
		];

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 120,
			height: 20,
			initialEntries,
		});

		const runtime = getActiveHostRuntime()!;
		const scroll = runtime.scroll!;
		await harness.mouseWheel("up", 40, 6, 9);
		expect(harness.screen().sliceText(4, 0, 120)).toContain("10:05");

		const headerRows = 3;
		const geoAtTurn2 = getRailGeometry();
		const tick0Row = headerRows + geoAtTurn2.ticksY;
		const tick1Row = headerRows + geoAtTurn2.ticksY + 1;

		await harness.mouseClick(119, tick0Row);
		const turn1StartOffset = scroll.scrollTop;
		expect(scroll.isFollowingEnd).toBe(false);

		const cardPos = harness.screen().findText("› continue");
		expect(cardPos).toBeDefined();
		await harness.mouseMove(cardPos!.col + 3, cardPos!.row);
		expect(harness.screen().rowText(cardPos!.row - 1).trim()).toBe("");
		expect(harness.screen().rowText(cardPos!.row)).toContain("Copy");

		await harness.mouseClick(119, tick1Row);
		const turn2StartOffset = scroll.scrollTop;
		expect(turn2StartOffset).toBeGreaterThan(turn1StartOffset + 10);
		expect(scroll.isFollowingEnd).toBe(false);

		const chatRenderSpy = vi.spyOn(runtime.chatContainer!, "render");
		chatRenderSpy.mockClear();
		scroll.scrollTo(turn1StartOffset + 6, { disableFollow: true });
		expect(harness.screen().rowText(4)).toContain("10:00");
		expect(chatRenderSpy).toHaveBeenCalledTimes(1);
		chatRenderSpy.mockRestore();

		await harness.mouseClick(119, tick1Row);
		await harness.submitInput("/sticky prev");
		expect(scroll.scrollTop).toBe(turn1StartOffset);
		expect(scroll.isFollowingEnd).toBe(false);
	});

	it("shares a single cached Turn coordinate calculation across Sticky Prompt and Outline Rail and invalidates only on branch, width, or contentHeight changes", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 120,
			height: 22,
			responses: [
				fauxAssistantMessage(buildResponseText("resp1", 16)),
				fauxAssistantMessage(buildResponseText("resp2", 16)),
				fauxAssistantMessage(buildResponseText("resp3", 24)),
			],
		});

		await harness.submitInput("First turn");
		await harness.submitInput("Second turn");
		await harness.mouseWheel("up", 30, 8, 5);

		const runtime = getActiveHostRuntime()!;
		const scroll = runtime.scroll!;
		const firstCard = findFirstMountedUserCard(scroll.children[0]);
		expect(firstCard).toBeDefined();

		const cardRenderSpy = vi.spyOn(firstCard!, "render");
		cardRenderSpy.mockClear();

		/* TuiAltScreen вызывает firstCard.render ровно 1 раз на кадр разметки, а Sticky Prompt и Outline Rail читают кэш без повторного обхода дерева */
		const baseScrollTop = scroll.scrollTop;
		for (let i = 1; i <= 5; i += 1) {
			scroll.scrollTo(baseScrollTop + (i % 2 === 0 ? 0 : 1), { disableFollow: true });
			harness.flushFrame();
		}
		expect(cardRenderSpy).toHaveBeenCalledTimes(5);

		await harness.resize(100, 22);
		cardRenderSpy.mockClear();
		scroll.scrollTo(baseScrollTop + 2, { disableFollow: true });
		harness.flushFrame();
		scroll.scrollTo(baseScrollTop + 1, { disableFollow: true });
		harness.flushFrame();
		expect(cardRenderSpy).toHaveBeenCalledTimes(2);

		scroll.scrollToEnd();
		await harness.submitInput("Third turn live");
		const stickyTop = [3, 4, 5].map((r) => harness!.screen().rowText(r)).join("\n");
		expect(stickyTop).toContain("Third turn live");
	});

	it("disables follow-end when jumping to an earlier Turn and restores follow-end when navigating forward to the final Turn via Sticky Prompt or Outline Rail", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 120,
			height: 20,
			responses: [
				fauxAssistantMessage(buildResponseText("resp1", 16)),
				fauxAssistantMessage(buildResponseText("resp2", 16)),
				fauxAssistantMessage(buildResponseText("resp3", 16)),
			],
		});

		await harness.submitInput("Turn one");
		await harness.submitInput("Turn two");
		await harness.submitInput("Turn three");

		const scroll = getActiveHostRuntime()!.scroll!;
		const maxScrollTop = scroll.scrollTop;
		expect(scroll.isFollowingEnd).toBe(true);
		expect(maxScrollTop).toBeGreaterThan(20);

		const headerRows = 3;
		const geo = getRailGeometry();
		const tick0Row = headerRows + geo.ticksY;
		const tick2Row = headerRows + geo.ticksY + 2;
		const downArrowRow = headerRows + geo.downY;

		await harness.mouseClick(119, tick0Row);
		const turn1Top = scroll.scrollTop;
		expect(scroll.isFollowingEnd).toBe(false);
		expect(turn1Top).toBeLessThan(maxScrollTop);

		await harness.mouseClick(119, downArrowRow);
		expect(scroll.scrollTop).toBeGreaterThan(turn1Top);
		expect(scroll.isFollowingEnd).toBe(false);

		await harness.mouseClick(119, downArrowRow);
		expect(scroll.scrollTop).toBe(maxScrollTop);
		expect(scroll.isFollowingEnd).toBe(true);

		await harness.submitInput("/sticky prev");
		expect(scroll.isFollowingEnd).toBe(false);

		await harness.mouseClick(119, tick2Row);
		expect(scroll.scrollTop).toBe(maxScrollTop);
		expect(scroll.isFollowingEnd).toBe(true);

		await harness.submitInput("/sticky prev");
		expect(scroll.isFollowingEnd).toBe(false);

		await harness.submitInput("/sticky next");
		expect(scroll.scrollTop).toBe(maxScrollTop);
		expect(scroll.isFollowingEnd).toBe(true);
	});

	it("toggles /sticky and /outline in memory without writing files to disk while preserving Hover Popup and ScrollView scrollbar invariants", async () => {
		const tempCwd = mkdtempSync(join(tmpdir(), "pi-ui-turn-index-cwd-"));
		try {
			harness = await createInteractiveHarness({
				theme: "dark",
				width: 120,
				height: 22,
				cwd: tempCwd,
				persistSession: false,
				persistSettings: false,
				responses: [
					fauxAssistantMessage(buildResponseText("resp1", 16)),
					fauxAssistantMessage(buildResponseText("resp2", 16)),
				],
			});

			await harness.submitInput("Alpha prompt");
			await harness.submitInput("Beta prompt");
			await harness.mouseWheel("up", 40, 8, 5);

			const scroll = getActiveHostRuntime()!.scroll!;
			expect(scroll.scrollbar).toBe("hidden");

			const headerRows = 3;
			const geo = getRailGeometry();
			await harness.mouseMove(119, headerRows + geo.ticksY);
			expect(harness.screen().text()).toContain("Alpha prompt");
			expect(harness.screen().text()).toContain("╭─");

			await harness.pressKey("\x0b");
			expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
			expect(harness.screen().text()).toContain("Command Palette");

			await harness.pressKey("\x1b");
			expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

			await harness.mouseMove(20, 6);
			const afterLeaveLines = Array.from({ length: scroll.viewportHeight }, (_, r) =>
				harness!.screen().sliceText(headerRows + r, 40, 118),
			).join("\n");
			expect(afterLeaveLines).not.toContain("╭─");

			expect(harness.screen().rowText(4)).toContain("› ");
			await harness.submitInput("/sticky toggle");
			expect(harness.screen().rowText(4)).not.toContain("› Alpha prompt");
			expect(harness.screen().rowText(4)).not.toContain("› Beta prompt");

			await harness.submitInput("/sticky toggle");
			expect(harness.screen().rowText(4)).toContain("› ");

			const hasRail = () =>
				Array.from({ length: scroll.viewportHeight }, (_, r) =>
					harness!.screen().sliceText(headerRows + r, 118, 120),
				).some((cell) => cell === " ▲" || cell === "━━" || cell === " ─");

			expect(hasRail()).toBe(true);
			await harness.submitInput("/outline");
			expect(hasRail()).toBe(false);
			await harness.submitInput("/outline");
			expect(hasRail()).toBe(true);

			expect(readdirSync(tempCwd)).toEqual([]);
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});

	it("never hides the lower prompt under Sticky Prompt when earlier turns contain grouped tool calls", async () => {
		const tempCwd = mkdtempSync(join(tmpdir(), "pi-ui-sticky-grouped-"));
		try {
			writeFileSync(join(tempCwd, "a.txt"), "alpha\n", "utf8");
			writeFileSync(join(tempCwd, "b.txt"), "beta\n", "utf8");
			writeFileSync(join(tempCwd, "c.txt"), "gamma\n", "utf8");

			harness = await createInteractiveHarness({
				theme: "dark",
				width: 110,
				height: 36,
				cwd: tempCwd,
				responses: [
					fauxAssistantMessage(
						[fauxThinking("Inspecting files"), fauxToolCall("read", { path: "a.txt", toolSummary: "Read a" })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(
						[fauxThinking("Inspecting b"), fauxToolCall("read", { path: "b.txt", toolSummary: "Read b" })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(
						[fauxThinking("Inspecting c"), fauxToolCall("read", { path: "c.txt", toolSummary: "Read c" })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage([fauxText("Finished reading all three files.")]),
					fauxAssistantMessage([fauxText(buildResponseText("second-reply", 28))]),
				],
			});

			await harness.submitInput("Upper prompt alpha\nsecond line of upper prompt");
			await harness.submitInput("Lower prompt beta");

			const scroll = getActiveHostRuntime()!.scroll!;
			const contentHeight = (scroll as unknown as { contentHeight?: number }).contentHeight ?? 0;

			/* Находим реальную строку Lower prompt beta при scrollTop = 0 */
			scroll.scrollTo(0, { disableFollow: true });
			harness.flushFrame();
			const atZero = harness.screen();
			const lowerAtZero = atZero.findText("Lower prompt beta");
			expect(lowerAtZero).toBeDefined();
			const realLowerDocRow = lowerAtZero!.row - 3;

			const assertLowerPromptVisibleAcrossHandoff = (lowerRow: number, totalHeight: number) => {
				for (
					let top = Math.max(1, lowerRow - 5);
					top <= Math.min(Math.max(1, totalHeight - scroll.viewportHeight), lowerRow + 3);
					top += 1
				) {
					scroll.scrollTo(top, { disableFollow: true });
					harness!.flushFrame();
					expect(harness!.screen().text()).toContain("Lower prompt beta");
				}
			};

			/* В свёрнутом состоянии группы инструментов нижний промпт ни на одном шаге не перекрывается верхним Sticky Prompt */
			assertLowerPromptVisibleAcrossHandoff(realLowerDocRow, contentHeight);

			/* Раскрываем свёрнутую группу инструментов кликом и убеждаемся, что кэш координат обновился и нижний промпт по-прежнему не пропадает */
			scroll.scrollTo(0, { disableFollow: true });
			harness.flushFrame();
			const groupHit =
				harness.screen().findText("Explored") ??
				harness.screen().findText("3 files");
			expect(groupHit).toBeDefined();
			await harness.mouseClick(groupHit!.col + 2, groupHit!.row);

			const expandedHeight = (scroll as unknown as { contentHeight?: number }).contentHeight ?? 0;
			expect(expandedHeight).toBeGreaterThan(contentHeight);
			const lowerExpanded = harness.screen().findText("Lower prompt beta");
			expect(lowerExpanded).toBeDefined();
			assertLowerPromptVisibleAcrossHandoff(lowerExpanded!.row - 3, expandedHeight);
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});

	it("preserves referential string[] and Component identity across consecutive animation frames without re-hydrating session entries (ADR-0008)", async () => {
		const tempCwd = mkdtempSync(join(tmpdir(), "pi-ui-adr0008-cache-"));
		try {
			writeFileSync(join(tempCwd, "one.txt"), "one\n", "utf8");
			writeFileSync(join(tempCwd, "two.txt"), "two\n", "utf8");

			let tick = 0;
			harness = await createInteractiveHarness({
				theme: "dark",
				width: 110,
				height: 36,
				cwd: tempCwd,
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_ev, ctx) => {
							ctx.ui.setWidget("live-progress", () => ({
								render: () => [`◆ 1/3 steps · frame ${tick}`],
								invalidate() {},
							}));
						});
					},
				],
				responses: [
					fauxAssistantMessage(
						[fauxThinking("Reading file one"), fauxToolCall("read", { path: "one.txt", toolSummary: "Read one" })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(
						[fauxThinking("Reading file two"), fauxToolCall("read", { path: "two.txt", toolSummary: "Read two" })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage([fauxThinking("Synthesizing answer"), fauxText("```ts\nexport const ok = true;\n```\n\nAll files inspected.")]),
					fauxAssistantMessage([fauxText("Follow-up answer with metrics row.")]),
				],
			});

			await harness.submitInput("First prompt with grouped exploration");
			await harness.submitInput("Second plain prompt");
			harness.flushFrame(true);

			const modeAny = harness.mode as unknown as {
				chatContainer: Container;
				ui: { requestRender: () => void };
				renderer?: { doRender: () => void };
			};
			const chat = modeAny.chatContainer;
			const renderer = modeAny.renderer!;

			/* Прогревочный кадр заполняет референциальные кэши карточек и групп */
			tick += 1;
			modeAny.ui.requestRender();
			renderer.doRender();

			const baselineLayout = (chat as unknown as { childLines?: { lines: string[]; children: Component[] } }).childLines;
			expect(baselineLayout).toBeDefined();
			const baselineLines = baselineLayout!.lines;

			const getEntriesSpy = vi.spyOn(harness.session.sessionManager, "getEntries");
			const getBranchSpy = vi.spyOn(harness.session.sessionManager, "getBranch");

			for (let frame = 0; frame < 10; frame += 1) {
				tick += 1;
				modeAny.ui.requestRender();
				renderer.doRender();
				const nextLayout = (chat as unknown as { childLines?: { lines: string[]; children: Component[] } }).childLines;
				expect(nextLayout).toBe(baselineLayout);
				expect(nextLayout?.lines).toBe(baselineLines);
			}

			/* Ни один завершённый промпт или чип не клонирует getEntries() повторно на кадрах анимации */
			expect(getEntriesSpy).toHaveBeenCalledTimes(0);
			/* getBranch() читается не более одного раза за проход рендера (TurnIndex), а не в каждой карточке метрик */
			expect(getBranchSpy.mock.calls.length).toBeLessThanOrEqual(10);

			getEntriesSpy.mockRestore();
			getBranchSpy.mockRestore();
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});
});
