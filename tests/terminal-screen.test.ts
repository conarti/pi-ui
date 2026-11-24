import { afterEach, describe, expect, it } from "vitest";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import conartiPiUi from "../src/index.ts";
import {
	captureTerminalScreen,
	createExtensionHarness,
	parseTerminalFrame,
	type ExtensionHarness,
} from "./harness/index.ts";

describe("headless terminal screen buffer snapshot", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.shutdownSession();
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

	it("verifies composited Sticky Prompt, Outline Rail, rightmost scrollbar, and selection masking on cell grid", async () => {
		const t1 = new Date(2026, 3, 19, 10, 15).getTime();
		const t2 = new Date(2026, 3, 19, 10, 30).getTime();
		const branch = [
			{ type: "message", id: "u1", message: { role: "user", content: "First pinned prompt", timestamp: t1 } },
			{ type: "message", id: "u2", message: { role: "user", content: "Second prompt", timestamp: t2 } },
		];

		harness = createExtensionHarness({
			theme: "dark",
			width: 96,
			height: 16,
			entries: branch,
			branch,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		harness.tui.chatContainer.addChild(
			new UserMessageComponent("First pinned prompt", undefined, 1, [], "u1", new Date(t1).toISOString()),
		);
		harness.tui.chatContainer.addChild({
			render: () => Array.from({ length: 14 }, (_, idx) => `selectable transcript line ${idx + 1}`),
			invalidate() {},
		});
		harness.tui.chatContainer.addChild(
			new UserMessageComponent("Second prompt", undefined, 1, [], "u2", new Date(t2).toISOString()),
		);
		harness.tui.chatContainer.addChild({
			render: () => Array.from({ length: 12 }, (_, idx) => `tail line ${idx + 1}`),
			invalidate() {},
		});

		harness.tui.renderViewport(96, 16);
		harness.tui.scroll.scrollTo(6, { disableFollow: true });
		harness.tui.renderViewport(96, 16);

		/* Выделяем строки транскрипта и проверяем, что выделение не инвертирует Sticky Prompt и Outline Rail */
		harness.tui.pressMouse(4, 5, "left");
		harness.tui.dragMouse(28, 7, "left");
		harness.tui.releaseMouse(28, 7, "left");

		const screen = captureTerminalScreen(harness.tui, 96, 16);

		expect(screen.sliceText(1, 0, 40)).toContain("› First pinned prompt");
		expect(screen.cellAt(1, 2)?.bg.kind).toBe("rgb");

		const hasRightmostScrollbar = Array.from({ length: 16 }, (_, r) => screen.cellAt(r, 95)?.char).some(
			(ch) => ch === "┃" || ch === "│" || ch === "█",
		);
		expect(hasRightmostScrollbar).toBe(true);

		const railSlices = Array.from({ length: 16 }, (_, r) => screen.sliceText(r, 93, 95));
		expect(railSlices.some((s) => s === " ▲")).toBe(true);
		expect(railSlices.some((s) => s === "──")).toBe(true);

		const transcriptSelected = Array.from({ length: 30 }, (_, c) => screen.cellAt(6, c)?.inverse === true).some(
			Boolean,
		);
		expect(transcriptSelected).toBe(true);

		for (let r = 0; r < 3; r += 1) {
			for (let c = 0; c < 93; c += 1) {
				expect(screen.cellAt(r, c)?.inverse).toBe(false);
			}
		}
		for (let r = 0; r < 16; r += 1) {
			expect(screen.cellAt(r, 93)?.inverse).toBe(false);
			expect(screen.cellAt(r, 94)?.inverse).toBe(false);
		}
	});
});
