import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, sliceByColumn, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import { OutlinePreviewPopup, OutlineRailComponent } from "../src/features/outline-rail/rail-view.ts";
import { createOutlineRailSlot } from "../src/features/outline-rail/index.ts";
import { renderPill } from "../src/shared/ansi.ts";
import { TranscriptTurnIndex } from "../src/shared/turn-index.ts";
import { registerPromptPillFormatter } from "../src/features/transcript/user-prompt.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

const OSC133_PREFIX_RE = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/g;

function cleanPromptLine(line: string): string {
	return stripTerminalSequences(line.replace(OSC133_PREFIX_RE, ""));
}

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

function hasInvertedVisibleCell(ansiLine: string): boolean {
	let inverse = false;
	let i = 0;
	while (i < ansiLine.length) {
		if (ansiLine[i] === "\x1b") {
			const csi = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(ansiLine.slice(i));
			if (csi) {
				if (csi[2] === "m") {
					const params = csi[1] === "" ? [0] : csi[1]!.split(";").map(Number);
					for (let p = 0; p < params.length; p++) {
						const code = params[p]!;
						if (code === 38 || code === 48) {
							p += params[p + 1] === 2 ? 4 : params[p + 1] === 5 ? 2 : 0;
							continue;
						}
						if (code === 0 || code === 27) inverse = false;
						else if (code === 7) inverse = true;
					}
				}
				i += csi[0].length;
				continue;
			}
			const oscOrApc = /^\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/.exec(
				ansiLine.slice(i),
			);
			if (oscOrApc) {
				i += oscOrApc[0].length;
				continue;
			}
		}
		if (inverse) return true;
		i += 1;
	}
	return false;
}

