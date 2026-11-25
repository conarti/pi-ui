import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPowerShellToolDefinition,
	defineTool,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SessionWorkflow } from "../src/shared/session-workflow.ts";
import {
	contentText,
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxToolCall,
	type InteractiveHarness,
} from "./harness/index.ts";

function findToolResult(harness: InteractiveHarness, toolCallId: string) {
	return harness.session.messages.find(
		(m): m is Extract<(typeof harness.session.messages)[number], { role: "toolResult" }> =>
			m.role === "toolResult" && m.toolCallId === toolCallId,
	);
}

async function waitForScreen(
	harness: InteractiveHarness,
	predicate: (text: string) => boolean,
	timeoutMs = 3000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		await harness.flush();
		const text = harness.screen().text();
		if (predicate(text)) return text;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return harness.screen().text();
}

function buildPreflightCustomTools(cwd: string, log: string[]): ToolDefinition<any, any, any>[] {
	const psTool = createPowerShellToolDefinition(cwd, {
		operations: {
			async exec(command, _cwd, opts) {
				log.push(`ps:${command}`);
				opts.onData(Buffer.from(`ps-ok:${command}\n`, "utf8"));
				return { exitCode: 0 };
			},
		},
	});

	const deployProd = defineTool({
		name: "deploy_prod",
		label: "Deploy Prod",
		description: "Destructive deployment tool via MCP annotations",
		parameters: Type.Object({ env: Type.Optional(Type.String()), target: Type.Optional(Type.String()) }),
		annotations: { destructiveHint: true },
		executionMode: "parallel",
		async execute(_id, params) {
			log.push(`deploy_prod:${params.env ?? params.target ?? "default"}`);
			return { content: [{ type: "text", text: "deployed" }], details: {} };
		},
	});

	const mcpDocs = defineTool({
		name: "mcp_docs",
		label: "MCP Docs",
		description: "Unannotated read-only lookup tool",
		parameters: Type.Object({ query: Type.String() }),
		executionMode: "parallel",
		async execute(_id, params) {
			log.push(`mcp_docs:${params.query}`);
			return { content: [{ type: "text", text: `docs:${params.query}` }], details: {} };
		},
	});

	return [psTool, deployProd, mcpDocs];
}

function buildDestructiveExtensionTool(log: string[]): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "drop_table",
			label: "Drop Table",
			description: "Extension-registered destructive tool",
			parameters: Type.Object({ table: Type.String() }),
			annotations: { destructiveHint: true },
			executionMode: "parallel",
			async execute(_id, params) {
				log.push(`drop_table:${params.table}`);
				return { content: [{ type: "text", text: "dropped" }], details: {} };
			},
		});
	};
}

