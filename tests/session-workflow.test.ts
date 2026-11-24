import { stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import conartiPiUi from "../src/index.ts";
import { getSessionWorkflow } from "../src/shared/session-workflow.ts";
import { requestRender, runAppAction } from "../src/shared/ui-action-bridge.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

function leftClick(x: number, y: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y } as unknown as TuiMouseEvent;
}

function mountWidgetComponent(harness: ExtensionHarness, name: string): Component {
	const factory = harness.widgets.get(name) as ((tui: unknown, theme: unknown) => Component) | undefined;
	if (!factory) throw new Error(`Widget "${name}" is not mounted`);
	return factory(harness.tui, harness.ctx.ui.theme);
}

async function flushMicrotasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function findTextX(line: string, needle: string): number {
	const plain = stripTerminalSequences(line);
	const idx = plain.indexOf(needle);
	if (idx < 0) throw new Error(`Text "${needle}" not found in "${plain}"`);
	return idx;
}

function assistantMessage(text: string, stopReason = "stop") {
	return {
		role: "assistant",
		stopReason,
		content: [{ type: "text", text }],
	};
}

function getLatestPersistedState(harness: ExtensionHarness): Record<string, any> | undefined {
	const entry = [...harness.appendedEntries]
		.reverse()
		.find((e) => e.customType === "conarti-ui-state");
	return entry?.data as Record<string, any> | undefined;
}

