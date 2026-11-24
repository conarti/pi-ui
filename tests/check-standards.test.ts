import { describe, expect, it } from "vitest";
import {
	checkRepositoryStandards,
	findSingleLineCommentLines,
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

	it("passes repository-wide standards check on clean workspace", () => {
		expect(checkRepositoryStandards()).toEqual([]);
	});
});
