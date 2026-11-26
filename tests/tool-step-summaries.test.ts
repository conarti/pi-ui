import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/features/tool-calls/config.ts";
import { formatAllGroupedSummary } from "../src/features/tool-calls/density.ts";
import { TOOL_DENSITIES } from "../src/features/tool-calls/types.ts";
import {
	AGY_TOOL_SUMMARIES_ENTRY_TYPE,
	buildStepHeaderParts,
	formatWorkspacePath,
	relativizeCommandPaths,
	rememberLiveToolSummary,
	resolveExternalToolSummary,
	summarizeCodemodeIntentFallback,
} from "../src/features/tool-calls/step-summaries.ts";
import {
	formatImageResultSummary,
	hasImageContent,
	summarizeCustomArguments,
} from "../src/features/tool-calls/invocation.ts";

describe("Tool Calls: O(1) step-summary index and semantic fallbacks (pure seam)", () => {
	it("indexes pi-agy-tool-summaries incrementally in O(1) over SessionManager and arrays without re-scanning", () => {
		const entries: Array<Record<string, unknown>> = [
			{
				type: "custom",
				customType: AGY_TOOL_SUMMARIES_ENTRY_TYPE,
				data: {
					summaries: {
						"call-1": "  Inspect   repo state \x1b[31m\x1b[0m ",
					},
				},
			},
		];

		let getEntriesCalls = 0;
		const sessionManagerLike = {
			getEntryCount: () => entries.length,
			getEntries: () => {
				getEntriesCalls += 1;
				return [...entries];
			},
		};

		expect(resolveExternalToolSummary("call-1", {}, sessionManagerLike)).toBe("Inspect repo state");
		expect(getEntriesCalls).toBe(1);

		/* Повторные обращения при неизменном getEntryCount не вызывают getEntries() */
		expect(resolveExternalToolSummary("call-1", {}, sessionManagerLike)).toBe("Inspect repo state");
		expect(resolveExternalToolSummary("call-missing", {}, sessionManagerLike)).toBeUndefined();
		expect(getEntriesCalls).toBe(1);

		/* Добавление новой записи индексирует только хвост */
		entries.push({
			type: "custom",
			customType: AGY_TOOL_SUMMARIES_ENTRY_TYPE,
			data: {
				summaries: {
					"call-2": "Verify test suite",
				},
			},
		});
		expect(resolveExternalToolSummary("call-2", {}, sessionManagerLike)).toBe("Verify test suite");
		expect(getEntriesCalls).toBe(2);
		expect(resolveExternalToolSummary("call-1", {}, sessionManagerLike)).toBe("Inspect repo state");
		expect(getEntriesCalls).toBe(2);

		/* Прямой массив записей также поддерживается инкрементально */
		const plainEntries: Array<Record<string, unknown>> = [
			{
				type: "custom",
				customType: AGY_TOOL_SUMMARIES_ENTRY_TYPE,
				data: { summaries: { "arr-1": "Scan config files" } },
			},
		];
		expect(resolveExternalToolSummary("arr-1", {}, plainEntries)).toBe("Scan config files");
		plainEntries.push({
			type: "custom",
			customType: AGY_TOOL_SUMMARIES_ENTRY_TYPE,
			data: { summaries: { "arr-2": "Run typecheck" } },
		});
		expect(resolveExternalToolSummary("arr-2", {}, plainEntries)).toBe("Run typecheck");
	});

	it("prioritizes inline toolSummary and toolAction fields and remembers live overrides", () => {
		expect(
			resolveExternalToolSummary("inline-1", { toolSummary: "Check git history" }),
		).toBe("Check git history");
		expect(
			resolveExternalToolSummary("inline-2", { toolAction: "Inspect diff hunks" }),
		).toBe("Inspect diff hunks");
		expect(
			resolveExternalToolSummary("inline-3", { input: { toolSummary: "Nested input summary" } }),
		).toBe("Nested input summary");

		const source: unknown[] = [];
		resolveExternalToolSummary("inline-1", { toolSummary: "Check git history" }, source);
		expect(resolveExternalToolSummary("inline-1", {}, source)).toBe("Check git history");

		rememberLiveToolSummary("live-only-1", "Format markdown table", source);
		expect(resolveExternalToolSummary("live-only-1", {}, source)).toBe("Format markdown table");
	});

	it("isolates live labels from other sessions reusing the same call ID", () => {
		const first: unknown[] = [];
		const second = [{ type: "custom", customType: AGY_TOOL_SUMMARIES_ENTRY_TYPE, data: { summaries: { "call-1": "Second session" } } }];
		expect(resolveExternalToolSummary("call-1", { toolSummary: "First session" }, first)).toBe("First session");
		expect(resolveExternalToolSummary("call-1", {}, second)).toBe("Second session");
		expect(resolveExternalToolSummary("call-1", {}, first)).toBe("First session");
	});

	it("formats workspace-relative and ~/... paths cleanly", () => {
		const fakeCwd = "/workspace/my-repo";
		expect(formatWorkspacePath("/workspace/my-repo/src/index.ts", fakeCwd)).toBe("src/index.ts");
		expect(formatWorkspacePath("/workspace/my-repo", fakeCwd)).toBe(".");

		const homeFile = join(homedir(), "notes", "todo.md");
		expect(formatWorkspacePath(homeFile, fakeCwd)).toBe("~/notes/todo.md");
		expect(relativizeCommandPaths(`cat /workspace/my-repo/README.md ${homeFile}`, fakeCwd)).toBe(
			"cat README.md ~/notes/todo.md",
		);
	});

	it("synthesizes semantic codemode summaries without raw JavaScript snippets", () => {
		const readOnly = summarizeCodemodeIntentFallback(
			{
				code: `
					const a = await tools.read({ path: "/repo/src/density.ts" });
					const b = await tools.read({ path: "/repo/src/grouping.ts" });
					return { a, b };
				`,
			},
			"success",
			"/repo",
		);
		expect(readOnly).toEqual({ verb: "Read", target: "density.ts, grouping.ts" });

		const mixed = summarizeCodemodeIntentFallback(
			{
				code: `
					await tools.read({ path: "/repo/src/a.ts" });
					await tools.bash({ command: "npm test" });
					await tools.edit({ path: "/repo/src/a.ts", edits: [] });
				`,
			},
			"success",
			"/repo",
		);
		expect(mixed).toEqual({
			verb: "Ran batch",
			target: "1 edit, 1 read, 1 command (a.ts)",
		});

		const generic = summarizeCodemodeIntentFallback(
			{ code: "const x = 1 + 2; return x;" },
			"running",
			"/repo",
		);
		expect(generic).toEqual({ verb: "Running script", target: "codemode" });
		expect(generic.target).not.toContain("const x");
	});

	it("builds step header parts with stepSummary priority, relative paths, and full grep/find patterns on expand", () => {
		const cmWithSummary = buildStepHeaderParts({
			name: "codemode",
			args: { code: "await tools.bash({ command: 'git status' });" },
			status: "success",
			rawPath: "",
			stepSummary: "Inspect repo state",
			cwd: "/repo",
			summarizeCustomArgs: summarizeCustomArguments,
		});
		expect(cmWithSummary).toEqual({ verb: "Inspect repo state", target: "" });

		const bashWithSummary = buildStepHeaderParts({
			name: "bash",
			args: { command: "git status -sb" },
			status: "success",
			rawPath: "",
			stepSummary: "Check git status",
			cwd: "/repo",
			summarizeCustomArgs: summarizeCustomArguments,
		});
		expect(bashWithSummary).toEqual({ verb: "Check git status", target: "git status -sb" });

		for (const name of ["read", "edit", "write", "ls"]) {
			expect(buildStepHeaderParts({
				name, args: {}, status: "success", rawPath: "/repo/src", cwd: "/repo",
				stepSummary: "Inspect repo state", summarizeCustomArgs: summarizeCustomArguments,
			})).toEqual({ verb: "Inspect repo state", target: "src" });
		}

		const longPattern = "very_long_identifier_pattern_that_exceeds_forty_eight_characters_easily";
		const collapsedGrep = buildStepHeaderParts({
			name: "grep",
			args: { pattern: longPattern, path: "/repo/src" },
			status: "success",
			rawPath: "/repo/src",
			cwd: "/repo",
			expanded: false,
			summarizeCustomArgs: summarizeCustomArguments,
		});
		expect(collapsedGrep.target.length).toBeLessThan(longPattern.length + 12);

		const expandedGrep = buildStepHeaderParts({
			name: "grep",
			args: { pattern: longPattern, path: "/repo/src" },
			status: "success",
			rawPath: "/repo/src",
			cwd: "/repo",
			expanded: true,
			summarizeCustomArgs: summarizeCustomArguments,
		});
		expect(expandedGrep.target).toContain(longPattern);
		expect(expandedGrep.target).toContain("in src");
	});

	it("defaults Tool Density to balanced across all 5 presets and formats Compact/Grouped summaries with diff counts", () => {
		expect(DEFAULT_CONFIG.density).toBe("balanced");
		expect(TOOL_DENSITIES).toEqual(["balanced", "compact", "grouped", "diff-focus", "detailed"]);

		const mixedRows = [
			{
				toolName: "edit",
				toolCallId: "e1",
				args: { path: "src/a.ts" },
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { diff: "+10\n+11\n-1\n" },
					isError: false,
				},
				isPartial: false,
			},
			{
				toolName: "write",
				toolCallId: "w1",
				args: { path: "src/b.ts", content: "l1\nl2\nl3\n" },
				result: { content: [{ type: "text", text: "ok" }], details: {}, isError: false },
				isPartial: false,
			},
			{
				toolName: "bash",
				toolCallId: "b1",
				args: { command: "npm test" },
				result: { content: [{ type: "text", text: "ok" }], details: {}, isError: false },
				isPartial: false,
			},
			{
				toolName: "codemode",
				toolCallId: "cm1",
				args: { code: "return 1;" },
				result: { content: [{ type: "text", text: "ok" }], details: {}, isError: false },
				isPartial: false,
			},
		];
		const compactSummary = formatAllGroupedSummary(mixedRows as never);
		expect(compactSummary.summary).toBe("Edited 2 files, ran 2 commands");
		expect(compactSummary.changes).toEqual({ added: 5, removed: 1 });

		const pureExplore = [
			{
				toolName: "read",
				toolCallId: "r1",
				args: { path: "src/a.ts" },
				result: { content: [], details: {} },
				isPartial: false,
			},
			{
				toolName: "grep",
				toolCallId: "g1",
				args: { pattern: "foo" },
				result: { content: [], details: {} },
				isPartial: false,
			},
		];
		expect(formatAllGroupedSummary(pureExplore as never)).toEqual({
			summary: "Explored 1 file, 1 search",
		});

		/* 1x1 PNG в base64 для проверки метаданных изображения */
		const png1x1 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const imageResult = {
			content: [{ type: "image", data: png1x1, mimeType: "image/png" }],
			details: {},
		};
		expect(hasImageContent(imageResult)).toBe(true);
		expect(formatImageResultSummary(imageResult as never)).toBe("image/png · 1×1");
		expect(hasImageContent({ content: [{ type: "text", text: "hello" }] })).toBe(false);
	});
});
