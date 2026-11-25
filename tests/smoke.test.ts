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

		/* В реальном InteractiveMode runtime.tui — это Proxy (this.ui !== this.renderer) */
		expect(runtime!.tui).toBe(harness.tui);
		expect(harness.tui).not.toBe(harness.tui.valueOf());

		const layoutRoot = (harness.tui as unknown as { layoutRoot?: unknown }).layoutRoot;
		expect(layoutRoot).toBeInstanceOf(VStack);
		const rootEntries =
			(layoutRoot as { entries?: Array<{ component: unknown }> }).entries ?? [];
		expect(rootEntries.some((entry) => entry.component instanceof HStack)).toBe(false);
		expect(runtime!.scroll).toBeInstanceOf(ScrollView);
		expect(runtime!.scroll?.scrollbar).toBe("auto");
		expect(runtime!.viewportSlots?.topSlot).toBeDefined();
		expect(runtime!.viewportSlots?.rightRail).toBeDefined();

		/* Проверяем регистрацию слэш-команд и инструмента ask_user_question в реальной сессии */
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

		/* Отправляем два хода через реальный цикл ввода InteractiveMode */
		await harness.submitInput("First turn anchor question");
		await harness.submitInput("Second turn follow-up question");

		/* Проверяем, что Outline Rail реально скомпозирован в колонках width - 3 .. width - 2 (117..118) */
		const bottomScreen = harness.screen();
		let hasRailGlyph = false;
		for (let r = 0; r < bottomScreen.height; r += 1) {
			const railSlice = bottomScreen.sliceText(r, 117, 119);
			if (/[●○▲▼│]/.test(railSlice)) {
				hasRailGlyph = true;
				break;
			}
		}
		expect(hasRailGlyph).toBe(true);

		/* Прокручиваем вверх к обмену первого хода и проверяем закреплённый сверху Sticky Prompt */
		await harness.mouseWheel("up", 40, 10, 8);
		const scrolledScreen = harness.screen();
		const topRows = [0, 1, 2, 3].map((r) => scrolledScreen.rowText(r)).join("\n");
		expect(topRows).toContain("First turn anchor question");

		/* Возвращаемся вниз, выделяем мышью текст ответа и проверяем маску хрома + попап ╭ ❝ Цитировать ╮ */
		await harness.mouseWheel("down", 40, 10, 12);
		const readyScreen = harness.screen();
		const targetPos = readyScreen.findText("Selectable target sentence");
		expect(targetPos).toBeDefined();

		/* Тянем выделение вплоть до колонки Outline Rail (118), проверяя, что хром не инвертируется */
		await harness.mouseDrag(targetPos!.col, targetPos!.row, 118, targetPos!.row, { steps: 3 });
		const selectedScreen = harness.screen();
		expect(selectedScreen.cellAt(targetPos!.row, targetPos!.col)?.inverse).toBe(true);
		expect(selectedScreen.cellAt(targetPos!.row, 117)?.inverse).toBe(false);
		expect(selectedScreen.cellAt(targetPos!.row, 118)?.inverse).toBe(false);

		const quotePopupPos = selectedScreen.findText("Цитировать");
		expect(quotePopupPos).toBeDefined();
		expect(selectedScreen.text()).toContain("╭ ❝ Цитировать ╮");

		/* Кликаем по попапу цитирования через реальные SGR-координаты терминала */
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
