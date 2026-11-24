import { afterEach, describe, expect, it } from "vitest";
import { HStack, ScrollView, VStack } from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import { isLightTheme } from "../src/shared/ansi.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

describe("conartiPiUi end-to-end extension smoke", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("mounts, renders, and cleans up cleanly with dark theme in fullscreen viewport", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 120, height: 32 });
		expect(isLightTheme(harness.ctx.ui.theme)).toBe(false);

		const originalRoot = harness.tui.layoutRoot;
		harness.mount(conartiPiUi);

		// Core flags, commands, shortcuts, and tools are registered
		expect(harness.flags.has("plan")).toBe(true);
		expect(harness.commands.has("context")).toBe(true);
		expect(harness.commands.has("palette")).toBe(true);
		expect(harness.commands.has("sticky")).toBe(true);
		expect(harness.commands.has("outline")).toBe(true);
		expect(harness.shortcuts.has("alt+m")).toBe(true);
		expect(harness.shortcuts.has("ctrl+alt+p")).toBe(true);
		expect(harness.tools.has("ask_user_question")).toBe(true);

		await harness.startSession();

		// Header & composer mounted and render cleanly
		expect(harness.header).toBeDefined();
		expect(harness.editor).toBeDefined();
		const headerLines = harness.header!.render(120);
		const editorLines = harness.editor!.render(120);
		expect(headerLines.length).toBeGreaterThan(0);
		expect(editorLines.length).toBeGreaterThan(0);

		// Fullscreen shell composed VStack + HStack while preserving ScrollView native scrollbar
		expect(harness.tui.layoutRoot).not.toBe(originalRoot);
		expect(harness.tui.layoutRoot).toBeInstanceOf(VStack);
		expect(harness.tui.scroll).toBeInstanceOf(ScrollView);
		expect(harness.tui.scroll.scrollbar).toBe("auto");

		const entries = (harness.tui.layoutRoot as unknown as { entries?: Array<{ component: unknown }> }).entries ?? [];
		expect(entries.some((entry) => entry.component instanceof HStack)).toBe(true);

		const viewportLines = harness.tui.renderViewport(120, 32);
		expect(viewportLines.length).toBeGreaterThan(0);

		// Session shutdown restores original layout root cleanly
		await harness.shutdownSession();
		expect(harness.tui.layoutRoot).toBe(originalRoot);
		harness = undefined;
	});

	it("mounts, renders, and cleans up cleanly with light theme in fullscreen viewport", async () => {
		harness = createExtensionHarness({ theme: "light", width: 120, height: 32 });
		expect(isLightTheme(harness.ctx.ui.theme)).toBe(true);

		const originalRoot = harness.tui.layoutRoot;
		harness.mount(conartiPiUi);
		await harness.startSession();

		expect(harness.header).toBeDefined();
		expect(harness.editor).toBeDefined();
		expect(harness.header!.render(120).length).toBeGreaterThan(0);
		expect(harness.editor!.render(120).length).toBeGreaterThan(0);
		expect(harness.tui.renderViewport(120, 32).length).toBeGreaterThan(0);

		await harness.shutdownSession();
		expect(harness.tui.layoutRoot).toBe(originalRoot);
		harness = undefined;
	});
});
