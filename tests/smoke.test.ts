import { afterEach, describe, expect, it } from "vitest";
import { HStack, ScrollView, VStack } from "@earendil-works/pi-tui";
import { isLightTheme } from "../src/shared/ansi.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

function buildTallReply(prefix: string, linesCount: number, markerLine?: string): string {
	const lines: string[] = [];
	for (let i = 1; i <= linesCount; i += 1) {
		lines.push(`${prefix} line ${i}: detailed response content for viewport scrolling.`);
	}
	if (markerLine) {
		lines.push(markerLine);
	}
	return lines.join("\n");
}

describe("conartiPiUi end-to-end InteractiveMode smoke", () => {
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
	});

	it("mounts in dark theme over InteractiveMode Proxy, renders Sticky Prompt + Outline Rail, masks chrome selection, and quotes via mouse Hover Popup", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 120,
			height: 28,
			responses: [
				fauxAssistantMessage(buildTallReply("Alpha response", 20)),
				fauxAssistantMessage(
					buildTallReply("Beta response", 12, "Selectable target sentence for quoting"),
				),
			],
		});

		const runtime = getActiveHostRuntime();
		expect(runtime).toBeDefined();
		expect(isLightTheme(runtime!.theme())).toBe(false);

		/* В реальном InteractiveMode runtime.tui является Proxy-обёрткой (this.ui !== this.renderer) */
		expect(runtime!.tui).toBe(harness.tui);
		expect(harness.tui).not.toBe(harness.tui.valueOf());

		const layoutRoot = (harness.tui as unknown as { layoutRoot?: unknown }).layoutRoot;
		expect(layoutRoot).toBeInstanceOf(VStack);
		const rootEntries =
			(layoutRoot as { entries?: Array<{ component: unknown }> }).entries ?? [];
		expect(rootEntries.some((entry) => entry.component instanceof HStack)).toBe(false);
		expect(runtime!.scroll).toBeInstanceOf(ScrollView);
		expect(runtime!.scroll?.scrollbar).toBe("hidden");
		expect(runtime!.viewportSlots?.pinnedHeader).toBeDefined();
		expect(runtime!.viewportSlots?.topSlot).toBeDefined();
		expect(runtime!.viewportSlots?.rightRail).toBeDefined();

		const slashNames = new Set(
			harness.session.extensionRunner?.getRegisteredCommands().map((cmd) => cmd.name) ?? [],
		);
		expect(slashNames.has("context")).toBe(true);
		expect(slashNames.has("palette")).toBe(true);
		expect(slashNames.has("sticky")).toBe(true);
		expect(slashNames.has("outline")).toBe(true);
		expect(slashNames.has("quote")).toBe(true);
		expect(slashNames.has("quotes")).toBe(true);

		const allToolNames = new Set(harness.session.getAllTools().map((tool) => tool.name));
		expect(allToolNames.has("ask_user_question")).toBe(true);

		await harness.submitInput("First turn anchor question");
		await harness.submitInput("Second turn follow-up question");

		const bottomScreen = harness.screen();
		let hasRailGlyph = false;
		for (let r = 3; r < bottomScreen.height; r += 1) {
			const railSlice = bottomScreen.sliceText(r, 118, 120);
			if (/[▲▼━─]/.test(railSlice)) {
				hasRailGlyph = true;
				break;
			}
		}
		expect(hasRailGlyph).toBe(true);

		await harness.mouseWheel("up", 40, 10, 8);
		const scrolledScreen = harness.screen();
		const topRows = [3, 4, 5].map((r) => scrolledScreen.rowText(r)).join("\n");
		expect(topRows).toContain("First turn anchor question");

		await harness.mouseWheel("down", 40, 10, 12);
		const readyScreen = harness.screen();
		const targetPos = readyScreen.findText("Selectable target sentence");
		expect(targetPos).toBeDefined();

		const railGeo = getActiveHostRuntime()!.viewportSlots!.rightRail!.geometry!;
		const railScreenDownY = 3 + railGeo.downY;
		await harness.mouseDrag(
			targetPos!.col,
			targetPos!.row,
			119,
			Math.min(targetPos!.row, railScreenDownY),
			{ steps: 3 },
		);
		const selectedScreen = harness.screen();
		expect(selectedScreen.cellAt(targetPos!.row, targetPos!.col)?.inverse).toBe(true);
		expect(selectedScreen.cellAt(railScreenDownY, 118)?.inverse).toBe(false);
		expect(selectedScreen.cellAt(railScreenDownY, 119)?.inverse).toBe(false);

		const quotePopupPos = selectedScreen.findText("[Quote · Alt+Q]");
		expect(quotePopupPos).toBeDefined();
		expect(selectedScreen.text()).toContain("[Copy]  [Quote · Alt+Q]");

		await harness.mouseClick(quotePopupPos!.col + 2, quotePopupPos!.row);
		const afterQuoteScreen = harness.screen();
		expect(afterQuoteScreen.text()).toContain("Quote #1");

		await harness.dispose();
		expect(getActiveHostRuntime()).toBeUndefined();
		harness = undefined;
	});

	it("mounts cleanly with light package theme and --plan flag in fullscreen viewport", async () => {
		harness = await createInteractiveHarness({
			theme: "light",
			flags: { plan: true },
			width: 120,
			height: 28,
		});

		const runtime = getActiveHostRuntime();
		expect(runtime).toBeDefined();
		expect(isLightTheme(runtime!.theme())).toBe(true);

		const frame = harness.screen();
		expect(frame.height).toBe(28);
		expect(frame.text()).toContain("Plan");

		await harness.dispose();
		expect(getActiveHostRuntime()).toBeUndefined();
		harness = undefined;
	});
});
