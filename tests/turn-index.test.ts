import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	Container,
	HStack,
	Text,
	VStack,
	stripTerminalSequences,
	type Component,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import { getOutlineSettings } from "../src/features/outline-rail/index.ts";
import { getStickyConfig } from "../src/features/sticky-prompt/index.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

interface ViewportComponents {
	stickyBar: Component & { handleMouse?: (event: TuiMouseEvent) => unknown };
	outlineRail: Component & { handleMouse?: (event: TuiMouseEvent) => unknown };
}

function getViewportComponents(harness: ExtensionHarness): ViewportComponents {
	const rootEntries =
		(harness.tui.layoutRoot as unknown as { entries?: Array<{ component: Component }> }).entries ?? [];
	const stickyBar = rootEntries[0]?.component as ViewportComponents["stickyBar"] | undefined;
	const hstack = rootEntries.find((e) => e.component instanceof HStack)?.component as
		| { entries?: Array<{ component: Component }> }
		| undefined;
	const outlineRail = hstack?.entries?.[1]?.component as ViewportComponents["outlineRail"] | undefined;
	if (!stickyBar || !outlineRail) {
		throw new Error("Expected StickyPromptBar and OutlineRail to be mounted in fullscreen layout");
	}
	return { stickyBar, outlineRail };
}

function createMultilineBlock(prefix: string, lineCount: number): Component {
	const lines = Array.from({ length: lineCount }, (_, i) => `${prefix} line ${i + 1}`);
	return new Text(lines.join("\n"), 0, 0);
}

function makeUserEntry(id: string, content: string, timestamp: number) {
	return {
		type: "message",
		id,
		message: {
			role: "user",
			content,
			timestamp,
		},
	};
}

function syncTranscriptLayout(harness: ExtensionHarness, viewportHeight = 12, contentWidth = 118): number {
	const totalLines = harness.tui.chatContainer.render(contentWidth).length;
	harness.tui.scroll.updateLayout(totalLines, viewportHeight, () => harness.tui.requestRender());
	return totalLines;
}