describe("Session Workflow via extension harness", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("restores only withheld write tools when exiting Plan mode without overwriting mid-session tool changes", async () => {
		harness = createExtensionHarness({
			activeTools: ["read", "bash", "edit", "write", "grep"],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		// Enter Plan mode: strips only edit and write
		await harness.runCommand("mode", "plan");
		expect(harness.getActiveTools()).toEqual(["read", "bash", "grep"]);

		// Mid-session while in Plan mode: user activates mcp_search and deactivates grep
		harness.pi.setActiveTools(["read", "bash", "mcp_search"]);

		// Exit Plan mode into Code: restores only edit and write alongside current tools
		await harness.runCommand("mode", "code");
		expect(harness.getActiveTools()).toEqual(["read", "bash", "mcp_search", "edit", "write"]);
	});

	it("restores only the subset of write tools that were active before Plan mode, including when exiting into Auto-Safe", async () => {
		harness = createExtensionHarness({
			activeTools: ["read", "bash", "edit"],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		await harness.runCommand("mode", "plan");
		expect(harness.getActiveTools()).toEqual(["read", "bash"]);

		// Activate another tool mid-session
		harness.pi.setActiveTools(["read", "bash", "find"]);

		// Exit Plan mode directly into Auto-Safe: only edit (not write) is restored
		await harness.runCommand("mode", "safe");
		expect(harness.getActiveTools()).toEqual(["read", "bash", "find", "edit"]);
	});

	it("tracks and restores write tools when session starts with --plan flag or reloads while already in Plan mode", async () => {
		// 1. Start session directly with --plan flag
		harness = createExtensionHarness({
			flags: { plan: true },
			activeTools: ["read", "bash", "edit", "write", "grep"],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		expect(harness.getActiveTools()).toEqual(["read", "bash", "grep"]);

		// Mid-session tool change while in Plan mode
		harness.pi.setActiveTools(["read", "bash", "custom_tool"]);

		// Persist state by switching/saving or check persisted entries from startup?
		// Exit Plan mode -> restores edit and write while keeping custom_tool
		await harness.runCommand("mode", "code");
		expect(harness.getActiveTools()).toEqual(["read", "bash", "custom_tool", "edit", "write"]);

		await harness.shutdownSession();

		// 2. Reload a session whose persisted state is already in Plan mode AND host activeTools already lack edit/write
		harness = createExtensionHarness({
			activeTools: ["read", "bash", "mcp_docs"],
			entries: [
				{
					type: "custom",
					customType: "conarti-ui-state",
					data: {
						mode: "plan",
						planRaw: "",
						planComments: {},
						planSteps: [],
						executingPlan: false,
						withheldWriteTools: ["edit", "write"],
					},
				},
			],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		expect(harness.getActiveTools()).toEqual(["read", "bash", "mcp_docs"]);

		await harness.runCommand("mode", "code");
		expect(harness.getActiveTools()).toEqual(["read", "bash", "mcp_docs", "edit", "write"]);

		await harness.shutdownSession();

		// 3. Reload a legacy session in Plan mode (no withheldWriteTools field) where activeTools already lack write tools
		harness = createExtensionHarness({
			activeTools: ["read", "bash"],
			entries: [
				{
					type: "custom",
					customType: "grok-ui-state",
					data: {
						mode: "plan",
						planRaw: "",
						planComments: {},
						planSteps: [],
						executingPlan: false,
					},
				},
			],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		expect(harness.getActiveTools()).toEqual(["read", "bash"]);

		await harness.runCommand("mode", "safe");
		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
	});

	it("automatically clears pre-existing line-pinned comments when a new Plan is generated in Plan mode", async () => {
		harness = createExtensionHarness({ width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		// Enter Plan mode and receive Plan #1
		await harness.runCommand("mode", "plan");
		await harness.emit("agent_end", {
			messages: [
				assistantMessage("# Plan 1\n1. Inspect schema\n2. Update API"),
			],
		});

		// Plan Studio auto-opens on stopReason === "stop"; add a line-pinned comment on line 1 (index 1)
		expect(harness.activeCustomModal).toBeDefined();
		const studio1 = harness.activeCustomModal!.component;
		studio1.handleInput?.("j"); // move to line 2 ("1. Inspect schema")
		studio1.handleInput?.("\r"); // start comment edit
		studio1.handleInput?.("Check nullability");
		studio1.handleInput?.("\r"); // save comment
		studio1.handleInput?.("\x1b"); // close Plan Studio

		expect(harness.activeCustomModal).toBeUndefined();
		expect(getLatestPersistedState(harness)?.planComments).toEqual({ 1: "Check nullability" });

		// Receive newly generated Plan #2 in Plan mode
		await harness.emit("agent_end", {
			messages: [
				assistantMessage("# Plan 2\n1. Completely different step A\n2. Step B"),
			],
		});

		// Persisted state and newly opened Plan Studio must have 0 stale comments
		const saved = getLatestPersistedState(harness);
		expect(saved?.planRaw).toContain("Completely different step A");
		expect(saved?.planComments).toEqual({});

		expect(harness.activeCustomModal).toBeDefined();
		const rendered = stripTerminalSequences(harness.activeCustomModal!.component.render(100).join("\n"));
		expect(rendered).toContain("Completely different step A");
		expect(rendered).not.toContain("Check nullability");

		harness.activeCustomModal!.done("close");
	});

	it("preserves an unapproved Plan draft and its line-pinned comments across manual Session Mode switches", async () => {
		harness = createExtensionHarness({ width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		// Generate a plan in Plan mode and pin a comment
		await harness.runCommand("mode", "plan");
		await harness.emit("agent_end", {
			messages: [assistantMessage("# Migration Plan\n1. Extract workflow\n2. Wire commands")],
		});

		const studio = harness.activeCustomModal!.component;
		studio.handleInput?.("j");
		studio.handleInput?.("\r");
		studio.handleInput?.("Keep legacy restore intact");
		studio.handleInput?.("\r");
		studio.handleInput?.("\x1b");

		// Switch manually Plan -> Code -> Auto-Safe -> Plan via commands and Alt+M shortcut
		await harness.runCommand("mode", "code");
		expect(getLatestPersistedState(harness)).toMatchObject({
			mode: "code",
			planRaw: "# Migration Plan\n1. Extract workflow\n2. Wire commands",
			planComments: { 1: "Keep legacy restore intact" },
			executingPlan: false,
		});

		await harness.runCommand("mode", "safe");
		expect(getLatestPersistedState(harness)).toMatchObject({
			mode: "safe",
			planRaw: "# Migration Plan\n1. Extract workflow\n2. Wire commands",
			planComments: { 1: "Keep legacy restore intact" },
			executingPlan: false,
		});

		// Cycle Safe -> Code -> Plan using Alt+M
		await harness.triggerShortcut("alt+m"); // safe -> code
		await harness.triggerShortcut("alt+m"); // code -> plan
		expect(getLatestPersistedState(harness)).toMatchObject({
			mode: "plan",
			planRaw: "# Migration Plan\n1. Extract workflow\n2. Wire commands",
			planComments: { 1: "Keep legacy restore intact" },
			executingPlan: false,
		});

		// Opening Plan Studio still renders the preserved draft and comment
		const openPromise = harness.runCommand("plan", "review");
		expect(harness.activeCustomModal).toBeDefined();
		const rendered = stripTerminalSequences(harness.activeCustomModal!.component.render(100).join("\n"));
		expect(rendered).toContain("Extract workflow");
		expect(rendered).toContain("Keep legacy restore intact");
		harness.activeCustomModal!.done("close");
		await openPromise;
	});

	it("atomically resets Plan text, lines, steps, comments, and execution tracking when dismissing the banner or running /plan clear", async () => {
		harness = createExtensionHarness({ width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		// 1. Dismissing the draft Plan banner in Code mode
		await harness.runCommand("mode", "plan");
		await harness.emit("agent_end", {
			messages: [assistantMessage("1. Build module\n2. Add tests")],
		});
		const studio = harness.activeCustomModal!.component;
		studio.handleInput?.("\r");
		studio.handleInput?.("Draft note");
		studio.handleInput?.("\r");
		studio.handleInput?.("\x1b");

		await harness.runCommand("mode", "code");
		const draftWidget = mountWidgetComponent(harness, "conarti-plan");
		const draftLine = draftWidget.render(100)[0]!;
		const dismissX = findTextX(draftLine, "✕");
		draftWidget.handleMouse?.(leftClick(dismissX, 0));

		expect(getLatestPersistedState(harness)).toMatchObject({
			planRaw: "",
			planComments: {},
			planSteps: [],
			executingPlan: false,
		});
		expect(harness.widgets.has("conarti-plan")).toBe(false);

		// 2. Dismissing the executing Plan banner ("✕ Скрыть")
		await harness.runCommand("mode", "plan");
		await harness.emit("agent_end", {
			messages: [assistantMessage("1. Step one\n2. Step two")],
		});
		harness.activeCustomModal!.done("approve");
		await flushMicrotasks();

		expect(getLatestPersistedState(harness)?.executingPlan).toBe(true);
		const execWidget = mountWidgetComponent(harness, "conarti-plan");
		const execLine = execWidget.render(100)[0]!;
		const clearX = findTextX(execLine, "Скрыть");
		execWidget.handleMouse?.(leftClick(clearX, 0));

		expect(getLatestPersistedState(harness)).toMatchObject({
			planRaw: "",
			planComments: {},
			planSteps: [],
			executingPlan: false,
		});
		expect(harness.widgets.has("conarti-plan")).toBe(false);

		// before_agent_start must not inject stale execution context
		const beforeStartResults = await harness.emit("before_agent_start", {});
		expect(beforeStartResults.filter(Boolean)).toEqual([]);

		// 3. Running /plan clear during active execution
		await harness.runCommand("mode", "plan");
		await harness.emit("agent_end", {
			messages: [assistantMessage("1. Alpha\n2. Beta")],
		});
		harness.activeCustomModal!.done("approve");
		await flushMicrotasks();

		expect(getLatestPersistedState(harness)?.executingPlan).toBe(true);
		await harness.runCommand("plan", "clear");

		expect(getLatestPersistedState(harness)).toMatchObject({
			planRaw: "",
			planComments: {},
			planSteps: [],
			executingPlan: false,
		});
		expect(harness.widgets.has("conarti-plan")).toBe(false);
		const afterClearResults = await harness.emit("before_agent_start", {});
		expect(afterClearResults.filter(Boolean)).toEqual([]);
	});

	it("approves a Plan into execution, tracks [DONE:N] step completion, and persists/restores across session restarts including legacy grok-ui-state", async () => {
		harness = createExtensionHarness({
			activeTools: ["read", "bash", "edit", "write"],
			width: 100,
			height: 32,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		// Enter Plan mode, generate 2-step plan, add a line comment, and approve
		await harness.runCommand("mode", "plan");
		expect(harness.getActiveTools()).toEqual(["read", "bash"]);

		await harness.emit("agent_end", {
			messages: [assistantMessage("1. Implement parser\n2. Add integration tests")],
		});

		const studio = harness.activeCustomModal!.component;
		studio.handleInput?.("\r");
		studio.handleInput?.("Handle empty input");
		studio.handleInput?.("\r");
		studio.handleInput?.("a"); // approve shortcut
		await flushMicrotasks();

		// Transitions cleanly to Code mode, restores write tools, clears comments, sends user message
		expect(harness.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
		expect(harness.sentUserMessages).toHaveLength(1);
		expect(String(harness.sentUserMessages[0]!.content)).toContain("Handle empty input");
		expect(String(harness.sentUserMessages[0]!.content)).toContain("[DONE:n]");

		expect(getLatestPersistedState(harness)).toMatchObject({
			mode: "code",
			executingPlan: true,
			planComments: {},
			planSteps: [
				{ step: 1, text: "Implement parser", completed: false },
				{ step: 2, text: "Add integration tests", completed: false },
			],
		});

		// Turn 1 completes step 1 via [DONE:1]
		await harness.emit("turn_end", {
			message: assistantMessage("Implemented parser. [DONE:1]"),
		});
		expect(getLatestPersistedState(harness)?.planSteps).toEqual([
			{ step: 1, text: "Implement parser", completed: true },
			{ step: 2, text: "Add integration tests", completed: false },
		]);

		// Restart session with persisted entries -> restores mode, plan, and step 1 completion accurately
		const persistedEntries = harness.ctx.sessionManager.getEntries();
		await harness.shutdownSession();

		harness = createExtensionHarness({
			entries: persistedEntries,
			activeTools: ["read", "bash", "edit", "write"],
			width: 100,
			height: 32,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		const restoredWidget = mountWidgetComponent(harness, "conarti-plan");
		expect(stripTerminalSequences(restoredWidget.render(100)[0]!)).toContain("План 1/2");

		// Agent finishes step 2 via [done:2] -> notifies completion
		await harness.emit("agent_end", {
			messages: [assistantMessage("Tests green. [done:2]")],
		});
		expect(getLatestPersistedState(harness)?.planSteps).toEqual([
			{ step: 1, text: "Implement parser", completed: true },
			{ step: 2, text: "Add integration tests", completed: true },
		]);
		expect(harness.notifications.some((n) => n.message.includes("Все шаги плана выполнены"))).toBe(true);

		await harness.shutdownSession();

		// Legacy "grok-ui-state" entry restores cleanly across restarts
		harness = createExtensionHarness({
			entries: [
				{
					type: "custom",
					customType: "grok-ui-state",
					data: {
						mode: "safe",
						planRaw: "1. Legacy step",
						planComments: { 0: "Legacy note" },
						planSteps: [{ step: 1, text: "Legacy step", completed: false }],
						executingPlan: false,
					},
				},
			],
			width: 100,
			height: 32,
		});
		harness.mount(conartiPiUi);
		await harness.startSession();

		const openPromise = harness.runCommand("plan", "review");
		expect(harness.activeCustomModal).toBeDefined();
		const rendered = stripTerminalSequences(harness.activeCustomModal!.component.render(100).join("\n"));
		expect(rendered).toContain("Legacy step");
		expect(rendered).toContain("Legacy note");
		harness.activeCustomModal!.done("close");
		await openPromise;
	});

	it("decouples UI action callbacks into the UI Action Bridge and removes dead global callback fields from SessionWorkflow", async () => {
		harness = createExtensionHarness({ width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		// SessionWorkflow has no imperative UI callback fields
		const workflow = getSessionWorkflow() as unknown as Record<string, unknown>;
		expect("requestRender" in workflow).toBe(false);
		expect("runAppAction" in workflow).toBe(false);
		expect("submitPrompt" in workflow).toBe(false);
		expect("jumpPrompt" in workflow).toBe(false);

		// UI Action Bridge forwards requestRender to host TUI
		const beforeRenders = harness.tui.renderCount;
		requestRender();
		expect(harness.tui.renderCount).toBeGreaterThan(beforeRenders);

		// UI Action Bridge forwards app actions to the mounted composer editor
		const actionSpy = vi.fn();
		const editorAny = harness.editor as unknown as { actionHandlers?: Map<string, () => void> };
		editorAny.actionHandlers = new Map([["app.model.select", actionSpy]]);

		expect(runAppAction("app.model.select")).toBe(true);
		expect(actionSpy).toHaveBeenCalledTimes(1);
		expect(runAppAction("app.nonexistent")).toBe(false);

		// Shutdown clears the UI Action Bridge cleanly
		await harness.shutdownSession();
		expect(runAppAction("app.model.select")).toBe(false);
		const afterShutdownRenders = harness.tui.renderCount;
		requestRender();
		expect(harness.tui.renderCount).toBe(afterShutdownRenders);
		harness = undefined;
	});
});
