import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/features/tool-calls/config.ts";
import {
	classifyExploration,
	extractCommandOutput,
	formatExploredSummary,
	sliceHeadTailPreview,
} from "../src/features/tool-calls/density.ts";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

describe("Tool Density: command & codemode output slicing (pure seam)", () => {
	it("slices outputs above 5 lines into 2 head + … + 3 tail and strips shell exit trailers and codemode headers", () => {
		expect(sliceHeadTailPreview([])).toEqual({
			head: [],
			omitted: 0,
			tail: [],
		});

		expect(sliceHeadTailPreview(["one", "two", "three", "four", "five"])).toEqual({
			head: ["one", "two", "three", "four", "five"],
			omitted: 0,
			tail: [],
		});

		expect(sliceHeadTailPreview(["L1", "L2", "L3", "L4", "L5", "L6"])).toEqual({
			head: ["L1", "L2"],
			omitted: 1,
			tail: ["L4", "L5", "L6"],
		});

		expect(
			sliceHeadTailPreview(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"]),
		).toEqual({
			head: ["L1", "L2"],
			omitted: 5,
			tail: ["L8", "L9", "L10"],
		});

		const bashFailed = extractCommandOutput(
			"bash",
			"step 1\nstep 2\nstep 3\nstep 4\nstep 5\nERR: missing token\nCommand exited with code 2",
			true,
		);
		expect(bashFailed.exitCode).toBe(2);
		expect(sliceHeadTailPreview(bashFailed.lines)).toEqual({
			head: ["step 1", "step 2"],
			omitted: 1,
			tail: ["step 4", "step 5", "ERR: missing token"],
		});

		const bashEmpty = extractCommandOutput("bash", "(no output)\n", false);
		expect(bashEmpty.lines).toEqual([]);

		const codemodeDone = extractCommandOutput(
			"codemode",
			"Script completed\nWall time 0.4 seconds\nOutput:\nrow 1\nrow 2\nrow 3\nrow 4\nrow 5\nrow 6\nrow 7",
			false,
		);
		expect(sliceHeadTailPreview(codemodeDone.lines)).toEqual({
			head: ["row 1", "row 2"],
			omitted: 2,
			tail: ["row 5", "row 6", "row 7"],
		});
	});

	it("classifies strictly read-only inspection calls via Shell Effect, rejects mutating commands, and formats Explored N files, M searches", () => {
		expect(classifyExploration("read", { path: "src/index.ts" })).toBe("read");
		expect(classifyExploration("grep", { pattern: "TODO", path: "src" })).toBe("search");
		expect(classifyExploration("find", { pattern: "*.ts", path: "src" })).toBe("search");
		expect(classifyExploration("ls", { path: "src" })).toBe("list");

		expect(classifyExploration("bash", { command: "cd src && rg 'ShellEffect' 2>/dev/null | head -n 20" })).toBe(
			"search",
		);
		expect(classifyExploration("bash", { command: "env LC_ALL=C sed -n '1,30p' src/index.ts" })).toBe("read");
		expect(classifyExploration("bash", { command: "git grep 'ToolDensity'" })).toBe("search");
		expect(classifyExploration("bash", { command: "git ls-files src" })).toBe("list");
		expect(classifyExploration("bash", { command: "git branch --show-current" })).toBe("read");
		expect(classifyExploration("bash", { command: "shasum package.json" })).toBe("read");
		expect(classifyExploration("bash", { command: "pwd" })).toBe("list");
		expect(classifyExploration("bash", { command: "ls -la src | grep density" })).toBe("search");
		expect(classifyExploration("powershell", { command: "Get-Content src/index.ts" })).toBe("read");
		expect(classifyExploration("powershell", { command: "Resolve-Path src" })).toBe("read");
		expect(classifyExploration("powershell", { command: "Select-String -Pattern foo src/a.ts" })).toBe("search");

		for (const mutating of [
			"rm -rf dist",
			"sed -i 's/a/b/' src/index.ts",
			"find . -name '*.tmp' -delete",
			"fd . -x rm",
			"cat src/a.ts > src/b.ts",
			"rg foo | tee out.log",
			"npm test",
			"node -e 'console.log(1)'",
			"git checkout -b other",
			"echo $(whoami)",
		]) {
			expect(classifyExploration("bash", { command: mutating })).toBeUndefined();
		}
		expect(classifyExploration("edit", { path: "src/a.ts" })).toBeUndefined();
		expect(classifyExploration("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
		expect(classifyExploration("codemode", { code: "return 1;" })).toBeUndefined();

		const doneRows = [
			{ toolName: "read", toolCallId: "r1", args: { path: "src/a.ts" }, result: { content: [] }, isPartial: false },
			{ toolName: "read", toolCallId: "r2", args: { path: "src/b.ts" }, result: { content: [] }, isPartial: false },
			{ toolName: "grep", toolCallId: "g1", args: { pattern: "foo" }, result: { content: [] }, isPartial: false },
			{ toolName: "bash", toolCallId: "b1", args: { command: "rg bar src" }, result: { content: [] }, isPartial: false },
		];
		expect(formatExploredSummary(doneRows as any)).toBe("Explored 2 files, 2 searches");

		const runningRows = [
			...doneRows,
			{ toolName: "ls", toolCallId: "l1", args: { path: "src" }, result: undefined, isPartial: true },
		];
		expect(formatExploredSummary(runningRows as any)).toBe("Exploring 2 files, 2 searches, 1 directory");
	});
});

function extractRgbTriples(ansi: string): Array<[number, number, number]> {
	return [...ansi.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/gu)].map((m) => [
		Number(m[1]),
		Number(m[2]),
		Number(m[3]),
	]);
}

describe("Tool Density: ExtensionHarness integration", () => {
	let harness: ExtensionHarness | undefined;
	let agentDir = "";
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		agentDir = mkdtempSync(join(tmpdir(), "pi-ui-ticket13-agent-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		if (harness) {
			await harness.runCommand("silent", "off");
			await harness.shutdownSession();
			harness = undefined;
		}
		stopAllAnimations();
		vi.useRealTimers();
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	});

	it("renders ◆ diamond indicator across all 8 built-in tools, codemode, and custom/MCP tools with 30 fps breathing, 0-timer idle cleanup, muted collapsed diamond, and dimmed parenthetical counts/durations in dark & light blue-slate tones", async () => {
		vi.useFakeTimers();
		expect(DEFAULT_CONFIG.tools).toEqual([
			"read",
			"write",
			"edit",
			"bash",
			"powershell",
			"grep",
			"find",
			"ls",
		]);
		expect(DEFAULT_CONFIG.density).toBe("detailed");

		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();
		expect(vi.getTimerCount()).toBe(0);

		await harness.emit("agent_start", {});
		await harness.emit("tool_execution_start", {
			toolCallId: "tc-grep",
			toolName: "grep",
			args: { pattern: "ScrollView", path: "src" },
		});

		const grepRow = new ToolExecutionComponent(
			"grep",
			"tc-grep",
			{ pattern: "ScrollView", path: "src" },
			undefined,
			undefined,
			harness.tui.asTui(),
			harness.ctx.cwd,
		);
		(grepRow as any).markExecutionStarted();

		const runningFrame0 = grepRow.render(90).join("\n");
		expect(stripTerminalSequences(runningFrame0)).toContain("◆");
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(33 * 6);
		const runningFrame1 = grepRow.render(90).join("\n");
		expect(runningFrame1).not.toBe(runningFrame0);

		for (const [r, g, b] of extractRgbTriples(runningFrame1)) {
			expect(r).toBeLessThan(g);
			expect(g).toBeLessThan(b);
		}

		await harness.emit("tool_execution_end", {
			toolCallId: "tc-grep",
			toolName: "grep",
			durationMs: 120,
		});
		(grepRow as any).updateResult(
			{
				content: [{ type: "text", text: "src/a.ts:1:ScrollView\nsrc/b.ts:4:ScrollView\nsrc/c.ts:9:ScrollView" }],
				durationMs: 120,
			},
			false,
		);
		await harness.emit("agent_end", { messages: [] });

		const settledDark = grepRow.render(90).join("\n");
		const settledPlain = stripTerminalSequences(settledDark);
		expect(vi.getTimerCount()).toBe(0);
		expect(settledPlain).toContain("◆");
		expect(settledPlain).toContain("(3 lines · 120ms)");
		expect(settledDark).not.toBe(runningFrame1);
		for (const [r, g, b] of extractRgbTriples(settledDark)) {
			expect(r).toBeLessThan(g);
			expect(g).toBeLessThan(b);
		}

		harness.setTheme("light");
		const settledLight = grepRow.render(90).join("\n");
		expect(settledLight).not.toBe(settledDark);
		for (const [r, g, b] of extractRgbTriples(settledLight)) {
			expect(r).toBeLessThan(g);
			expect(g).toBeLessThan(b);
		}
		harness.setTheme("dark");

		const toolCases: Array<{ name: string; args: Record<string, unknown>; resultText: string; details?: unknown }> = [
			{ name: "read", args: { path: "src/index.ts" }, resultText: "line 1\nline 2" },
			{ name: "write", args: { path: "src/out.ts", content: "export const x = 1;\n" }, resultText: "Wrote file" },
			{
				name: "edit",
				args: { path: "src/index.ts" },
				resultText: "Edited file",
				details: { diff: "-1 old\n+1 new" },
			},
			{ name: "bash", args: { command: "echo ok" }, resultText: "ok" },
			{ name: "powershell", args: { command: "Write-Output ok" }, resultText: "ok" },
			{ name: "grep", args: { pattern: "foo", path: "src" }, resultText: "src/index.ts:1:foo" },
			{ name: "find", args: { pattern: "*.ts", path: "src" }, resultText: "src/index.ts" },
			{ name: "ls", args: { path: "src" }, resultText: "index.ts" },
			{ name: "codemode", args: { code: "return 'hello';" }, resultText: "hello" },
			{ name: "mcp__github__search", args: { query: "pi-tui" }, resultText: "issue #9\nissue #13" },
		];

		for (const [idx, item] of toolCases.entries()) {
			const id = `tc-all-${idx}`;
			const row = new ToolExecutionComponent(
				item.name,
				id,
				item.args,
				undefined,
				undefined,
				harness.tui.asTui(),
				harness.ctx.cwd,
			);
			(row as any).updateResult(
				{
					content: [{ type: "text", text: item.resultText }],
					details: item.details,
					durationMs: 45,
				},
				false,
			);
			const plain = row.render(90).map(stripTerminalSequences).join("\n");
			expect(plain).toContain("◆");
			expect(plain).not.toContain("⦁");
		}
	});

	it("defaults to Detailed density: shows inline edit/write contextual diffs (+N -M + diff lines) and 2 head + … + 3 tail previews with a 30 fps breathing left bar for bash, powershell, and codemode", async () => {
		vi.useFakeTimers();
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const editRow = new ToolExecutionComponent(
			"edit",
			"tc-edit-1",
			{ path: "src/auth.ts" },
			undefined,
			undefined,
			harness.tui.asTui(),
			harness.ctx.cwd,
		);
		(editRow as any).updateResult(
			{
				content: [{ type: "text", text: "Updated src/auth.ts" }],
				details: {
					patch: [
						"@@ -10,4 +10,5 @@",
						" const header = req.headers.authorization;",
						"-const valid = checkLegacy(header);",
						"+const token = parseBearer(header);",
						"+const valid = verifyJwt(token);",
						" return valid;",
					].join("\n"),
				},
				durationMs: 65,
			},
			false,
		);
		const editPlain = editRow.render(96).map(stripTerminalSequences).join("\n");
		expect(editPlain).toContain("◆ Edited src/auth.ts (+2 -1 · 65ms)");
		expect(editPlain).toContain("const header = req.headers.authorization;");
		expect(editPlain).toContain("-const valid = checkLegacy(header);");
		expect(editPlain).toContain("+const token = parseBearer(header);");
		expect(editPlain).toContain("+const valid = verifyJwt(token);");

		const writeRow = new ToolExecutionComponent(
			"write",
			"tc-write-1",
			{ path: "src/config.ts", content: "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n" },
			undefined,
			undefined,
			harness.tui.asTui(),
			harness.ctx.cwd,
		);
		(writeRow as any).updateResult(
			{
				content: [{ type: "text", text: "Wrote src/config.ts" }],
				durationMs: 30,
			},
			false,
		);
		const writePlain = writeRow.render(96).map(stripTerminalSequences).join("\n");
		expect(writePlain).toContain("◆ Wrote src/config.ts (+3 -0 · 30ms)");
		expect(writePlain).toContain("+export const A = 1;");
		expect(writePlain).toContain("+export const C = 3;");

		await harness.emit("agent_start", {});
		for (const cmdTool of ["bash", "powershell", "codemode"] as const) {
			const callId = `tc-${cmdTool}-run`;
			const args =
				cmdTool === "codemode"
					? { code: "return await tools.bash({ command: 'ls' });" }
					: { command: "npm run check" };
			await harness.emit("tool_execution_start", { toolCallId: callId, toolName: cmdTool, args });

			const row = new ToolExecutionComponent(
				cmdTool,
				callId,
				args,
				undefined,
				undefined,
				harness.tui.asTui(),
				harness.ctx.cwd,
			);
			(row as any).markExecutionStarted();

			const preChunkAnsi0 = row.render(96);
			const preChunkPlain0 = preChunkAnsi0.map(stripTerminalSequences).filter((l) => l.trim().length > 0);
			expect(preChunkPlain0[0]).toContain("◆ Running");
			expect(preChunkPlain0.slice(1).map((l) => l.trim())).toEqual(["▎ Running…"]);
			const preBarBefore = preChunkAnsi0.find((l) => stripTerminalSequences(l).includes("▎ Running…"))!;
			vi.advanceTimersByTime(33 * 6);
			const preChunkAnsi1 = row.render(96);
			const preBarAfter = preChunkAnsi1.find((l) => stripTerminalSequences(l).includes("▎ Running…"))!;
			expect(preBarAfter).not.toBe(preBarBefore);

			const partialLines = Array.from({ length: 8 }, (_, i) => `${cmdTool}-out-${i + 1}`).join("\n");
			(row as any).updateResult(
				{
					content: [{ type: "text", text: partialLines }],
				},
				true,
			);

			const runAnsi0 = row.render(96);
			const runPlain0 = runAnsi0.map(stripTerminalSequences).filter((l) => l.trim().length > 0);
			expect(runPlain0[0]).toContain("◆ Running");
			const previewPlain0 = runPlain0.slice(1).map((l) => l.trim());
			expect(previewPlain0).toEqual([
				`▎ ${cmdTool}-out-1`,
				`▎ ${cmdTool}-out-2`,
				"▎ …",
				`▎ ${cmdTool}-out-6`,
				`▎ ${cmdTool}-out-7`,
				`▎ ${cmdTool}-out-8`,
			]);
			expect(vi.getTimerCount()).toBe(1);

			const barLine0Before = runAnsi0.find((l) => stripTerminalSequences(l).includes(`${cmdTool}-out-1`))!;
			const barLine1Before = runAnsi0.find((l) => stripTerminalSequences(l).includes(`${cmdTool}-out-2`))!;
			expect(extractRgbTriples(barLine0Before)[0]).not.toEqual(extractRgbTriples(barLine1Before)[0]);

			vi.advanceTimersByTime(33 * 6);
			const runAnsi1 = row.render(96);
			const barLine0After = runAnsi1.find((l) => stripTerminalSequences(l).includes(`${cmdTool}-out-1`))!;
			expect(barLine0After).not.toBe(barLine0Before);
			for (const [r, g, b] of extractRgbTriples(barLine0After)) {
				expect(r).toBeLessThan(g);
				expect(g).toBeLessThan(b);
			}

			const finalLines = Array.from({ length: 10 }, (_, i) => `${cmdTool}-out-${i + 1}`).join("\n");
			const wrappedFinal =
				cmdTool === "codemode"
					? `Script completed\nWall time 0.3 seconds\nOutput:\n${finalLines}`
					: finalLines;
			await harness.emit("tool_execution_end", { toolCallId: callId, toolName: cmdTool, durationMs: 310 });
			(row as any).updateResult(
				{
					content: [{ type: "text", text: wrappedFinal }],
					durationMs: 310,
				},
				false,
			);

			const donePlain = row
				.render(96)
				.map(stripTerminalSequences)
				.filter((l) => l.trim().length > 0);
			expect(donePlain[0]).toContain("◆ Ran");
			expect(donePlain[0]).toContain("(10 lines · 310ms)");
			expect(donePlain.slice(1).map((l) => l.trim())).toEqual([
				`│ ${cmdTool}-out-1`,
				`│ ${cmdTool}-out-2`,
				"│ …",
				`│ ${cmdTool}-out-8`,
				`│ ${cmdTool}-out-9`,
				`│ ${cmdTool}-out-10`,
			]);
		}

		await harness.emit("agent_end", { messages: [] });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("folds consecutive Shell Effect-verified read-only calls into ◆ Explored N files, M searches, never folds mutating commands, toggles groups and author custom renderers on click, and respects /silent", async () => {
		vi.useFakeTimers();
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		await harness.emit("agent_start", {});

		const mkRow = (id: string, name: string, args: Record<string, unknown>, def?: ToolDefinition<any, any, any>) =>
			new ToolExecutionComponent(name, id, args, undefined, def, harness!.tui.asTui(), harness!.ctx.cwd);

		const r1 = mkRow("exp-1", "read", { path: "src/a.ts" });
		(r1 as any).updateResult({ content: [{ type: "text", text: "const a = 1;" }], durationMs: 12 }, false);

		const r2 = mkRow("exp-2", "read", { path: "src/b.ts" });
		(r2 as any).updateResult({ content: [{ type: "text", text: "const b = 2;" }], durationMs: 14 }, false);

		const g1 = mkRow("exp-3", "grep", { pattern: "ScrollView", path: "src" });
		(g1 as any).updateResult({ content: [{ type: "text", text: "src/a.ts:1:ScrollView" }], durationMs: 18 }, false);

		await harness.emit("tool_execution_start", {
			toolCallId: "exp-4",
			toolName: "bash",
			args: { command: "rg 'ToolDensity' src 2>/dev/null" },
		});
		const bReadOnly = mkRow("exp-4", "bash", { command: "rg 'ToolDensity' src 2>/dev/null" });
		(bReadOnly as any).markExecutionStarted();

		const bMutating = mkRow("mut-1", "bash", { command: "sed -i 's/a/b/' src/a.ts" });
		(bMutating as any).updateResult({ content: [{ type: "text", text: "patched src/a.ts" }], durationMs: 40 }, false);

		const authorToolDef = {
			name: "custom_diagram",
			label: "custom_diagram",
			description: "Custom diagram tool",
			parameters: {} as any,
			execute: async () => ({ content: [], details: undefined }),
			renderResult: (_result: any, opts: { expanded: boolean }) =>
				new Text(opts.expanded ? "AUTHOR_FULL_DIAGRAM_VIEW" : "AUTHOR_COMPACT", 0, 0),
		} as ToolDefinition<any, any, any>;
		const customRow = mkRow("cust-1", "custom_diagram", { title: "arch" }, authorToolDef);
		(customRow as any).updateResult({ content: [{ type: "text", text: "raw fallback" }], durationMs: 55 }, false);

		harness.tui.chatContainer.addChild(r1);
		harness.tui.chatContainer.addChild(r2);
		harness.tui.chatContainer.addChild(g1);
		harness.tui.chatContainer.addChild(bReadOnly);
		harness.tui.chatContainer.addChild(bMutating);
		harness.tui.chatContainer.addChild(customRow);

		const runningChat0 = harness.tui.chatContainer.render(96);
		const runningPlain0 = runningChat0.map(stripTerminalSequences).join("\n");
		expect(runningPlain0).toContain("◆ Exploring 2 files, 2 searches");
		expect(runningPlain0).not.toContain("Read src/a.ts");
		expect(runningPlain0).not.toContain("src/b.ts");
		expect(runningPlain0).toContain("sed -i 's/a/b/' src/a.ts");
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(33 * 5);
		const runningChat1 = harness.tui.chatContainer.render(96);
		expect(runningChat1.join("\n")).not.toBe(runningChat0.join("\n"));

		await harness.emit("tool_execution_end", { toolCallId: "exp-4", toolName: "bash", durationMs: 22 });
		(bReadOnly as any).updateResult({ content: [{ type: "text", text: "src/types.ts:3:ToolDensity" }], durationMs: 22 }, false);
		await harness.emit("agent_end", { messages: [] });
		expect(vi.getTimerCount()).toBe(0);

		const foldedLines = harness.tui.chatContainer.render(96);
		const foldedPlain = foldedLines.map(stripTerminalSequences).join("\n");
		expect(foldedPlain).toContain("◆ Explored 2 files, 2 searches");
		expect(foldedPlain).not.toContain("Read src/a.ts");
		expect(foldedPlain).not.toContain("(click to expand)");
		expect(foldedPlain).toContain("◆ Ran sed -i 's/a/b/' src/a.ts");
		expect(foldedPlain).toContain("◆ custom_diagram arch");
		expect(foldedPlain).not.toContain("AUTHOR_FULL_DIAGRAM_VIEW");

		const exploredRowIdx = foldedLines.findIndex((l) =>
			stripTerminalSequences(l).includes("◆ Explored 2 files, 2 searches"),
		);
		expect(exploredRowIdx).toBeGreaterThanOrEqual(0);

		const clickGroup = harness.tui.chatContainer.handleMouse({
			type: "click",
			button: "left",
			x: 4,
			y: exploredRowIdx,
			screenX: 4,
			screenY: exploredRowIdx,
			width: 96,
			height: foldedLines.length,
			shift: false,
			alt: false,
			ctrl: false,
		} as any);
		expect(clickGroup?.handled).toBe(true);

		const expandedGroupLines = harness.tui.chatContainer.render(96);
		const expandedGroupPlain = expandedGroupLines.map(stripTerminalSequences).join("\n");
		expect(expandedGroupPlain).toContain("◆ Explored 2 files, 2 searches");
		expect(expandedGroupPlain).toContain("◆ Read src/a.ts");
		expect(expandedGroupPlain).toContain("◆ Read src/b.ts");
		expect(expandedGroupPlain).toContain("◆ Searched /ScrollView/ in src");

		const collapseGroup = harness.tui.chatContainer.handleMouse({
			type: "click",
			button: "left",
			x: 4,
			y: exploredRowIdx,
			screenX: 4,
			screenY: exploredRowIdx,
			width: 96,
			height: expandedGroupLines.length,
			shift: false,
			alt: false,
			ctrl: false,
		} as any);
		expect(collapseGroup?.handled).toBe(true);

		const recollapsedLines = harness.tui.chatContainer.render(96);
		expect(recollapsedLines.map(stripTerminalSequences).join("\n")).not.toContain("◆ Read src/a.ts");

		const customRowIdx = recollapsedLines.findIndex((l) =>
			stripTerminalSequences(l).includes("◆ custom_diagram arch"),
		);
		expect(customRowIdx).toBeGreaterThan(0);
		const clickCustom = harness.tui.chatContainer.handleMouse({
			type: "click",
			button: "left",
			x: 4,
			y: customRowIdx,
			screenX: 4,
			screenY: customRowIdx,
			width: 96,
			height: recollapsedLines.length,
			shift: false,
			alt: false,
			ctrl: false,
		} as any);
		expect(clickCustom?.handled).toBe(true);

		const expandedCustomLines = harness.tui.chatContainer.render(96);
		expect(expandedCustomLines.map(stripTerminalSequences).join("\n")).toContain("AUTHOR_FULL_DIAGRAM_VIEW");

		await harness.runCommand("silent", "on");
		const silentPlain = harness.tui.chatContainer.render(96).map(stripTerminalSequences).join("\n").trim();
		expect(silentPlain).toBe("");

		await harness.runCommand("silent", "off");
		const restoredPlain = harness.tui.chatContainer.render(96).map(stripTerminalSequences).join("\n");
		expect(restoredPlain).toContain("◆ Explored 2 files, 2 searches");
		expect(restoredPlain).toContain("AUTHOR_FULL_DIAGRAM_VIEW");
	});

	it("switches live without reload across detailed, diff-focus, and compact via /density and /compact-tools", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		const reloadSpy = vi.fn();
		(harness.ctx as any).reload = reloadSpy;

		harness.mount(conartiPiUi);
		await harness.startSession();
		expect(harness.commands.has("density")).toBe(true);
		expect(harness.commands.has("compact-tools")).toBe(true);

		const mkRow = (id: string, name: string, args: Record<string, unknown>) =>
			new ToolExecutionComponent(name, id, args, undefined, undefined, harness!.tui.asTui(), harness!.ctx.cwd);

		const readA = mkRow("d-r1", "read", { path: "src/one.ts" });
		(readA as any).updateResult({ content: [{ type: "text", text: "export const one = 1;" }], durationMs: 10 }, false);
		const readB = mkRow("d-r2", "read", { path: "src/two.ts" });
		(readB as any).updateResult({ content: [{ type: "text", text: "export const two = 2;" }], durationMs: 11 }, false);

		const editRow = mkRow("d-edit", "edit", { path: "src/service.ts" });
		(editRow as any).updateResult(
			{
				content: [{ type: "text", text: "Updated" }],
				details: {
					patch: "@@ -1,2 +1,3 @@\n const port = 3000;\n-const host = 'localhost';\n+const host = '0.0.0.0';\n+const tls = true;",
				},
				durationMs: 42,
			},
			false,
		);

		const writeRow = mkRow("d-write", "write", {
			path: "src/constants.ts",
			content: "export const MAX = 10;\nexport const MIN = 1;\n",
		});
		(writeRow as any).updateResult({ content: [{ type: "text", text: "Wrote" }], durationMs: 28 }, false);

		const bashRow = mkRow("d-bash", "bash", { command: "npm test" });
		(bashRow as any).updateResult(
			{
				content: [{ type: "text", text: Array.from({ length: 8 }, (_, i) => `bash-line-${i + 1}`).join("\n") }],
				durationMs: 210,
			},
			false,
		);

		const psRow = mkRow("d-ps", "powershell", { command: "Invoke-Pester" });
		(psRow as any).updateResult(
			{
				content: [{ type: "text", text: Array.from({ length: 7 }, (_, i) => `ps-line-${i + 1}`).join("\n") }],
				durationMs: 190,
			},
			false,
		);

		const cmRow = mkRow("d-cm", "codemode", { code: "return 'done';" });
		(cmRow as any).updateResult(
			{
				content: [{ type: "text", text: Array.from({ length: 9 }, (_, i) => `cm-line-${i + 1}`).join("\n") }],
				durationMs: 150,
			},
			false,
		);

		const mcpRow = mkRow("d-mcp", "mcp__docs__lookup", { topic: "ScrollView" });
		(mcpRow as any).updateResult(
			{ content: [{ type: "text", text: "doc-1\ndoc-2\ndoc-3\ndoc-4" }], durationMs: 80 },
			false,
		);

		for (const r of [readA, readB, editRow, writeRow, bashRow, psRow, cmRow, mcpRow]) {
			harness.tui.chatContainer.addChild(r);
		}

		const renderTranscript = () =>
			harness!.tui.chatContainer.render(96).map(stripTerminalSequences).join("\n");

		const detailedView = renderTranscript();
		expect(detailedView).toContain("◆ Explored 2 files");
		expect(detailedView).toContain("◆ Edited src/service.ts (+2 -1 · 42ms)");
		expect(detailedView).toContain("+const host = '0.0.0.0';");
		expect(detailedView).toContain("+export const MAX = 10;");
		expect(detailedView).toContain("bash-line-1");
		expect(detailedView).toContain("bash-line-8");
		expect(detailedView).not.toContain("bash-line-4");
		expect(detailedView).toContain("ps-line-1");
		expect(detailedView).toContain("ps-line-7");
		expect(detailedView).toContain("cm-line-1");
		expect(detailedView).toContain("cm-line-9");

		await harness.runCommand("density", "diff-focus");
		const diffFocusView = renderTranscript();
		expect(diffFocusView).toContain("◆ Explored 2 files");
		expect(diffFocusView).toContain("+const host = '0.0.0.0';");
		expect(diffFocusView).toContain("+export const MAX = 10;");
		expect(diffFocusView).toContain("◆ Ran npm test (8 lines · 210ms)");
		expect(diffFocusView).not.toContain("bash-line-1");
		expect(diffFocusView).not.toContain("ps-line-1");
		expect(diffFocusView).not.toContain("cm-line-1");
		expect(bashRow.render(96).filter((l) => l.trim().length > 0)).toHaveLength(1);
		expect(psRow.render(96).filter((l) => l.trim().length > 0)).toHaveLength(1);
		expect(cmRow.render(96).filter((l) => l.trim().length > 0)).toHaveLength(1);

		await harness.runCommand("density", "compact");
		const compactView = renderTranscript();
		expect(compactView).toContain("◆ Explored 2 files");
		expect(compactView).toContain("◆ Edited src/service.ts (+2 -1 · 42ms)");
		expect(compactView).toContain("◆ Wrote src/constants.ts (+2 -0 · 28ms)");
		expect(compactView).toContain("◆ Ran npm test (8 lines · 210ms)");
		expect(compactView).toContain("◆ mcp__docs__lookup ScrollView (4 lines · 80ms)");
		expect(compactView).not.toContain("+const host = '0.0.0.0';");
		expect(compactView).not.toContain("+export const MAX = 10;");
		expect(compactView).not.toContain("bash-line-1");
		expect(editRow.render(96).filter((l) => l.trim().length > 0)).toHaveLength(1);
		expect(writeRow.render(96).filter((l) => l.trim().length > 0)).toHaveLength(1);

		const clickFoldedEdit = editRow.handleMouse({
			type: "click",
			button: "left",
			x: 4,
			y: 1,
			screenX: 4,
			screenY: 1,
			width: 96,
			height: 2,
			shift: false,
			alt: false,
			ctrl: false,
		} as any);
		expect(clickFoldedEdit?.handled).toBe(true);
		expect(editRow.render(96).map(stripTerminalSequences).join("\n")).toContain("+const host = '0.0.0.0';");
		(editRow as any).setExpanded(false);

		await harness.runCommand("density", "detailed");
		const backToDetailed = renderTranscript();
		expect(backToDetailed).toContain("+const host = '0.0.0.0';");
		expect(backToDetailed).toContain("bash-line-1");
		expect(backToDetailed).toContain("cm-line-9");

		await harness.runCommand("compact-tools", "diff-focus");
		expect(renderTranscript()).not.toContain("bash-line-1");
		expect(renderTranscript()).toContain("+const host = '0.0.0.0';");

		await harness.runCommand("compact-tools", "compact");
		expect(renderTranscript()).not.toContain("+const host = '0.0.0.0';");

		await harness.runCommand("compact-tools", "detailed");
		expect(renderTranscript()).toContain("bash-line-8");
		expect(renderTranscript()).toContain("+const host = '0.0.0.0';");

		expect(reloadSpy).not.toHaveBeenCalled();
	});

	it("handles member row toggling inside expanded groups, codemode details.calls streaming, narrow/0 widths, malformed args, /reload, and project scope guards", async () => {
		vi.useFakeTimers();
		const projDir = mkdtempSync(join(tmpdir(), "pi-ui-ticket13-proj-"));
		try {
			harness = createExtensionHarness({
				theme: "dark",
				width: 100,
				height: 32,
				cwd: projDir,
				projectTrusted: true,
			});
			harness.mount(conartiPiUi);
			await harness.startSession();

			const r1 = new ToolExecutionComponent(
				"read",
				"edge-r1",
				{ path: "src/alpha.ts" },
				undefined,
				undefined,
				harness.tui.asTui(),
				projDir,
			);
			(r1 as any).updateResult({ content: [{ type: "text", text: "const alpha = 123;" }], durationMs: 10 }, false);

			const r2 = new ToolExecutionComponent(
				"read",
				"edge-r2",
				{ path: "src/beta.ts" },
				undefined,
				undefined,
				harness.tui.asTui(),
				projDir,
			);
			(r2 as any).updateResult({ content: [{ type: "text", text: "const beta = 456;" }], durationMs: 10 }, false);

			harness.tui.chatContainer.addChild(r1);
			harness.tui.chatContainer.addChild(r2);

			const initialGroup = harness.tui.chatContainer.render(80);
			const groupHeaderY = initialGroup.findIndex((l) =>
				stripTerminalSequences(l).includes("◆ Explored 2 files"),
			);
			harness.tui.chatContainer.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y: groupHeaderY,
				screenX: 4,
				screenY: groupHeaderY,
				width: 80,
				height: initialGroup.length,
				shift: false,
				alt: false,
				ctrl: false,
			} as any);

			const afterGroupOpen = harness.tui.chatContainer.render(80);
			const r1HeaderY = afterGroupOpen.findIndex((l) =>
				stripTerminalSequences(l).includes("◆ Read src/alpha.ts"),
			);
			expect(r1HeaderY).toBeGreaterThan(groupHeaderY);

			harness.tui.chatContainer.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y: r1HeaderY,
				screenX: 4,
				screenY: r1HeaderY,
				width: 80,
				height: afterGroupOpen.length,
				shift: false,
				alt: false,
				ctrl: false,
			} as any);
			const withR1Body = harness.tui.chatContainer.render(80);
			expect(withR1Body.map(stripTerminalSequences).join("\n")).toContain("const alpha = 123;");

			harness.tui.chatContainer.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y: r1HeaderY,
				screenX: 4,
				screenY: r1HeaderY,
				width: 80,
				height: withR1Body.length,
				shift: false,
				alt: false,
				ctrl: false,
			} as any);
			const afterR1Close = harness.tui.chatContainer.render(80).map(stripTerminalSequences).join("\n");
			expect(afterR1Close).not.toContain("const alpha = 123;");
			expect(afterR1Close).toContain("◆ Read src/alpha.ts");
			expect(afterR1Close).toContain("◆ Read src/beta.ts");

			await harness.emit("agent_start", {});
			await harness.emit("tool_execution_start", {
				toolCallId: "cm-live",
				toolName: "codemode",
				args: { code: "await tools.read({ path: 'a' });" },
			});
			await harness.emit("tool_execution_start", {
				toolCallId: "cm-live/1",
				parentToolCallId: "cm-live",
				toolName: "read",
			});
			await harness.emit("tool_execution_end", {
				toolCallId: "cm-live/1",
				parentToolCallId: "cm-live",
				toolName: "read",
				isError: false,
			});

			const cmLive = new ToolExecutionComponent(
				"codemode",
				"cm-live",
				{ code: "await tools.read({ path: 'a' });" },
				undefined,
				undefined,
				harness.tui.asTui(),
				projDir,
			);
			(cmLive as any).markExecutionStarted();
			(cmLive as any).updateResult(
				{
					content: [],
					details: {
						calls: Array.from({ length: 6 }, (_, i) => ({
							id: `cm-live/${i + 1}`,
							name: "read",
							args: `{"file":${i + 1}}`,
							status: i < 5 ? "ok" : "running",
						})),
					},
				},
				true,
			);

			const cmRunning = cmLive
				.render(90)
				.map(stripTerminalSequences)
				.filter((l) => l.trim().length > 0)
				.map((l) => l.trim());
			expect(cmRunning.slice(1)).toEqual([
				'▎ ✓ read {"file":1}',
				'▎ ✓ read {"file":2}',
				"▎ …",
				'▎ ✓ read {"file":4}',
				'▎ ✓ read {"file":5}',
				'▎ … read {"file":6}',
			]);

			await harness.emit("tool_execution_end", { toolCallId: "cm-live", toolName: "codemode", durationMs: 90 });
			(cmLive as any).updateResult(
				{ content: [{ type: "text", text: "ok" }], durationMs: 90 },
				false,
			);
			await harness.emit("agent_end", { messages: [] });
			expect(cmLive.render(90).map(stripTerminalSequences).join("\n")).toContain("read 1");

			const malformedRow = new ToolExecutionComponent(
				"custom_broken",
				"edge-malformed",
				"not-an-object" as any,
				undefined,
				undefined,
				harness.tui.asTui(),
				projDir,
			);
			(malformedRow as any).updateResult(
				{ content: [{ type: "text", text: "recovered error" }], isError: true },
				false,
			);
			expect(malformedRow.render(0)).toEqual([]);
			for (const w of [1, 8, 20, 60]) {
				const lines = malformedRow.render(w);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(w);
				}
			}

			harness.selectHandler = async (_title, items) =>
				(items as string[]).find((item) => item.toLowerCase().startsWith("compact"));
			await harness.runCommand("density", "");
			await harness.emit("session_start", { reason: "reload" });
			expect(cmLive.render(90).filter((l) => l.trim().length > 0)).toHaveLength(1);

			await harness.runCommand("density", "diff-focus project");
			const savedJson = JSON.parse(readFileSync(join(projDir, ".pi", "compact-tools.json"), "utf8"));
			expect(savedJson.density).toBe("diff-focus");

			const untrustedDir = mkdtempSync(join(tmpdir(), "pi-ui-ticket13-untrusted-"));
			try {
				const untrusted = createExtensionHarness({
					theme: "dark",
					cwd: untrustedDir,
					projectTrusted: false,
				});
				untrusted.mount(conartiPiUi);
				await untrusted.startSession();
				await untrusted.runCommand("density", "compact project");
				expect(existsSync(join(untrustedDir, ".pi", "compact-tools.json"))).toBe(false);
				expect(
					untrusted.notifications.some((n) => n.message.includes("trusted project")),
				).toBe(true);
				await untrusted.shutdownSession();
			} finally {
				rmSync(untrustedDir, { recursive: true, force: true });
			}
		} finally {
			rmSync(projDir, { recursive: true, force: true });
		}
	});

	it("routes through registerToolRenderer (publicRendering = true) with real host tool definitions, preserves JS script view on expanded real codemode, updates late nested summaries on header rows, and switches /density mid-stream", async () => {
		vi.useFakeTimers();
		const projDir = mkdtempSync(join(tmpdir(), "pi-ui-ticket13-pub-"));
		try {
			mkdirSync(join(projDir, ".pi"), { recursive: true });
			writeFileSync(
				join(projDir, ".pi", "compact-tools.json"),
				JSON.stringify({ custom_tools: { enabled: false } }, null, 2),
				"utf8",
			);

			harness = createExtensionHarness({
				theme: "dark",
				width: 100,
				height: 32,
				cwd: projDir,
				projectTrusted: true,
				enableToolRendererRegistry: true,
			});
			harness.mount(conartiPiUi);
			await harness.startSession();

			await harness.emit("agent_start", {});
			await harness.emit("tool_execution_start", {
				toolCallId: "pub-cm-1",
				toolName: "codemode",
				args: { code: "const total = 42;\nreturn await tools.read({ path: 'src/a.ts' });" },
			});

			const cmDef = harness.resolveToolDefinition("codemode");
			expect(cmDef).toBeDefined();

			const cmRow = new ToolExecutionComponent(
				"codemode",
				"pub-cm-1",
				{ code: "const total = 42;\nreturn await tools.read({ path: 'src/a.ts' });" },
				undefined,
				cmDef,
				harness.tui.asTui(),
				projDir,
			);
			harness.tui.chatContainer.addChild(cmRow);
			(cmRow as any).markExecutionStarted();

			await harness.emit("tool_execution_end", {
				toolCallId: "pub-cm-1",
				toolName: "codemode",
				durationMs: 140,
			});
			(cmRow as any).updateResult(
				{
					content: [
						{ type: "text", text: "Script completed\nWall time 0.14 seconds\nOutput:\n" },
						{ type: "text", text: Array.from({ length: 7 }, (_, i) => `res-${i + 1}`).join("\n") },
					],
					details: {
						calls: [{ id: "pub-cm-1/1", name: "read", args: '{"path":"src/a.ts"}', status: "ok" }],
					},
					durationMs: 140,
				},
				false,
			);

			const settledBeforeLate = cmRow.render(96).map(stripTerminalSequences).join("\n");
			expect(settledBeforeLate).toContain("◆ Ran codemode");
			expect(settledBeforeLate).toContain("(7 lines · 140ms)");
			expect(settledBeforeLate).toContain("res-1");
			expect(settledBeforeLate).toContain("res-2");
			expect(settledBeforeLate).toContain("res-7");
			expect(settledBeforeLate).not.toContain("res-4");

			await harness.emit("message_end", {
				message: {
					role: "toolResult",
					toolCallId: "pub-cm-1",
					toolName: "codemode",
					nestedCalls: {
						calls: [{ id: "pub-cm-1/1", name: "read", status: "ok" }],
						complete: true,
					},
				},
			});
			const settledAfterLate = cmRow.render(96).map(stripTerminalSequences).join("\n");
			expect(settledAfterLate).toContain("read 1");

			(cmRow as any).setExpanded(true);
			const expandedCm = cmRow.render(96).map(stripTerminalSequences).join("\n");
			expect(expandedCm).toContain("const total = 42;");
			expect(expandedCm).toContain('✓ read {"path":"src/a.ts"}');
			expect(expandedCm).toContain("res-4");
			expect(expandedCm).not.toContain("Took ");
			(cmRow as any).setExpanded(false);

			await harness.emit("tool_execution_start", {
				toolCallId: "pub-bash-stream",
				toolName: "bash",
				args: { command: "npm run build" },
			});
			const bashStream = new ToolExecutionComponent(
				"bash",
				"pub-bash-stream",
				{ command: "npm run build" },
				undefined,
				harness.resolveToolDefinition("bash"),
				harness.tui.asTui(),
				projDir,
			);
			harness.tui.chatContainer.addChild(bashStream);
			(bashStream as any).markExecutionStarted();
			(bashStream as any).updateResult(
				{ content: [{ type: "text", text: "b1\nb2\nb3\nb4\nb5\nb6\nb7" }] },
				true,
			);

			await harness.runCommand("density", "diff-focus");
			expect(cmRow.render(96).filter((l) => l.trim().length > 0)).toHaveLength(1);
			expect(bashStream.render(96).map(stripTerminalSequences).join("\n")).toContain("▎ b1");

			await harness.runCommand("density", "compact");
			expect(bashStream.render(96).map(stripTerminalSequences).join("\n")).toContain("▎ b7");

			await harness.emit("tool_execution_end", {
				toolCallId: "pub-bash-stream",
				toolName: "bash",
				durationMs: 250,
			});
			(bashStream as any).updateResult(
				{ content: [{ type: "text", text: "b1\nb2\nb3\nb4\nb5\nb6\nb7" }], durationMs: 250 },
				false,
			);
			expect(bashStream.render(96).filter((l) => l.trim().length > 0)).toHaveLength(1);

			await harness.runCommand("compact-tools", "off");
			expect(stripTerminalSequences(cmRow.render(96).join("\n"))).not.toContain("◆");

			await harness.runCommand("density", "detailed");
			expect(stripTerminalSequences(cmRow.render(96).join("\n"))).toContain("◆ Ran codemode");
			expect(stripTerminalSequences(bashStream.render(96).join("\n"))).toContain("b7");

			await harness.emit("agent_end", { messages: [] });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			rmSync(projDir, { recursive: true, force: true });
		}
	});

	it("computes real +N -M contextual diffs when write overwrites an existing file, shows … when wrapped diff rows exceed preview cap, and strips bash truncation footers from tail preview", async () => {
		const projDir = mkdtempSync(join(tmpdir(), "pi-ui-ticket13-write-"));
		try {
			mkdirSync(join(projDir, "src"), { recursive: true });
			const targetFile = join(projDir, "src", "existing.ts");
			const beforeLines = [
				"export const LINE_1 = 1;",
				"export const LINE_2 = 2;",
				"export const LINE_3 = 3;",
				"export const LINE_4 = 4;",
				"export const LINE_5 = 5;",
				"export const PORT = 3000;",
				"export const LINE_7 = 7;",
				"export const LINE_8 = 8;",
				"export const LINE_9 = 9;",
				"export const LINE_10 = 10;",
			];
			writeFileSync(targetFile, `${beforeLines.join("\n")}\n`, "utf8");

			harness = createExtensionHarness({
				theme: "dark",
				width: 100,
				height: 32,
				cwd: projDir,
				projectTrusted: true,
				enableToolRendererRegistry: true,
			});
			harness.mount(conartiPiUi);
			await harness.startSession();

			const afterContent = `${[
				...beforeLines.slice(0, 5),
				"export const PORT = 8080;",
				"export const HOST = '0.0.0.0';",
				...beforeLines.slice(6),
			].join("\n")}\n`;

			await harness.emit("agent_start", {});
			await harness.emit("tool_call", {
				toolCallId: "write-overwrite-1",
				toolName: "write",
				input: { path: "src/existing.ts", content: afterContent },
			});
			await harness.emit("tool_execution_start", {
				toolCallId: "write-overwrite-1",
				toolName: "write",
				args: { path: "src/existing.ts", content: afterContent },
			});
			writeFileSync(targetFile, afterContent, "utf8");

			const writeRow = new ToolExecutionComponent(
				"write",
				"write-overwrite-1",
				{ path: "src/existing.ts", content: afterContent },
				undefined,
				harness.resolveToolDefinition("write"),
				harness.tui.asTui(),
				projDir,
			);
			await harness.emit("tool_execution_end", {
				toolCallId: "write-overwrite-1",
				toolName: "write",
				durationMs: 35,
			});
			(writeRow as any).updateResult(
				{
					content: [{ type: "text", text: "Successfully wrote to src/existing.ts" }],
					details: undefined,
					durationMs: 35,
				},
				false,
			);
			await harness.emit("agent_end", { messages: [] });

			const collapsedWrite = writeRow.render(96).map(stripTerminalSequences).join("\n");
			expect(collapsedWrite).toContain("◆ Wrote src/existing.ts (+2 -1 · 35ms)");
			expect(collapsedWrite).toContain("-export const PORT = 3000;");
			expect(collapsedWrite).toContain("+export const PORT = 8080;");
			expect(collapsedWrite).toContain("+export const HOST = '0.0.0.0';");
			expect(collapsedWrite).not.toContain("LINE_3 = 3");

			(writeRow as any).setExpanded(true);
			const expandedWrite = writeRow.render(96).map(stripTerminalSequences).join("\n");
			expect(expandedWrite).toContain("LINE_3 = 3");

			const streamedFile = join(projDir, "src", "file.ts");
			const initialFileContent = "export const MODE = 'legacy';\nexport const RETRIES = 1;\n";
			const updatedFileContent = "export const MODE = 'modern';\nexport const RETRIES = 3;\nexport const TIMEOUT = 500;\n";
			writeFileSync(streamedFile, initialFileContent, "utf8");

			await harness.emit("agent_start", {});
			await harness.emit("message_update", {
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "write-stream-1", name: "write", arguments: { path: "src/f" } }],
				},
			});
			const streamedWriteRow = new ToolExecutionComponent(
				"write",
				"write-stream-1",
				{ path: "src/f" },
				undefined,
				harness.resolveToolDefinition("write"),
				harness.tui.asTui(),
				projDir,
			);
			expect(streamedWriteRow.render(96).map(stripTerminalSequences).join("\n")).toContain("Writing src/f");

			(streamedWriteRow as any).updateArgs({ path: "src/file.ts", content: updatedFileContent });
			streamedWriteRow.render(96);
			(streamedWriteRow as any).setArgsComplete();

			await harness.emit("tool_execution_start", {
				toolCallId: "write-stream-1",
				toolName: "write",
				args: { path: "src/file.ts", content: updatedFileContent },
			});
			writeFileSync(streamedFile, updatedFileContent, "utf8");
			await harness.emit("tool_execution_end", {
				toolCallId: "write-stream-1",
				toolName: "write",
				durationMs: 25,
			});
			(streamedWriteRow as any).updateResult(
				{
					content: [{ type: "text", text: "Successfully wrote to src/file.ts" }],
					details: undefined,
					durationMs: 25,
				},
				false,
			);
			await harness.emit("agent_end", { messages: [] });

			const streamedWritePlain = streamedWriteRow.render(96).map(stripTerminalSequences).join("\n");
			expect(streamedWritePlain).toContain("◆ Wrote src/file.ts (+3 -2 · 25ms)");
			expect(streamedWritePlain).toContain("-export const MODE = 'legacy';");
			expect(streamedWritePlain).toContain("+export const MODE = 'modern';");

			const wrappedEdit = new ToolExecutionComponent(
				"edit",
				"edit-wrap-1",
				{ path: "src/long.ts" },
				undefined,
				harness.resolveToolDefinition("edit"),
				harness.tui.asTui(),
				projDir,
			);
			const longExpr = "veryLongIdentifierName_".repeat(6);
			(wrappedEdit as any).updateResult(
				{
					content: [{ type: "text", text: "Updated src/long.ts" }],
					details: {
						patch: [
							"@@ -1,4 +1,4 @@",
							`-${longExpr}1;`,
							`-${longExpr}2;`,
							`+${longExpr}3;`,
							`+${longExpr}4;`,
						].join("\n"),
					},
					durationMs: 20,
				},
				false,
			);
			const narrowEditLines = wrappedEdit.render(34).map(stripTerminalSequences);
			expect(narrowEditLines.at(-1)?.trim()).toBe("│ …");

			const truncBash = new ToolExecutionComponent(
				"bash",
				"bash-trunc-1",
				{ command: "seq 1 5000" },
				undefined,
				harness.resolveToolDefinition("bash"),
				harness.tui.asTui(),
				projDir,
			);
			(truncBash as any).updateResult(
				{
					content: [
						{
							type: "text",
							text: "out-1\nout-2\nout-3\nout-4\nout-5\nout-6\nout-7\n\n[Showing lines 1-7 of 5000. Full output: /tmp/pi-bash-test.log]",
						},
					],
					details: {
						fullOutputPath: "/tmp/pi-bash-test.log",
						truncation: { truncated: true, outputLines: 7, totalLines: 5000 },
					},
					durationMs: 90,
				},
				false,
			);
			const truncPlain = truncBash
				.render(96)
				.map(stripTerminalSequences)
				.filter((l) => l.trim().length > 0)
				.map((l) => l.trim());
			expect(truncPlain.slice(1)).toEqual([
				"│ out-1",
				"│ out-2",
				"│ …",
				"│ out-5",
				"│ out-6",
				"│ out-7",
			]);
		} finally {
			rmSync(projDir, { recursive: true, force: true });
		}
	});

	it("handles in-place streaming args mutation without folding mutating commands, ignores blank spacer clicks above Explored groups, lets project density override global legacy style, and supports 256color themes", async () => {
		vi.useFakeTimers();
		const projDir = mkdtempSync(join(tmpdir(), "pi-ui-ticket13-edge2-"));
		try {
			writeFileSync(
				join(agentDir, "compact-tools.json"),
				JSON.stringify({ style: "claude" }, null, 2),
				"utf8",
			);
			mkdirSync(join(projDir, ".pi"), { recursive: true });
			writeFileSync(
				join(projDir, ".pi", "compact-tools.json"),
				JSON.stringify({ density: "diff-focus" }, null, 2),
				"utf8",
			);

			harness = createExtensionHarness({
				theme: "dark",
				width: 100,
				height: 32,
				cwd: projDir,
				projectTrusted: true,
				enableToolRendererRegistry: true,
			});
			harness.mount(conartiPiUi);
			await harness.startSession();

			const mk = (id: string, name: string, args: Record<string, unknown>) =>
				new ToolExecutionComponent(
					name,
					id,
					args,
					undefined,
					harness!.resolveToolDefinition(name),
					harness!.tui.asTui(),
					projDir,
				);

			const doneCmd = mk("cfg-bash", "bash", { command: "npm run lint" });
			(doneCmd as any).updateResult(
				{ content: [{ type: "text", text: "l1\nl2\nl3\nl4\nl5\nl6" }], durationMs: 50 },
				false,
			);
			expect(stripTerminalSequences(doneCmd.render(90).join("\n"))).toContain("◆ Ran npm run lint");
			expect(doneCmd.render(90).filter((l) => l.trim().length > 0)).toHaveLength(1);

			const r1 = mk("mut-r1", "read", { path: "src/a.ts" });
			(r1 as any).updateResult({ content: [{ type: "text", text: "a" }], durationMs: 5 }, false);

			const mutableArgs: Record<string, unknown> = { command: "cat src/b.ts" };
			const rStream = mk("mut-stream", "bash", mutableArgs);
			(rStream as any).updateResult({ content: [{ type: "text", text: "b" }], durationMs: 8 }, false);

			harness.tui.chatContainer.addChild(r1);
			harness.tui.chatContainer.addChild(rStream);

			const beforeMutate = harness.tui.chatContainer.render(90);
			expect(beforeMutate.map(stripTerminalSequences).join("\n")).toContain("◆ Explored 2 files");

			const spacerClick = harness.tui.chatContainer.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y: 0,
				screenX: 4,
				screenY: 0,
				width: 90,
				height: beforeMutate.length,
				shift: false,
				alt: false,
				ctrl: false,
			} as any);
			expect(spacerClick).toBeUndefined();
			expect(harness.tui.chatContainer.render(90).map(stripTerminalSequences).join("\n")).not.toContain(
				"◆ Read src/a.ts",
			);

			mutableArgs.command = "cat src/b.ts > src/out.ts";
			(rStream as any).updateArgs(mutableArgs);
			const afterMutate = harness.tui.chatContainer.render(90).map(stripTerminalSequences).join("\n");
			expect(afterMutate).not.toContain("◆ Explored");
			expect(afterMutate).toContain("◆ Read src/a.ts");
			expect(afterMutate).toContain("◆ Ran cat src/b.ts > src/out.ts");

			const baseDark = harness.ctx.ui.theme;
			const theme256 = {
				...baseDark,
				getColorMode: () => "256color" as const,
			};
			harness.setTheme(theme256 as any);

			await harness.emit("agent_start", {});
			await harness.emit("tool_execution_start", {
				toolCallId: "c256-bash",
				toolName: "bash",
				args: { command: "npm test" },
			});
			const row256 = mk("c256-bash", "bash", { command: "npm test" });
			(row256 as any).markExecutionStarted();
			(row256 as any).updateResult({ content: [{ type: "text", text: "t1\nt2\nt3" }] }, true);

			const ansi256Running = row256.render(90).join("\n");
			expect(ansi256Running).toContain("\x1b[38;5;");
			expect(ansi256Running).not.toContain("\x1b[38;2;");

			await harness.emit("tool_execution_end", { toolCallId: "c256-bash", toolName: "bash", durationMs: 40 });
			(row256 as any).updateResult({ content: [{ type: "text", text: "t1\nt2\nt3" }], durationMs: 40 }, false);
			await harness.emit("agent_end", { messages: [] });

			const ansi256Done = row256.render(90).join("\n");
			expect(ansi256Done).toContain("\x1b[38;5;");
			expect(ansi256Done).not.toContain("\x1b[38;2;");
		} finally {
			rmSync(projDir, { recursive: true, force: true });
		}
	});
});
