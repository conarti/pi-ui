import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createBashToolDefinition,
	createCodemodeExtension,
	createPowerShellToolDefinition,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DEFAULT_CONFIG } from "../src/features/tool-calls/config.ts";
import {
	classifyExploration,
	extractCommandOutput,
	formatExploredSummary,
	sliceHeadTailPreview,
} from "../src/features/tool-calls/density.ts";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import {
	createAssistantMessageEventStream,
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type InteractiveHarness,
} from "./harness/index.ts";

const ZERO_USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeStreamMsg(
	content: AssistantMessage["content"],
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux-density",
		provider: "faux",
		model: "faux-1",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

function findRowGlyphRgb(
	harness: InteractiveHarness,
	rowNeedle: string,
	glyph: string,
): [number, number, number] | undefined {
	const screen = harness.screen();
	for (let r = 0; r < screen.height; r += 1) {
		if (!screen.rowText(r).includes(rowNeedle)) continue;
		for (let c = 0; c < screen.width; c += 1) {
			const cell = screen.cellAt(r, c);
			if (cell?.char === glyph && cell.fg.kind === "rgb") {
				return [cell.fg.r, cell.fg.g, cell.fg.b];
			}
		}
	}
	return undefined;
}

function collectRowRgbColors(
	harness: InteractiveHarness,
	rowNeedle: string,
): Array<[number, number, number]> {
	const screen = harness.screen();
	const out: Array<[number, number, number]> = [];
	for (let r = 0; r < screen.height; r += 1) {
		if (!screen.rowText(r).includes(rowNeedle)) continue;
		for (let c = 0; c < screen.width; c += 1) {
			const cell = screen.cellAt(r, c);
			if (cell && cell.char.trim().length > 0 && cell.fg.kind === "rgb") {
				out.push([cell.fg.r, cell.fg.g, cell.fg.b]);
			}
		}
	}
	return out;
}

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

		const codemodeConsole = extractCommandOutput(
			"codemode",
			"<console_output>\nc1\nc2\nc3\nc4\nc5\nc6\n</console_output>\n",
			false,
		);
		expect(sliceHeadTailPreview(codemodeConsole.lines)).toEqual({
			head: ["c1", "c2"],
			omitted: 1,
			tail: ["c4", "c5", "c6"],
		});
	});

	it("classifies strictly read-only inspection calls via Shell Effect, rejects mutating commands, and formats Explored N files, M searches", () => {
		expect(classifyExploration("read", { path: "src/index.ts" })).toBe("read");
		expect(classifyExploration("grep", { pattern: "TODO", path: "src" })).toBe("search");
		expect(classifyExploration("find", { pattern: "*.ts", path: "src" })).toBe("search");
		expect(classifyExploration("ls", { path: "src" })).toBe("list");

		expect(
			classifyExploration("bash", { command: "cd src && rg 'ShellEffect' 2>/dev/null | head -n 20" }),
		).toBe("search");
		expect(classifyExploration("bash", { command: "env LC_ALL=C sed -n '1,30p' src/index.ts" })).toBe(
			"read",
		);
		expect(classifyExploration("bash", { command: "git grep 'ToolDensity'" })).toBe("search");
		expect(classifyExploration("bash", { command: "git ls-files src" })).toBe("list");
		expect(classifyExploration("bash", { command: "git branch --show-current" })).toBe("read");
		expect(classifyExploration("bash", { command: "shasum package.json" })).toBe("read");
		expect(classifyExploration("bash", { command: "pwd" })).toBe("list");
		expect(classifyExploration("bash", { command: "ls -la src | grep density" })).toBe("search");
		expect(classifyExploration("powershell", { command: "Get-Content src/index.ts" })).toBe("read");
		expect(classifyExploration("powershell", { command: "Resolve-Path src" })).toBe("read");
		expect(
			classifyExploration("powershell", { command: "Select-String -Pattern foo src/a.ts" }),
		).toBe("search");

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
			{ toolName: "grep", toolCallId: "g1", args: { pattern: "x" }, result: { content: [] }, isPartial: false },
			{
				toolName: "bash",
				toolCallId: "b1",
				args: { command: "rg y src" },
				result: { content: [] },
				isPartial: false,
			},
		];
		expect(formatExploredSummary(doneRows as never)).toBe("Explored 2 files, 2 searches");

		const runningRows = [
			...doneRows,
			{ toolName: "ls", toolCallId: "l1", args: { path: "src" }, result: undefined, isPartial: true },
		];
		expect(formatExploredSummary(runningRows as never)).toBe(
			"Exploring 2 files, 2 searches, 1 directory",
		);
	});
});

