import { describe, expect, it } from "vitest";
import {
	buildEditorOpenCommand,
	classifyMarkdownLinkTarget,
	findFilePathSpansInLine,
	parseFilePathReference,
} from "../src/shared/link-targets.ts";
import {
	serializeMarkdownTableToCsv,
	serializeMarkdownTableToMd,
	serializeMarkdownTableToTsv,
	stripBlockquoteMarkers,
	type MarkdownTableToken,
} from "../src/shared/markdown-serializers.ts";
import { extractSkillInvocations, shortenSkillPath } from "../src/shared/skill-tags.ts";
import { formatTurnTime } from "../src/shared/turn-index.ts";

describe("formatTurnTime", () => {
	const now = new Date(2026, 10, 26, 12, 0);

	it("formats current-year timestamps as D MMM, HH:MM and prior-year as D MMM YYYY, HH:MM in datetime mode", () => {
		const sameYear = new Date(2026, 10, 25, 19, 56).getTime();
		const priorYear = new Date(2025, 10, 25, 19, 56).getTime();
		expect(formatTurnTime(sameYear, { mode: "datetime", now })).toBe("25 Nov, 19:56");
		expect(formatTurnTime(priorYear, { mode: "datetime", now })).toBe("25 Nov 2025, 19:56");
	});

	it("formats time-only and off modes accurately", () => {
		const ts = new Date(2026, 10, 25, 9, 5).getTime();
		expect(formatTurnTime(ts, { mode: "time", now })).toBe("09:05");
		expect(formatTurnTime(ts, { mode: "off", now })).toBe("");
	});
});

describe("extractSkillInvocations", () => {
	it("extracts <skill> XML with user message into Skill Chip metadata, /skill:<name> copy text, and /<skill> · <text> preview", () => {
		const raw = [
			'<skill name="tdd" location="/repo/.agents/skills/tdd/SKILL.md">',
			"References are relative to /repo/.agents/skills/tdd.",
			"",
			"# Test-Driven Development",
			"Red before green.",
			"</skill>",
			"",
			"Implement the parser cleanly",
		].join("\n");

		const res = extractSkillInvocations(raw, { cwd: "/repo" });
		expect(res.skills).toHaveLength(1);
		expect(res.skills[0]).toMatchObject({
			name: "tdd",
			location: "/repo/.agents/skills/tdd/SKILL.md",
			shortLocation: ".agents/skills/tdd/SKILL.md",
			body: "# Test-Driven Development\nRed before green.",
			lineCount: 2,
		});
		expect(res.userText).toBe("Implement the parser cleanly");
		expect(res.cleanCopyText).toBe("/skill:tdd Implement the parser cleanly");
		expect(res.previewText).toBe("/tdd · Implement the parser cleanly");
	});

	it("handles skill-only invocations and multiple skills without leaving XML wrappers", () => {
		const single = '<skill name="grilling" location="/tmp/grilling/SKILL.md">\nAsk hard questions.\n</skill>';
		const resSingle = extractSkillInvocations(single, { cwd: "/repo" });
		expect(resSingle.skills).toHaveLength(1);
		expect(resSingle.userText).toBe("");
		expect(resSingle.cleanCopyText).toBe("/skill:grilling");
		expect(resSingle.previewText).toBe("/grilling");

		const multi =
			'<skill name="tdd" location="/repo/a/SKILL.md">\nA\n</skill>\n<skill name="code-review" location="/repo/b/SKILL.md">\nB\n</skill>\n\nCheck diff';
		const resMulti = extractSkillInvocations(multi, { cwd: "/repo" });
		expect(resMulti.skills.map((s) => s.name)).toEqual(["tdd", "code-review"]);
		expect(resMulti.cleanCopyText).toBe("/skill:tdd /skill:code-review Check diff");
		expect(resMulti.previewText).toBe("/tdd /code-review · Check diff");
	});

	it("shortens paths relative to cwd cleanly", () => {
		expect(shortenSkillPath("/repo/.agents/skills/tdd/SKILL.md", "/repo")).toBe(
			".agents/skills/tdd/SKILL.md",
		);
		expect(shortenSkillPath("/outside/path/SKILL.md", "/repo")).toBe("/outside/path/SKILL.md");
	});
});

