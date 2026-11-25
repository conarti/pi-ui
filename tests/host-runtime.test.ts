import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AssistantMessageComponent,
	defineTool,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HStack, ScrollView, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { getActiveHostRuntime, unwrapHostTui } from "../src/shared/host-runtime.ts";
import { hookMethod } from "../src/shared/runtime-hooks.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type InteractiveHarness,
} from "./harness/index.ts";

function buildMultiLineText(prefix: string, lines: number): string {
	const out: string[] = [];
	for (let i = 1; i <= lines; i += 1) {
		out.push(`${prefix} row ${i}: transcript line for fullscreen chrome testing.`);
	}
	return out.join("\n");
}

function hasRenderedOutlineRail(harness: InteractiveHarness): boolean {
	const screen = harness.screen();
	const railStart = screen.width - 3;
	const railEnd = screen.width - 1;
	for (let r = 0; r < screen.height; r += 1) {
		if (/[●○▲▼│]/.test(screen.sliceText(r, railStart, railEnd))) {
			return true;
		}
	}
	return false;
}

describe("Host Runtime seam (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function createProjectDir(compactConfig?: Record<string, unknown>): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-ui-host-rt-"));
		tempDirs.push(dir);
		if (compactConfig) {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "compact-tools.json"),
				`${JSON.stringify(compactConfig, null, 2)}\n`,
				"utf8",
			);
		}
		return dir;
	}

	afterEach(async () => {
		vi.useRealTimers();
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("acquires host TUI Proxy in fullscreen mode with unwrapped VStack layoutRoot and zero belowEditor probe widgets", async () => {
		harness = await createInteractiveHarness({ theme: "dark", width: 120, height: 32 });

		const runtime = getActiveHostRuntime();
		expect(runtime).toBeDefined();
		expect(runtime!.tui).toBe(harness.tui);
		expect(unwrapHostTui(runtime!.tui)).not.toBe(runtime!.tui);
		expect(unwrapHostTui(runtime!.tui)).toBeInstanceOf(TuiAltScreen);
		expect(runtime!.isFullscreen).toBe(true);
		expect(runtime!.scroll).toBeInstanceOf(ScrollView);
		expect(runtime!.scroll?.scrollbar).toBe("auto");
		expect(runtime!.chatContainer).toBeDefined();
		expect(runtime!.viewportSlots?.topSlot).toBeDefined();
		expect(runtime!.viewportSlots?.rightRail).toBeDefined();

		const layoutRoot = (harness.tui as unknown as { layoutRoot?: unknown }).layoutRoot;
		expect(layoutRoot).toBeInstanceOf(VStack);
		const entries =
			(layoutRoot as { entries?: Array<{ component: unknown }> }).entries ?? [];
		expect(entries.some((entry) => entry.component instanceof HStack)).toBe(false);

		/* Контейнер widgetContainerBelow (индекс 5 в tui.children) не содержит пустых пробных виджетов */
		const rootChildren = (harness.tui as unknown as { children?: Array<{ children?: unknown[] }> }).children ?? [];
		const widgetBelow = rootChildren[5];
		expect(widgetBelow?.children ?? []).toEqual([]);
	});

	it("transitions live between regular and fullscreen TUI modes, rebinding ViewportChromeCompositor onto new renderers and dismissing Hover Popups cleanly", async () => {
		harness = await createInteractiveHarness({
			tuiMode: "regular",
			theme: "dark",
			width: 120,
			height: 28,
			responses: [
				fauxAssistantMessage(buildMultiLineText("TurnOne", 18)),
				fauxAssistantMessage(
					`${buildMultiLineText("TurnTwo", 10)}\nQuotable line across mode switch`,
				),
			],
		});

		const runtime = getActiveHostRuntime();
		expect(runtime).toBeDefined();
		expect(runtime!.isFullscreen).toBe(false);
		expect(runtime!.scroll).toBeUndefined();
		expect(runtime!.viewportSlots).toBeUndefined();
		expect(runtime!.chatContainer).toBeDefined();

		await harness.submitInput("Prompt in regular mode 1");
		await harness.submitInput("Prompt in regular mode 2");

		const switchedToFullscreen = await harness.setTuiMode("fullscreen");
		expect(switchedToFullscreen).toBe(true);
		expect(runtime!.isFullscreen).toBe(true);
		expect(runtime!.scroll).toBeInstanceOf(ScrollView);
		expect(runtime!.viewportSlots?.topSlot).toBeDefined();
		expect(runtime!.viewportSlots?.rightRail).toBeDefined();
		expect(hasRenderedOutlineRail(harness)).toBe(true);

		const firstAltRenderer = unwrapHostTui(harness.tui);
		expect(firstAltRenderer).toBeInstanceOf(TuiAltScreen);

		const fsScreen = harness.screen();
		const quoteTarget = fsScreen.findText("Quotable line across mode switch");
		expect(quoteTarget).toBeDefined();
		await harness.mouseDrag(
			quoteTarget!.col,
			quoteTarget!.row,
			quoteTarget!.col + 12,
			quoteTarget!.row,
		);
		expect(harness.screen().text()).toContain("╭ ❝ Цитировать ╮");

		const switchedToRegular = await harness.setTuiMode("regular");
		expect(switchedToRegular).toBe(true);
		expect(runtime!.isFullscreen).toBe(false);
		expect(runtime!.scroll).toBeUndefined();
		expect(runtime!.viewportSlots).toBeUndefined();

		const switchedBackToFullscreen = await harness.setTuiMode("fullscreen");
		expect(switchedBackToFullscreen).toBe(true);
		const secondAltRenderer = unwrapHostTui(harness.tui);
		expect(secondAltRenderer).toBeInstanceOf(TuiAltScreen);
		expect(secondAltRenderer).not.toBe(firstAltRenderer);
		expect(runtime!.isFullscreen).toBe(true);
		expect(runtime!.viewportSlots?.topSlot).toBeDefined();
		expect(runtime!.viewportSlots?.rightRail).toBeDefined();
		expect(hasRenderedOutlineRail(harness)).toBe(true);

		await harness.mouseWheel("up", 40, 10, 8);
		const stickyTop = [0, 1, 2, 3].map((r) => harness!.screen().rowText(r)).join("\n");
		expect(stickyTop).toContain("Prompt in regular mode 1");
		await harness.mouseWheel("down", 40, 10, 12);

		await harness.paste("/palette", true);
		await harness.sendInput("\r");
		expect(harness.screen().text()).toContain("Поиск команд");
		expect(await harness.setTuiMode("regular")).toBe(false);
		await harness.pressKey("\x1b");
		expect(harness.screen().text()).not.toContain("Поиск команд");

		const reboundScreen = harness.screen();
		const reboundTarget = reboundScreen.findText("Quotable line across mode switch");
		expect(reboundTarget).toBeDefined();
		await harness.mouseDrag(
			reboundTarget!.col,
			reboundTarget!.row,
			reboundTarget!.col + 12,
			reboundTarget!.row,
		);
		expect(harness.screen().text()).toContain("╭ ❝ Цитировать ╮");

		await harness.dispose();
		expect(getActiveHostRuntime()).toBeUndefined();
		harness = undefined;
	});

	it("re-asserts 1003h pointer-motion tracking after TuiAltScreen.beforeTerminalStart writes 1002h inside terminal multiplexers", async () => {
		const prevTmux = process.env.TMUX;
		process.env.TMUX = "/tmp/tmux-1000/default,42,0";
		try {
			harness = await createInteractiveHarness({
				tuiMode: "regular",
				theme: "dark",
				width: 110,
				height: 28,
				responses: [
					fauxAssistantMessage(buildMultiLineText("MuxTurn1", 14)),
					fauxAssistantMessage(buildMultiLineText("MuxTurn2", 14)),
				],
			});

			await harness.submitInput("Mux prompt 1");
			await harness.submitInput("Mux prompt 2");

			const writeOffsetFirst = harness.terminal.writes.length;
			expect(await harness.setTuiMode("fullscreen")).toBe(true);
			const firstSwitchStream = harness.terminal.writes.slice(writeOffsetFirst).join("");
			expect(firstSwitchStream.indexOf("\x1b[?1049h")).toBeGreaterThanOrEqual(0);
			expect(firstSwitchStream.indexOf("\x1b[?1002h")).toBeGreaterThanOrEqual(0);
			expect(firstSwitchStream.lastIndexOf("\x1b[?1003h")).toBeGreaterThan(
				firstSwitchStream.lastIndexOf("\x1b[?1002h"),
			);

			expect(await harness.setTuiMode("regular")).toBe(true);

			const writeOffsetSecond = harness.terminal.writes.length;
			expect(await harness.setTuiMode("fullscreen")).toBe(true);
			const secondSwitchStream = harness.terminal.writes.slice(writeOffsetSecond).join("");
			expect(secondSwitchStream.indexOf("\x1b[?1002h")).toBeGreaterThanOrEqual(0);
			expect(secondSwitchStream.lastIndexOf("\x1b[?1003h")).toBeGreaterThan(
				secondSwitchStream.lastIndexOf("\x1b[?1002h"),
			);
		} finally {
			if (prevTmux === undefined) {
				delete process.env.TMUX;
			} else {
				process.env.TMUX = prevTmux;
			}
		}
	});

	it("consolidates prototype hooks without stacking across reloads or legacy markers", () => {
		let originalCalls = 0;
		const proto = {
			render(value: string) {
				originalCalls += 1;
				return `orig:${value}`;
			},
		};

		/* Имитация устаревшего расширения, сохранившего исходный метод под legacy-символом */
		const legacyOriginalSym = Symbol.for("test.legacy.original.render");
		const unwrapped = proto.render;
		Object.defineProperty(proto, legacyOriginalSym, { value: unwrapped });
		proto.render = function legacyWrapper(value: string) {
			return `legacy:${unwrapped.call(this, value)}`;
		};

		hookMethod(
			proto,
			"render",
			"test.consolidated",
			(_self, args, orig) => `v1:${orig.apply(_self, args)}`,
			[legacyOriginalSym],
		);
		const firstWrapper = proto.render;
		expect(proto.render("a")).toBe("v1:orig:a");
		expect(originalCalls).toBe(1);

		/* Повторная регистрация при /reload обновляет обработчик на месте без вложенных обёрток */
		hookMethod(
			proto,
			"render",
			"test.consolidated",
			(_self, args, orig) => `v2:${orig.apply(_self, args)}`,
			[legacyOriginalSym],
		);
		expect(proto.render).toBe(firstWrapper);
		expect(proto.render("b")).toBe("v2:orig:b");
		expect(originalCalls).toBe(2);
	});

	it("hot-swaps cleanly across real /reload and style switches without stacking wrappers or leaking timers", async () => {
		const projectDir = createProjectDir({ style: "compact", thinking: true, working: true });
		writeFileSync(join(projectDir, "sample.txt"), "hello reload\n", "utf8");

		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: projectDir,
			projectTrusted: true,
			width: 120,
			height: 30,
			responses: [
				fauxAssistantMessage(
					[
						fauxThinking("Inspecting sample file\nDetailed internal reasoning body"),
						fauxToolCall("read", { path: "sample.txt" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(buildMultiLineText("FirstReloadReply", 16)),
				fauxAssistantMessage(buildMultiLineText("SecondReloadReply", 16)),
			],
		});

		await harness.submitInput("/silent on");
		await harness.submitInput("Run first turn before reload");

		const updateContentAfterFirst = AssistantMessageComponent.prototype.updateContent;
		const assistantRenderAfterFirst = AssistantMessageComponent.prototype.render;
		const toolRenderAfterFirst = ToolExecutionComponent.prototype.render;
		const userRenderAfterFirst = UserMessageComponent.prototype.render;
		const altProto = TuiAltScreen.prototype as unknown as Record<string, unknown>;
		const altDoRenderAfterFirst = altProto.doRender;
		const altMouseAfterFirst = altProto.handleMouseEvent;
		const altCompositeAfterFirst = altProto.compositeScrollToEndIndicator;

		await harness.reload();
		await harness.submitInput("Run second turn after reload");
		await harness.submitInput("/silent off");

		expect(AssistantMessageComponent.prototype.updateContent).toBe(updateContentAfterFirst);
		expect(AssistantMessageComponent.prototype.render).toBe(assistantRenderAfterFirst);
		expect(ToolExecutionComponent.prototype.render).toBe(toolRenderAfterFirst);
		expect(UserMessageComponent.prototype.render).toBe(userRenderAfterFirst);
		expect(altProto.doRender).toBe(altDoRenderAfterFirst);
		expect(altProto.handleMouseEvent).toBe(altMouseAfterFirst);
		expect(altProto.compositeScrollToEndIndicator).toBe(altCompositeAfterFirst);

		expect(hasRenderedOutlineRail(harness)).toBe(true);

		vi.useFakeTimers();
		await harness.submitInput("/compact-tools claude");
		await harness.submitInput("/compact-tools codex");
		await harness.submitInput("/compact-tools off");
		harness.flushFrame();
		expect(vi.getTimerCount()).toBe(0);

		await harness.submitInput("/compact-tools compact");
		harness.flushFrame();

		const rootChildren = (harness.tui as unknown as { children?: Array<{ children?: unknown[] }> }).children ?? [];
		expect(rootChildren[5]?.children ?? []).toEqual([]);

		await harness.dispose();
		expect(vi.getTimerCount()).toBe(0);
		harness = undefined;
	});

	it("preserves compact-tools thinking and working config flags and groups exploration reads in claude style without belowEditor widgets", async () => {
		const projectDir = createProjectDir({ style: "claude", thinking: true, working: true });
		writeFileSync(join(projectDir, "a.ts"), "export const a = 1;\n", "utf8");
		writeFileSync(join(projectDir, "b.ts"), "export const b = 2;\n", "utf8");

		let observedWorkingDuringTool = false;
		const inspectProbeTool = defineTool({
			name: "inspect_probe",
			label: "Inspect Probe",
			description: "Deterministic probe tool to observe active working progress row",
			parameters: Type.Object({}),
			async execute() {
				const midTurnText = harness!.screen().text();
				if (midTurnText.includes("Using inspect probe")) {
					observedWorkingDuringTool = true;
				}
				return {
					content: [{ type: "text", text: "probe ok" }],
					details: {},
				};
			},
		});

		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: projectDir,
			projectTrusted: true,
			width: 120,
			height: 32,
			customTools: [inspectProbeTool],
			responses: [
				fauxAssistantMessage(
					[
						fauxThinking("Compare exported constants\nHidden second line of thinking"),
						fauxToolCall("read", { path: "a.ts" }),
						fauxToolCall("read", { path: "b.ts" }),
						fauxToolCall("inspect_probe", {}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Finished reading both files."),
			],
		});

		await harness.submitInput("Inspect both TypeScript modules");

		const finalScreen = harness.screen();
		const fullText = finalScreen.text();

		expect(fullText).toContain("Read 2 files");
		expect(fullText).not.toContain("Hidden second line of thinking");
		expect(observedWorkingDuringTool).toBe(true);
		expect(fullText).toContain("Finished reading both files.");

		const rootChildren = (harness.tui as unknown as { children?: Array<{ children?: unknown[] }> }).children ?? [];
		expect(rootChildren[5]?.children ?? []).toEqual([]);
	});
});
