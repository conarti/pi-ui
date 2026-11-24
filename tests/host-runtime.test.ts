import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, HStack, ScrollView, TuiAltScreen, VStack, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import {
	getActiveHostRuntime,
	setHostRuntimeAdapter,
	type HostRuntimeAdapter,
} from "../src/shared/host-runtime.ts";
import { hookMethod } from "../src/shared/runtime-hooks.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

describe("Host Runtime seam", () => {
	let harness: ExtensionHarness | undefined;
	const tempDirs: string[] = [];

	function createProjectDir(compactConfig?: Record<string, unknown>): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-ui-ticket5-"));
		tempDirs.push(dir);
		if (compactConfig) {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "compact-tools.json"), JSON.stringify(compactConfig, null, 2));
		}
		return dir;
	}

	afterEach(async () => {
		vi.useRealTimers();
		setHostRuntimeAdapter(undefined);
		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("acquires host TUI once per session_start with zero belowEditor probe widgets", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 120, height: 32 });
		const customSpy = vi.spyOn(harness.ctx.ui, "custom");
		const setWidgetSpy = vi.spyOn(harness.ctx.ui, "setWidget");

		harness.mount(conartiPiUi);
		await harness.startSession();

		// Host TUI acquired once via a single probe
		expect(customSpy).toHaveBeenCalledTimes(1);

		// Zero empty belowEditor probe widgets registered by tool-call controllers
		const belowEditorCalls = setWidgetSpy.mock.calls.filter(([, , opts]) => {
			const placement = (opts as { placement?: string } | undefined)?.placement;
			return placement === "belowEditor";
		});
		expect(belowEditorCalls).toEqual([]);
		expect([...harness.widgets.keys()].filter((key) => key.startsWith("compact-tools-"))).toEqual([]);

		// Shared handle exposes TUI, primary ScrollView, chat container, and fullscreen layout
		const runtime = getActiveHostRuntime();
		expect(runtime).toBeDefined();
		expect(runtime!.tui).toBe(harness.tui.asTui());
		expect(runtime!.isFullscreen).toBe(true);
		expect(runtime!.scroll).toBe(harness.tui.scroll);
		expect(runtime!.scroll?.scrollbar).toBe("auto");
		expect(runtime!.chatContainer).toBe(harness.tui.chatContainer);

		expect(harness.tui.layoutRoot).toBeInstanceOf(VStack);
		const entries = (harness.tui.layoutRoot as unknown as { entries?: Array<{ component: unknown }> }).entries ?? [];
		expect(entries.some((entry) => entry.component instanceof HStack)).toBe(false);
		expect(runtime!.viewportSlots?.topSlot).toBeDefined();
		expect(runtime!.viewportSlots?.rightRail).toBeDefined();
	});

	it("falls back gracefully in non-fullscreen TUI mode without a ScrollView or layoutRoot", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 120, height: 32 });
		const chatContainer = new Container();
		const nonFullscreenTui = {
			children: [chatContainer, new Container(), new Container(), new Container(), new Container(), new Container(), new Container()],
			terminal: { columns: 120, rows: 32, write: vi.fn() },
			requestRender: vi.fn(),
		} as unknown as TUI;

		const adapter: HostRuntimeAdapter = {
			acquire: async (ctx) => ({
				tui: nonFullscreenTui,
				keybindings: harness!.keybindings,
				theme: () => ctx.ui.theme,
			}),
		};
		setHostRuntimeAdapter(adapter);

		const customSpy = vi.spyOn(harness.ctx.ui, "custom");
		harness.mount(conartiPiUi);
		await expect(harness.startSession()).resolves.toBeUndefined();

		// Injectable adapter bypassed ctx.ui.custom
		expect(customSpy).not.toHaveBeenCalled();

		const runtime = getActiveHostRuntime();
		expect(runtime).toBeDefined();
		expect(runtime!.isFullscreen).toBe(false);
		expect(runtime!.scroll).toBeUndefined();
		expect(runtime!.chatContainer).toBe(chatContainer);

		// Shutdown clears active host runtime cleanly
		await harness.shutdownSession();
		expect(getActiveHostRuntime()).toBeUndefined();
		harness = undefined;
	});

	it("consolidates prototype hooks without stacking across reloads or legacy markers", () => {
		let originalCalls = 0;
		const proto = {
			render(value: string) {
				originalCalls += 1;
				return `orig:${value}`;
			},
		};

		// Simulate an older extension wrapping proto.render and saving the unwrapped original under a legacy symbol
		const legacyOriginalSym = Symbol.for("test.legacy.original.render");
		const unwrapped = proto.render;
		Object.defineProperty(proto, legacyOriginalSym, { value: unwrapped });
		proto.render = function legacyWrapper(value: string) {
			return `legacy:${unwrapped.call(this, value)}`;
		};

		hookMethod(proto, "render", "test.consolidated", (self, args, orig) => `v1:${orig.apply(self, args)}`, [legacyOriginalSym]);
		const firstWrapper = proto.render;
		expect(proto.render("a")).toBe("v1:orig:a");
		expect(originalCalls).toBe(1);

		// Hot-swap behavior on reload: same wrapper reference, no stacking
		hookMethod(proto, "render", "test.consolidated", (self, args, orig) => `v2:${orig.apply(self, args)}`, [legacyOriginalSym]);
		expect(proto.render).toBe(firstWrapper);
		expect(proto.render("b")).toBe("v2:orig:b");
		expect(originalCalls).toBe(2);
	});

	it("hot-swaps cleanly across reloads and style switches without stacking wrappers or leaking timers", async () => {
		vi.useFakeTimers();
		const projectDir = createProjectDir({ style: "compact", thinking: true, working: true });
		harness = createExtensionHarness({ theme: "dark", cwd: projectDir, projectTrusted: true });

		harness.mount(conartiPiUi);
		await harness.startSession();
		await harness.runCommand("silent", "on");

		// Trigger timers and lazy activity hooks during active run
		await harness.emit("agent_start", {});
		vi.advanceTimersByTime(300);

		const updateContentAfterFirst = AssistantMessageComponent.prototype.updateContent;
		const assistantRenderAfterFirst = AssistantMessageComponent.prototype.render;
		const toolRenderAfterFirst = ToolExecutionComponent.prototype.render;
		const userRenderAfterFirst = UserMessageComponent.prototype.render;
		const altProto = TuiAltScreen.prototype as any;
		const altDoRenderAfterFirst = altProto.doRender;
		const altMouseAfterFirst = altProto.handleMouseEvent;

		// Simulate /reload: shutdown(reload) -> fresh extension mount -> session_start(reload)
		await harness.emit("session_shutdown", { reason: "reload" });
		expect(vi.getTimerCount()).toBe(0);

		const reloaded = createExtensionHarness({ theme: "dark", cwd: projectDir, projectTrusted: true });
		reloaded.mount(conartiPiUi);
		await reloaded.emit("session_start", { reason: "reload" });
		await reloaded.emit("agent_start", {});
		vi.advanceTimersByTime(160);
		await reloaded.runCommand("silent", "off");

		// Wrapper identities must be unchanged (no stacking)
		expect(AssistantMessageComponent.prototype.updateContent).toBe(updateContentAfterFirst);
		expect(AssistantMessageComponent.prototype.render).toBe(assistantRenderAfterFirst);
		expect(ToolExecutionComponent.prototype.render).toBe(toolRenderAfterFirst);
		expect(UserMessageComponent.prototype.render).toBe(userRenderAfterFirst);
		expect(altProto.doRender).toBe(altDoRenderAfterFirst);
		expect(altProto.handleMouseEvent).toBe(altMouseAfterFirst);

		// Switch styles: claude -> codex -> off -> compact
		const setWidgetSpy = vi.spyOn(reloaded.ctx.ui, "setWidget");
		await reloaded.runCommand("compact-tools", "claude");
		await reloaded.runCommand("compact-tools", "codex");
		await reloaded.runCommand("compact-tools", "off");
		await reloaded.emit("agent_end", { messages: [] });
		// Turning style off + ending run must stop all timers
		expect(vi.getTimerCount()).toBe(0);

		await reloaded.runCommand("compact-tools", "compact");

		// Zero belowEditor probe widgets created across style switches
		const belowEditorCalls = setWidgetSpy.mock.calls.filter(([, , opts]) => {
			const placement = (opts as { placement?: string } | undefined)?.placement;
			return placement === "belowEditor";
		});
		expect(belowEditorCalls).toEqual([]);

		await reloaded.shutdownSession();
		expect(vi.getTimerCount()).toBe(0);
		harness = undefined;
	});

	it("preserves compact-tools thinking and working config flags through the unified Host Runtime seam", async () => {
		vi.useFakeTimers();
		const projectDir = createProjectDir({ style: "compact", thinking: true, working: true });
		harness = createExtensionHarness({ theme: "dark", cwd: projectDir, projectTrusted: true });

		harness.mount(conartiPiUi);
		await harness.startSession();

		// thinking: true binds ThinkingCycleController (sets hidden label and registers assistant-thinking transformer)
		expect(harness.hiddenThinkingLabels.length).toBeGreaterThan(0);
		expect(harness.markdownTransformers.length).toBeGreaterThan(0);
		const transformed = harness.markdownTransformers.reduce(
			(md, fn) => fn(md, { messageType: "assistant-thinking", availableWidth: 80 }),
			"Inspect files\nChecking src/index.ts in detail",
		);
		expect(stripTerminalSequences(transformed)).toContain("Inspect files");
		expect(stripTerminalSequences(transformed)).not.toContain("Checking src/index.ts in detail");

		// working: true binds ProgressController (updates working message and stops cleanly on agent_settled)
		await harness.emit("agent_start", {});
		await harness.emit("tool_execution_start", { toolCallId: "tc-1", toolName: "read", args: { path: "src/index.ts" } });
		vi.advanceTimersByTime(160);
		const plainWorking = harness.workingMessages
			.filter((m): m is string => typeof m === "string")
			.map((m) => stripTerminalSequences(m));
		expect(plainWorking.some((m) => m.includes("Reading file"))).toBe(true);

		await harness.emit("tool_execution_end", { toolCallId: "tc-1", toolName: "read" });
		await harness.emit("agent_settled", {});
		expect(harness.workingMessages.at(-1)).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("binds ToolGroupController via HostRuntimeHandle with zero belowEditor widgets in claude/codex styles", async () => {
		const projectDir = createProjectDir({ style: "claude" });
		harness = createExtensionHarness({ theme: "dark", cwd: projectDir, projectTrusted: true });
		const setWidgetSpy = vi.spyOn(harness.ctx.ui, "setWidget");

		harness.mount(conartiPiUi);
		await harness.startSession();

		// Add two exploration read rows to the chat container
		const makeReadRow = (id: string, path: string) =>
			Object.assign(Object.create(ToolExecutionComponent.prototype), {
				toolName: "read",
				toolCallId: id,
				args: { path },
				result: { content: [{ type: "text", text: "line 1" }] },
				isPartial: false,
				expanded: false,
				render: () => [`read ${path}`],
				invalidate() {},
			});
		harness.tui.chatContainer.addChild(makeReadRow("tc-r1", "src/a.ts"));
		harness.tui.chatContainer.addChild(makeReadRow("tc-r2", "src/b.ts"));

		const rendered = harness.tui.chatContainer.render(100).map((line) => stripTerminalSequences(line)).join("\n");
		expect(rendered).toContain("Read 2 files");

		// No belowEditor probe widget (including compact-tools-groups) was mounted or disposed
		const belowEditorCalls = setWidgetSpy.mock.calls.filter(([key, , opts]) => {
			const placement = (opts as { placement?: string } | undefined)?.placement;
			return placement === "belowEditor" || key === "compact-tools-groups";
		});
		expect(belowEditorCalls).toEqual([]);
	});
});