describe("Tool-call preflight (Shell Effect, destructiveHint, Permission Prompt queue on real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function createTempProject(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-ui-preflight-"));
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

	it("in Plan mode blocks edit, write, destructiveHint tools, and mutating bash/powershell while allowing read-only Shell Effect and unannotated tools", async () => {
		const legacyWf = new SessionWorkflow();
		legacyWf.mode = "plan";
		const legacyRes = await legacyWf.preflightToolCall(
			{
				toolName: "legacy_drop",
				tools: {
					getActiveTools: () => [],
					setActiveTools: () => {},
					getAllTools: () => [{ name: "legacy_drop", destructiveHint: true }],
				},
			},
			async () => "allow",
		);
		expect(legacyRes?.block).toBe(true);

		const executed: string[] = [];
		const projectDir = createTempProject();
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(join(projectDir, "README.md"), "# Demo Readme\n", "utf8");
		writeFileSync(join(projectDir, "src", "app.ts"), "export const x = 'a > b';\n", "utf8");

		harness = await createInteractiveHarness({
			cwd: projectDir,
			width: 110,
			height: 34,
			tools: ["+grep"],
			customTools: buildPreflightCustomTools(projectDir, executed),
			extensionFactories: [buildDestructiveExtensionTool(executed)],
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall(
							"edit",
							{ path: "src/app.ts", edits: [{ oldText: "x", newText: "y" }] },
							{ id: "plan-edit" },
						),
						fauxToolCall("write", { path: "src/new.ts", content: "x" }, { id: "plan-write" }),
						fauxToolCall("deploy_prod", { env: "prod" }, { id: "plan-deploy" }),
						fauxToolCall("drop_table", { table: "users" }, { id: "plan-drop" }),
						fauxToolCall("bash", { command: "echo $(rm -rf /tmp/x)" }, { id: "plan-bash-sub" }),
						fauxToolCall("bash", { command: "node -e 'process.exit(0)'" }, { id: "plan-bash-node" }),
						fauxToolCall("bash", { command: "echo hi > out.txt" }, { id: "plan-bash-redir" }),
						fauxToolCall("powershell", { command: "Set-Content -Path a.txt -Value hi" }, { id: "plan-ps-mut" }),
						fauxToolCall("bash", { command: "ls -1 src" }, { id: "plan-bash-ro1" }),
						fauxToolCall("bash", { command: 'rg "a > b" src/ 2>/dev/null' }, { id: "plan-bash-ro2" }),
						fauxToolCall("powershell", { command: "Get-ChildItem -Path src" }, { id: "plan-ps-ro" }),
						fauxToolCall("read", { path: "README.md" }, { id: "plan-read" }),
						fauxToolCall("mcp_docs", { query: "modal card" }, { id: "plan-docs" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("1. Inspect files\n2. Propose changes"),
			],
		});

		await harness.submitInput("/mode plan");
		harness.session.setActiveToolsByName([
			"read",
			"bash",
			"powershell",
			"edit",
			"write",
			"grep",
			"deploy_prod",
			"drop_table",
			"mcp_docs",
		]);

		await harness.submitInput("Inspect project and draft a plan");
		await harness.pressKey("\x1b");

		expect(readFileSync(join(projectDir, "src", "app.ts"), "utf8")).toBe("export const x = 'a > b';\n");
		expect(existsSync(join(projectDir, "src", "new.ts"))).toBe(false);
		expect(existsSync(join(projectDir, "out.txt"))).toBe(false);
		expect(executed).toEqual([
			"ps:Get-ChildItem -Path src",
			"mcp_docs:modal card",
		]);

		expect(findToolResult(harness, "plan-edit")?.isError).toBe(true);
		expect(findToolResult(harness, "plan-write")?.isError).toBe(true);

		const deployErr = contentText(findToolResult(harness, "plan-deploy")!.content);
		expect(findToolResult(harness, "plan-deploy")?.isError).toBe(true);
		expect(deployErr).toContain("deploy_prod");

		const dropErr = contentText(findToolResult(harness, "plan-drop")!.content);
		expect(findToolResult(harness, "plan-drop")?.isError).toBe(true);
		expect(dropErr).toContain("drop_table");

		expect(contentText(findToolResult(harness, "plan-bash-sub")!.content)).toMatch(
			/substitution|opaque|mutat/i,
		);
		expect(contentText(findToolResult(harness, "plan-bash-node")!.content)).toMatch(/interpreter/i);
		expect(contentText(findToolResult(harness, "plan-bash-redir")!.content)).toMatch(/redirection/i);
		expect(findToolResult(harness, "plan-ps-mut")?.isError).toBe(true);

		expect(findToolResult(harness, "plan-bash-ro1")?.isError).toBe(false);
		expect(findToolResult(harness, "plan-bash-ro2")?.isError).toBe(false);
		expect(findToolResult(harness, "plan-ps-ro")?.isError).toBe(false);
		expect(findToolResult(harness, "plan-read")?.isError).toBe(false);
		expect(findToolResult(harness, "plan-docs")?.isError).toBe(false);
	});

	it("in Auto Session Mode runs read-only tools immediately and gates edit, write, destructiveHint, and mutating bash/powershell behind Permission Prompt Modal Card", async () => {
		const executed: string[] = [];
		const projectDir = createTempProject();
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(join(projectDir, "README.md"), "# Safe Readme\n", "utf8");
		writeFileSync(join(projectDir, "src", "app.ts"), "export const mode = 'old';\n", "utf8");

		harness = await createInteractiveHarness({
			cwd: projectDir,
			width: 110,
			height: 34,
			customTools: buildPreflightCustomTools(projectDir, executed),
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("read", { path: "README.md" }, { id: "ro-read" }),
						fauxToolCall("mcp_docs", { query: "plans" }, { id: "ro-docs" }),
						fauxToolCall("bash", { command: 'echo "a > b"' }, { id: "ro-bash" }),
						fauxToolCall("powershell", { command: "Get-Content README.md" }, { id: "ro-ps" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Read-only checks passed."),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"edit",
							{ path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] },
							{ id: "safe-edit" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "src/new.ts", content: "blocked" }, { id: "safe-write" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("deploy_prod", { env: "prod" }, { id: "safe-deploy" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: "touch blocked.txt" }, { id: "safe-bash" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("powershell", { command: "Remove-Item dist -Recurse" }, { id: "safe-ps" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Auto-Safe workflow finished."),
			],
		});
		harness.session.setActiveToolsByName([
			"read",
			"bash",
			"powershell",
			"edit",
			"write",
			"deploy_prod",
			"mcp_docs",
		]);

		await harness.submitInput("/mode safe");

		await harness.submitInput("Run read-only checks");
		expect(harness.screen().text()).toContain("Read-only checks passed.");
		expect(harness.screen().text()).not.toContain("Auto-Safe Confirmation");
		expect(executed).toEqual(["mcp_docs:plans", "ps:Get-Content README.md"]);

		const safeTurn = harness.submitInput("Apply safe mutations");

		const editModalText = await waitForScreen(harness, (t) => t.includes("src/app.ts"));
		expect(editModalText).toContain("Auto-Safe Confirmation");
		expect(editModalText).toContain("edit");
		await harness.pressKey("\r");

		const writeModalText = await waitForScreen(harness, (t) => t.includes("src/new.ts"));
		expect(readFileSync(join(projectDir, "src", "app.ts"), "utf8")).toBe("export const mode = 'new';\n");
		expect(writeModalText).toContain("Auto-Safe Confirmation");
		expect(writeModalText).toContain("write");
		await harness.pressKey("\x1b");

		const deployModalText = await waitForScreen(harness, (t) => t.includes("deploy_prod"));
		expect(existsSync(join(projectDir, "src", "new.ts"))).toBe(false);
		expect(findToolResult(harness, "safe-write")?.isError).toBe(true);
		expect(contentText(findToolResult(harness, "safe-write")!.content)).toContain("Auto-Safe");
		expect(deployModalText).toContain("deploy_prod");
		await harness.pressKey("\r");

		const bashModalText = await waitForScreen(harness, (t) => t.includes("touch blocked.txt"));
		expect(executed).toContain("deploy_prod:prod");
		expect(bashModalText).toContain("bash");
		await harness.pressKey("\x1b");

		const psModalText = await waitForScreen(harness, (t) => t.includes("Remove-Item dist -Recurse"));
		expect(existsSync(join(projectDir, "blocked.txt"))).toBe(false);
		expect(findToolResult(harness, "safe-bash")?.isError).toBe(true);
		expect(psModalText).toContain("powershell");
		await harness.pressKey("\r");

		await safeTurn;
		expect(harness.screen().text()).not.toContain("Auto-Safe Confirmation");
		expect(executed).toContain("ps:Remove-Item dist -Recurse");
		expect(harness.screen().text()).toContain("Auto-Safe workflow finished.");
	});

	it("serializes concurrent mutating tool calls strictly one Modal Card at a time in FIFO order without deadlocking on prompt errors or session abort", async () => {
		const wf = new SessionWorkflow();
		wf.mode = "safe";
		let confirmCalls = 0;
		const [errOutcome, okOutcome] = await Promise.all([
			wf.preflightToolCall({ toolName: "edit", input: { path: "src/a.ts" } }, async () => {
				confirmCalls += 1;
				throw new Error("UI prompt failed");
			}),
			wf.preflightToolCall({ toolName: "write", input: { path: "src/b.ts" } }, async () => {
				confirmCalls += 1;
				return "allow";
			}),
		]);
		expect(errOutcome?.block).toBe(true);
		expect(okOutcome).toBeUndefined();
		expect(confirmCalls).toBe(2);

		const settledOrder: string[] = [];
		const executed: string[] = [];

		const parallelParent = defineTool({
			name: "parallel_batch",
			label: "Parallel Batch",
			description: "Runs 3 mutating child tool calls concurrently via ctx.executeTool",
			parameters: Type.Object({}),
			async execute(_id, _params, signal, _onUpdate, ctx) {
				const [r1, r2, r3] = await Promise.all([
					ctx.executeTool("write", { path: "first.txt", content: "1" }, { signal }).then((res) => {
						settledOrder.push("first");
						return res;
					}),
					ctx.executeTool("bash", { command: "touch second.txt" }, { signal }).then((res) => {
						settledOrder.push("second");
						return res;
					}),
					ctx.executeTool("deploy_prod", { target: "third" }, { signal }).then((res) => {
						settledOrder.push("third");
						return res;
					}),
				]);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								firstErr: r1.isError,
								secondErr: r2.isError,
								thirdErr: r3.isError,
							}),
						},
					],
					details: {},
				};
			},
		});

		const projectDir = createTempProject();
		harness = await createInteractiveHarness({
			cwd: projectDir,
			width: 110,
			height: 34,
			customTools: [...buildPreflightCustomTools(projectDir, executed), parallelParent],
			responses: [
				fauxAssistantMessage([fauxToolCall("parallel_batch", {}, { id: "batch-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Batch settled cleanly."),
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "aborted-write.txt", content: "x" }, { id: "abort-1" })],
					{ stopReason: "toolUse" },
				),
			],
		});
		harness.session.setActiveToolsByName([
			"read",
			"bash",
			"edit",
			"write",
			"deploy_prod",
			"parallel_batch",
		]);

		await harness.submitInput("/mode safe");
		const turn = harness.submitInput("Run concurrent batch");

		const firstScreen = await waitForScreen(harness, (t) => t.includes("first.txt"));
		expect(settledOrder).toEqual([]);
		expect(firstScreen).toContain("Auto-Safe Confirmation");
		expect(firstScreen).not.toContain("touch second.txt");
		expect(firstScreen).not.toContain("deploy_prod");

		await harness.pressKey("\r");
		const secondScreen = await waitForScreen(harness, (t) => t.includes("touch second.txt"));
		await waitForScreen(harness, () => settledOrder.includes("first"));
		expect(settledOrder).toEqual(["first"]);
		expect(existsSync(join(projectDir, "first.txt"))).toBe(true);
		expect(secondScreen).toContain("touch second.txt");

		await harness.pressKey("\x1b");
		const thirdScreen = await waitForScreen(harness, (t) => t.includes("deploy_prod"));
		expect(settledOrder).toEqual(["first", "second"]);
		expect(existsSync(join(projectDir, "second.txt"))).toBe(false);
		expect(thirdScreen).toContain("deploy_prod");

		await harness.pressKey("\r");
		await turn;

		expect(settledOrder).toEqual(["first", "second", "third"]);
		expect(executed).toEqual(["deploy_prod:third"]);
		expect(harness.screen().text()).not.toContain("Auto-Safe Confirmation");
		const batchResult = JSON.parse(contentText(findToolResult(harness, "batch-1")!.content));
		expect(batchResult).toEqual({ firstErr: false, secondErr: true, thirdErr: false });

		const abortTurn = harness.submitInput("Trigger abortable safe prompt");
		await waitForScreen(harness, (t) => t.includes("aborted-write.txt"));
		await harness.session.abort();
		await abortTurn;
		expect(existsSync(join(projectDir, "aborted-write.txt"))).toBe(false);
		expect(harness.screen().text()).not.toContain("Auto-Safe Confirmation");
	});

	it("allow-for-the-rest-of-the-turn ('a') drains queued sibling calls without extra modals and resets on agent_end and session restart", async () => {
		const executed: string[] = [];

		const parallelTurnBatch = defineTool({
			name: "turn_batch",
			label: "Turn Batch",
			description: "Launches 3 concurrent mutating calls",
			parameters: Type.Object({}),
			async execute(_id, _params, signal, _onUpdate, ctx) {
				await Promise.all([
					ctx.executeTool("write", { path: "one.txt", content: "1" }, { signal }),
					ctx.executeTool("write", { path: "two.txt", content: "2" }, { signal }),
					ctx.executeTool("bash", { command: "touch three.txt" }, { signal }),
				]);
				return { content: [{ type: "text", text: "all three allowed" }], details: {} };
			},
		});

		const projectDir = createTempProject();
		harness = await createInteractiveHarness({
			cwd: projectDir,
			width: 110,
			height: 34,
			customTools: [...buildPreflightCustomTools(projectDir, executed), parallelTurnBatch],
			responses: [
				fauxAssistantMessage([fauxToolCall("turn_batch", {}, { id: "tb-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("deploy_prod", { env: "staging" }, { id: "tb-follow" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Turn 1 complete."),
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "next-turn.txt", content: "next" }, { id: "tb-next" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Turn 2 complete."),
			],
		});
		harness.session.setActiveToolsByName([
			"read",
			"bash",
			"edit",
			"write",
			"deploy_prod",
			"turn_batch",
		]);

		await harness.submitInput("/mode safe");

		const turn1 = harness.submitInput("Execute turn 1 batch");
		await waitForScreen(harness, (t) => t.includes("one.txt"));
		await harness.pressKey("a");
		await turn1;

		expect(existsSync(join(projectDir, "one.txt"))).toBe(true);
		expect(existsSync(join(projectDir, "two.txt"))).toBe(true);
		expect(existsSync(join(projectDir, "three.txt"))).toBe(true);
		expect(executed).toEqual(["deploy_prod:staging"]);
		expect(harness.screen().text()).toContain("Turn 1 complete.");

		const turn2 = harness.submitInput("Execute turn 2 mutation");
		await waitForScreen(harness, (t) => t.includes("next-turn.txt"));
		await harness.pressKey("a");
		await turn2;
		expect(existsSync(join(projectDir, "next-turn.txt"))).toBe(true);

		await harness.dispose();
		harness = await createInteractiveHarness({
			cwd: projectDir,
			width: 110,
			height: 34,
			responses: [
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "after-restart.txt", content: "ok" }, { id: "tb-restart" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Restart turn complete."),
			],
		});

		await harness.submitInput("/mode safe");
		const turn3 = harness.submitInput("Execute after restart");
		await waitForScreen(harness, (t) => t.includes("after-restart.txt"));
		await harness.pressKey("\r");
		await turn3;
		expect(existsSync(join(projectDir, "after-restart.txt"))).toBe(true);
	});
});
