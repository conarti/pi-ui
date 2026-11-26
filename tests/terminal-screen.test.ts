import { afterEach, describe, expect, it } from "vitest";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import {
	captureTerminalScreen,
	createInteractiveHarness,
	fauxAssistantMessage,
	parseTerminalFrame,
	type InteractiveHarness,
} from "./harness/index.ts";

function buildLines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, idx) => `${prefix} ${idx + 1}`).join("\n");
}

describe("headless terminal screen buffer snapshot", () => {
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
	});

	it("decodes truecolor, 256-color, inverse attributes, OSC 8 hyperlinks, wide graphemes, and inline images", () => {
		const screen = parseTerminalFrame(
			[
				"\x1b_Ga=T,f=100,r=4,y=40,h=80;AAAA\x1b\\\x1b[38;2;59;130;246;48;2;24;32;48;1m🚀\x1b[0m \x1b]8;;https://example.com\x07\x1b[38;5;110;4mLink\x1b[0m\x1b]8;;\x07 \x1b[7mSEL\x1b[27m",
			],
			24,
		);

		expect(screen.images).toHaveLength(1);
		expect(screen.images[0]).toMatchObject({
			protocol: "kitty",
			row: 0,
			col: 0,
			params: { a: "T", f: "100", r: "4", y: "40", h: "80" },
		});

		expect(screen.cellAt(0, 0)).toMatchObject({
			char: "🚀",
			width: 2,
			bold: true,
			fg: { kind: "rgb", r: 59, g: 130, b: 246 },
			bg: { kind: "rgb", r: 24, g: 32, b: 48 },
		});
		expect(screen.cellAt(0, 1)?.width).toBe(0);

		expect(screen.cellAt(0, 3)).toMatchObject({
			char: "L",
			underline: true,
			fg: { kind: "palette256", index: 110 },
			hyperlink: "https://example.com",
		});

		expect(screen.cellAt(0, 8)).toMatchObject({
			char: "S",
			inverse: true,
		});
		expect(screen.cellAt(0, 11)?.inverse).toBe(false);
	});

	it("verifies composited Sticky Prompt, over-scrollbar Outline Rail, and selection masking on cell grid in real InteractiveMode", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 96,
			height: 24,
			responses: [
				fauxAssistantMessage(buildLines("selectable transcript line", 16)),
				fauxAssistantMessage(buildLines("tail line", 14)),
			],
		});

		await harness.submitInput("First pinned prompt");
		await harness.submitInput("Second prompt");

		await harness.mouseWheel("up", 20, 8, 5);

		const preSelect = harness.screen();
		const targetPos = preSelect.findText("selectable transcript line");
		expect(targetPos).toBeDefined();
		expect(targetPos!.row).toBeGreaterThanOrEqual(6);

		const headerRows = 3;
		const railGeo = getActiveHostRuntime()?.viewportSlots?.rightRail?.geometry!;
		expect(railGeo).toBeDefined();
		const railScreenUp = headerRows + railGeo.upY;
		const railScreenDown = headerRows + railGeo.downY;
		await harness.mouseDrag(
			targetPos!.col,
			Math.min(targetPos!.row, railScreenUp),
			95,
			Math.max(targetPos!.row + 1, railScreenDown),
			{ steps: 3 },
		);

		const screen = captureTerminalScreen(harness);
		const viewportRows = getActiveHostRuntime()?.scroll?.viewportHeight ?? 14;

		expect(screen.sliceText(4, 0, 44)).toContain("› First pinned prompt");
		expect(screen.cellAt(4, 2)?.bg.kind).toBe("rgb");
		expect(screen.cellAt(4, 0)?.bg.kind).toBe("default");

		const railSlices = Array.from({ length: viewportRows }, (_, r) =>
			screen.sliceText(headerRows + r, 94, 96),
		);
		expect(railSlices.some((s) => s === " ▲")).toBe(true);
		expect(railSlices.some((s) => s === "━━")).toBe(true);

		const transcriptSelected = Array.from(
			{ length: 40 },
			(_, c) => screen.cellAt(targetPos!.row, c)?.inverse === true,
		).some(Boolean);
		expect(transcriptSelected).toBe(true);

		for (let r = headerRows; r < headerRows + 3; r += 1) {
			for (let c = 0; c < 94; c += 1) {
				expect(screen.cellAt(r, c)?.inverse).toBe(false);
			}
		}
		for (let r = railScreenUp; r <= railScreenDown; r += 1) {
			expect(screen.cellAt(r, 94)?.inverse).toBe(false);
			expect(screen.cellAt(r, 95)?.inverse).toBe(false);
		}
	});
});
