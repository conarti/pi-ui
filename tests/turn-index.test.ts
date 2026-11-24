import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Text,
	stripTerminalSequences,
	type Component,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import { getOutlineSettings } from "../src/features/outline-rail/index.ts";
import { getStickyConfig } from "../src/features/sticky-prompt/index.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

interface ViewportComponents {
	stickyBar: Component & { handleMouse?: (event: TuiMouseEvent) => unknown };
	outlineRail: Component & { handleMouse?: (event: TuiMouseEvent) => unknown };
}

function getViewportComponents(_harness: ExtensionHarness): ViewportComponents {
	const slots = getActiveHostRuntime()?.viewportSlots;
	const stickyBar = slots?.topSlot as ViewportComponents["stickyBar"] | undefined;
	const outlineRail = slots?.rightRail as ViewportComponents["outlineRail"] | undefined;
	if (!stickyBar || !outlineRail) {
		throw new Error("Expected StickyPromptBar and OutlineRail to be mounted in fullscreen viewport slots");
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

function syncTranscriptLayout(harness: ExtensionHarness, viewportHeight = 12, contentWidth = 117): number {
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
		stickyCfg.showNavigation = false;
		stickyCfg.mode = "auto";
		getOutlineSettings().enabled = true;

		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("reports identical Turn counts, sanitized titles, timestamps, and scroll offsets across Sticky Prompt and Outline Rail after compaction", async () => {
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

		syncTranscriptLayout(harness, 12, 117);

		const { stickyBar, outlineRail } = getViewportComponents(harness);

		harness.tui.scroll.scrollTo(8, { disableFollow: true });

		const stickyLines = stickyBar.render(117).map(stripTerminalSequences);
		const stickyText = stickyLines.join("\n");

		expect(stickyText).not.toContain("#4/5");
		expect(stickyText).toContain("09:15");
		expect(stickyText).toContain("Inspect compacted");
		expect(stickyText).toContain("turn four");

		const railLines = outlineRail.render(2);
		expect(railLines.length).toBe(12);

		outlineRail.handleMouse?.({
			type: "move",
			button: "none",
			x: 0,
			y: 6,
			screenX: 117,
			screenY: 6,
			width: 2,
			height: 12,
		} as TuiMouseEvent);

		const popupOverlay = harness.tui.overlayStack.find((o) => o.options?.nonCapturing);
		expect(popupOverlay).toBeDefined();
		const popupLines = popupOverlay!.component
			.render(Number(popupOverlay!.options?.width ?? 40))
			.map(stripTerminalSequences);
		const popupText = popupLines.join("\n");

		expect(popupLines[0]?.trim()).toBe("09:15");
		expect(popupText).not.toContain("Реплика");
		expect(popupText).toContain("Inspect compacted turn four");

		outlineRail.handleMouse?.({
			type: "click",
			button: "left",
			x: 0,
			y: 6,
			screenX: 117,
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

		const initialCardLines = turn1Card.render(117);
		expect(initialCardLines[0]).toContain("\x1b]133;A\x07");

		syncTranscriptLayout(harness, 12, 117);

		const { stickyBar, outlineRail } = getViewportComponents(harness);
		const docRenderSpy = vi.spyOn(harness.tui.chatContainer, "render");

		harness.tui.scroll.scrollTo(20, { disableFollow: true });
		expect(stripTerminalSequences(stickyBar.render(117).join("\n"))).toContain("10:05");
		outlineRail.render(2);

		expect(docRenderSpy).not.toHaveBeenCalled();

		(turn1Card as unknown as { handleMouse?: (e: TuiMouseEvent) => unknown }).handleMouse?.({
			type: "move",
			button: "none",
			x: 4,
			y: 0,
			screenX: 4,
			screenY: 2,
			width: 117,
			height: 3,
		} as TuiMouseEvent);
		const hoveredCardLine = stripTerminalSequences(turn1Card.render(117).join("\n"));
		expect(hoveredCardLine).toContain("Copy");

		await harness.emit("session_tree", {});
		outlineRail.render(2);

		outlineRail.handleMouse?.({
			type: "click",
			button: "left",
			x: 0,
			y: 6,
			screenX: 117,
			screenY: 6,
			width: 2,
			height: 12,
		} as TuiMouseEvent);
		expect(harness.tui.scroll.scrollTop).toBe(17);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		outlineRail.handleMouse?.({
			type: "click",
			button: "left",
			x: 0,
			y: 5,
			screenX: 117,
			screenY: 5,
			width: 2,
			height: 12,
		} as TuiMouseEvent);
		expect(harness.tui.scroll.scrollTop).toBe(2);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		harness.tui.scroll.scrollTo(20, { disableFollow: true });
		expect(stripTerminalSequences(stickyBar.render(117).join("\n"))).toContain("10:05");
		await harness.runCommand("sticky", "prev");
		expect(harness.tui.scroll.scrollTop).toBe(2);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

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

		const initialHeight = syncTranscriptLayout(harness, 12, 117);
		const { stickyBar, outlineRail } = getViewportComponents(harness);

		const turn1RenderSpy = vi.spyOn(turn1Card, "render");
		const resp1RenderSpy = vi.spyOn(resp1, "render");

		stickyBar.render(117);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(1);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(1);

		outlineRail.render(2);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(1);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(1);

		for (let tick = 0; tick < 5; tick++) {
			stickyBar.render(117);
			outlineRail.render(2);
		}
		expect(turn1RenderSpy).toHaveBeenCalledTimes(1);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(1);

		harness.tui.scroll.updateLayout(initialHeight + 4, 12, () => harness!.tui.requestRender());
		stickyBar.render(117);
		outlineRail.render(2);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(2);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(2);

		harness.tui.terminal.columns = 100;
		stickyBar.render(97);
		outlineRail.render(2);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(3);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(3);

		const t3 = new Date(2026, 0, 15, 11, 10).getTime();
		const liveTurn3Card = new UserMessageComponent("Third turn live", undefined, 1, [], "u3", new Date(t3).toISOString());
		harness.tui.chatContainer.addChild(liveTurn3Card);
		harness.tui.scroll.updateLayout(initialHeight + 18, 12, () => harness!.tui.requestRender());
		harness.tui.scroll.scrollTo(40, { disableFollow: true });
		expect(stripTerminalSequences(stickyBar.render(97).join("\n"))).toContain("Third turn live");

		const nextBranch = [...branch, makeUserEntry("u3", "Third turn live", t3)];
		harness.setEntries(nextBranch, nextBranch);
		stickyBar.render(97);
		outlineRail.render(2);
		expect(turn1RenderSpy).toHaveBeenCalledTimes(5);
		expect(resp1RenderSpy).toHaveBeenCalledTimes(5);
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

		harness.tui.chatContainer.addChild(new UserMessageComponent("Turn one"));
		harness.tui.chatContainer.addChild(createMultilineBlock("resp1", 15));
		harness.tui.chatContainer.addChild(new UserMessageComponent("Turn two"));
		harness.tui.chatContainer.addChild(createMultilineBlock("resp2", 15));
		harness.tui.chatContainer.addChild(new UserMessageComponent("Turn three"));
		harness.tui.chatContainer.addChild(createMultilineBlock("resp3", 15));

		const totalHeight = syncTranscriptLayout(harness, 12, 117);
		const maxScrollTop = totalHeight - 12;
		expect(harness.tui.scroll.isFollowingEnd).toBe(true);
		expect(harness.tui.scroll.scrollTop).toBe(maxScrollTop);

		const { stickyBar, outlineRail } = getViewportComponents(harness);
		outlineRail.render(2);

		const clickRail = (y: number) =>
			outlineRail.handleMouse?.({
				type: "click",
				button: "left",
				x: 0,
				y,
				screenX: 117,
				screenY: y,
				width: 2,
				height: 12,
			} as TuiMouseEvent);

		clickRail(4);
		expect(harness.tui.scroll.scrollTop).toBe(0);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		outlineRail.render(2);
		clickRail(7);
		expect(harness.tui.scroll.scrollTop).toBe(18);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		outlineRail.render(2);
		clickRail(7);
		expect(harness.tui.scroll.scrollTop).toBe(maxScrollTop);
		expect(harness.tui.scroll.isFollowingEnd).toBe(true);

		stickyBar.render(117);
		await harness.runCommand("sticky", "prev");
		expect(harness.tui.scroll.scrollTop).toBe(18);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		outlineRail.render(2);
		clickRail(6);
		expect(harness.tui.scroll.scrollTop).toBe(maxScrollTop);
		expect(harness.tui.scroll.isFollowingEnd).toBe(true);

		stickyBar.render(117);
		await harness.runCommand("sticky", "prev");
		expect(harness.tui.scroll.scrollTop).toBe(18);
		expect(harness.tui.scroll.isFollowingEnd).toBe(false);

		harness.tui.scroll.scrollTo(19, { disableFollow: true });
		stickyBar.render(117);
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

			syncTranscriptLayout(harness, 12, 117);

			const { stickyBar, outlineRail } = getViewportComponents(harness);

			expect(harness.tui.scroll.scrollbar).toBe("auto");

			expect(stickyBar.render(117).length).toBeGreaterThan(0);
			expect(outlineRail.render(2).length).toBe(12);

			expect(harness.tui.overlayStack.some((o) => o.options?.nonCapturing)).toBe(false);
			outlineRail.handleMouse?.({
				type: "move",
				button: "none",
				x: 0,
				y: 5,
				screenX: 117,
				screenY: 5,
				width: 2,
				height: 12,
			} as TuiMouseEvent);
			const hoverEntry = harness.tui.overlayStack.find((o) => o.options?.nonCapturing);
			expect(hoverEntry).toBeDefined();
			expect(harness.tui.isOverlayVisible(hoverEntry!)).toBe(true);

			const modalHandle = harness.tui.showOverlay({ render: () => ["modal"], invalidate() {} }, {});
			expect(harness.tui.getTopmostVisibleOverlay()).toBeDefined();
			expect(harness.tui.isOverlayVisible(hoverEntry!)).toBe(false);
			modalHandle.hide();
			expect(harness.tui.isOverlayVisible(hoverEntry!)).toBe(true);

			outlineRail.handleMouse?.({
				type: "move",
				button: "none",
				x: 0,
				y: 0,
				screenX: 117,
				screenY: 0,
				width: 2,
				height: 12,
			} as TuiMouseEvent);
			expect(harness.tui.overlayStack.some((o) => o.options?.nonCapturing)).toBe(false);

			await harness.runCommand("sticky", "toggle");
			expect(stickyBar.render(117)).toEqual([]);
			await harness.runCommand("sticky", "toggle");
			expect(stickyBar.render(117).length).toBeGreaterThan(0);

			await harness.runCommand("outline");
			expect(outlineRail.render(2)).toEqual([]);
			await harness.runCommand("outline");
			expect(outlineRail.render(2).length).toBe(12);

			expect(readdirSync(tempCwd)).toEqual([]);
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});
});
