import { afterEach, describe, expect, it, vi } from "vitest";
import {
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	stripTerminalSequences,
	VStack,
} from "@earendil-works/pi-tui";
import { getOutlineSettings } from "../src/features/outline-rail/index.ts";
import type { OutlineRailComponent } from "../src/features/outline-rail/rail-view.ts";
import { getStickyConfig } from "../src/features/sticky-prompt/index.ts";
import { registerPromptPillFormatter } from "../src/features/transcript/user-prompt.ts";
import { renderPill } from "../src/shared/ansi.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	makeAssistantEntry,
	makeUserEntry,
	type InteractiveHarness,
	type SessionEntry,
} from "./harness/index.ts";

function extractBgRgbs(lines: readonly string[]): Array<[number, number, number]> {
	const out: Array<[number, number, number]> = [];
	const re = /\x1b\[48;2;(\d+);(\d+);(\d+)m/g;
	for (const line of lines) {
		for (const m of line.matchAll(re)) {
			out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
		}
	}
	return out;
}

function luminance([r, g, b]: [number, number, number]): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

function buildLines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, idx) => `${prefix}-${idx + 1}`).join("\n");
}

function getRailGeometry(): NonNullable<OutlineRailComponent["geometry"]> {
	const rail = getActiveHostRuntime()?.viewportSlots?.rightRail as OutlineRailComponent | undefined;
	if (!rail?.geometry) {
		throw new Error("Expected OutlineRail geometry to be active");
	}
	return rail.geometry;
}