describe("markdown-serializers (table TSV/CSV/MD and blockquote strip)", () => {
	const sampleTable: MarkdownTableToken = {
		align: ["left", "center", "right"],
		header: [
			{ text: "Tool", tokens: [{ type: "text", text: "Tool" }] },
			{ text: "Notes", tokens: [{ type: "text", text: "Notes" }] },
			{ text: "Count", tokens: [{ type: "text", text: "Count" }] },
		],
		rows: [
			[
				{ text: "`read`", tokens: [{ type: "codespan", text: "read" }] },
				{ text: 'Reads "files", fast', tokens: [{ type: "text", text: 'Reads "files", fast' }] },
				{ text: "12", tokens: [{ type: "text", text: "12" }] },
			],
			[
				{ text: "**edit**", tokens: [{ type: "strong", text: "edit", tokens: [{ type: "text", text: "edit" }] }] },
				{
					text: "See [docs](https://pi.dev) | v2",
					tokens: [
						{ type: "text", text: "See " },
						{ type: "link", text: "docs", href: "https://pi.dev", tokens: [{ type: "text", text: "docs" }] },
						{ type: "text", text: " | v2" },
					],
				},
				{ text: "4", tokens: [{ type: "text", text: "4" }] },
			],
		],
	};

	it("serializes Markdown tables into valid TSV, RFC 4180 CSV, and GFM Markdown", () => {
		expect(serializeMarkdownTableToTsv(sampleTable)).toBe(
			[
				"Tool\tNotes\tCount",
				'read\tReads "files", fast\t12',
				"edit\tSee docs | v2\t4",
			].join("\n"),
		);

		expect(serializeMarkdownTableToCsv(sampleTable)).toBe(
			[
				"Tool,Notes,Count",
				'read,"Reads ""files"", fast",12',
				"edit,See docs | v2,4",
			].join("\n"),
		);

		expect(serializeMarkdownTableToMd(sampleTable)).toBe(
			[
				"| Tool | Notes | Count |",
				"| :--- | :---: | ---: |",
				'| `read` | Reads "files", fast | 12 |',
				"| **edit** | See [docs](https://pi.dev) \\| v2 | 4 |",
			].join("\n"),
		);
	});

	it("strips leading > markers from blockquotes while preserving Markdown formatting, links, and nested quotes", () => {
		const raw = [
			"> **Important**: review [Pi docs](https://pi.dev) and `pi-ui.json`.",
			">",
			"> > Nested citation line",
		].join("\n");
		expect(stripBlockquoteMarkers(raw)).toBe(
			[
				"**Important**: review [Pi docs](https://pi.dev) and `pi-ui.json`.",
				"",
				"> Nested citation line",
			].join("\n"),
		);

		expect(stripBlockquoteMarkers(">\n>   ")).toBe("");
	});
});

describe("link-targets (hidden URLs, file path:line[:col], and editor command builder)", () => {
	it("parses file paths with optional :line and :col while rejecting clock times and prose ratios", () => {
		const res1 = parseFilePathReference("src/shared/i18n.ts:42:7", {
			cwd: "/repo",
			checkExists: () => false,
		});
		expect(res1).toMatchObject({
			kind: "path",
			rawPath: "src/shared/i18n.ts",
			resolvedPath: "/repo/src/shared/i18n.ts",
			line: 42,
			column: 7,
			copyText: "src/shared/i18n.ts:42:7",
		});

		const res2 = parseFilePathReference("package.json", {
			cwd: "/repo",
			checkExists: (p) => p === "/repo/package.json",
		});
		expect(res2).toMatchObject({
			kind: "path",
			rawPath: "package.json",
			resolvedPath: "/repo/package.json",
			copyText: "package.json",
		});

		expect(parseFilePathReference("19:56", { cwd: "/repo", checkExists: () => false })).toBeUndefined();
		expect(parseFilePathReference("and/or", { cwd: "/repo", checkExists: () => false })).toBeUndefined();
		expect(
			parseFilePathReference("https://pi.dev/docs", { cwd: "/repo", checkExists: () => false }),
		).toBeUndefined();
	});

	it("classifies hidden Markdown links [text](url) and local file links cleanly", () => {
		expect(
			classifyMarkdownLinkTarget("https://github.com/conarti/pi-ui", "pi-ui repo", {
				cwd: "/repo",
				checkExists: () => false,
			}),
		).toMatchObject({
			kind: "url",
			url: "https://github.com/conarti/pi-ui",
			copyText: "https://github.com/conarti/pi-ui",
		});

		expect(
			classifyMarkdownLinkTarget("src/index.ts#L18", "entry point", {
				cwd: "/repo",
				checkExists: () => false,
			}),
		).toMatchObject({
			kind: "path",
			rawPath: "src/index.ts",
			line: 18,
			copyText: "src/index.ts:18",
		});
	});

	it("finds accurate column spans for local file paths in rendered lines", () => {
		const spans = findFilePathSpansInLine("Inspect src/shared/ansi.ts:120 and `README.md:4` next.", {
			cwd: "/repo",
			checkExists: (p) => p.endsWith("README.md"),
		});
		expect(spans).toHaveLength(2);
		expect(spans[0]!.target.copyText).toBe("src/shared/ansi.ts:120");
		expect(spans[0]!.xStart).toBe("Inspect ".length);
		expect(spans[1]!.target.copyText).toBe("README.md:4");
	});

	it("builds $VISUAL/$EDITOR launch commands with :line support for GUI and terminal editors", () => {
		expect(buildEditorOpenCommand("code --reuse-window", "/repo/a.ts", { line: 42, column: 3 })).toEqual({
			command: "code",
			args: ["--reuse-window", "-g", "/repo/a.ts:42:3"],
		});
		expect(buildEditorOpenCommand("nvim", "/repo/a.ts", { line: 42 })).toEqual({
			command: "nvim",
			args: ["+42", "/repo/a.ts"],
		});
		expect(buildEditorOpenCommand("zed", "/repo/a.ts", { line: 10 })).toEqual({
			command: "zed",
			args: ["/repo/a.ts:10"],
		});
		expect(buildEditorOpenCommand("", "/repo/a.ts", { line: 10 })).toBeUndefined();
	});
});
