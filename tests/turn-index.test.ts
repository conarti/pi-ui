import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
		const stickyBand = [0, 1, 2].map((r) => midScreen.sliceText(r, 0, 119)).join("\n");

		expect(stickyBand).not.toContain("#4/5");
		expect(stickyBand).toContain("09:15");
		expect(stickyBand).not.toContain("\x07");
		expect(stickyBand).toContain("Inspect compacted");
		expect(stickyBand).toContain("turn four");

		const geo = getRailGeometry();
		expect(geo.windowEnd - geo.windowStart).toBe(5);

		const turn4TickRow = geo.ticksY + 3;
		await harness.mouseMove(117, turn4TickRow);

		const hoverScreen = harness.screen();
		const hoverText = hoverScreen.text();
		expect(hoverText).toContain("09:15");
		expect(hoverText).not.toContain("Реплика");
		expect(hoverText).toContain("Inspect compacted turn four");

		const prevScrollTop = scroll.scrollTop;
		await harness.mouseClick(117, turn4TickRow);
		expect(scroll.scrollTop).not.toBe(prevScrollTop);
		expect(scroll.isFollowingEnd).toBe(false);

		const jumpedScreen = harness.screen();
		expect(jumpedScreen.rowText(1)).toContain("Inspect compacted");
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
		expect(harness.screen().sliceText(1, 0, 119)).toContain("10:05");

		const geoAtTurn2 = getRailGeometry();
		const tick0Row = geoAtTurn2.ticksY;
		const tick1Row = geoAtTurn2.ticksY + 1;

		await harness.mouseClick(117, tick0Row);
		const turn1StartOffset = scroll.scrollTop;
		expect(scroll.isFollowingEnd).toBe(false);

		const cardPos = harness.screen().findText("› continue");
		expect(cardPos).toBeDefined();
		await harness.mouseMove(cardPos!.col + 3, cardPos!.row);
		expect(harness.screen().rowText(cardPos!.row - 1)).toContain("Copy");

		await harness.mouseClick(117, tick1Row);
		const turn2StartOffset = scroll.scrollTop;
		expect(turn2StartOffset).toBeGreaterThan(turn1StartOffset + 10);
		expect(scroll.isFollowingEnd).toBe(false);

		const chatRenderSpy = vi.spyOn(runtime.chatContainer!, "render");
		chatRenderSpy.mockClear();
		scroll.scrollTo(turn1StartOffset + 6, { disableFollow: true });
		expect(harness.screen().rowText(1)).toContain("10:00");
		expect(chatRenderSpy).toHaveBeenCalledTimes(1);
		chatRenderSpy.mockRestore();

		await harness.mouseClick(117, tick1Row);
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
		const stickyTop = [0, 1, 2].map((r) => harness!.screen().rowText(r)).join("\n");
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

		const geo = getRailGeometry();
		const tick0Row = geo.ticksY;
		const tick2Row = geo.ticksY + 2;
		const downArrowRow = geo.downY;

		await harness.mouseClick(117, tick0Row);
		const turn1Top = scroll.scrollTop;
		expect(scroll.isFollowingEnd).toBe(false);
		expect(turn1Top).toBeLessThan(maxScrollTop);

		await harness.mouseClick(117, downArrowRow);
		expect(scroll.scrollTop).toBeGreaterThan(turn1Top);
		expect(scroll.isFollowingEnd).toBe(false);

		await harness.mouseClick(117, downArrowRow);
		expect(scroll.scrollTop).toBe(maxScrollTop);
		expect(scroll.isFollowingEnd).toBe(true);

		await harness.submitInput("/sticky prev");
		expect(scroll.isFollowingEnd).toBe(false);

		await harness.mouseClick(117, tick2Row);
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
			await harness.mouseWheel("up", 40, 8, 3);

			const scroll = getActiveHostRuntime()!.scroll!;
			expect(scroll.scrollbar).toBe("auto");

			const geo = getRailGeometry();
			await harness.mouseMove(117, geo.ticksY);
			expect(harness.screen().text()).toContain("Alpha prompt");
			expect(harness.screen().text()).toContain("╭─");

			await harness.pressKey("\x0b");
			expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
			expect(harness.screen().text()).toContain("Command Palette");

			await harness.pressKey("\x1b");
			expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

			await harness.mouseMove(20, 6);
			const afterLeaveLines = Array.from({ length: scroll.viewportHeight }, (_, r) =>
				harness!.screen().sliceText(r, 40, 116),
			).join("\n");
			expect(afterLeaveLines).not.toContain("╭─");

			expect(harness.screen().rowText(1)).toContain("› ");
			await harness.submitInput("/sticky toggle");
			expect(harness.screen().rowText(1)).not.toContain("› Alpha prompt");
			expect(harness.screen().rowText(1)).not.toContain("› Beta prompt");

			await harness.submitInput("/sticky toggle");
			expect(harness.screen().rowText(1)).toContain("› ");

			const hasRail = () =>
				Array.from({ length: scroll.viewportHeight }, (_, r) =>
					harness!.screen().sliceText(r, 117, 119),
				).some((cell) => cell === " ▲" || cell === "──" || cell === " ─");

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
});
