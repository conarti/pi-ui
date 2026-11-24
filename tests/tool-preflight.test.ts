import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import conartiPiUi from "../src/index.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

async function flushMicrotasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function renderActiveModalText(harness: ExtensionHarness, width = 72): string {
	const modal = harness.activeCustomModal;
	if (!modal) throw new Error("Expected an active Modal Card overlay");
	return stripTerminalSequences(modal.component.render(width).join("\n"));
}

async function emitToolCall(
	harness: ExtensionHarness,
	toolName: string,
	input: Record<string, unknown> = {},
	toolCallId = "call-1",
): Promise<{ block?: boolean; reason?: string } | undefined> {
	const results = await harness.emit("tool_call", {
		type: "tool_call",
		toolCallId,
		toolName,
		input,
	});
	return results.find((r): r is { block?: boolean; reason?: string } => Boolean(r));
}

describe("Tool-call preflight (Shell Effect, destructiveHint, Auto-Safe queue)", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("in Plan mode blocks edit, write, destructiveHint tools, and mutating bash/powershell while allowing read-only Shell Effect and unannotated tools", async () => {
		harness = createExtensionHarness({
			activeTools: ["read", "bash", "powershell", "edit", "write", "grep", "deploy_prod", "mcp_docs"],
			allTools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "powershell" },
				{ name: "edit" },
				{ name: "write" },
				{ name: "grep" },
				{ name: "deploy_prod", annotations: { destructiveHint: true } },
				{ name: "drop_table", destructiveHint: true },
				{ name: "mcp_docs" },
			],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();
		await harness.runCommand("mode", "plan");

		// Built-in write tools are blocked
		const editRes = await emitToolCall(harness, "edit", { path: "src/app.ts" });
		expect(editRes?.block).toBe(true);
		expect(editRes?.reason).toBeTruthy();

		const writeRes = await emitToolCall(harness, "write", { path: "src/new.ts", content: "x" });
		expect(writeRes?.block).toBe(true);
		expect(writeRes?.reason).toBeTruthy();

		// Destructive-annotated tools (both MCP annotations.destructiveHint and top-level destructiveHint) are blocked
		const deployRes = await emitToolCall(harness, "deploy_prod", { env: "prod" });
		expect(deployRes?.block).toBe(true);
		expect(deployRes?.reason).toContain("deploy_prod");

		const dropRes = await emitToolCall(harness, "drop_table", { table: "users" });
		expect(dropRes?.block).toBe(true);
		expect(dropRes?.reason).toContain("drop_table");

		// Mutating bash commands (including subshells, interpreters, redirects, mutating flags) are blocked with Shell Effect reason
		const bashSubshell = await emitToolCall(harness, "bash", { command: "echo $(rm -rf /tmp/x)" });
		expect(bashSubshell?.block).toBe(true);
		expect(bashSubshell?.reason).toMatch(/substitution|opaque|mutat/i);

		const bashNode = await emitToolCall(harness, "bash", { command: "node -e 'process.exit(0)'" });
		expect(bashNode?.block).toBe(true);
		expect(bashNode?.reason).toMatch(/interpreter/i);

		const bashRedirect = await emitToolCall(harness, "bash", { command: "echo hi > out.txt" });
		expect(bashRedirect?.block).toBe(true);
		expect(bashRedirect?.reason).toMatch(/redirection/i);

		// Mutating powershell commands are blocked
		const psMutating = await emitToolCall(harness, "powershell", { command: "Set-Content -Path a.txt -Value hi" });
		expect(psMutating?.block).toBe(true);
		expect(psMutating?.reason).toBeTruthy();

		// Read-only bash commands (git inspection, quoted '>', harmless redirects) execute freely
		expect(await emitToolCall(harness, "bash", { command: "git status -sb" })).toBeUndefined();
		expect(await emitToolCall(harness, "bash", { command: "git log --oneline -n 5" })).toBeUndefined();
		expect(await emitToolCall(harness, "bash", { command: 'rg "a > b" src/ 2>/dev/null' })).toBeUndefined();

		// Read-only powershell commands execute freely
		expect(await emitToolCall(harness, "powershell", { command: "Get-ChildItem -Path src" })).toBeUndefined();

		// Read-only built-ins and unannotated non-write tools execute freely
		expect(await emitToolCall(harness, "read", { path: "README.md" })).toBeUndefined();
		expect(await emitToolCall(harness, "mcp_docs", { query: "modal card" })).toBeUndefined();
	});

	it("in Auto-Safe mode allows read-only tools immediately and opens Auto-Safe Modal Card for edit, write, destructiveHint, and mutating bash/powershell", async () => {
		harness = createExtensionHarness({
			activeTools: ["read", "bash", "powershell", "edit", "write", "deploy_prod", "mcp_docs"],
			allTools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "powershell" },
				{ name: "edit" },
				{ name: "write" },
				{ name: "deploy_prod", annotations: { destructiveHint: true } },
				{ name: "mcp_docs" },
			],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();
		await harness.runCommand("mode", "safe");

		// Read-only tools, unannotated custom tools, and read-only Shell Effect execute without prompting
		expect(await emitToolCall(harness, "read", { path: "README.md" })).toBeUndefined();
		expect(await emitToolCall(harness, "mcp_docs", { query: "plans" })).toBeUndefined();
		expect(await emitToolCall(harness, "bash", { command: "git diff --stat" })).toBeUndefined();
		expect(await emitToolCall(harness, "bash", { command: 'echo "a > b"' })).toBeUndefined();
		expect(await emitToolCall(harness, "powershell", { command: "Get-Content README.md" })).toBeUndefined();
		expect(harness.activeCustomModal).toBeUndefined();

		// edit -> opens Modal Card; pressing Enter allows
		const editPromise = emitToolCall(harness, "edit", { path: "src/app.ts" });
		await flushMicrotasks();
		expect(harness.activeCustomModal).toBeDefined();
		expect(renderActiveModalText(harness)).toContain("Auto-Safe Confirmation");
		expect(renderActiveModalText(harness)).toContain("edit");
		expect(renderActiveModalText(harness)).toContain("src/app.ts");
		harness.activeCustomModal!.component.handleInput?.("\r");
		expect(await editPromise).toBeUndefined();
		expect(harness.activeCustomModal).toBeUndefined();

		// write -> opens Modal Card; pressing Escape blocks
		const writePromise = emitToolCall(harness, "write", { path: "src/new.ts" });
		await flushMicrotasks();
		expect(harness.activeCustomModal).toBeDefined();
		expect(renderActiveModalText(harness)).toContain("write");
		harness.activeCustomModal!.component.handleInput?.("\x1b");
		const writeResult = await writePromise;
		expect(writeResult?.block).toBe(true);
		expect(writeResult?.reason).toContain("Auto-Safe");

		// destructiveHint: true tool -> opens Modal Card; pressing Enter allows
		const deployPromise = emitToolCall(harness, "deploy_prod", { env: "prod" });
		await flushMicrotasks();
		expect(harness.activeCustomModal).toBeDefined();
		expect(renderActiveModalText(harness)).toContain("deploy_prod");
		harness.activeCustomModal!.component.handleInput?.("\r");
		expect(await deployPromise).toBeUndefined();

		// mutating bash -> opens Modal Card; pressing Escape blocks
		const bashPromise = emitToolCall(harness, "bash", { command: "rm -rf dist" });
		await flushMicrotasks();
		expect(harness.activeCustomModal).toBeDefined();
		expect(renderActiveModalText(harness)).toContain("bash");
		expect(renderActiveModalText(harness)).toContain("rm -rf dist");
		harness.activeCustomModal!.component.handleInput?.("\x1b");
		expect((await bashPromise)?.block).toBe(true);

		// mutating powershell -> opens Modal Card; pressing Enter allows
		const psPromise = emitToolCall(harness, "powershell", { command: "Remove-Item dist -Recurse" });
		await flushMicrotasks();
		expect(harness.activeCustomModal).toBeDefined();
		expect(renderActiveModalText(harness)).toContain("powershell");
		expect(renderActiveModalText(harness)).toContain("Remove-Item dist -Recurse");
		harness.activeCustomModal!.component.handleInput?.("\r");
		expect(await psPromise).toBeUndefined();
	});

	it("serializes concurrent mutating tool calls in Auto-Safe mode strictly one Modal Card at a time in FIFO order", async () => {
		harness = createExtensionHarness({
			activeTools: ["bash", "edit", "write", "deploy_prod"],
			allTools: [
				{ name: "bash" },
				{ name: "edit" },
				{ name: "write" },
				{ name: "deploy_prod", annotations: { destructiveHint: true } },
			],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();
		await harness.runCommand("mode", "safe");

		const settledOrder: string[] = [];
		const p1 = emitToolCall(harness, "edit", { path: "src/first.ts" }, "call-parent/1").then((r) => {
			settledOrder.push("first");
			return r;
		});
		const p2 = emitToolCall(harness, "bash", { command: "mkdir tmp-second" }, "call-parent/2").then((r) => {
			settledOrder.push("second");
			return r;
		});
		const p3 = emitToolCall(harness, "deploy_prod", { target: "third" }, "call-parent/3").then((r) => {
			settledOrder.push("third");
			return r;
		});

		// Only the first modal is mounted; second and third wait in the FIFO queue without colliding
		await flushMicrotasks();
		expect(harness.tui.overlayStack).toHaveLength(1);
		expect(renderActiveModalText(harness)).toContain("src/first.ts");
		expect(settledOrder).toEqual([]);

		// Allow #1 -> #1 resolves, #2 opens next
		harness.activeCustomModal!.component.handleInput?.("\r");
		await flushMicrotasks();
		expect(settledOrder).toEqual(["first"]);
		expect(harness.tui.overlayStack).toHaveLength(1);
		expect(renderActiveModalText(harness)).toContain("mkdir tmp-second");

		// Block #2 -> #2 blocks, #3 opens next
		harness.activeCustomModal!.component.handleInput?.("\x1b");
		await flushMicrotasks();
		expect(settledOrder).toEqual(["first", "second"]);
		expect(harness.tui.overlayStack).toHaveLength(1);
		expect(renderActiveModalText(harness)).toContain("deploy_prod");

		// Allow #3 -> #3 resolves, no modals left
		harness.activeCustomModal!.component.handleInput?.("\r");
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
		expect(settledOrder).toEqual(["first", "second", "third"]);
		expect(r1).toBeUndefined();
		expect(r2?.block).toBe(true);
		expect(r3).toBeUndefined();
		expect(harness.tui.overlayStack).toHaveLength(0);
	});

	it("never deadlocks the Auto-Safe confirmation queue if one confirmation prompt rejects", async () => {
		harness = createExtensionHarness({
			mode: "print",
			hasUI: false,
			activeTools: ["edit", "write"],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();
		await harness.runCommand("mode", "safe");

		let callCount = 0;
		harness.confirmHandler = async () => {
			callCount++;
			if (callCount === 1) throw new Error("UI prompt failed");
			return true;
		};

		const [r1, r2] = await Promise.all([
			emitToolCall(harness, "edit", { path: "src/a.ts" }, "c1"),
			emitToolCall(harness, "write", { path: "src/b.ts" }, "c2"),
		]);

		expect(r1?.block).toBe(true);
		expect(r2).toBeUndefined();
		expect(callCount).toBe(2);
	});

	it("allow-for-the-rest-of-the-turn immediately allows queued sibling calls without further dialogs and resets on agent_end and session lifecycle", async () => {
		harness = createExtensionHarness({
			activeTools: ["bash", "edit", "write", "deploy_prod"],
			allTools: [
				{ name: "bash" },
				{ name: "edit" },
				{ name: "write" },
				{ name: "deploy_prod", annotations: { destructiveHint: true } },
			],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();
		await harness.runCommand("mode", "safe");
		await harness.emit("agent_start", {});

		const showOverlaySpy = vi.spyOn(harness.tui, "showOverlay");

		// Launch 3 concurrent mutating calls
		const p1 = emitToolCall(harness, "edit", { path: "src/one.ts" }, "turn-1/1");
		const p2 = emitToolCall(harness, "write", { path: "src/two.ts" }, "turn-1/2");
		const p3 = emitToolCall(harness, "bash", { command: "touch three.txt" }, "turn-1/3");

		await flushMicrotasks();
		expect(showOverlaySpy).toHaveBeenCalledTimes(1);
		expect(renderActiveModalText(harness)).toContain("src/one.ts");

		// User selects "allow for the rest of the turn" ('a')
		harness.activeCustomModal!.component.handleInput?.("a");

		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
		expect(r1).toBeUndefined();
		expect(r2).toBeUndefined();
		expect(r3).toBeUndefined();
		// Queued siblings #2 and #3 resolved immediately without opening any additional modals
		expect(showOverlaySpy).toHaveBeenCalledTimes(1);
		expect(harness.tui.overlayStack).toHaveLength(0);

		// Another mutating call later in the same turn also skips confirmation
		expect(await emitToolCall(harness, "deploy_prod", { env: "staging" }, "turn-1/4")).toBeUndefined();
		expect(showOverlaySpy).toHaveBeenCalledTimes(1);

		// End of agent run resets turn-wide allowance
		await harness.emit("agent_end", { messages: [] });

		// Next turn prompts again
		const nextTurnCall = emitToolCall(harness, "edit", { path: "src/next-turn.ts" }, "turn-2/1");
		await flushMicrotasks();
		expect(showOverlaySpy).toHaveBeenCalledTimes(2);
		expect(renderActiveModalText(harness)).toContain("src/next-turn.ts");
		// Select allow-turn again, then shut down session before agent_end
		harness.activeCustomModal!.component.handleInput?.("a");
		expect(await nextTurnCall).toBeUndefined();

		await harness.shutdownSession();

		// Start a new session in Auto-Safe mode -> turn allowance is reset and confirmation prompts again
		harness = createExtensionHarness({
			activeTools: ["bash", "edit", "write", "deploy_prod"],
		});
		harness.mount(conartiPiUi);
		await harness.startSession();
		await harness.runCommand("mode", "safe");
		const restartShowOverlaySpy = vi.spyOn(harness.tui, "showOverlay");

		const afterRestartCall = emitToolCall(harness, "write", { path: "src/after-restart.ts" }, "turn-3/1");
		await flushMicrotasks();
		expect(restartShowOverlaySpy).toHaveBeenCalledTimes(1);
		expect(renderActiveModalText(harness)).toContain("src/after-restart.ts");
		harness.activeCustomModal!.component.handleInput?.("\r");
		expect(await afterRestartCall).toBeUndefined();
	});
});