describe("Transcript Turn Index (Sticky Prompt + Outline Rail)", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		const stickyCfg = getStickyConfig();
		stickyCfg.enabled = true;
		stickyCfg.showTimestamp = true;
		stickyCfg.showNavigation = true;
		stickyCfg.mode = "auto";
		getOutlineSettings().enabled = true;

		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("reports identical Turn counts, ordinals, sanitized titles, timestamps, and scroll offsets across Sticky Prompt and Outline Rail after compaction", async () => {
		const t1 = new Date(2026, 0, 15, 9, 0).getTime();
		const t2 = new Date(2026, 0, 15, 9, 5).getTime();
		const t3 = new Date(2026, 0, 15, 9, 10).getTime();
		const t4 = new Date(2026, 0, 15, 9, 15).getTime();
		const t5 = new Date(2026, 0, 15, 9, 20).getTime();

		const branch = [
			makeUserEntry("u1", "First compacted prompt", t1),
			makeUserEntry("u2", "Second compacted prompt", t2),
			makeUserEntry("u3", "Third compacted prompt", t3),
			{ type: "compaction", id: "cmp-1", summary: "Compacted earlier turns" },
			makeUserEntry("u4", "Inspect \x1b[31mcompacted\x1b[0m   turn\x07 four", t4),
			makeUserEntry("u5", "Final prompt five", t5),
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 120,
			height: 32,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		// Transcript after compaction: 4-line compaction summary + only Turns 4 and 5 mounted
		const compactionSummary = createMultilineBlock("summary", 4);
		const turn4Card = new UserMessageComponent("Inspect \x1b[31mcompacted\x1b[0m   turn\x07 four");
		const response4 = createMultilineBlock("resp4", 18);
		const turn5Card = new UserMessageComponent("Final prompt five");
		const response5 = createMultilineBlock("resp5", 18);

		harness.tui.chatContainer.addChild(compactionSummary);
		harness.tui.chatContainer.addChild(turn4Card);
		harness.tui.chatContainer.addChild(response4);
		harness.tui.chatContainer.addChild(turn5Card);
		harness.tui.chatContainer.addChild(response5);

		syncTranscriptLayout(harness, 12, 118);

		const { stickyBar, outlineRail } = getViewportComponents(harness);

		// Scroll past Turn 4 card (starts at row 4, 1 line tall -> row 8 is inside response 4)
		harness.tui.scroll.scrollTo(8, { disableFollow: true });

		const stickyLines = stickyBar.render(120).map(stripTerminalSequences);
		const stickyText = stickyLines.join("\n");

		// Sticky Prompt must align with compacted branch: #4/5, sanitized title, and Turn 4 timestamp 09:15
		expect(stickyText).toContain("#4/5");
		expect(stickyText).toContain("09:15");
		expect(stickyText).toContain("Inspect compacted turn four");

		// Outline Rail renders and hovering Turn 4 tick shows identical ordinal/count and sanitized title
		const railLines = outlineRail.render(2);
		expect(railLines.length).toBe(12);

		// With 5 turns in height 12: totalRows = 5 + 2 = 7, top = floor((12 - 7)/2) = 2, ticksY = 3
		// Turn index 3 (ordinal 4) is at y = 3 + 3 = 6
		outlineRail.handleMouse?.({
			type: "move",
			button: "none",
			x: 0,
			y: 6,
			screenX: 118,
			screenY: 6,
			width: 2,
			height: 12,
		} as TuiMouseEvent);

		const popupOverlay = harness.tui.overlayStack.find((o) => o.options?.nonCapturing);
		expect(popupOverlay).toBeDefined();
		const popupText = popupOverlay!.component
			.render(Number(popupOverlay!.options?.width ?? 40))
			.map(stripTerminalSequences)
			.join("\n");

		expect(popupText).toContain("Реплика 4 из 5");
		expect(popupText).toContain("Inspect compacted turn four");

		// Clicking Turn 4 tick jumps to Turn 4's exact structural row offset (row 4)
		outlineRail.handleMouse?.({
			type: "click",
			button: "left",
			x: 0,
			y: 6,
			screenX: 118,
			screenY: 6,
			width: 2,
			height: 12,
		} as TuiMouseEvent);

		expect(harness.tui.scroll.scrollTop).toBe(4);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);
	});

	it("computes structural Turn offsets without full-document ANSI matching and stays stable across hover, copy badge, OSC markers, and duplicate prompts", async () => {
		const t1 = new Date(2026, 0, 15, 10, 0).getTime();
		const t2 = new Date(2026, 0, 15, 10, 5).getTime();
		const branch = [
			makeUserEntry("u1", "continue", t1),
			makeUserEntry("u2", "continue", t2),
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 120,
			height: 32,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		// Nested Container hierarchy: [2-line header, innerGroup([turn1, resp1, turn2, resp2])]
		const header = createMultilineBlock("session-header", 2);
		const innerGroup = new Container();
		const turn1Card = new UserMessageComponent("continue");
		const resp1 = createMultilineBlock("resp1", 12);
		const turn2Card = new UserMessageComponent("continue");
		const resp2 = createMultilineBlock("resp2", 18);

		innerGroup.addChild(turn1Card);
		innerGroup.addChild(resp1);
		innerGroup.addChild(turn2Card);
		innerGroup.addChild(resp2);

		harness.tui.chatContainer.addChild(header);
		harness.tui.chatContainer.addChild(innerGroup);

		// Confirm user prompt card renders OSC 133 zone markers
		const initialCardLines = turn1Card.render(118);
		expect(initialCardLines[0]).toContain("\x1b]133;A\x07");

		syncTranscriptLayout(harness, 12, 118);

		const { stickyBar, outlineRail } = getViewportComponents(harness);
		const docRenderSpy = vi.spyOn(harness.tui.chatContainer, "render");

		// Scroll into response 2 so Sticky Prompt shows #2/2
		harness.tui.scroll.scrollTo(18, { disableFollow: true });
		expect(stripTerminalSequences(stickyBar.render(120).join("\n"))).toContain("#2/2");
		outlineRail.render(2);

		// Structural walk must NEVER call doc.render() for ANSI string matching
		expect(docRenderSpy).not.toHaveBeenCalled();

		// Hover turn1Card -> changes background RGB and adds " Copy " badge
		(turn1Card as unknown as { handleMouse?: (e: TuiMouseEvent) => unknown }).handleMouse?.({
			type: "move",
			button: "none",
			x: 4,
			y: 0,
			screenX: 4,
			screenY: 2,
			width: 118,
			height: 1,
		} as TuiMouseEvent);
		const hoveredCardLine = stripTerminalSequences(turn1Card.render(118).join("\n"));
		expect(hoveredCardLine).toContain("Copy");

		// Force a fresh coordinate computation while hovered (simulate session_tree invalidation)
		await harness.emit("session_tree", {});
		outlineRail.render(2);

		// With 2 turns and refHeight=12: stable uses height 11 -> top = floor((11 - 4)/2) = 3, ticksY = 4
		// Tick 1 (Turn 2, duplicate text "continue") is at y = 5 -> row 2 + 1 + 12 = 15 (moving up from row 18)
		outlineRail.handleMouse?.({
			type: "click",
			button: "left",
			x: 0,
			y: 5,
			screenX: 118,
			screenY: 5,
			width: 2,
			height: 12,
		} as TuiMouseEvent);
		expect(harness.tui.scroll.scrollTop).toBe(15);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		// Tick 0 (Turn 1) is at y = 4 -> must jump to row 2 (after 2-line header)
		outlineRail.handleMouse?.({
			type: "click",
			button: "left",
			x: 0,
			y: 4,
			screenX: 118,
			screenY: 4,
			width: 2,
			height: 12,
		} as TuiMouseEvent);
		expect(harness.tui.scroll.scrollTop).toBe(2);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		// Verify Sticky Prompt navigating prev from row 18 lands cleanly on Turn 1 (row 2)
		harness.tui.scroll.scrollTo(18, { disableFollow: true });
		expect(stripTerminalSequences(stickyBar.render(120).join("\n"))).toContain("#2/2");
		await harness.runCommand("sticky", "prev");
		expect(harness.tui.scroll.scrollTop).toBe(2);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		// Structural walk still never called doc.render()
		expect(docRenderSpy).not.toHaveBeenCalled();
	});

	it("shares a single cached Turn coordinate calculation across Sticky Prompt and Outline Rail and invalidates only on branch, width, or contentHeight changes", async () => {
		const t1 = new Date(2026, 0, 15, 11, 0).getTime();
		const t2 = new Date(2026, 0, 15, 11, 5).getTime();
		const branch = [makeUserEntry("u1", "First turn", t1), makeUserEntry("u2", "Second turn", t2)];

		harness = createExtensionHarness({
			theme: "dark",
			width: 120,
			height: 32,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		const turn1Card = new UserMessageComponent("First turn");
		const resp1 = createMultilineBlock("resp1", 15);
		const turn2Card = new UserMessageComponent("Second turn");
		const resp2 = createMultilineBlock("resp2", 15);

		harness.tui.chatContainer.addChild(turn1Card);
		harness.tui.chatContainer.addChild(resp1);
		harness.tui.chatContainer.addChild(turn2Card);
		harness.tui.chatContainer.addChild(resp2);

		const initialHeight = syncTranscriptLayout(harness, 12, 118);
		const { stickyBar, outlineRail } = getViewportComponents(harness);

		const turn1RenderSpy = vi.spyOn(turn1Card, "render");
		const resp1RenderSpy = vi.spyOn(resp1, "render");

		// Cold cache: StickyPromptBar renders once -> populates shared cache
		stickyBar.render(120);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(1);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(1);

		// OutlineRail in the same frame hits the shared cache (0 additional child renders)
		outlineRail.render(2);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(1);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(1);

		// Simulate 5 streaming animation ticks with unchanged branch, width, and contentHeight
		for (let tick = 0; tick < 5; tick++) {
			stickyBar.render(120);
			outlineRail.render(2);
		}
		expect(turn1RenderSpy).toHaveBeenCalledTimes(1);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(1);

		// 1. Invalidate on contentHeight change (streaming appends lines)
		harness.tui.scroll.updateLayout(initialHeight + 4, 12, () => harness!.tui.requestRender());
		stickyBar.render(120);
		outlineRail.render(2);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(2);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(2);

		// 2. Invalidate on contentWidth change (terminal resize)
		harness.tui.terminal.columns = 100;
		stickyBar.render(100);
		outlineRail.render(2);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(3);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(3);

		// 3. Invalidate on branch change (new Turn appended)
		const t3 = new Date(2026, 0, 15, 11, 10).getTime();
		const nextBranch = [...branch, makeUserEntry("u3", "Third turn", t3)];
		harness.setEntries(nextBranch, nextBranch);
		harness.tui.chatContainer.addChild(new UserMessageComponent("Third turn"));
		stickyBar.render(100);
		outlineRail.render(2);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(4);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(4);
	});

	it("disables follow-end when jumping to an earlier Turn and restores follow-end when navigating forward to the final Turn via Sticky Prompt or Outline Rail", async () => {
		const t1 = new Date(2026, 0, 15, 12, 0).getTime();
		const t2 = new Date(2026, 0, 15, 12, 5).getTime();
		const t3 = new Date(2026, 0, 15, 12, 10).getTime();
		const branch = [
			makeUserEntry("u1", "Turn one", t1),
			makeUserEntry("u2", "Turn two", t2),
			makeUserEntry("u3", "Turn three", t3),
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 120,
			height: 32,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		// Turn 1 at row 0 (1 line), resp1 (15 lines), Turn 2 at row 16 (1 line), resp2 (15 lines), Turn 3 at row 32 (1 line), resp3 (15 lines)
		harness.tui.chatContainer.addChild(new UserMessageComponent("Turn one"));
		harness.tui.chatContainer.addChild(createMultilineBlock("resp1", 15));
		harness.tui.chatContainer.addChild(new UserMessageComponent("Turn two"));
		harness.tui.chatContainer.addChild(createMultilineBlock("resp2", 15));
		harness.tui.chatContainer.addChild(new UserMessageComponent("Turn three"));
		harness.tui.chatContainer.addChild(createMultilineBlock("resp3", 15));

		const totalHeight = syncTranscriptLayout(harness, 12, 118);
		const maxScrollTop = totalHeight - 12;
		expect(harness.tui.scroll.isFollowingEnd).toBe(true);
		expect(harness.tui.scroll.scrollTop).toBe(maxScrollTop);

		const { stickyBar, outlineRail } = getViewportComponents(harness);
		outlineRail.render(2);

		// With 3 turns and refHeight=12: stable uses height 11 -> totalRows=5, top=floor((11-5)/2)=3
		// upY = 3, tick0 (Turn 1) = 4, tick1 (Turn 2) = 5, tick2 (Turn 3) = 6, downY = 7
		const clickRail = (y: number) =>
			outlineRail.handleMouse?.({
				type: "click",
				button: "left",
				x: 0,
				y,
				screenX: 118,
				screenY: y,
				width: 2,
				height: 12,
			} as TuiMouseEvent);

		// 1. Click Turn 1 tick -> disables follow-end at row 0
		clickRail(4);
		expect(harness.tui.scroll.scrollTop).toBe(0);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		// 2. Click down-arrow -> moves to Turn 2 (row 16), follow-end remains disabled
		outlineRail.render(2);
		clickRail(7);
		expect(harness.tui.scroll.scrollTop).toBe(16);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		// 3. Click down-arrow again -> moves forward to final Turn 3, restores follow-end at bottom
		outlineRail.render(2);
		clickRail(7);
		expect(harness.tui.scroll.scrollTop).toBe(maxScrollTop);
		expect(harness.tui.scroll.isFollowingEnd).toBe(true);

		// 4. Navigate back to Turn 2 via Sticky Prompt -> disables follow-end at row 16
		stickyBar.render(120);
		await harness.runCommand("sticky", "prev");
		expect(harness.tui.scroll.scrollTop).toBe(16);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		// 5. Click final Turn 3 tick on Outline Rail from Turn 2 -> restores follow-end at bottom
		outlineRail.render(2);
		clickRail(6);
		expect(harness.tui.scroll.scrollTop).toBe(maxScrollTop);
		expect(harness.tui.scroll.isFollowingEnd).toBe(true);

		// 6. Navigate back to Turn 2 then forward to final Turn 3 via Sticky Prompt -> restores follow-end at bottom
		stickyBar.render(120);
		await harness.runCommand("sticky", "prev");
		expect(harness.tui.scroll.scrollTop).toBe(16);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		// Scroll 1 line into Turn 2's response so Sticky Prompt pins Turn 2 in auto mode
		harness.tui.scroll.scrollTo(17, { disableFollow: true });
		stickyBar.render(120);
		await harness.runCommand("sticky", "next");
		expect(harness.tui.scroll.scrollTop).toBe(maxScrollTop);
		expect(harness.tui.scroll.isFollowingEnd).toBe(true);
	});

	it("toggles /sticky and /outline in memory without writing files to disk while preserving Hover Popup and ScrollView scrollbar invariants", async () => {
		const tempCwd = mkdtempSync(join(tmpdir(), "pi-ui-ticket7-"));
		try {
			const t1 = new Date(2026, 0, 15, 13, 0).getTime();
			const t2 = new Date(2026, 0, 15, 13, 5).getTime();
			const branch = [makeUserEntry("u1", "Alpha prompt", t1), makeUserEntry("u2", "Beta prompt", t2)];

			harness = createExtensionHarness({
				theme: "dark",
				width: 120,
				height: 32,
				cwd: tempCwd,
				entries: branch,
				branch,
			});
			harness.mount(conartiPiUi);
			await harness.startSession();

			harness.tui.chatContainer.addChild(new UserMessageComponent("Alpha prompt"));
			harness.tui.chatContainer.addChild(createMultilineBlock("resp1", 15));
			harness.tui.chatContainer.addChild(new UserMessageComponent("Beta prompt"));
			harness.tui.chatContainer.addChild(createMultilineBlock("resp2", 15));

			syncTranscriptLayout(harness, 12, 118);

			const { stickyBar, outlineRail } = getViewportComponents(harness);

			// ScrollView native scrollbar remains active ("auto")
			expect(harness.tui.scroll.scrollbar).toBe("auto");

			// Initially both Sticky Prompt and Outline Rail render
			expect(stickyBar.render(120).length).toBeGreaterThan(0);
			expect(outlineRail.render(2).length).toBe(12);

			// Hover Popup is lazily mounted only while hovered, with nonCapturing: true
			expect(harness.tui.overlayStack.some((o) => o.options?.nonCapturing)).toBe(false);
			outlineRail.handleMouse?.({
				type: "move",
				button: "none",
				x: 0,
				y: 4,
				screenX: 118,
				screenY: 4,
				width: 2,
				height: 12,
			} as TuiMouseEvent);
			const hoverEntry = harness.tui.overlayStack.find((o) => o.options?.nonCapturing);
			expect(hoverEntry).toBeDefined();
			expect(harness.tui.isOverlayVisible(hoverEntry!)).toBe(true);

			// Topmost blocking modal hides Hover Popup via getTopmostVisibleOverlay() guard
			const modalHandle = harness.tui.showOverlay({ render: () => ["modal"], invalidate() {} }, {});
			expect(harness.tui.getTopmostVisibleOverlay()).toBeDefined();
			expect(harness.tui.isOverlayVisible(hoverEntry!)).toBe(false);
			modalHandle.hide();
			expect(harness.tui.isOverlayVisible(hoverEntry!)).toBe(true);

			// Moving off ticks removes Hover Popup via handle.hide()
			outlineRail.handleMouse?.({
				type: "move",
				button: "none",
				x: 0,
				y: 0,
				screenX: 118,
				screenY: 0,
				width: 2,
				height: 12,
			} as TuiMouseEvent);
			expect(harness.tui.overlayStack.some((o) => o.options?.nonCapturing)).toBe(false);

			// Toggle /sticky off -> hides Sticky Prompt in memory
			await harness.runCommand("sticky", "toggle");
			expect(stickyBar.render(120)).toEqual([]);
			await harness.runCommand("sticky", "toggle");
			expect(stickyBar.render(120).length).toBeGreaterThan(0);

			// Toggle /outline off -> hides Outline Rail in memory
			await harness.runCommand("outline");
			expect(outlineRail.render(2)).toEqual([]);
			await harness.runCommand("outline");
			expect(outlineRail.render(2).length).toBe(12);

			// Neither /sticky nor /outline writes any files to disk
			expect(readdirSync(tempCwd)).toEqual([]);
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});
});