describe("Tool Density: real InteractiveMode integration", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function createTempDir(prefix = "pi-ui-density-"): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		vi.useRealTimers();
		stopAllAnimations();
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		stopAllAnimations();
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("renders ✦ diamond indicator and 30 fps streaming command bars across built-in tools, codemode, and MCP tools in dark & light blue-slate tones with 0-timer idle cleanup", async () => {
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

		const projDir = createTempDir();
		mkdirSync(join(projDir, "src"), { recursive: true });
		writeFileSync(
			join(projDir, "src", "auth.ts"),
			[
				"const header = req.headers.authorization;",
				"const valid = checkLegacy(header);",
				"return valid;",
			].join("\n") + "\n",
			"utf8",
		);

		let emitShellChunk: ((chunk: string) => void) | undefined;
		let finishShellExec: ((exitCode?: number) => void) | undefined;

		const controlledBash = createBashToolDefinition(projDir, {
			operations: {
				async exec(_command, _cwd, opts) {
					emitShellChunk = (chunk) => opts.onData(Buffer.from(chunk, "utf8"));
					return await new Promise<{ exitCode: number | null }>((resolve) => {
						finishShellExec = (code = 0) => resolve({ exitCode: code });
					});
				},
			},
		});

		const controlledPs = createPowerShellToolDefinition(projDir, {
			operations: {
				async exec(_command, _cwd, opts) {
					emitShellChunk = (chunk) => opts.onData(Buffer.from(chunk, "utf8"));
					return await new Promise<{ exitCode: number | null }>((resolve) => {
						finishShellExec = (code = 0) => resolve({ exitCode: code });
					});
				},
			},
		});

		let emitCmUpdate: ((text: string) => void) | undefined;
		let finishCmExec: ((text: string) => void) | undefined;
		const controlledCodemode = defineTool({
			name: "codemode",
			label: "codemode",
			description: "Controlled codemode stream for 30 fps preview check",
			parameters: Type.Object({ code: Type.String() }),
			async execute(_id, _params, _signal, onUpdate) {
				emitCmUpdate = (text) => {
					onUpdate?.({ content: [{ type: "text", text }], details: {} });
				};
				const finalOut = await new Promise<string>((resolve) => {
					finishCmExec = resolve;
				});
				return {
					content: [
						{
							type: "text",
							text: `Script completed\nWall time 0.3 seconds\nOutput:\n${finalOut}`,
						},
					],
					details: {},
				};
			},
		});

		const mcpSearch = defineTool({
			name: "mcp__github__search",
			label: "mcp__github__search",
			description: "Custom MCP search tool",
			parameters: Type.Object({ query: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "issue #9\nissue #13" }], details: {} };
			},
		});

		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: projDir,
			width: 110,
			height: 44,
			tools: ["+grep", "+find", "+ls"],
			customTools: [controlledBash, controlledPs, controlledCodemode, mcpSearch],
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "npm run check" }, { id: "run-bash" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[fauxToolCall("powershell", { command: "npm run check" }, { id: "run-ps" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("codemode", { code: "return await tools.ls();" }, { id: "run-cm" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"edit",
							{
								path: "src/auth.ts",
								edits: [
									{
										oldText: "const valid = checkLegacy(header);",
										newText: "const token = parseBearer(header);\nconst valid = verifyJwt(token);",
									},
								],
							},
							{ id: "tc-edit-1" },
						),
						fauxToolCall(
							"write",
							{
								path: "src/config.ts",
								content: "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n",
							},
							{ id: "tc-write-1" },
						),
						fauxToolCall("mcp__github__search", { query: "pi-tui" }, { id: "tc-mcp-1" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("All tools completed."),
			],
		});
		harness.session.setActiveToolsByName([
			"read",
			"write",
			"edit",
			"bash",
			"powershell",
			"grep",
			"find",
			"ls",
			"codemode",
			"mcp__github__search",
		]);
		vi.runOnlyPendingTimers();
		expect(vi.getTimerCount()).toBe(0);

		const turn = harness.submitInput("Run command tools and file diffs");

		for (const cmdTool of ["bash", "powershell", "codemode"] as const) {
			await harness.flush();
			const preText = harness.screen().text();
			expect(preText).toContain("✦ Running");
			expect(preText).toContain("▎ Running…");
			expect(vi.getTimerCount()).toBe(1);

			const preBarRgb0 = findRowGlyphRgb(harness, "Running…", "▎");
			vi.advanceTimersByTime(33 * 6);
			harness.flushFrame();
			const preBarRgb1 = findRowGlyphRgb(harness, "Running…", "▎");
			expect(preBarRgb0).toBeDefined();
			expect(preBarRgb1).toBeDefined();
			expect(preBarRgb1).not.toEqual(preBarRgb0);

			const partialLines = Array.from({ length: 8 }, (_, i) => `${cmdTool}-out-${i + 1}`).join("\n");
			if (cmdTool === "codemode") {
				emitCmUpdate!(partialLines);
			} else {
				emitShellChunk!(`${partialLines}\n`);
			}
			await harness.flush();

			const midText = harness.screen().text();
			expect(midText).toContain(`▎ ${cmdTool}-out-1`);
			expect(midText).toContain(`▎ ${cmdTool}-out-2`);
			expect(midText).toContain("▎ …");
			expect(midText).toContain(`▎ ${cmdTool}-out-6`);
			expect(midText).toContain(`▎ ${cmdTool}-out-8`);
			expect(midText).not.toContain(`${cmdTool}-out-4`);

			const row0BarBefore = findRowGlyphRgb(harness, `${cmdTool}-out-1`, "▎");
			const row1BarBefore = findRowGlyphRgb(harness, `${cmdTool}-out-2`, "▎");
			expect(row0BarBefore).not.toEqual(row1BarBefore);

			vi.advanceTimersByTime(33 * 6);
			harness.flushFrame();
			const row0BarAfter = findRowGlyphRgb(harness, `${cmdTool}-out-1`, "▎");
			expect(row0BarAfter).not.toEqual(row0BarBefore);
			expect(row0BarAfter![0]).toBeLessThan(row0BarAfter![1]);
			expect(row0BarAfter![1]).toBeLessThan(row0BarAfter![2]);

			const tailLines = [`${cmdTool}-out-9`, `${cmdTool}-out-10`].join("\n");
			if (cmdTool === "codemode") {
				finishCmExec!(Array.from({ length: 10 }, (_, i) => `${cmdTool}-out-${i + 1}`).join("\n"));
			} else {
				emitShellChunk!(`${tailLines}\n`);
				finishShellExec!(0);
			}
			await harness.flush();
		}

		await turn;
		expect(vi.getTimerCount()).toBe(0);

		const settledDarkText = harness.screen().text();
		expect(settledDarkText).toContain("│ codemode-out-1");
		expect(settledDarkText).toContain("│ codemode-out-10");
		expect(settledDarkText).toContain("✦ Edited src/auth.ts (+2 -1");
		expect(settledDarkText).toContain("-const valid = checkLegacy(header);");
		expect(settledDarkText).toContain("+const token = parseBearer(header);");
		expect(settledDarkText).toContain("✦ Wrote src/config.ts (+3 -0");
		expect(settledDarkText).toContain("+export const A = 1;");
		expect(settledDarkText).toContain("✦ mcp__github__search pi-tui");

		const darkDiamond = findRowGlyphRgb(harness, "Edited src/auth.ts", "✦");
		expect(darkDiamond).toBeDefined();
		expect(darkDiamond![0]).toBeLessThan(darkDiamond![1]);
		expect(darkDiamond![1]).toBeLessThan(darkDiamond![2]);

		harness.setTheme("light");
		const lightDiamond = findRowGlyphRgb(harness, "Edited src/auth.ts", "✦");
		expect(lightDiamond).toBeDefined();
		expect(lightDiamond).not.toEqual(darkDiamond);
		expect(lightDiamond![0]).toBeLessThan(lightDiamond![1]);
		expect(lightDiamond![1]).toBeLessThan(lightDiamond![2]);

		for (const [r, g, b] of collectRowRgbColors(harness, "mcp__github__search")) {
			expect(r).toBeLessThanOrEqual(g);
			expect(g).toBeLessThanOrEqual(b);
		}
	});

	it("folds consecutive Shell Effect-verified read-only calls into ✦ Explored, never folds mutating commands, toggles groups, member rows, and author custom renderers via real mouse clicks, and respects /silent", async () => {
		vi.useFakeTimers();
		const projDir = createTempDir();
		mkdirSync(join(projDir, "src"), { recursive: true });
		writeFileSync(join(projDir, "src", "a.ts"), "export const uniqueAlphaBody = 111;\n", "utf8");
		writeFileSync(join(projDir, "src", "b.ts"), "export const searchNeedle = 222;\n", "utf8");

		let finishRoBash: (() => void) | undefined;
		const gatedBash = createBashToolDefinition(projDir, {
			operations: {
				async exec(command, _cwd, opts) {
					if (command.includes("rg 'searchNeedle'")) {
						await new Promise<void>((resolve) => {
							finishRoBash = resolve;
						});
						opts.onData(Buffer.from("src/b.ts:1:export const searchNeedle = 222;\n", "utf8"));
						return { exitCode: 0 };
					}
					opts.onData(Buffer.from("patched src/a.ts\n", "utf8"));
					return { exitCode: 0 };
				},
			},
		});

		const authorTool = defineTool({
			name: "custom_diagram",
			label: "custom_diagram",
			description: "Custom diagram tool with author renderer",
			parameters: Type.Object({ title: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "raw fallback" }], details: {} };
			},
			renderResult(_result, opts) {
				return new Text(opts.expanded ? "AUTHOR_FULL_DIAGRAM_VIEW" : "AUTHOR_COMPACT", 0, 0);
			},
		});

		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: projDir,
			width: 110,
			height: 40,
			customTools: [gatedBash, authorTool],
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("read", { path: "src/a.ts" }, { id: "exp-1" }),
						fauxToolCall("read", { path: "src/b.ts" }, { id: "exp-2" }),
						fauxToolCall("bash", { command: "rg 'searchNeedle' src 2>/dev/null" }, { id: "exp-3" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("bash", { command: "sed -i 's/111/999/' src/a.ts" }, { id: "mut-1" }),
						fauxToolCall("custom_diagram", { title: "arch" }, { id: "cust-1" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Exploration summary complete."),
			],
		});
		harness.session.setActiveToolsByName(["read", "bash", "custom_diagram"]);
		vi.runOnlyPendingTimers();

		const turn = harness.submitInput("Explore source files");
		await harness.flush();

		const runningText = harness.screen().text();
		expect(runningText).toContain("✦ Exploring 2 files, 1 search");
		expect(runningText).not.toContain("Read src/a.ts");
		expect(vi.getTimerCount()).toBe(1);

		const expDiamond0 = findRowGlyphRgb(harness, "Exploring 2 files", "✦");
		vi.advanceTimersByTime(33 * 5);
		harness.flushFrame();
		const expDiamond1 = findRowGlyphRgb(harness, "Exploring 2 files", "✦");
		expect(expDiamond1).not.toEqual(expDiamond0);

		finishRoBash!();
		await turn;
		expect(vi.getTimerCount()).toBe(0);

		const foldedScreen = harness.screen();
		const foldedText = foldedScreen.text();
		expect(foldedText).toContain("✦ Explored 2 files, 1 search");
		expect(foldedText).not.toContain("Read src/a.ts");
		expect(foldedText).not.toContain("(click to expand)");
		expect(foldedText).toContain("✦ Ran sed -i 's/111/999/' src/a.ts");
		expect(foldedText).toContain("✦ custom_diagram arch");
		expect(foldedText).not.toContain("AUTHOR_FULL_DIAGRAM_VIEW");

		const groupPos = foldedScreen.findText("✦ Explored 2 files, 1 search")!;
		if (groupPos.row > 1) {
			await harness.mouseClick(groupPos.col + 2, groupPos.row - 1);
			expect(harness.screen().text()).not.toContain("✦ Read src/a.ts");
		}

		vi.advanceTimersByTime(500);
		await harness.mouseClick(groupPos.col + 2, groupPos.row);
		const openedGroupScreen = harness.screen();
		expect(openedGroupScreen.text()).toContain("✦ Read src/a.ts");
		expect(openedGroupScreen.text()).toContain("✦ Read src/b.ts");

		vi.advanceTimersByTime(500);
		const memberPos = openedGroupScreen.findText("✦ Read src/a.ts")!;
		await harness.mouseClick(memberPos.col + 2, memberPos.row);
		expect(harness.screen().text()).toContain("export const uniqueAlphaBody = 111;");

		vi.advanceTimersByTime(500);
		const memberOpenPos = harness.screen().findText("✦ Read src/a.ts")!;
		await harness.mouseClick(memberOpenPos.col + 2, memberOpenPos.row);
		const afterMemberClose = harness.screen().text();
		expect(afterMemberClose).not.toContain("export const uniqueAlphaBody = 111;");
		expect(afterMemberClose).toContain("✦ Read src/a.ts");
		expect(afterMemberClose).toContain("✦ Read src/b.ts");

		vi.advanceTimersByTime(500);
		const customPos = harness.screen().findText("✦ custom_diagram arch")!;
		await harness.mouseClick(customPos.col + 2, customPos.row);
		expect(harness.screen().text()).toContain("AUTHOR_FULL_DIAGRAM_VIEW");

		await harness.submitInput("/silent on");
		const silentText = harness.screen().text();
		expect(silentText).not.toContain("✦ Read src/a.ts");
		expect(silentText).not.toContain("AUTHOR_FULL_DIAGRAM_VIEW");
		expect(silentText).toContain("Exploration summary complete.");

		await harness.submitInput("/silent off");
		const restoredText = harness.screen().text();
		expect(restoredText).toContain("✦ Read src/a.ts");
		expect(restoredText).toContain("AUTHOR_FULL_DIAGRAM_VIEW");
	});

	it("switches live without reload across detailed, diff-focus, and compact via /density (including interactive selector), /compact-tools, and trusted/untrusted project scopes", async () => {
		const projDir = createTempDir();
		mkdirSync(join(projDir, "src"), { recursive: true });
		writeFileSync(join(projDir, "src", "one.ts"), "export const one = 1;\n", "utf8");
		writeFileSync(join(projDir, "src", "two.ts"), "export const two = 2;\n", "utf8");
		writeFileSync(
			join(projDir, "src", "service.ts"),
			"const port = 3000;\nconst host = 'localhost';\n",
			"utf8",
		);

		const fastBash = createBashToolDefinition(projDir, {
			operations: {
				async exec(_cmd, _cwd, opts) {
					const out = Array.from({ length: 8 }, (_, i) => `bash-line-${i + 1}`).join("\n");
					opts.onData(Buffer.from(`${out}\n`, "utf8"));
					return { exitCode: 0 };
				},
			},
		});
		const fastPs = createPowerShellToolDefinition(projDir, {
			operations: {
				async exec(_cmd, _cwd, opts) {
					const out = Array.from({ length: 7 }, (_, i) => `ps-line-${i + 1}`).join("\n");
					opts.onData(Buffer.from(`${out}\n`, "utf8"));
					return { exitCode: 0 };
				},
			},
		});
		const fastCm = defineTool({
			name: "codemode",
			label: "codemode",
			description: "Deterministic codemode output",
			parameters: Type.Object({ code: Type.String() }),
			async execute() {
				const out = Array.from({ length: 9 }, (_, i) => `cm-line-${i + 1}`).join("\n");
				return { content: [{ type: "text", text: out }], details: {} };
			},
		});
		const mcpLookup = defineTool({
			name: "mcp__docs__lookup",
			label: "mcp__docs__lookup",
			description: "Docs lookup",
			parameters: Type.Object({ topic: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "doc-1\ndoc-2\ndoc-3\ndoc-4" }], details: {} };
			},
		});

		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: projDir,
			projectTrusted: true,
			width: 110,
			height: 54,
			customTools: [fastBash, fastPs, fastCm, mcpLookup],
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("read", { path: "src/one.ts" }, { id: "d-r1" }),
						fauxToolCall("read", { path: "src/two.ts" }, { id: "d-r2" }),
						fauxToolCall(
							"edit",
							{
								path: "src/service.ts",
								edits: [
									{
										oldText: "const host = 'localhost';",
										newText: "const host = '0.0.0.0';\nconst tls = true;",
									},
								],
							},
							{ id: "d-edit" },
						),
						fauxToolCall(
							"write",
							{
								path: "src/constants.ts",
								content: "export const MAX = 10;\nexport const MIN = 1;\n",
							},
							{ id: "d-write" },
						),
						fauxToolCall("bash", { command: "npm test" }, { id: "d-bash" }),
						fauxToolCall("powershell", { command: "Invoke-Pester" }, { id: "d-ps" }),
						fauxToolCall("codemode", { code: "return 'done';" }, { id: "d-cm" }),
						fauxToolCall("mcp__docs__lookup", { topic: "ScrollView" }, { id: "d-mcp" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Density matrix ready."),
			],
		});
		harness.session.setActiveToolsByName([
			"read",
			"edit",
			"write",
			"bash",
			"powershell",
			"codemode",
			"mcp__docs__lookup",
		]);

		await harness.submitInput("Build density matrix");

		const detailedText = harness.screen().text();
		expect(detailedText).toContain("✦ Explored 2 files");
		expect(detailedText).toContain("✦ Edited src/service.ts (+2 -1");
		expect(detailedText).toContain("+const host = '0.0.0.0';");
		expect(detailedText).toContain("+export const MAX = 10;");
		expect(detailedText).toContain("bash-line-1");
		expect(detailedText).toContain("bash-line-8");
		expect(detailedText).not.toContain("bash-line-4");
		expect(detailedText).toContain("ps-line-1");
		expect(detailedText).toContain("ps-line-7");
		expect(detailedText).toContain("cm-line-1");
		expect(detailedText).toContain("cm-line-9");

		await harness.submitInput("/density diff-focus");
		const diffFocusText = harness.screen().text();
		expect(diffFocusText).toContain("✦ Explored 2 files");
		expect(diffFocusText).toContain("+const host = '0.0.0.0';");
		expect(diffFocusText).toContain("+export const MAX = 10;");
		expect(diffFocusText).toContain("✦ Ran npm test (8 lines");
		expect(diffFocusText).not.toContain("bash-line-1");
		expect(diffFocusText).not.toContain("ps-line-1");
		expect(diffFocusText).not.toContain("cm-line-1");

		const selectCmd = harness.submitInput("/density");
		await harness.flush();
		await harness.pressKey("\x1b[B");
		await harness.pressKey("\x1b[B");
		await harness.pressKey("\r");
		await selectCmd;

		const compactText = harness.screen().text();
		expect(compactText).toContain("✦ Explored 2 files");
		expect(compactText).toContain("✦ Edited src/service.ts (+2 -1");
		expect(compactText).toContain("✦ Wrote src/constants.ts (+2 -0");
		expect(compactText).toContain("✦ Ran npm test (8 lines");
		expect(compactText).toContain("✦ mcp__docs__lookup ScrollView (4 lines");
		expect(compactText).not.toContain("+const host = '0.0.0.0';");
		expect(compactText).not.toContain("+export const MAX = 10;");
		expect(compactText).not.toContain("bash-line-1");

		const editPos = harness.screen().findText("✦ Edited src/service.ts")!;
		await harness.mouseClick(editPos.col + 2, editPos.row);
		expect(harness.screen().text()).toContain("+const host = '0.0.0.0';");

		await harness.reload();
		expect(harness.screen().text()).not.toContain("bash-line-1");

		await harness.submitInput("/compact-tools detailed");
		expect(harness.screen().text()).toContain("bash-line-8");
		expect(harness.screen().text()).toContain("+const host = '0.0.0.0';");

		await harness.submitInput("/compact-tools diff-focus");
		expect(harness.screen().text()).not.toContain("bash-line-1");
		expect(harness.screen().text()).toContain("+const host = '0.0.0.0';");

		await harness.submitInput("/density diff-focus project");
		const savedJson = JSON.parse(readFileSync(join(projDir, ".pi", "compact-tools.json"), "utf8"));
		expect(savedJson.density).toBe("diff-focus");

		await harness.dispose();
		harness = undefined;

		const untrustedDir = createTempDir("pi-ui-density-untrusted-");
		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: untrustedDir,
			projectTrusted: false,
			width: 100,
			height: 28,
		});
		await harness.submitInput("/density compact project");
		expect(existsSync(join(untrustedDir, ".pi", "compact-tools.json"))).toBe(false);
		expect(harness.screen().text()).toContain("trusted project");
	});

	it("routes real createCodemodeExtension through registerToolRenderer, preserves JS script + nested calls on expand, and switches /density mid-stream", async () => {
		const projDir = createTempDir();
		mkdirSync(join(projDir, ".pi"), { recursive: true });
		mkdirSync(join(projDir, "src"), { recursive: true });
		writeFileSync(
			join(projDir, ".pi", "compact-tools.json"),
			`${JSON.stringify({ custom_tools: { enabled: false } }, null, 2)}\n`,
			"utf8",
		);
		writeFileSync(join(projDir, "src", "a.ts"), "export const totalSeed = 42;\n", "utf8");

		let emitBuildOut: ((chunk: string) => void) | undefined;
		let finishBuild: (() => void) | undefined;
		const streamBash = createBashToolDefinition(projDir, {
			operations: {
				async exec(_cmd, _cwd, opts) {
					emitBuildOut = (chunk) => opts.onData(Buffer.from(chunk, "utf8"));
					await new Promise<void>((resolve) => {
						finishBuild = resolve;
						opts.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return { exitCode: 0 };
				},
			},
		});

		const cmScript = [
			"const total = 42;",
			"await tools.read({ path: 'src/a.ts' });",
			"for (let i = 1; i <= 7; i++) console.log(`res-${i}`);",
		].join("\n");

		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: projDir,
			projectTrusted: true,
			width: 110,
			height: 44,
			extensionFactories: [createCodemodeExtension()],
			customTools: [streamBash],
			responses: [
				fauxAssistantMessage([fauxToolCall("codemode", { code: cmScript }, { id: "real-cm-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Codemode finished."),
				fauxAssistantMessage([fauxToolCall("bash", { command: "npm run build" }, { id: "mid-bash" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Build finished."),
			],
		});
		harness.session.setActiveToolsByName(["read", "bash", "codemode"]);

		await harness.submitInput("Execute real codemode script");

		const settledCmText = harness.screen().text();
		expect(settledCmText).toContain("✦ Ran codemode");
		expect(settledCmText).toContain("read 1");
		expect(settledCmText).toContain("res-1");
		expect(settledCmText).toContain("res-2");
		expect(settledCmText).toContain("res-7");
		expect(settledCmText).not.toContain("res-4");

		const cmPos = harness.screen().findText("✦ Ran codemode")!;
		await harness.mouseClick(cmPos.col + 2, cmPos.row);
		const expandedCmText = harness.screen().text();
		expect(expandedCmText).toContain("const total = 42;");
		expect(expandedCmText).toContain("read");
		expect(expandedCmText).toContain("res-4");
		expect(expandedCmText).not.toContain("Took ");

		await new Promise((r) => setTimeout(r, 450));
		const cmOpenPos = harness.screen().findText("✦ Ran codemode")!;
		await harness.mouseClick(cmOpenPos.col + 2, cmOpenPos.row);

		const buildTurn = harness.submitInput("Run streaming build");
		await harness.flush();
		emitBuildOut!("b1\nb2\nb3\nb4\nb5\nb6\nb7\n");
		await harness.flush();
		expect(harness.screen().text()).toContain("▎ b1");
		expect(harness.screen().text()).toContain("▎ b7");

		await harness.paste("/density diff-focus", true);
		await harness.pressKey("\r");
		expect(harness.screen().text()).toContain("▎ b1");
		await harness.paste("/density compact", true);
		await harness.pressKey("\r");
		expect(harness.screen().text()).toContain("▎ b7");

		finishBuild!();
		await buildTurn;

		expect(harness.screen().text()).not.toContain("│ b7");
		expect(harness.screen().text()).toContain("✦ Ran npm run build");

		await harness.submitInput("/compact-tools off");
		expect(harness.screen().text()).not.toContain("✦ Ran codemode");

		await harness.submitInput("/density detailed");
		expect(harness.screen().text()).toContain("✦ Ran codemode");
		expect(harness.screen().text()).toContain("│ b7");
	});

	it("computes +N -M contextual diffs on streamed write overwrites, strips bash truncation footers, un-folds streaming args mutations, prioritizes project density over global legacy style, and supports 256color mode", async () => {
		const projDir = createTempDir();
		const agentDir = createTempDir("pi-ui-density-agent-");
		mkdirSync(join(projDir, ".pi"), { recursive: true });
		mkdirSync(join(projDir, "src"), { recursive: true });

		writeFileSync(
			join(agentDir, "compact-tools.json"),
			`${JSON.stringify({ style: "claude" }, null, 2)}\n`,
			"utf8",
		);
		writeFileSync(
			join(projDir, ".pi", "compact-tools.json"),
			`${JSON.stringify({ density: "diff-focus" }, null, 2)}\n`,
			"utf8",
		);

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
		writeFileSync(join(projDir, "src", "existing.ts"), `${beforeLines.join("\n")}\n`, "utf8");
		writeFileSync(join(projDir, "src", "a.ts"), "export const a = 1;\n", "utf8");
		writeFileSync(join(projDir, "src", "b.ts"), "export const b = 2;\n", "utf8");

		const truncBash = defineTool<
			ReturnType<typeof Type.Object<{ command: ReturnType<typeof Type.String> }>>,
			Record<string, unknown>
		>({
			name: "bash",
			label: "bash",
			description: "Bash returning truncated output footer",
			parameters: Type.Object({ command: Type.String() }),
			async execute(_id, params) {
				if (params.command.startsWith("seq")) {
					return {
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
					};
				}
				return { content: [{ type: "text", text: "b-content" }], details: {} };
			},
		});

		const pendingStreams: AssistantMessageEventStream[] = [];
		const streamWaiters: Array<(s: AssistantMessageEventStream) => void> = [];

		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: projDir,
			agentDir,
			projectTrusted: true,
			width: 100,
			height: 44,
			customTools: [truncBash],
			streamSimple: (_m, _c, opts) => {
				const st = createAssistantMessageEventStream();
				opts?.signal?.addEventListener(
					"abort",
					() => {
						const aborted = makeStreamMsg([], { stopReason: "aborted" });
						st.push({ type: "error", reason: "aborted", error: aborted });
						st.end(aborted);
					},
					{ once: true },
				);
				const w = streamWaiters.shift();
				if (w) w(st);
				else pendingStreams.push(st);
				return st;
			},
		});

		const nextStream = () =>
			pendingStreams.length > 0
				? Promise.resolve(pendingStreams.shift()!)
				: new Promise<AssistantMessageEventStream>((r) => streamWaiters.push(r));

		const afterContent = `${[
			...beforeLines.slice(0, 5),
			"export const PORT = 8080;",
			"export const HOST = '0.0.0.0';",
			...beforeLines.slice(6),
		].join("\n")}\n`;

		const t1 = harness.submitInput("Overwrite existing.ts and run seq");
		const s1 = await nextStream();
		const partialCallMsg = makeStreamMsg([
			{ type: "toolCall", id: "w-stream-1", name: "write", arguments: { path: "src/e" } },
		]);
		s1.push({ type: "start", partial: makeStreamMsg([]) });
		s1.push({ type: "toolcall_start", contentIndex: 0, partial: partialCallMsg });
		await harness.flush();
		expect(harness.screen().text()).toContain("Writing src/e");

		const fullCallMsg = makeStreamMsg(
			[
				{
					type: "toolCall",
					id: "w-stream-1",
					name: "write",
					arguments: { path: "src/existing.ts", content: afterContent },
				},
				{
					type: "toolCall",
					id: "b-seq-1",
					name: "bash",
					arguments: { command: "seq 1 5000" },
				},
			],
			{ stopReason: "toolUse" },
		);
		s1.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: fullCallMsg.content[0] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
			partial: fullCallMsg,
		});
		s1.push({ type: "done", reason: "toolUse", message: fullCallMsg });
		s1.end(fullCallMsg);

		const s1Done = await nextStream();
		const final1 = makeStreamMsg([{ type: "text", text: "Overwrite complete." }]);
		s1Done.push({ type: "done", reason: "stop", message: final1 });
		s1Done.end(final1);
		await t1;

		const diffFocusScreen = harness.screen().text();
		expect(diffFocusScreen).toContain("✦ Wrote src/existing.ts (+2 -1");
		expect(diffFocusScreen).toContain("-export const PORT = 3000;");
		expect(diffFocusScreen).toContain("+export const PORT = 8080;");
		expect(diffFocusScreen).not.toContain("LINE_3 = 3");
		expect(diffFocusScreen).not.toContain("out-1");

		await harness.submitInput("/density detailed");
		const detailedScreen = harness.screen().text();
		expect(detailedScreen).toContain("│ out-1");
		expect(detailedScreen).toContain("│ out-2");
		expect(detailedScreen).toContain("│ …");
		expect(detailedScreen).toContain("│ out-5");
		expect(detailedScreen).toContain("│ out-7");
		expect(detailedScreen).not.toContain("Showing lines 1-7");

		const narrowLines = harness.renderFrame(34, 44);
		for (const line of narrowLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(34);
		}
		await harness.resize(100, 44);

		const t2 = harness.submitInput("Stream mutable bash args");
		const s2 = await nextStream();
		const pExplore = makeStreamMsg([
			{ type: "toolCall", id: "m-r1", name: "read", arguments: { path: "src/a.ts" } },
			{ type: "toolCall", id: "m-b1", name: "bash", arguments: { command: "cat src/b.ts" } },
		]);
		s2.push({ type: "start", partial: makeStreamMsg([]) });
		s2.push({ type: "toolcall_start", contentIndex: 0, partial: pExplore });
		s2.push({ type: "toolcall_start", contentIndex: 1, partial: pExplore });
		await harness.flush();
		expect(harness.screen().text()).toContain("Exploring 2 files");

		const pMutated = makeStreamMsg(
			[
				{ type: "toolCall", id: "m-r1", name: "read", arguments: { path: "src/a.ts" } },
				{
					type: "toolCall",
					id: "m-b1",
					name: "bash",
					arguments: { command: "cat src/b.ts > src/out.ts" },
				},
			],
			{ stopReason: "toolUse" },
		);
		s2.push({ type: "toolcall_delta", contentIndex: 1, delta: " > src/out.ts", partial: pMutated });
		await harness.flush();
		expect(harness.screen().text()).not.toContain("Exploring 2 files");

		s2.push({ type: "done", reason: "toolUse", message: pMutated });
		s2.end(pMutated);
		const s2Done = await nextStream();
		const final2 = makeStreamMsg([{ type: "text", text: "Args mutation handled." }]);
		s2Done.push({ type: "done", reason: "stop", message: final2 });
		s2Done.end(final2);
		await t2;

		const afterMutText = harness.screen().text();
		expect(afterMutText).toContain("✦ Read src/a.ts");
		expect(afterMutText).toContain("✦ Ran cat src/b.ts > src/out.ts");

		await harness.dispose();
		harness = undefined;

		harness = await createInteractiveHarness({
			theme: "dark",
			trueColor: false,
			cwd: projDir,
			projectTrusted: true,
			width: 100,
			height: 30,
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "src/a.ts" }, { id: "c256-r1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("256color check complete."),
			],
		});
		await harness.submitInput("Check 256color tool row");
		const screen256 = harness.screen();
		const pos256 = screen256.findText("✦ Read src/a.ts");
		expect(pos256).toBeDefined();
		let sawPalette256 = false;
		let sawTrueColor = false;
		for (let c = 0; c < screen256.width; c += 1) {
			const cell = screen256.cellAt(pos256!.row, c);
			if (cell?.fg.kind === "palette256") sawPalette256 = true;
			if (cell?.fg.kind === "rgb") sawTrueColor = true;
		}
		expect(sawPalette256).toBe(true);
		expect(sawTrueColor).toBe(false);
	});
});
