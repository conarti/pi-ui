import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getActiveComposerEditor } from "../src/features/chrome/composer.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import { getSessionWorkflow } from "../src/shared/session-workflow.ts";
import { requestRender, runAppAction } from "../src/shared/ui-action-bridge.ts";
import {
	contentText,
	createInteractiveHarness,
	fauxAssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

function getLatestPersistedState(harness: InteractiveHarness): Record<string, unknown> | undefined {
	const entries = harness.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as { type?: string; customType?: string; data?: Record<string, unknown> };
		if (entry.type === "custom" && entry.customType === "conarti-ui-state") {
			return entry.data;
		}
	}
	return undefined;
}

async function openSlashWithoutWaiting(harness: InteractiveHarness, cmd: string): Promise<void> {
	await harness.paste(cmd, true);
	await harness.pressKey("\r");
	await harness.flush();
}

describe("Session Workflow on real InteractiveMode", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-ui-workflow-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("restores only withheld write tools when exiting Plan mode without overwriting mid-session tool changes", async () => {
		const mcpSearch = defineTool({
			name: "mcp_search",
			label: "MCP Search",
			description: "Search tool",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {} };
			},
		});

		harness = await createInteractiveHarness({
			tools: ["+grep"],
			customTools: [mcpSearch],
		});
		harness.session.setActiveToolsByName(["read", "bash", "edit", "write", "grep"]);
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "grep"]);

		await harness.submitInput("/mode plan");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "grep"]);

		harness.session.setActiveToolsByName(["read", "bash", "mcp_search"]);

		await harness.submitInput("/mode code");
		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"mcp_search",
			"edit",
			"write",
		]);
	});

	it("restores only the subset of write tools that were active before Plan mode, including when exiting into Auto Session Mode", async () => {
		harness = await createInteractiveHarness({
			tools: ["-write", "+find"],
		});
		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"edit",
			"find",
			"ask_user_question",
		]);

		await harness.submitInput("/mode plan");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "find", "ask_user_question"]);

		harness.session.setActiveToolsByName(["read", "bash"]);

		await harness.submitInput("/mode safe");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit"]);
	});

	it("tracks and restores write tools across --plan startup flag, /reload, persisted conarti-ui-state, and legacy grok-ui-state", async () => {
		const extraTool = defineTool({
			name: "mcp_docs",
			label: "MCP Docs",
			description: "Docs lookup",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {} };
			},
		});

		harness = await createInteractiveHarness({
			flags: { plan: true },
			tools: ["+grep"],
			customTools: [extraTool],
		});
		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"grep",
			"ask_user_question",
			"mcp_docs",
		]);

		await harness.reload();
		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"grep",
			"ask_user_question",
			"mcp_docs",
		]);

		harness.session.setActiveToolsByName(["read", "bash", "mcp_docs"]);
		await harness.submitInput("/mode code");
		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"mcp_docs",
			"edit",
			"write",
		]);
		await harness.dispose();
		harness = undefined;

		harness = await createInteractiveHarness({
			tools: ["-edit", "-write"],
			customTools: [extraTool],
			setupSession(sm) {
				sm.appendCustomEntry("conarti-ui-state", {
					mode: "plan",
					planRaw: "",
					planComments: {},
					planSteps: [],
					executingPlan: false,
					withheldWriteTools: ["edit", "write"],
				});
			},
		});
		harness.session.setActiveToolsByName(["read", "bash", "mcp_docs"]);
		await harness.submitInput("/mode code");
		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"mcp_docs",
			"edit",
			"write",
		]);
		await harness.dispose();
		harness = undefined;

		harness = await createInteractiveHarness({
			tools: ["-edit", "-write"],
			setupSession(sm) {
				sm.appendCustomEntry("grok-ui-state", {
					mode: "plan",
					planRaw: "",
					planComments: {},
					planSteps: [],
					executingPlan: false,
				});
			},
		});
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "ask_user_question"]);
		await harness.submitInput("/mode safe");
		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"ask_user_question",
			"edit",
			"write",
		]);
	});

	it("automatically clears pre-existing line-pinned comments when a new Plan is generated in Plan mode", async () => {
		harness = await createInteractiveHarness({
			width: 100,
			height: 32,
			responses: [
				fauxAssistantMessage("# Plan 1\n1. Inspect schema\n2. Update API"),
				fauxAssistantMessage("# Plan 2\n1. Completely different step A\n2. Step B"),
			],
		});

		await harness.submitInput("/mode plan");
		await harness.submitInput("Generate first plan");

		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		await harness.pressKey("j");
		await harness.pressKey("\r");
		await harness.typeText("Check nullability");
		await harness.pressKey("\r");
		await harness.pressKey("\x1b");

		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
		expect(getLatestPersistedState(harness)?.planComments).toEqual({ 1: "Check nullability" });

		await harness.submitInput("Generate replacement plan");

		const saved = getLatestPersistedState(harness);
		expect(String(saved?.planRaw ?? "")).toContain("Completely different step A");
		expect(saved?.planComments).toEqual({});

		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		const studioText = harness.screen().text();
		expect(studioText).toContain("Completely different step A");
		expect(studioText).not.toContain("Check nullability");
		await harness.pressKey("\x1b");
	});

	it("preserves an unapproved Plan draft and its line-pinned comments across manual Session Mode switches (/mode and Alt+M)", async () => {
		harness = await createInteractiveHarness({
			width: 100,
			height: 32,
			responses: [fauxAssistantMessage("# Migration Plan\n1. Extract workflow\n2. Wire commands")],
		});

		await harness.submitInput("/mode plan");
		await harness.submitInput("Draft migration plan");

		await harness.pressKey("j");
		await harness.pressKey("\r");
		await harness.typeText("Keep legacy restore intact");
		await harness.pressKey("\r");
		await harness.pressKey("\x1b");

		await harness.submitInput("/mode always-approve");
		expect(getLatestPersistedState(harness)).toMatchObject({
			mode: "always-approve",
			planRaw: "# Migration Plan\n1. Extract workflow\n2. Wire commands",
			planComments: { 1: "Keep legacy restore intact" },
			executingPlan: false,
		});

		await harness.submitInput("/mode auto");
		expect(getLatestPersistedState(harness)).toMatchObject({
			mode: "auto",
			planRaw: "# Migration Plan\n1. Extract workflow\n2. Wire commands",
			planComments: { 1: "Keep legacy restore intact" },
			executingPlan: false,
		});

		await harness.pressKey("\x1bm");
		await harness.pressKey("\x1bm");
		expect(getLatestPersistedState(harness)).toMatchObject({
			mode: "plan",
			planRaw: "# Migration Plan\n1. Extract workflow\n2. Wire commands",
			planComments: { 1: "Keep legacy restore intact" },
			executingPlan: false,
		});

		await openSlashWithoutWaiting(harness, "/plan review");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Extract workflow");
		expect(harness.screen().text()).toContain("Keep legacy restore intact");
		await harness.pressKey("\x1b");
	});

	it("atomically resets Plan text, lines, steps, comments, and execution context when clicking banner dismiss pills or running /plan clear", async () => {
		harness = await createInteractiveHarness({
			width: 110,
			height: 34,
			responses: [
				fauxAssistantMessage("1. Build module\n2. Add tests"),
				fauxAssistantMessage("1. Step one\n2. Step two"),
				fauxAssistantMessage("Started step one."),
				fauxAssistantMessage("Normal code reply after banner dismiss."),
				fauxAssistantMessage("1. Alpha\n2. Beta"),
				fauxAssistantMessage("Started alpha."),
				fauxAssistantMessage("Normal reply after /plan clear."),
			],
		});

		await harness.submitInput("/mode plan");
		await harness.submitInput("Build draft plan");
		await harness.pressKey("\r");
		await harness.typeText("Draft note");
		await harness.pressKey("\r");
		await harness.pressKey("\x1b");

		await harness.submitInput("/mode always-approve");
		const draftScreen = harness.screen();
		const openBannerPos = draftScreen.findText("Open plan");
		expect(openBannerPos).toBeDefined();
		const bannerRow = draftScreen.rowText(openBannerPos!.row);
		const dismissCol = bannerRow.lastIndexOf("✕");
		expect(dismissCol).toBeGreaterThan(openBannerPos!.col);

		await harness.mouseClick(dismissCol, openBannerPos!.row);
		expect(getLatestPersistedState(harness)).toMatchObject({
			planRaw: "",
			planComments: {},
			planSteps: [],
			executingPlan: false,
		});
		expect(harness.screen().text()).not.toContain("Open plan");

		await harness.submitInput("/mode plan");
		await harness.submitInput("Generate executable plan");
		await harness.pressKey("a");
		await harness.flush();
		await new Promise((r) => setTimeout(r, 30));
		await harness.flush();

		expect(getLatestPersistedState(harness)?.executingPlan).toBe(true);
		const hidePos = harness.screen().findText("Hide");
		expect(hidePos).toBeDefined();
		await harness.mouseClick(hidePos!.col + 1, hidePos!.row);

		expect(getLatestPersistedState(harness)).toMatchObject({
			planRaw: "",
			planComments: {},
			planSteps: [],
			executingPlan: false,
		});
		expect(harness.screen().text()).not.toContain("Plan 0/2");

		await harness.submitInput("Follow-up after hiding plan");
		const callAfterHide = harness.calls.at(-1)!;
		const serializedHideMsgs = JSON.stringify(callAfterHide.messages);
		expect(serializedHideMsgs).not.toContain("[Plan execution]");

		await harness.submitInput("/mode plan");
		await harness.submitInput("Generate second executable plan");
		await harness.pressKey("a");
		await harness.flush();
		await new Promise((r) => setTimeout(r, 30));
		await harness.flush();

		expect(getLatestPersistedState(harness)?.executingPlan).toBe(true);
		await harness.submitInput("/plan clear");
		expect(getLatestPersistedState(harness)).toMatchObject({
			planRaw: "",
			planComments: {},
			planSteps: [],
			executingPlan: false,
		});

		await harness.submitInput("Follow-up after /plan clear");
		const callAfterClear = harness.calls.at(-1)!;
		expect(JSON.stringify(callAfterClear.messages)).not.toContain("[Выполнение плана]");
	});

	it("approves a Plan into execution, tracks [DONE:N] / [done:N] completion, and persists/restores across disk restarts and legacy grok-ui-state", async () => {
		const projectDir = createTempDir();
		const agentDir = createTempDir();

		harness = await createInteractiveHarness({
			cwd: projectDir,
			agentDir,
			persistSession: true,
			width: 110,
			height: 34,
			responses: [
				fauxAssistantMessage("1. Implement parser\n2. Add integration tests"),
				fauxAssistantMessage("Implemented parser. [DONE:1]"),
			],
		});

		await harness.submitInput("/mode plan");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "ask_user_question"]);

		await harness.submitInput("Plan parser work");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);

		await harness.pressKey("\r");
		await harness.typeText("Handle empty input");
		await harness.pressKey("\r");
		await harness.pressKey("a");

		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && harness.calls.length < 2) {
			await new Promise((r) => setTimeout(r, 10));
		}
		await harness.flush();

		expect(harness.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"ask_user_question",
			"edit",
			"write",
		]);
		const allCall1Text = harness.calls[1]!.messages
			.map((m) => (typeof m.content === "string" ? m.content : contentText(m.content)))
			.join("\n");
		expect(allCall1Text).toContain("Handle empty input");
		expect(allCall1Text).toContain("[DONE:n]");

		expect(getLatestPersistedState(harness)).toMatchObject({
			mode: "always-approve",
			executingPlan: true,
			planComments: {},
			planSteps: [
				{ step: 1, text: "Implement parser", completed: true },
				{ step: 2, text: "Add integration tests", completed: false },
			],
		});

		const sessionFile = harness.session.sessionFile!;
		expect(sessionFile).toBeTruthy();
		await harness.dispose();
		harness = undefined;

		harness = await createInteractiveHarness({
			cwd: projectDir,
			agentDir,
			sessionManager: SessionManager.open(sessionFile),
			width: 110,
			height: 34,
			responses: [fauxAssistantMessage("Tests green. [done:2]")],
		});

		expect(harness.screen().text()).toContain("Plan 1/2");

		await harness.submitInput("Finish step 2");
		expect(getLatestPersistedState(harness)?.planSteps).toEqual([
			{ step: 1, text: "Implement parser", completed: true },
			{ step: 2, text: "Add integration tests", completed: true },
		]);
		expect(harness.screen().text()).toContain("All plan steps completed");

		await harness.dispose();
		harness = undefined;

		harness = await createInteractiveHarness({
			width: 100,
			height: 32,
			setupSession(sm) {
				sm.appendCustomEntry("grok-ui-state", {
					mode: "safe",
					planRaw: "1. Legacy step",
					planComments: { 0: "Legacy note" },
					planSteps: [{ step: 1, text: "Legacy step", completed: false }],
					executingPlan: false,
				});
			},
		});

		expect(getSessionWorkflow().mode).toBe("auto");

		await openSlashWithoutWaiting(harness, "/plan review");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		const legacyScreen = harness.screen().text();
		expect(legacyScreen).toContain("Legacy step");
		expect(legacyScreen).toContain("Legacy note");
		await harness.pressKey("\x1b");
	});

	it("decouples UI action callbacks into the UI Action Bridge and resets cleanly on shutdown", async () => {
		harness = await createInteractiveHarness({ width: 100, height: 32 });

		const workflow = getSessionWorkflow() as unknown as Record<string, unknown>;
		expect("requestRender" in workflow).toBe(false);
		expect("runAppAction" in workflow).toBe(false);
		expect("submitPrompt" in workflow).toBe(false);
		expect("jumpPrompt" in workflow).toBe(false);

		const writesBefore = harness.terminal.writes.length;
		requestRender();
		harness.flushFrame(true);
		expect(harness.terminal.writes.length).toBeGreaterThan(writesBefore);

		const editor = getActiveComposerEditor();
		expect(editor).toBeDefined();
		let invoked = 0;
		editor!.actionHandlers.set("app.model.select", () => {
			invoked += 1;
		});

		expect(runAppAction("app.model.select")).toBe(true);
		expect(invoked).toBe(1);
		expect(runAppAction("app.nonexistent")).toBe(false);

		await harness.dispose();
		harness = undefined;
		expect(runAppAction("app.model.select")).toBe(false);
	});
});