describe("Viewport chrome & refined user prompt cards (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	let disposePillFormatter: (() => void) | undefined;

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetCapabilitiesCache();
		const stickyCfg = getStickyConfig();
		stickyCfg.enabled = true;
		stickyCfg.showTimestamp = true;
		stickyCfg.showNavigation = false;
		stickyCfg.mode = "auto";
		getOutlineSettings().enabled = true;
		disposePillFormatter?.();
		disposePillFormatter = undefined;
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
	});

	it.each(["dark", "light"] as const)(
		"renders sent user prompt cards in %s theme as full-width vpad bands with single › prefix, 24h timestamp, and non-reflowing Copy hover",
		async (themeMode) => {
			const ts = new Date(2026, 3, 19, 15, 14).getTime();
			harness = await createInteractiveHarness({
				theme: themeMode,
				width: 68,
				height: 20,
				initialEntries: [
					makeUserEntry("u1", null, "Build a clean parser for edge cases now", ts),
					makeAssistantEntry("a1", "u1", "Parser ready.", ts + 1000),
				],
			});

			const scroll = getActiveHostRuntime()!.scroll!;
			scroll.scrollTo(0, { disableFollow: true });

			const idleScreen = harness.screen();
			const promptHit = idleScreen.findText("› Build a clean parser for edge cases now");
			expect(promptHit).toBeDefined();
			const cardMidRow = promptHit!.row;
			expect(cardMidRow).toBeGreaterThanOrEqual(1);

			const topPad = idleScreen.rowText(cardMidRow - 1).trim();
			const midRow = idleScreen.rowText(cardMidRow);
			const botPad = idleScreen.rowText(cardMidRow + 1).trim();

			expect(topPad).toBe("");
			expect(midRow).toContain("› Build a clean parser for edge cases now");
			expect(midRow).not.toContain("┃");
			expect(midRow.trimEnd().endsWith("15:14")).toBe(true);
			expect(botPad).toBe("");

			const rawCardLines = harness
				.renderFrame()
				.slice(cardMidRow - 1, cardMidRow + 2);
			const bgs = extractBgRgbs(rawCardLines);
			expect(bgs.length).toBeGreaterThan(0);
			for (const rgb of bgs) {
				if (themeMode === "light") {
					expect(luminance(rgb)).toBeGreaterThan(180);
				} else {
					expect(luminance(rgb)).toBeLessThan(80);
				}
				expect(rgb[2]).toBeGreaterThanOrEqual(rgb[0]);
			}

			await harness.mouseMove(12, cardMidRow);
			const hoveredScreen = harness.screen();
			expect(hoveredScreen.rowText(cardMidRow - 1).trim()).toBe("");
			expect(hoveredScreen.rowText(cardMidRow)).toContain("Copy");
			expect(hoveredScreen.rowText(cardMidRow)).not.toContain("15:14");
			const tsCol = midRow.lastIndexOf("19 Apr, 15:14");
			expect(tsCol).toBeGreaterThan(20);
			expect(hoveredScreen.rowText(cardMidRow).slice(0, tsCol)).toBe(midRow.slice(0, tsCol));

			const copyPos = hoveredScreen.findText("Copy");
			expect(copyPos).toBeDefined();
			expect(copyPos!.row).toBe(cardMidRow);
			expect(copyPos!.col).toBeGreaterThan(30);

			const writesBeforeCopy = harness.terminal.writes.length;
			await harness.mouseClick(copyPos!.col + 1, copyPos!.row);
			expect(
				harness.terminal.writes.slice(writesBeforeCopy).some((w) => w.includes("\x1b]52;c;")),
			).toBe(true);
			expect(await getActiveHostRuntime()!.clipboard.readText?.()).toBe(
				"Build a clean parser for edge cases now",
			);

			const copiedScreen = harness.screen();
			expect(copiedScreen.rowText(cardMidRow - 1).trim()).toBe("");
			expect(copiedScreen.rowText(cardMidRow)).toContain("Copied");
			expect(copiedScreen.rowText(cardMidRow).slice(0, tsCol)).toBe(midRow.slice(0, tsCol));

			vi.useFakeTimers();
			await harness.mouseClick(copyPos!.col + 1, copyPos!.row);
			expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
			await harness.dispose();
			expect(vi.getTimerCount()).toBe(0);
			harness = undefined;
		},
	);

	it("formats inline Prompt Chip pills and routes pill clicks through registerPromptPillFormatter across wrapped widths", async () => {
		const clickedIds: string[] = [];
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 22,
			responses: [
				fauxAssistantMessage("Noted first turn."),
				fauxAssistantMessage("Noted wrapped turn."),
			],
		});

		disposePillFormatter = registerPromptPillFormatter((rawText, context) => {
			let text = rawText;
			const pills = [];
			if (text.includes("[🖼 Image #1]")) {
				text = text.replace(
					"[🖼 Image #1]",
					renderPill("🖼 Image #1", { theme: context.theme, variant: "neutral" }),
				);
				pills.push({ id: "chip-1", label: "🖼 Image #1", onClick: () => clickedIds.push("chip-1") });
			}
			if (text.includes("[📋 Pasted #2 · 8 lines]")) {
				text = text.replace(
					"[📋 Pasted #2 · 8 lines]",
					renderPill("📋 Pasted #2 · 8 lines", { theme: context.theme, variant: "neutral" }),
				);
				pills.push({
					id: "chip-2",
					label: "📋 Pasted #2 · 8 lines",
					onClick: () => clickedIds.push("chip-2"),
				});
			}
			return { text, pills };
		});

		await harness.submitInput("Plain 🖼 Image #1 then [🖼 Image #1] and [📋 Pasted #2 · 8 lines]");
		const scroll = getActiveHostRuntime()!.scroll!;
		scroll.scrollTo(0, { disableFollow: true });

		const screenWide = harness.screen();
		const cardHit = screenWide.findText("Plain 🖼 Image #1");
		expect(cardHit).toBeDefined();
		const rowText = screenWide.rowText(cardHit!.row);
		const firstPlainCol = rowText.indexOf("🖼 Image #1");
		const secondPillCol = rowText.indexOf("🖼 Image #1", firstPlainCol + 11);
		expect(firstPlainCol).toBeGreaterThan(2);
		expect(secondPillCol).toBeGreaterThan(firstPlainCol + 10);

		await harness.mouseClick(firstPlainCol + 2, cardHit!.row);
		expect(clickedIds).toEqual([]);

		await harness.mouseClick(secondPillCol + 2, cardHit!.row);
		expect(clickedIds).toEqual(["chip-1"]);

		disposePillFormatter();
		disposePillFormatter = registerPromptPillFormatter((rawText, context) => ({
			text: rawText
				.replace(
					"[📋 Pasted #2 · 8 lines]",
					renderPill("📋 Pasted #2 · 8 lines", { theme: context.theme, variant: "neutral" }),
				)
				.replace(
					"[🖼 Image #1]",
					renderPill("🖼 Image #1", { theme: context.theme, variant: "neutral" }),
				),
			pills: [
				{ id: "wrapped-1", label: "📋 Pasted #2 · 8 lines", onClick: () => clickedIds.push("wrapped-1") },
				{ id: "after-wrap-2", label: "🖼 Image #1", onClick: () => clickedIds.push("after-wrap-2") },
			],
		}));

		await harness.submitInput("[📋 Pasted #2 · 8 lines]\n[🖼 Image #1]");
		await harness.resize(32, 22);
		scroll.scrollToEnd();

		const narrowScreen = harness.screen();
		let wrappedImgRow = -1;
		let wrappedImgCol = -1;
		for (let r = narrowScreen.height - 1; r >= 0; r -= 1) {
			const idx = narrowScreen.rowText(r).indexOf("🖼 Image #1");
			if (idx !== -1) {
				wrappedImgRow = r;
				wrappedImgCol = idx;
				break;
			}
		}
		expect(wrappedImgRow).toBeGreaterThan(1);
		await harness.mouseClick(wrappedImgCol + 2, wrappedImgRow);
		expect(clickedIds).toEqual(["chip-1", "after-wrap-2"]);
	});

	it.each(["dark", "light"] as const)(
		"renders monochrome adaptive Outline Rail glyphs and Hover Popup with 24h timestamp above a neutral-bordered box in %s theme",
		async (themeMode) => {
			const t1 = new Date(2026, 3, 19, 9, 5).getTime();
			const t2 = new Date(2026, 3, 19, 15, 14).getTime();
			const t3 = new Date(2026, 3, 19, 16, 42).getTime();
			const initialEntries: SessionEntry[] = [
				makeUserEntry("u1", null, "First prompt alpha", t1),
				makeAssistantEntry("a1", "u1", buildLines("resp1", 18), t1 + 1000),
				makeUserEntry("u2", "a1", "Second prompt beta", t2),
				makeAssistantEntry("a2", "u2", buildLines("resp2", 18), t2 + 1000),
				makeUserEntry("u3", "a2", "Third prompt gamma", t3),
				makeAssistantEntry("a3", "u3", buildLines("resp3", 18), t3 + 1000),
			];

			harness = await createInteractiveHarness({
				theme: themeMode,
				width: 100,
				height: 20,
				initialEntries,
			});

			const runtime = getActiveHostRuntime()!;
			const scroll = runtime.scroll!;
			const theme = runtime.theme();
			const rail = runtime.viewportSlots!.rightRail as OutlineRailComponent;

			scroll.scrollTo(rail.offsetOf(1) + 2, { disableFollow: true });
			const headerRows = 3;
			const idleScreen = harness.screen();
			const geo = getRailGeometry();

			expect(idleScreen.sliceText(headerRows + geo.upY, 98, 100)).toBe(" ▲");
			expect(idleScreen.sliceText(headerRows + geo.ticksY, 98, 100)).toBe(" ─");
			expect(idleScreen.sliceText(headerRows + geo.ticksY + 1, 98, 100)).toBe("━━");
			expect(idleScreen.sliceText(headerRows + geo.ticksY + 2, 98, 100)).toBe(" ─");
			expect(idleScreen.sliceText(headerRows + geo.downY, 98, 100)).toBe(" ▼");

			const rawFrameIdle = harness.renderFrame();
			expect(rawFrameIdle[headerRows + geo.ticksY]).toContain(theme.getFgAnsi("dim"));
			expect(rawFrameIdle[headerRows + geo.ticksY + 1]).toContain(theme.getFgAnsi("text"));

			const tick3Row = headerRows + geo.ticksY + 2;
			await harness.mouseMove(99, tick3Row);

			const hoveredScreen = harness.screen();
			expect(hoveredScreen.sliceText(tick3Row, 98, 100)).toBe("━━");

			const boxTopHit = hoveredScreen.findText("╭─");
			expect(boxTopHit).toBeDefined();
			expect(hoveredScreen.rowText(boxTopHit!.row)).toContain("─╮");
			expect(hoveredScreen.text()).toContain("Third prompt gamma");
			expect(hoveredScreen.text()).not.toContain("Реплика");
			expect(hoveredScreen.text()).not.toContain("Turn #3");

			await harness.pressKey("\x0b");
			expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
			expect(harness.screen().text()).toContain("Command Palette");
			expect(harness.screen().text()).not.toContain("Third prompt gamma");

			await harness.pressKey("\x1b");
			expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

			await harness.mouseMove(20, 4);
			const afterLeaveViewport = Array.from({ length: scroll.viewportHeight }, (_, r) =>
				harness!.screen().sliceText(headerRows + r, 40, 97),
			).join("\n");
			expect(afterLeaveViewport).not.toContain("Third prompt gamma");
		},
	);

	it.each(["dark", "light"] as const)(
		"keeps ScrollView full-width with rightmost scrollbar at width - 1, stable Outline Rail at width - 3..width - 2, constant viewportHeight, and single-turn Sticky Prompt with 3-line collapse and row-by-row push in %s theme",
		async (themeMode) => {
			const t1 = new Date(2026, 3, 19, 10, 15).getTime();
			const t2 = new Date(2026, 3, 19, 10, 30).getTime();
			const longPrompt1 = [
				"Line one of multi-line user prompt",
				"Line two of multi-line user prompt",
				"Line three of multi-line user prompt",
				"Line four hidden while collapsed",
				"Line five hidden while collapsed",
			].join("\n");
			const initialEntries: SessionEntry[] = [
				makeUserEntry("u1", null, longPrompt1, t1),
				makeAssistantEntry("a1", "u1", buildLines("response-one-row", 16), t1 + 1000),
				makeUserEntry("u2", "a1", "Next turn prompt", t2),
				makeAssistantEntry("a2", "u2", buildLines("response-two-row", 16), t2 + 1000),
			];

			harness = await createInteractiveHarness({
				theme: themeMode,
				width: 100,
				height: 24,
				initialEntries,
			});

			const layoutRoot = (harness.tui as unknown as { layoutRoot?: unknown }).layoutRoot;
			expect(layoutRoot).toBeInstanceOf(VStack);

			const headerRows = 3;
			const scroll = getActiveHostRuntime()!.scroll!;
			scroll.scrollTo(0, { disableFollow: true });
			const atTopScreen = harness.screen();
			const initialViewportHeight = scroll.viewportHeight;
			expect(initialViewportHeight).toBeGreaterThanOrEqual(14);
			expect(atTopScreen.text()).toContain("Line four hidden while collapsed");

			scroll.scrollTo(10, { disableFollow: true });
			expect(scroll.viewportHeight).toBe(initialViewportHeight);
			expect(scroll.scrollbar).toBe("hidden");

			const collapsedScreen = harness.screen();
			const railSlices = Array.from({ length: initialViewportHeight }, (_, r) =>
				collapsedScreen.sliceText(headerRows + r, 98, 100),
			);
			expect(railSlices.some((s) => s === " ▲")).toBe(true);
			expect(railSlices.some((s) => s === "━━")).toBe(true);
			expect(railSlices.some((s) => s === " ─")).toBe(true);
			expect(railSlices.some((s) => s === " ▼")).toBe(true);

			const stickyTopFive = Array.from({ length: 5 }, (_, r) =>
				collapsedScreen.sliceText(headerRows + r, 0, 100),
			);
			expect(stickyTopFive[0]?.trim()).toBe("");
			expect(stickyTopFive[1]).toContain("› Line one of multi-line user prompt");
			expect(stickyTopFive[1]?.trimEnd().endsWith("10:15")).toBe(true);
			expect(stickyTopFive[2]).toContain("Line two of multi-line user prompt");
			expect(stickyTopFive[3]).toContain("Line three of multi-line user prompt");
			expect(stickyTopFive[3]).toContain("+2 lines (Alt+s)");
			expect(stickyTopFive[4]?.trim()).toBe("");
			expect(stickyTopFive.join("\n")).not.toContain("#1/2");
			expect(stickyTopFive.join("\n")).not.toContain("↑");
			expect(stickyTopFive.join("\n")).not.toContain("Line four hidden while collapsed");

			await harness.mouseClick(12, headerRows + 2);
			const expandedScreen = harness.screen();
			expect(scroll.viewportHeight).toBe(initialViewportHeight);
			const expandedTopSeven = Array.from({ length: 7 }, (_, r) =>
				expandedScreen.sliceText(headerRows + r, 0, 100),
			).join("\n");
			expect(expandedTopSeven).toContain("Line four hidden while collapsed");
			expect(expandedTopSeven).toContain("Line five hidden while collapsed");

			await harness.pressKey("\x1bs");
			const recollapsedTopSix = Array.from({ length: 6 }, (_, r) =>
				harness!.screen().sliceText(headerRows + r, 0, 100),
			).join("\n");
			expect(recollapsedTopSix).not.toContain("Line four hidden while collapsed");

			const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
			const turn2Start = rail.offsetOf(1);
			scroll.scrollTo(turn2Start - 3, { disableFollow: true });
			const pushedScreen = harness.screen();
			expect(pushedScreen.sliceText(headerRows + 0, 0, 100)).toContain("Line two of multi-line user prompt");
			expect(pushedScreen.sliceText(headerRows + 1, 0, 100)).toContain("Line three of multi-line user prompt");
			expect(pushedScreen.sliceText(headerRows + 2, 0, 100).trim()).toBe("");
			expect(pushedScreen.sliceText(headerRows + 4, 0, 100)).toContain("› Next turn prompt");

			scroll.scrollTo(turn2Start + 4, { disableFollow: true });
			const turn2Pinned = harness.screen();
			expect(turn2Pinned.sliceText(headerRows + 0, 0, 100).trim()).toBe("");
			expect(turn2Pinned.sliceText(headerRows + 1, 0, 100)).toContain("› Next turn prompt");
			expect(turn2Pinned.sliceText(headerRows + 1, 0, 100).trimEnd().endsWith("10:30")).toBe(true);
			expect(
				Array.from({ length: 4 }, (_, r) => turn2Pinned.sliceText(headerRows + r, 0, 100)).join("\n"),
			).not.toContain("Line one of multi-line user prompt");
		},
	);

	it("preserves inline Kitty image scrolling below Sticky Prompt while stripping covered image sequences under Sticky Prompt rows", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const pngHeader = Buffer.alloc(32);
		pngHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
		pngHeader.writeUInt32BE(13, 8);
		pngHeader.write("IHDR", 12, "ascii");
		pngHeader.writeUInt32BE(360, 16);
		pngHeader.writeUInt32BE(108, 20);
		const realKitty = renderImage(
			pngHeader.toString("base64"),
			{ widthPx: 360, heightPx: 108 },
			{ maxWidthCells: 40, maxHeightCells: 6, imageId: 191, moveCursor: false },
		);
		expect(realKitty).not.toBeNull();
		expect(realKitty!.rows).toBe(6);

		const t1 = new Date(2026, 3, 19, 11, 0).getTime();
		const t2 = new Date(2026, 3, 19, 11, 10).getTime();

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 18,
			extensionFactories: [
				(pi) => {
					pi.registerMessageRenderer("chart-fixture", () => ({
						render: () => [
							"intro-1",
							"intro-2",
							realKitty!.sequence,
							"",
							"",
							"",
							"",
							"",
							"\x1b[4A\x1b]1337;File=inline=1;width=30:AAAA\x07",
							...Array.from({ length: 12 }, (_, idx) => `after-image-${idx + 1}`),
						],
						invalidate() {},
					}));
				},
			],
			initialEntries: [
				makeUserEntry("u1", null, "Show chart", t1),
				{
					type: "custom_message",
					id: "cm1",
					parentId: "u1",
					timestamp: new Date(t1 + 500).toISOString(),
					customType: "chart-fixture",
					content: "chart-output",
					display: true,
				},
				makeUserEntry("u2", "cm1", "Follow up", t2),
				makeAssistantEntry("a2", "u2", buildLines("tail", 14), t2 + 1000),
			],
		});

		const headerRows = 3;
		const scroll = getActiveHostRuntime()!.scroll!;
		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		const turn1Start = rail.offsetOf(0);

		let kittyDocRow = -1;
		for (let offset = turn1Start + 1; offset < turn1Start + 14; offset += 1) {
			scroll.scrollTo(offset, { disableFollow: true });
			const frame = harness.renderFrame();
			const rowIdx = frame.findIndex((line, idx) => idx >= headerRows + 3 && line.includes("\x1b_G"));
			if (rowIdx >= headerRows + 4) {
				kittyDocRow = offset + (rowIdx - headerRows);
				expect(frame.slice(headerRows, headerRows + 3).some((line) => line.includes("\x1b_G"))).toBe(false);
				break;
			}
		}
		expect(kittyDocRow).toBeGreaterThan(turn1Start);

		/* При перекрытии верхних 2 строк 6-строчной Kitty-картинки остаётся r=4, y=36, h=72 */
		scroll.scrollTo(kittyDocRow - 1, { disableFollow: true });
		const partiallyCovered2 = harness.renderFrame();
		expect(partiallyCovered2.slice(headerRows, headerRows + 3).some((line) => line.includes("\x1b_G"))).toBe(false);
		expect(stripTerminalSequences(partiallyCovered2[headerRows + 1]!)).toContain("› Show chart");
		expect(partiallyCovered2[headerRows + 3]).toContain("\x1b_G");
		expect(partiallyCovered2[headerRows + 3]).toContain("r=4");
		expect(partiallyCovered2[headerRows + 3]).toContain("y=36");
		expect(partiallyCovered2[headerRows + 3]).toContain("h=72");

		scroll.scrollTo(kittyDocRow + 1, { disableFollow: true });
		const partiallyCovered4 = harness.renderFrame();
		expect(partiallyCovered4.slice(headerRows, headerRows + 3).some((line) => line.includes("\x1b_G"))).toBe(false);
		expect(partiallyCovered4[headerRows + 3]).toContain("\x1b_G");
		expect(partiallyCovered4[headerRows + 3]).toContain("r=2");
		expect(partiallyCovered4[headerRows + 3]).toContain("y=72");
		expect(partiallyCovered4[headerRows + 3]).toContain("h=36");

		scroll.scrollTo(kittyDocRow + 3, { disableFollow: true });
		const itermBleedFrame = harness.renderFrame();
		expect(itermBleedFrame[headerRows + 3]).not.toContain("\x1b]1337;File=");
	});

	it("prevents applySelection highlight bleed onto composited Sticky Prompt and Outline Rail while highlighting uncovered transcript text", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 20,
			responses: [
				fauxAssistantMessage(
					Array.from(
						{ length: 18 },
						(_, idx) => `Selectable transcript row ${idx + 1} with wide content padding`,
					).join("\n"),
				),
				fauxAssistantMessage(buildLines("Second response", 14)),
			],
		});

		await harness.submitInput("Select response lines");
		await harness.submitInput("Second turn");

		const headerRows = 3;
		const scroll = getActiveHostRuntime()!.scroll!;
		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		scroll.scrollTo(rail.offsetOf(0) + 2, { disableFollow: true });
		harness.flushFrame();

		await harness.mouseDrag(4, headerRows + 4, 97, headerRows + 8, { steps: 3 });

		scroll.scrollTo(rail.offsetOf(0) + 6, { disableFollow: true });
		const selectedScreen = harness.screen();
		const vpHeight = scroll.viewportHeight;

		const hasUncoveredInverse = Array.from(
			{ length: 80 },
			(_, c) => selectedScreen.cellAt(headerRows + 3, c)?.inverse === true,
		).some(Boolean);
		expect(hasUncoveredInverse).toBe(true);

		for (let r = headerRows; r < headerRows + 3; r += 1) {
			for (let c = 0; c < 98; c += 1) {
				expect(selectedScreen.cellAt(r, c)?.inverse).toBe(false);
			}
		}
		const geo = getRailGeometry();
		for (let r = headerRows + geo.upY; r <= headerRows + geo.downY; r += 1) {
			expect(selectedScreen.cellAt(r, 98)?.inverse).toBe(false);
			expect(selectedScreen.cellAt(r, 99)?.inverse).toBe(false);
		}
		await harness.mouseMove(99, headerRows + geo.ticksY);
		const popupScreen = harness.screen();
		const topBoxHit = popupScreen.findText("╭─");
		expect(topBoxHit).toBeDefined();

		const leftOfPopupSelected = Array.from(
			{ length: Math.max(0, topBoxHit!.col - 2) },
			(_, c) => popupScreen.cellAt(headerRows + 4, c)?.inverse === true,
		).some(Boolean);
		expect(leftOfPopupSelected).toBe(true);

		for (let r = topBoxHit!.row; r < headerRows + vpHeight; r += 1) {
			const rowSlice = popupScreen.sliceText(r, topBoxHit!.col, 98);
			const endIdx = rowSlice.indexOf("╯") !== -1 ? rowSlice.indexOf("╯") : rowSlice.indexOf("│", 1);
			if (endIdx === -1) break;
			for (let c = topBoxHit!.col; c <= topBoxHit!.col + endIdx; c += 1) {
				expect(popupScreen.cellAt(r, c)?.inverse).toBe(false);
			}
			if (rowSlice.includes("╯")) break;
		}
	});

	it("routes mouse hover, click, and wheel events to composited Sticky Prompt and Outline Rail before underlying transcript rows while respecting blocking modals", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 100,
			height: 18,
			responses: [
				fauxAssistantMessage([
					fauxThinking("Underlying hidden reasoning line"),
					fauxText(buildLines("alpha-resp", 16)),
				]),
				fauxAssistantMessage(buildLines("beta-resp", 14)),
			],
		});

		await harness.typeText("Alpha line 1");
		await harness.pressKey("\x1b[13;2u");
		await harness.typeText("Alpha line 2");
		await harness.pressKey("\x1b[13;2u");
		await harness.typeText("Alpha line 3");
		await harness.pressKey("\x1b[13;2u");
		await harness.typeText("Alpha line 4");
		await harness.submitDraft();
		await harness.submitInput("Beta target turn");

		const headerRows = 3;
		const scroll = getActiveHostRuntime()!.scroll!;
		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		const turn1Start = rail.offsetOf(0);

		scroll.scrollTo(turn1Start + 1, { disableFollow: true });
		const thoughtWhenOpen = harness.screen().findText("Thought");
		expect(thoughtWhenOpen).toBeDefined();
		const thoughtDocRow = scroll.scrollTop + (thoughtWhenOpen!.row - headerRows);

		scroll.scrollTo(thoughtDocRow - 2, { disableFollow: true });
		harness.flushFrame();

		await harness.mouseMove(8, headerRows + 2);
		await harness.mouseClick(8, headerRows + 2);
		const afterStickyExpand = harness.screen().text();
		expect(afterStickyExpand).toContain("Alpha line 4");
		expect(afterStickyExpand).not.toContain("Underlying hidden reasoning line");

		await harness.mouseClick(8, headerRows + 2);

		const beforeStickyWheel = scroll.scrollTop;
		await harness.mouseWheel("down", 15, headerRows + 2, 1);
		expect(scroll.scrollTop).toBeGreaterThan(beforeStickyWheel);

		scroll.scrollTo(turn1Start + 1, { disableFollow: true });
		const uncoveredThought = harness.screen().findText("Thought");
		expect(uncoveredThought).toBeDefined();
		expect(uncoveredThought!.row).toBeGreaterThanOrEqual(headerRows + 3);
		await harness.mouseClick(uncoveredThought!.col + 1, uncoveredThought!.row);
		expect(harness.screen().text()).toContain("Underlying hidden reasoning line");

		scroll.scrollTo(turn1Start + 8, { disableFollow: true });
		harness.flushFrame();
		const geo = getRailGeometry();
		await harness.mouseMove(99, headerRows + geo.ticksY + 1);
		expect(harness.screen().text()).toContain("Beta target turn");

		const beforeRailWheel = scroll.scrollTop;
		await harness.mouseWheel("down", 99, headerRows + geo.ticksY + 1, 1);
		expect(scroll.scrollTop).toBeGreaterThan(beforeRailWheel);

		await harness.mouseClick(99, headerRows + getRailGeometry().ticksY);
		expect(scroll.scrollTop).toBe(turn1Start);

		await harness.mouseMove(20, 8);
		const afterLeaveText = Array.from({ length: scroll.viewportHeight }, (_, r) =>
			harness!.screen().sliceText(headerRows + r, 40, 97),
		).join("\n");
		expect(afterLeaveText).not.toContain("╭─");

		await harness.pressKey("\x0b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.mouseMove(99, headerRows + getRailGeometry().ticksY + 1);
		expect(harness.screen().text()).toContain("Command Palette");
		expect(harness.screen().text()).not.toContain("Beta target turn");
		await harness.pressKey("\x1b");
	});

	it("handles empty/narrow/CJK user prompts, mid-push Sticky clicks, and live /outline content margin toggling cleanly", async () => {
		const t1 = new Date(2026, 3, 19, 0, 0).getTime();
		const t2 = new Date(2026, 3, 19, 23, 59).getTime();
		const cjkPrompt = "日本語テスト 🚀 line 1\nКириллица строка 2\nLine 3\nHidden line 4";
		const initialEntries: SessionEntry[] = [
			makeUserEntry("u0", null, "   \n\t  ", t1 - 500),
			makeUserEntry("u1", "u0", cjkPrompt, t1),
			makeAssistantEntry("a1", "u1", buildLines("gap", 12), t1 + 1000),
			makeUserEntry("u2", "a1", "Midnight boundary check", t2),
			makeAssistantEntry("a2", "u2", buildLines("end", 14), t2 + 1000),
		];

		harness = await createInteractiveHarness({
			theme: "light",
			width: 80,
			height: 18,
			initialEntries,
		});

		await harness.resize(8, 18);
		expect(harness.screen().width).toBe(8);
		await harness.resize(80, 18);

		const headerRows = 3;
		const scroll = getActiveHostRuntime()!.scroll!;
		scroll.scrollTo(0, { disableFollow: true });
		expect(harness.screen().text()).toContain("日本語テスト");

		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		const turn1Start = rail.offsetOf(0);
		const turn2Start = rail.offsetOf(1);

		scroll.scrollTo(turn2Start - 3, { disableFollow: true });
		const midPushScreen = harness.screen();
		expect(midPushScreen.sliceText(headerRows + 0, 0, 80)).toContain("Кириллица строка 2");
		expect(midPushScreen.sliceText(headerRows + 4, 0, 80)).toContain("23:59");

		const railGeoOnCard = rail.geometry!;
		scroll.scrollTo(Math.max(0, turn2Start - railGeoOnCard.ticksY), { disableFollow: true });
		const railOverCard = harness.screen();
		const cardBgLeft = railOverCard.cellAt(headerRows + railGeoOnCard.ticksY, 10)?.bg;
		const railBgOverCard = railOverCard.cellAt(headerRows + railGeoOnCard.ticksY, 79)?.bg;
		expect(cardBgLeft?.kind).toBe("rgb");
		expect(railBgOverCard?.kind).toBe("default");

		await harness.mouseClick(10, headerRows + 1);
		scroll.scrollTo(turn1Start + 6, { disableFollow: true });
		const expandedAfterMidPush = Array.from({ length: 6 }, (_, r) =>
			harness!.screen().rowText(headerRows + r),
		).join("\n");
		expect(expandedAfterMidPush).toContain("Hidden line 4");

		await harness.submitInput("/outline");
		scroll.scrollTo(turn1Start + 5, { disableFollow: true });
		scroll.scrollTo(turn1Start + 6, { disableFollow: true });
		const railOffScreen = harness.screen();
		const vpHeight = scroll.viewportHeight;
		const railOffCols = Array.from({ length: vpHeight }, (_, r) =>
			railOffScreen.sliceText(headerRows + r, 78, 80),
		);
		expect(railOffCols.some((c) => c === " ▲" || c === "━━")).toBe(false);
		expect(scroll.scrollbar).toBe("hidden");

		const tsColVisible = railOffScreen.rowText(headerRows + 1).indexOf("00:00");
		expect(tsColVisible).toBeGreaterThan(60);

		await harness.dispose();
		harness = await createInteractiveHarness({
			theme: "light",
			width: 80,
			height: 28,
			initialEntries: [
				makeUserEntry("u1", null, cjkPrompt, t1),
				makeAssistantEntry("a1", "u1", "Short reply", t1 + 1000),
			],
		});
		await harness.submitInput("/sticky always");
		getActiveHostRuntime()!.scroll!.scrollTo(0, { disableFollow: true });
		const shortCollapsed = harness.screen();
		expect(shortCollapsed.rowText(headerRows + 3)).toContain("Line 3 · +1 line (Alt+s)");

		await harness.mouseClick(75, headerRows + 1);
		const shortExpanded = harness.screen();
		expect(shortExpanded.rowText(headerRows + 3)).not.toContain("(Alt+s)");
		expect(shortExpanded.rowText(headerRows + 4)).toContain("Hidden line 4");
	});

	it("renders Outline Rail, Hover Popup, and Sticky Prompt together in narrow 46-column split panes", async () => {
		const t1 = new Date(2026, 3, 19, 10, 15).getTime();
		const t2 = new Date(2026, 3, 19, 10, 42).getTime();
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 46,
			height: 35,
			initialEntries: [
				makeUserEntry("u1", null, "First split-pane prompt alpha", t1),
				makeAssistantEntry("a1", "u1", buildLines("reply1", 24), t1 + 1000),
				makeUserEntry("u2", "a1", "Second split-pane prompt beta", t2),
				makeAssistantEntry("a2", "u2", buildLines("reply2", 24), t2 + 1000),
			],
		});

		const headerRows = 3;
		await harness.mouseWheel("up", 20, 10, 5);
		const scrolled = harness.screen();
		expect(
			`${scrolled.sliceText(headerRows + 1, 0, 46)} ${scrolled.sliceText(headerRows + 2, 0, 46)}`,
		).toContain("First split-pane");
		expect(scrolled.rowText(headerRows + 1).trimEnd().endsWith("19 Apr, 10:15")).toBe(true);

		const railSlices = Array.from({ length: scrolled.height }, (_, r) =>
			scrolled.sliceText(r, 44, 46),
		);
		const upRow = railSlices.findIndex((s) => s === " ▲");
		const downRow = railSlices.findIndex((s) => s === " ▼");
		expect(upRow).toBeGreaterThanOrEqual(headerRows);
		expect(downRow).toBeGreaterThan(upRow);
		expect(railSlices.slice(upRow + 1, downRow)).toEqual([" ─", "━━"]);

		const rail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		await harness.mouseMove(45, upRow + 1);
		const hovered = harness.screen();
		expect(hovered.sliceText(upRow, 44, 46)).toBe(" ▲");
		expect(hovered.sliceText(upRow + 1, 44, 46)).toBe("━━");
		expect(hovered.sliceText(downRow, 44, 46)).toBe(" ▼");
		expect(hovered.text()).toContain("First split-pane");

		await harness.mouseClick(45, upRow + 1);
		expect(getActiveHostRuntime()!.scroll!.scrollTop).toBe(rail.offsetOf(0));
	});

	it("inherits true underlying background under Outline Rail across colored Markdown text, headings, rules, prompts, and code cards", async () => {
		const t1 = new Date(2026, 3, 19, 11, 0).getTime();
		const t2 = new Date(2026, 3, 19, 11, 5).getTime();
		const lightReply = [
			"Plain assistant prose reaching right edge of split pane cleanly now.",
			"> Muted blockquote text reaching right edge of split pane cleanly now.",
			...Array.from({ length: 16 }, (_, i) => `Paragraph line ${i + 1} reaching right edge of split pane.`),
		].join("\n");

		harness = await createInteractiveHarness({
			theme: "light",
			width: 46,
			height: 24,
			initialEntries: [
				makeUserEntry("u1", null, "First light prompt", t1),
				makeAssistantEntry("a1", "u1", lightReply, t1 + 1000),
				makeUserEntry("u2", "a1", "Second light prompt", t2),
				makeAssistantEntry("a2", "u2", lightReply, t2 + 1000),
			],
		});

		const headerRows = 3;
		const lightScroll = getActiveHostRuntime()!.scroll!;
		const lightRail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		lightScroll.scrollTo(2, { disableFollow: true });
		const lightTextScreen = harness.screen();
		const lightGeo = lightRail.geometry!;
		expect(lightGeo).toBeDefined();
		for (let r = headerRows + lightGeo.upY; r <= headerRows + lightGeo.downY; r++) {
			const leftBg = lightTextScreen.cellAt(r, 4)?.bg;
			expect(lightTextScreen.cellAt(r, 45)?.bg).toEqual(leftBg);
			expect(lightTextScreen.cellAt(r, 44)?.bg).toEqual(leftBg);
		}

		await harness.dispose();
		const darkRichReply = [
			"# Heading",
			"---",
			"```ts",
			"const greeting = \"emerald string literal reaching right rail\";",
			"const second = \"another emerald literal reaching right rail\";",
			"const third = \"yet another emerald line under outline rail\";",
			"const fourth = \"fourth emerald line under outline rail\";",
			"```",
			...Array.from({ length: 14 }, (_, i) => `Filler line ${i + 1}`),
		].join("\n");

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 46,
			height: 24,
			initialEntries: [
				makeUserEntry("u1", null, "First dark prompt", t1),
				makeAssistantEntry("a1", "u1", darkRichReply, t1 + 1000),
				makeUserEntry("u2", "a1", "Second dark prompt", t2),
				makeAssistantEntry("a2", "u2", darkRichReply, t2 + 1000),
			],
		});

		const darkScroll = getActiveHostRuntime()!.scroll!;
		const darkRail = getActiveHostRuntime()!.viewportSlots!.rightRail as OutlineRailComponent;
		for (let top = 0; top <= 8; top++) {
			darkScroll.scrollTo(top, { disableFollow: true });
			const withRail = harness.screen();
			const geo = darkRail.geometry!;
			expect(geo).toBeDefined();

			await harness.submitInput("/outline");
			darkScroll.scrollTo(top, { disableFollow: true });
			const withoutRail = harness.screen();

			await harness.submitInput("/outline");
			darkScroll.scrollTo(top, { disableFollow: true });

			for (let r = headerRows + geo.upY; r <= headerRows + geo.downY; r++) {
				expect(withRail.cellAt(r, 44)?.bg).toEqual(withoutRail.cellAt(r, 44)?.bg);
				expect(withRail.cellAt(r, 45)?.bg).toEqual(withoutRail.cellAt(r, 45)?.bg);
				if (withRail.rowText(r).trimStart().startsWith("Heading")) {
					expect(withRail.cellAt(r, 20)?.underline).toBe(false);
				}
			}
		}
	});
});
