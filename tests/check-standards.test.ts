import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkRepositoryStandards,
	findDisallowedCloseGlyphLines,
	findSingleLineCommentLines,
	findTestAntiMockViolations,
	validateCommitMessage,
} from "../scripts/check-standards.mjs";

describe("check-standards mechanical guardrails", () => {
	it("detects single-line comments while ignoring URLs, strings, templates, regexes, and block comments", () => {
		const sample = [
			'const url = "https://example.com/a//b";',
			"const tpl = `prefix ${/* block // inside */ 'http://ok'} // not-comment-no: wait`;",
			"const cleanTpl = `http://inside-template/${1 + 2}/path`;",
			"const rx = /^https:\\/\\/foo\\/\\/bar/gi;",
			"/* Блочный комментарий с // внутри не считается нарушением */",
			"const bad = 42; // нарушение",
		].join("\n");

		expect(findSingleLineCommentLines(sample)).toEqual([6]);
	});

	it("handles single-line comments inside template literal expressions", () => {
		const sample = [
			"const value = `${",
			"  1 + 1 // внутри интерполяции это реальный однострочный комментарий",
			"}`;",
		].join("\n");

		expect(findSingleLineCommentLines(sample)).toEqual([2]);
	});

	it("validates commit messages against prohibited trailers and typography", () => {
		expect(
			validateCommitMessage("feat(viewport): add terminal screen snapshot helper\n\n# git comment — ignored"),
		).toEqual([]);

		expect(
			validateCommitMessage("feat: bad title\n\nCo-Authored-By: Someone <a@b.com>"),
		).toContain("Commit message contains prohibited Co-Authored-By trailer");

		expect(
			validateCommitMessage("feat: title \u2014 with em-dash"),
		).toContain("Commit message contains prohibited em-dash or en-dash");

		expect(
			validateCommitMessage("feat: title -- with double hyphen"),
		).toContain("Commit message contains prohibited double hyphen in prose");
	});

	it("flags banned TUI casts, overlayStack access, direct handleMouse calls, and fake-host imports while ignoring comments and non-import literals", () => {
		const integrationSample = [
			'import { FakeTui } from "./harness/fake-tui.ts";',
			'import "./harness/extension-harness.ts";',
			'import { setHostRuntimeAdapter, type HostRuntimeAdapter } from "../src/shared/host-runtime.ts";',
			"const castTui = raw as unknown as TUI;",
			"const viaHelper = harness.tui.asTui();",
			"const stack = tui.overlayStack;",
			'const bracketStack = tui["overlayStack"];',
			"component.handleMouse(event);",
			"component.handleMouse?.(event);",
			'vi.mock("./harness/fake-theme.ts");',
			"optionalTarget?.handleMouse(event);",
			"const legacyOverlayCheck = tui.hasOverlayEntries;",
			"/* FakeTui tui.overlayStack tui.hasOverlayEntries comp.handleMouse(ev) raw as unknown as TUI */",
			'const safeLiteral = "FakeTui tui.overlayStack comp.handleMouse(ev) as unknown as TUI";',
			"const safeTemplate = `createExtensionHarness ${1 + 1} tui.overlayStack`;",
			"const safeRegex = /tui\\.overlayStack|comp\\.handleMouse\\(/g;",
		].join("\n");

		const violations = findTestAntiMockViolations(integrationSample);
		const byLine = new Map<number, string[]>();
		for (const v of violations) {
			const list = byLine.get(v.line) ?? [];
			list.push(v.message);
			byLine.set(v.line, list);
		}

		expect(byLine.get(1)?.some((m) => m.includes("fake-tui"))).toBe(true);
		expect(byLine.get(1)?.some((m) => m.includes("FakeTui"))).toBe(true);
		expect(byLine.get(2)?.some((m) => m.includes("extension-harness"))).toBe(true);
		expect(byLine.get(3)?.some((m) => m.includes("setHostRuntimeAdapter"))).toBe(true);
		expect(byLine.get(4)?.some((m) => m.includes("as unknown as TUI"))).toBe(true);
		expect(byLine.get(5)?.some((m) => m.includes("asTui"))).toBe(true);
		expect(byLine.get(6)?.some((m) => m.includes("overlayStack"))).toBe(true);
		expect(byLine.get(7)?.some((m) => m.includes("overlayStack"))).toBe(true);
		expect(byLine.get(8)?.some((m) => m.includes("handleMouse"))).toBe(true);
		expect(byLine.get(9)?.some((m) => m.includes("handleMouse"))).toBe(true);
		expect(byLine.get(10)?.some((m) => m.includes("fake-theme"))).toBe(true);
		expect(byLine.get(11)?.some((m) => m.includes("handleMouse"))).toBe(true);
		expect(byLine.get(12)?.some((m) => m.includes("hasOverlayEntries"))).toBe(true);
		expect(byLine.has(13)).toBe(false);
		expect(byLine.has(14)).toBe(false);
		expect(byLine.has(15)).toBe(false);
		expect(byLine.has(16)).toBe(false);

		const pureUnitViolations = findTestAntiMockViolations("widget.handleMouse(ev);\nconst bad = x as unknown as TUI;", {
			isPureUnit: true,
		});
		expect(pureUnitViolations.map((v) => v.line)).toEqual([2]);
	});

	it("fails checkRepositoryStandards if deleted fake-harness files or production adapter backdoors reappear", () => {
		const tmpRoot = mkdtempSync(join(tmpdir(), "pi-ui-standards-"));
		try {
			mkdirSync(join(tmpRoot, "src", "shared"), { recursive: true });
			mkdirSync(join(tmpRoot, "tests", "harness"), { recursive: true });
			writeFileSync(
				join(tmpRoot, "package.json"),
				JSON.stringify({
					name: "@conarti/pi-ui",
					peerDependencies: {
						"@earendil-works/pi-ai": "*",
						"@earendil-works/pi-agent-core": "*",
						"@earendil-works/pi-coding-agent": "*",
						"@earendil-works/pi-tui": "*",
						typebox: "*",
					},
				}),
				"utf8",
			);
			writeFileSync(join(tmpRoot, "tests", "harness", "fake-tui.ts"), "export const x = 1;\n", "utf8");
			writeFileSync(
				join(tmpRoot, "src", "shared", "host-runtime.ts"),
				'export function setHostRuntimeAdapter(tui: { hasOverlayEntries?: boolean }) { return tui.hasOverlayEntries ? "[✕]" : "[×]"; }\n',
				"utf8",
			);
			writeFileSync(
				join(tmpRoot, "tests", "sample-integration.test.ts"),
				"const bad = raw as unknown as TUI;\ncomp.handleMouse(ev);\n",
				"utf8",
			);

			const errors = checkRepositoryStandards(tmpRoot);
			expect(errors.some((e) => e.includes("tests/harness/fake-tui.ts"))).toBe(true);
			expect(errors.some((e) => e.includes("setHostRuntimeAdapter"))).toBe(true);
			expect(errors.some((e) => e.includes("hasOverlayEntries"))).toBe(true);
			expect(errors.some((e) => e.includes('standardized close glyph "×"'))).toBe(true);
			expect(findDisallowedCloseGlyphLines('/* ✕ allowed in comment */\nconst ok = "[×]";\nconst bad = "[✕]";')).toEqual([3]);
			expect(errors.some((e) => e.includes("tests/sample-integration.test.ts:1:"))).toBe(true);
			expect(errors.some((e) => e.includes("tests/sample-integration.test.ts:2:"))).toBe(true);
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("passes repository-wide standards check on clean workspace", () => {
		expect(checkRepositoryStandards()).toEqual([]);
	});
});