describe("Viewport chrome & refined user prompt cards", () => {
	let harness: ExtensionHarness | undefined;
	let disposePillFormatter: (() => void) | undefined;

	afterEach(async () => {
		disposePillFormatter?.();
		disposePillFormatter = undefined;
		vi.restoreAllMocks();
		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it.each(["dark", "light"] as const)(
		"renders sent user prompt cards in %s theme as full-width vpad bands with single › prefix, 24h timestamp, and non-reflowing Copy hover",
		async (themeMode) => {
			harness = createExtensionHarness({ theme: themeMode, width: 64, height: 24 });
			harness.mount(conartiPiUi);
			await harness.startSession();

			const ts = new Date(2026, 3, 19, 15, 14).getTime();
			await harness.emit("message_start", {
				type: "message_start",
				message: { role: "user", content: "Build a clean parser for edge cases now", timestamp: ts },
			});
			const card = new UserMessageComponent("Build a clean parser for edge cases now");
			harness.tui.chatContainer.addChild(card);

			const idleLines = card.render(56);
			expect(idleLines.length).toBe(3);
			for (const line of idleLines) {
				expect(visibleWidth(line.replace(OSC133_PREFIX_RE, ""))).toBe(56);
			}

			const plainIdle = idleLines.map(cleanPromptLine);
			expect(plainIdle[0]?.trim()).toBe("");
			expect(plainIdle[1]).toContain("› Build a clean parser for edge cases now");
			expect(plainIdle[1]).not.toContain("┃");
			expect(plainIdle[1]?.trimEnd().endsWith("15:14")).toBe(true);
			expect(plainIdle[2]?.trim()).toBe("");

			const bgs = extractBgRgbs(idleLines);
			expect(bgs.length).toBeGreaterThan(0);
			for (const rgb of bgs) {
				if (themeMode === "light") {
					expect(luminance(rgb)).toBeGreaterThan(180);
				} else {
					expect(luminance(rgb)).toBeLessThan(80);
				}
				expect(rgb[2]).toBeGreaterThanOrEqual(rgb[0]);
			}

			(card as unknown as { handleMouse?: (e: TuiMouseEvent) => unknown }).handleMouse?.({
				type: "move",
				button: "none",
				x: 8,
				y: 1,
				screenX: 8,
				screenY: 1,
				width: 56,
				height: 3,
			} as TuiMouseEvent);

			const hoveredLines = card.render(56);
			expect(hoveredLines.length).toBe(3);
			const plainHovered = hoveredLines.map(cleanPromptLine);
			expect(plainHovered[0]).toContain("Copy");
			expect(plainHovered[1]).toBe(plainIdle[1]);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const copyCol = plainHovered[0]!.indexOf("Copy");
			expect(copyCol).toBeGreaterThan(30);

			(card as unknown as { handleMouse?: (e: TuiMouseEvent) => unknown }).handleMouse?.({
				type: "click",
				button: "left",
				x: copyCol + 1,
				y: 0,
				screenX: copyCol + 1,
				screenY: 0,
				width: 56,
				height: 3,
			} as TuiMouseEvent);

			expect(stdoutSpy).toHaveBeenCalled();
			const copiedLines = card.render(56).map(cleanPromptLine);
			expect(copiedLines[0]).toContain("Copied");
			expect(copiedLines[1]).toBe(plainIdle[1]);
		},
	);

	it("formats inline Prompt Chip pills and routes pill clicks through registerPromptPillFormatter", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 80, height: 24 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const clickedIds: string[] = [];
		disposePillFormatter = registerPromptPillFormatter((rawText, context) => {
			const token = "[🖼 Image #1]";
			if (!rawText.includes(token)) return rawText;
			const styledPill = renderPill("🖼 Image #1", { theme: context.theme, variant: "neutral" });
			return {
				text: rawText.replace(token, styledPill),
				pills: [
					{
						id: "chip-1",
						label: "🖼 Image #1",
						onClick: () => clickedIds.push("chip-1"),
					},
				],
			};
		});

		const card = new UserMessageComponent("Check [🖼 Image #1] layout");
		harness.tui.chatContainer.addChild(card);

		const lines = card.render(70);
		expect(lines.length).toBe(3);
		const plainRow1 = cleanPromptLine(lines[1]!);
		expect(plainRow1).toContain("Check");
		expect(plainRow1).toContain("🖼 Image #1");
		expect(plainRow1).toContain("layout");

		const pillCol = plainRow1.indexOf("🖼 Image #1");
		expect(pillCol).toBeGreaterThan(2);

		(card as unknown as { handleMouse?: (e: TuiMouseEvent) => unknown }).handleMouse?.({
			type: "click",
			button: "left",
			x: pillCol + 2,
			y: 1,
			screenX: pillCol + 2,
			screenY: 1,
			width: 70,
			height: 3,
		} as TuiMouseEvent);

		expect(clickedIds).toEqual(["chip-1"]);
	});

	it.each(["dark", "light"] as const)(
		"renders monochrome adaptive Outline Rail glyphs and Grok-style Hover Popup with 24h timestamp above a neutral-bordered box in %s theme",
		async (themeMode) => {
			const t1 = new Date(2026, 3, 19, 9, 5).getTime();
			const t2 = new Date(2026, 3, 19, 15, 14).getTime();
			const t3 = new Date(2026, 3, 19, 16, 42).getTime();
			const branch = [
				{ type: "message", id: "u1", message: { role: "user", content: "First prompt alpha", timestamp: t1 } },
				{ type: "message", id: "u2", message: { role: "user", content: "Second prompt beta", timestamp: t2 } },
				{ type: "message", id: "u3", message: { role: "user", content: "Third prompt gamma", timestamp: t3 } },
			];

			harness = createExtensionHarness({
				theme: themeMode,
				width: 100,
				height: 20,
				entries: branch,
				branch,
			});
			harness.mount(conartiPiUi);
			await harness.startSession();

			harness.tui.chatContainer.addChild(
				new UserMessageComponent("First prompt alpha", undefined, 1, [], "u1", new Date(t1).toISOString()),
			);
			harness.tui.chatContainer.addChild({ render: () => Array.from({ length: 10 }, () => "resp1"), invalidate() {} });
			harness.tui.chatContainer.addChild(
				new UserMessageComponent("Second prompt beta", undefined, 1, [], "u2", new Date(t2).toISOString()),
			);
			harness.tui.chatContainer.addChild({ render: () => Array.from({ length: 10 }, () => "resp2"), invalidate() {} });
			harness.tui.chatContainer.addChild(
				new UserMessageComponent("Third prompt gamma", undefined, 1, [], "u3", new Date(t3).toISOString()),
			);
			harness.tui.chatContainer.addChild({ render: () => Array.from({ length: 10 }, () => "resp3"), invalidate() {} });

			const totalLines = harness.tui.chatContainer.render(97).length;
			harness.tui.scroll.updateLayout(totalLines, 12, () => harness!.tui.requestRender());
			harness.tui.scroll.scrollTo(14, { disableFollow: true });

			const shell = {
				tui: harness.tui.asTui(),
				theme: () => harness!.ctx.ui.theme,
				keybindings: harness.keybindings,
				scroll: harness.tui.scroll,
				requestRender: () => harness!.tui.requestRender(),
			};
			const turnIndex = new TranscriptTurnIndex({
				shell,
				getBranch: () => harness!.ctx.sessionManager.getBranch(),
				getTranscriptWidth: () => 97,
			});
			const rail = createOutlineRailSlot(harness.ctx, shell, turnIndex, () => 0);

			const idleRail = rail.render(2);
			expect(idleRail.length).toBe(12);
			const plainIdleRail = idleRail.map(stripTerminalSequences);

			/* В высоте 12 при 3 репликах: upY = 3, ticksY = 4..6, downY = 7 */
			expect(plainIdleRail[3]).toBe(" ▲");
			expect(plainIdleRail[4]).toBe(" ─");
			expect(plainIdleRail[5]).toBe("──");
			expect(plainIdleRail[6]).toBe(" ─");
			expect(plainIdleRail[7]).toBe(" ▼");

			const primaryFgEsc = harness.ctx.ui.theme.getFgAnsi("text");
			const dimFgEsc = harness.ctx.ui.theme.getFgAnsi("dim");
			expect(idleRail[4]).toContain(dimFgEsc);
			expect(idleRail[5]).toContain(primaryFgEsc);

			rail.handleMouse({
				type: "move",
				button: "none",
				x: 0,
				y: 5,
				screenX: 97,
				screenY: 5,
				width: 2,
				height: 12,
			} as TuiMouseEvent);

			const hoveredRail = rail.render(2);
			expect(stripTerminalSequences(hoveredRail[5]!)).toBe("━━");
			expect(hoveredRail[5]).toContain(primaryFgEsc);

			const popupOverlay = harness.tui.overlayStack.find(
				(o) => o.options?.nonCapturing && o.component instanceof OutlinePreviewPopup,
			);
			expect(popupOverlay).toBeDefined();

			const popupWidth = Number(popupOverlay!.options?.width ?? 32);
			const rawPopupLines = popupOverlay!.component.render(popupWidth);
			const plainPopupLines = rawPopupLines.map(stripTerminalSequences);

			expect(plainPopupLines[0]?.trim()).toBe("15:14");
			expect(plainPopupLines[0]?.endsWith("15:14")).toBe(true);
			expect(plainPopupLines[1]?.startsWith("╭")).toBe(true);
			expect(plainPopupLines[1]?.endsWith("╮")).toBe(true);
			expect(rawPopupLines[1]).toContain(harness.ctx.ui.theme.getFgAnsi("borderMuted"));
			expect(plainPopupLines.slice(1).join("\n")).toContain("Second prompt beta");
			expect(plainPopupLines.join("\n")).not.toContain("Реплика");
			expect(plainPopupLines.at(-1)?.startsWith("╰")).toBe(true);
			expect(plainPopupLines.at(-1)?.endsWith("╯")).toBe(true);

			const modal = harness.tui.showOverlay({ render: () => ["modal"], invalidate() {} }, {});
			expect(harness.tui.isOverlayVisible(popupOverlay!)).toBe(false);
			modal.hide();
			expect(harness.tui.isOverlayVisible(popupOverlay!)).toBe(true);

			rail.handleMouse({
				type: "move",
				button: "none",
				x: 0,
				y: 0,
				screenX: 97,
				screenY: 0,
				width: 2,
				height: 12,
			} as TuiMouseEvent);
			expect(harness.tui.overlayStack.some((o) => o.component instanceof OutlinePreviewPopup)).toBe(false);
			rail.dispose();
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
			const branch = [
				{ type: "message", id: "u1", message: { role: "user", content: longPrompt1, timestamp: t1 } },
				{ type: "message", id: "u2", message: { role: "user", content: "Next turn prompt", timestamp: t2 } },
			];

			harness = createExtensionHarness({
				theme: themeMode,
				width: 100,
				height: 16,
				entries: branch,
				branch,
			});
			const originalRoot = harness.tui.layoutRoot;
			harness.mount(conartiPiUi);
			await harness.startSession();

			/* Первичный layoutRoot не оборачивается во внешний VStack/HStack */
			expect(harness.tui.layoutRoot).toBe(originalRoot);

			harness.tui.chatContainer.addChild(
				new UserMessageComponent(longPrompt1, undefined, 1, [], "u1", new Date(t1).toISOString()),
			);
			harness.tui.chatContainer.addChild({
				render: () => Array.from({ length: 12 }, (_, idx) => `response-one-row-${idx + 1}`),
				invalidate() {},
			});
			harness.tui.chatContainer.addChild(
				new UserMessageComponent("Next turn prompt", undefined, 1, [], "u2", new Date(t2).toISOString()),
			);
			harness.tui.chatContainer.addChild({
				render: () => Array.from({ length: 14 }, (_, idx) => `response-two-row-${idx + 1}`),
				invalidate() {},
			});

			/* Начальный рендер на scrollTop = 0 */
			harness.tui.renderViewport(100, 16);
			harness.tui.scroll.scrollTo(0, { disableFollow: true });
			const atTopFrame = harness.tui.renderViewport(100, 16);
			const initialViewportHeight = harness.tui.scroll.viewportHeight;
			expect(initialViewportHeight).toBe(16);

			/* На scrollTop = 0 карточка Turn 1 показывает все 5 строк контента в транскрипте (не свернута Sticky Prompt) */
			const plainTop = atTopFrame.map(stripTerminalSequences);
			expect(plainTop.join("\n")).toContain("Line four hidden while collapsed");

			/* Скроллим на scrollTop = 8 (внутри ответа Turn 1): Sticky Prompt закрепляется свернутым до 3 строк + vpad = 5 строк */
			harness.tui.scroll.scrollTo(8, { disableFollow: true });
			const midFrame = harness.tui.renderViewport(100, 16);
			expect(harness.tui.scroll.viewportHeight).toBe(initialViewportHeight);

			/* Правая колонка (99) рендерит нативный скроллбар, а колонки 97..98 - Outline Rail */
			const scrollbarCells = midFrame.map((line) => stripTerminalSequences(sliceByColumn(line, 99, 1, true)));
			expect(scrollbarCells.some((ch) => ch === "┃" || ch === "│" || ch === "█")).toBe(true);

			const railCellsVisibleScrollbar = midFrame.map((line) =>
				stripTerminalSequences(sliceByColumn(line, 97, 2, true)),
			);
			expect(railCellsVisibleScrollbar.some((cell) => cell === " ▲")).toBe(true);
			expect(railCellsVisibleScrollbar.some((cell) => cell === "──")).toBe(true);
			expect(railCellsVisibleScrollbar.some((cell) => cell === " ─")).toBe(true);
			expect(railCellsVisibleScrollbar.some((cell) => cell === " ▼")).toBe(true);

			/* Когда auto-скроллбар скрывается по таймауту, Outline Rail остается ровно в колонках 97..98 без сдвига */
			(harness.tui.scroll as any).hideTransientScrollbar();
			expect(harness.tui.scroll.isScrollbarVisible).toBe(false);
			const hiddenScrollbarFrame = harness.tui.renderViewport(100, 16);
			const railCellsHiddenScrollbar = hiddenScrollbarFrame.map((line) =>
				stripTerminalSequences(sliceByColumn(line, 97, 2, true)),
			);
			expect(railCellsHiddenScrollbar).toEqual(railCellsVisibleScrollbar);

			/* Перетаскивание нативного скроллбара в правой колонке 99 меняет scrollTop */
			harness.tui.moveMouse(99, 1);
			harness.tui.pressMouse(99, 1, "left");
			harness.tui.dragMouse(99, 12, "left");
			harness.tui.releaseMouse(99, 12, "left");
			expect(harness.tui.scroll.scrollTop).toBeGreaterThan(10);

			/* Возвращаемся на scrollTop = 8 и проверяем свернутый Sticky Prompt (3 строки текста + … без #N/M и ↑ ↓) */
			harness.tui.scroll.scrollTo(8, { disableFollow: true });
			const stickyCollapsedFrame = harness.tui.renderViewport(100, 16);
			const stickyTopFive = stickyCollapsedFrame
				.slice(0, 5)
				.map((line) => stripTerminalSequences(sliceByColumn(line, 0, 97, true)));
			expect(stickyTopFive[0]?.trim()).toBe("");
			expect(stickyTopFive[1]).toContain("› Line one of multi-line user prompt");
			expect(stickyTopFive[1]?.trimEnd().endsWith("10:15")).toBe(true);
			expect(stickyTopFive[2]).toContain("Line two of multi-line user prompt");
			expect(stickyTopFive[3]).toContain("Line three of multi-line user prompt");
			expect(stickyTopFive[3]).toContain("…");
			expect(stickyTopFive[4]?.trim()).toBe("");
			expect(stickyTopFive.join("\n")).not.toContain("#1/2");
			expect(stickyTopFive.join("\n")).not.toContain("↑");
			expect(stickyTopFive.join("\n")).not.toContain("Line four hidden while collapsed");

			/* Клик по Sticky Prompt разворачивает полный текст, повторный клик или хоткей сворачивает обратно */
			harness.tui.clickMouse(12, 2, "left");
			const expandedFrame = harness.tui.renderViewport(100, 16);
			expect(harness.tui.scroll.viewportHeight).toBe(initialViewportHeight);
			const plainExpandedTop = expandedFrame
				.slice(0, 7)
				.map((line) => stripTerminalSequences(sliceByColumn(line, 0, 97, true)));
			expect(plainExpandedTop.join("\n")).toContain("Line four hidden while collapsed");
			expect(plainExpandedTop.join("\n")).toContain("Line five hidden while collapsed");

			vi.spyOn(harness.keybindings, "matches").mockImplementation(
				(data, action) => data === "\x1b[15~" && action === "app.tools.expand",
			);
			for (const listener of harness.terminalInputListeners) {
				listener("\x1b[15~");
			}
			const recollapsedFrame = harness.tui.renderViewport(100, 16);
			expect(
				recollapsedFrame
					.slice(0, 6)
					.map((line) => stripTerminalSequences(sliceByColumn(line, 0, 97, true)))
					.join("\n"),
			).not.toContain("Line four hidden while collapsed");

			/* Построчное вытеснение (pushOffset): карточка Turn 1 занимает 7 строк (0..6) + 12 строк ответа = Turn 2 начинается на строке 19.
			   При stickyHeight = 5:
			   scrollTop = 14 -> distance = 5 -> pushOffset = 0 (видимы все 5 строк Sticky)
			   scrollTop = 16 -> distance = 3 -> pushOffset = 2 (верхние 2 строки вытеснены, строка 3 контента теперь на экранной строке 1, а карточка Turn 2 начинается ровно на строке 3!)
			   scrollTop = 19 -> distance = 0 -> pushOffset = 5 (Sticky полностью вытеснен, карточка Turn 2 на строке 0)
			   scrollTop = 20 -> закрепляется уже один Turn 2! */
			harness.tui.scroll.scrollTo(16, { disableFollow: true });
			const pushedFrame = harness.tui.renderViewport(100, 16);
			const plainPushed = pushedFrame.map((line) => stripTerminalSequences(sliceByColumn(line, 0, 97, true)));
			expect(plainPushed[0]).toContain("Line two of multi-line user prompt");
			expect(plainPushed[1]).toContain("Line three of multi-line user prompt");
			expect(plainPushed[2]?.trim()).toBe("");
			expect(plainPushed[4]).toContain("› Next turn prompt");

			harness.tui.scroll.scrollTo(20, { disableFollow: true });
			const turn2PinnedFrame = harness.tui.renderViewport(100, 16);
			const plainTurn2Pinned = turn2PinnedFrame
				.slice(0, 4)
				.map((line) => stripTerminalSequences(sliceByColumn(line, 0, 97, true)));
			expect(plainTurn2Pinned[0]?.trim()).toBe("");
			expect(plainTurn2Pinned[1]).toContain("› Next turn prompt");
			expect(plainTurn2Pinned[1]?.trimEnd().endsWith("10:30")).toBe(true);
			expect(plainTurn2Pinned.join("\n")).not.toContain("Line one of multi-line user prompt");
		},
	);

	it("preserves inline Kitty image scrolling below Sticky Prompt while stripping covered image sequences under Sticky Prompt rows", async () => {
		const t1 = new Date(2026, 3, 19, 11, 0).getTime();
		const t2 = new Date(2026, 3, 19, 11, 10).getTime();
		const branch = [
			{ type: "message", id: "u1", message: { role: "user", content: "Show chart", timestamp: t1 } },
			{ type: "message", id: "u2", message: { role: "user", content: "Follow up", timestamp: t2 } },
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 100,
			height: 14,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		const kittySeq = "\x1b_Ga=T,f=100,i=91,c=40,r=3;AAAA\x1b\\";
		harness.tui.chatContainer.addChild(
			new UserMessageComponent("Show chart", undefined, 1, [], "u1", new Date(t1).toISOString()),
		);
		harness.tui.chatContainer.addChild({
			render: () => [
				"intro-1",
				"intro-2",
				kittySeq,
				"",
				"",
				...Array.from({ length: 12 }, (_, idx) => `after-image-${idx + 1}`),
			],
			invalidate() {},
		});
		harness.tui.chatContainer.addChild(
			new UserMessageComponent("Follow up", undefined, 1, [], "u2", new Date(t2).toISOString()),
		);
		harness.tui.chatContainer.addChild({
			render: () => Array.from({ length: 10 }, (_, idx) => `tail-${idx + 1}`),
			invalidate() {},
		});

		/* Карточка Turn 1 занимает строки 0..2, intro 3..4, Kitty-изображение на строке 5.
		   При scrollTop = 1: Sticky Prompt закрывает экранные строки 0..2, а изображение остается открытым на экранной строке 4! */
		harness.tui.renderViewport(100, 14);
		harness.tui.scroll.scrollTo(1, { disableFollow: true });
		const uncoveredImageFrame = harness.tui.renderViewport(100, 14);
		expect(uncoveredImageFrame[4]).toContain("\x1b_G");
		expect(uncoveredImageFrame.slice(0, 3).some((line) => line.includes("\x1b_G"))).toBe(false);

		/* При scrollTop = 4 строка 5 с Kitty-изображением попадает на экранную строку 1 под Sticky Prompt (0..2):
		   последовательность изображения очищается, и поверх рендерится Sticky Prompt */
		harness.tui.scroll.scrollTo(4, { disableFollow: true });
		const coveredImageFrame = harness.tui.renderViewport(100, 14);
		expect(coveredImageFrame.slice(0, 3).some((line) => line.includes("\x1b_G"))).toBe(false);
		expect(stripTerminalSequences(coveredImageFrame[1]!)).toContain("› Show chart");
	});

	it("prevents applySelection highlight bleed onto composited Sticky Prompt and Outline Rail while highlighting uncovered transcript text", async () => {
		const t1 = new Date(2026, 3, 19, 12, 0).getTime();
		const t2 = new Date(2026, 3, 19, 12, 5).getTime();
		const branch = [
			{ type: "message", id: "u1", message: { role: "user", content: "Select response lines", timestamp: t1 } },
			{ type: "message", id: "u2", message: { role: "user", content: "Second turn", timestamp: t2 } },
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 100,
			height: 14,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		harness.tui.chatContainer.addChild(
			new UserMessageComponent("Select response lines", undefined, 1, [], "u1", new Date(t1).toISOString()),
		);
		harness.tui.chatContainer.addChild({
			render: () =>
				Array.from({ length: 16 }, (_, idx) => `Selectable transcript row ${idx + 1} with wide content padding`),
			invalidate() {},
		});
		harness.tui.chatContainer.addChild(
			new UserMessageComponent("Second turn", undefined, 1, [], "u2", new Date(t2).toISOString()),
		);
		harness.tui.chatContainer.addChild({
			render: () => Array.from({ length: 12 }, (_, idx) => `Second response ${idx + 1}`),
			invalidate() {},
		});

		/* На scrollTop = 2 выделяем мышью строки 4..8 широким диапазоном до правого края */
		harness.tui.renderViewport(100, 14);
		harness.tui.scroll.scrollTo(2, { disableFollow: true });
		harness.tui.renderViewport(100, 14);

		harness.tui.pressMouse(2, 4, "left");
		harness.tui.dragMouse(96, 8, "left");
		harness.tui.releaseMouse(96, 8, "left");
		expect(harness.tui.hasActiveSelection()).toBe(true);

		/* Прокручиваем вниз до scrollTop = 6, чтобы выделенные строки транскрипта (документные 6..10) оказались прямо под Sticky Prompt (экранные 0..2) и на открытых строках 3..4 */
		harness.tui.scroll.scrollTo(6, { disableFollow: true });
		const selectedFrame = harness.tui.renderViewport(100, 14);

		/* Открытая выделенная строка 3 содержит инвертированные ячейки, но ни Sticky Prompt (0..2), ни Outline Rail + скроллбар (97..99) не инвертированы */
		expect(hasInvertedVisibleCell(sliceByColumn(selectedFrame[3]!, 0, 97, true))).toBe(true);
		for (let row = 0; row < 3; row++) {
			expect(selectedFrame[row]).not.toContain("\x1b[7m");
			expect(hasInvertedVisibleCell(selectedFrame[row]!)).toBe(false);
		}
		for (let row = 0; row < 14; row++) {
			expect(hasInvertedVisibleCell(sliceByColumn(selectedFrame[row]!, 97, 3, true))).toBe(false);
		}
	});

	it("routes mouse hover, click, and wheel events to Sticky Prompt and Outline Rail before underlying transcript rows", async () => {
		const t1 = new Date(2026, 3, 19, 14, 0).getTime();
		const t2 = new Date(2026, 3, 19, 14, 20).getTime();
		const branch = [
			{
				type: "message",
				id: "u1",
				message: {
					role: "user",
					content: "Alpha line 1\nAlpha line 2\nAlpha line 3\nAlpha line 4",
					timestamp: t1,
				},
			},
			{ type: "message", id: "u2", message: { role: "user", content: "Beta target turn", timestamp: t2 } },
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 100,
			height: 14,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		const underlyingEvents: string[] = [];
		const interactiveTranscriptBlock = {
			render: () => Array.from({ length: 16 }, (_, idx) => `interactive-row-${idx + 1}`),
			handleMouse: (event: TuiMouseEvent) => {
				underlyingEvents.push(`${event.type}:${event.y}`);
				return { handled: true, render: false };
			},
			invalidate() {},
		};

		harness.tui.chatContainer.addChild(
			new UserMessageComponent(
				"Alpha line 1\nAlpha line 2\nAlpha line 3\nAlpha line 4",
				undefined,
				1,
				[],
				"u1",
				new Date(t1).toISOString(),
			),
		);
		harness.tui.chatContainer.addChild(interactiveTranscriptBlock);
		harness.tui.chatContainer.addChild(
			new UserMessageComponent("Beta target turn", undefined, 1, [], "u2", new Date(t2).toISOString()),
		);
		harness.tui.chatContainer.addChild({
			render: () => Array.from({ length: 14 }, (_, idx) => `beta-resp-${idx + 1}`),
			invalidate() {},
		});

		/* Карточка Turn 1 занимает строки 0..5 (6 строк), interactiveTranscriptBlock занимает 6..21, Turn 2 начинается на 22.
		   На scrollTop = 8 экранные строки 0..4 заняты Sticky Prompt поверх interactiveTranscriptBlock! */
		harness.tui.renderViewport(100, 14);
		harness.tui.scroll.scrollTo(8, { disableFollow: true });
		harness.tui.renderViewport(100, 14);

		/* Наведение и клик по Sticky Prompt (экранная строка 2) НЕ попадают в нижележащий interactiveTranscriptBlock */
		harness.tui.moveMouse(15, 2);
		harness.tui.clickMouse(15, 2, "left");
		expect(underlyingEvents).toEqual([]);
		expect(harness.tui.hasActiveSelection()).toBe(false);

		const afterStickyClick = harness.tui.renderViewport(100, 14);
		expect(afterStickyClick.slice(0, 6).map(stripTerminalSequences).join("\n")).toContain("Alpha line 4");

		/* Сворачиваем обратно */
		harness.tui.clickMouse(15, 2, "left");
		harness.tui.renderViewport(100, 14);

		/* Колесо мыши по Sticky Prompt и по Outline Rail прокручивает ScrollView, не передавая wheel в нижележащий блок */
		const beforeStickyWheel = harness.tui.scroll.scrollTop;
		harness.tui.wheelMouse(15, 2, "down");
		expect(harness.tui.scroll.scrollTop).toBeGreaterThan(beforeStickyWheel);
		expect(underlyingEvents).toEqual([]);

		harness.tui.renderViewport(100, 14);
		harness.tui.moveMouse(15, 7);
		expect(underlyingEvents.length).toBe(1);
		underlyingEvents.length = 0;

		/* Наведение на тик Turn 2 в Outline Rail (x = 97, y = 7 при высоте 14 и 2 репликах: totalRows=4, top=5, ticksY=6, tick1=7)
		   монтирует Hover Popup с 14:20 над рамкой и не трогает транскрипт */
		harness.tui.moveMouse(97, 7);
		expect(underlyingEvents).toEqual([]);
		const withPopupFrame = harness.tui.renderViewport(100, 14).map(stripTerminalSequences).join("\n");
		expect(withPopupFrame).toContain("14:20");
		expect(withPopupFrame).toContain("Beta target turn");

		const beforeWheel = harness.tui.scroll.scrollTop;
		harness.tui.wheelMouse(97, 7, "down");
		expect(harness.tui.scroll.scrollTop).toBeGreaterThan(beforeWheel);
		expect(underlyingEvents).toEqual([]);

		/* Клик по тику Turn 1 (x = 97, y = 6) прыгает к началу Turn 1 (scrollTop = 0) */
		harness.tui.renderViewport(100, 14);
		harness.tui.clickMouse(97, 6, "left");
		expect(harness.tui.scroll.scrollTop).toBe(0);

		/* Уход курсора с Outline Rail на обычный транскрипт скрывает Hover Popup */
		harness.tui.renderViewport(100, 14);
		harness.tui.moveMouse(20, 10);
		expect(harness.tui.overlayStack.some((o) => o.component instanceof OutlinePreviewPopup)).toBe(false);
	});

	it("handles empty/narrow/CJK user prompts, mid-push Sticky clicks, and live /outline content margin toggling cleanly", async () => {
		const t1 = new Date(2026, 3, 19, 0, 0).getTime();
		const t2 = new Date(2026, 3, 19, 23, 59).getTime();
		const branch = [
			{
				type: "message",
				id: "u1",
				message: {
					role: "user",
					content: "日本語テスト 🚀 line 1\nКириллица строка 2\nLine 3\nHidden line 4",
					timestamp: t1,
				},
			},
			{ type: "message", id: "u2", message: { role: "user", content: "Midnight boundary check", timestamp: t2 } },
		];

		harness = createExtensionHarness({
			theme: "light",
			width: 80,
			height: 12,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		const emptyCard = new UserMessageComponent("   \n\t  ");
		expect(emptyCard.render(80)).toEqual([]);

		const cjkCard = new UserMessageComponent(
			"日本語テスト 🚀 line 1\nКириллица строка 2\nLine 3\nHidden line 4",
			undefined,
			1,
			[],
			"u1",
			new Date(t1).toISOString(),
		);
		expect(cjkCard.render(8)).toEqual([]);
		const cjkLines = cjkCard.render(77);
		for (const line of cjkLines) {
			expect(visibleWidth(line.replace(OSC133_PREFIX_RE, ""))).toBe(77);
		}
		expect(cleanPromptLine(cjkLines[1]!).trimEnd().endsWith("00:00")).toBe(true);

		harness.tui.chatContainer.addChild(cjkCard);
		harness.tui.chatContainer.addChild({
			render: () => Array.from({ length: 6 }, (_, i) => `gap-${i + 1}`),
			invalidate() {},
		});
		harness.tui.chatContainer.addChild(
			new UserMessageComponent("Midnight boundary check", undefined, 1, [], "u2", new Date(t2).toISOString()),
		);
		harness.tui.chatContainer.addChild({
			render: () => Array.from({ length: 12 }, (_, i) => `end-${i + 1}`),
			invalidate() {},
		});

		/* Карточка Turn 1 занимает 6 строк (0..5) + 6 строк ответа (6..11), Turn 2 начинается на 12.
		   При свернутом Sticky (5 строк) на scrollTop = 9: distance = 3 -> pushOffset = 2, видимы 3 строки Sticky (0..2), а на строке 3 начинается Turn 2! */
		harness.tui.renderViewport(80, 12);
		harness.tui.scroll.scrollTo(9, { disableFollow: true });
		const midPushFrame = harness.tui.renderViewport(80, 12);
		expect(stripTerminalSequences(sliceByColumn(midPushFrame[0]!, 0, 77, true))).toContain("Кириллица строка 2");
		expect(stripTerminalSequences(sliceByColumn(midPushFrame[4]!, 0, 77, true))).toContain("23:59");

		/* Клик по частично вытесненному Sticky (строка 1) корректно переводит localY с учетом pushOffset и разворачивает карточку */
		harness.tui.clickMouse(10, 1, "left");
		harness.tui.scroll.scrollTo(2, { disableFollow: true });
		const expandedAfterMidPushClick = harness.tui.renderViewport(80, 12);
		expect(expandedAfterMidPushClick.slice(0, 6).map(stripTerminalSequences).join("\n")).toContain("Hidden line 4");

		/* Выключение /outline убирает правую панель из колонок 77..78 и расширяет контент без поломки правого скроллбара в колонке 79 */
		await harness.runCommand("outline");
		const railOffFrame = harness.tui.renderViewport(80, 12);
		const railOffCols = railOffFrame.map((l) => stripTerminalSequences(sliceByColumn(l, 77, 2, true)));
		expect(railOffCols.some((c) => c === " ▲" || c === "──")).toBe(false);
		const scrollbarColOff = railOffFrame.map((l) => stripTerminalSequences(sliceByColumn(l, 79, 1, true)));
		expect(scrollbarColOff.some((ch) => ch === "┃" || ch === "│" || ch === "█")).toBe(true);
	});
});
