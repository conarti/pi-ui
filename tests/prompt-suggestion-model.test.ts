import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PI_UI_USER_CONFIG,
	getPiUiConfigPath,
	loadPiUiUserConfig,
	updatePiUiUserConfig,
} from "../src/shared/pi-ui-config.ts";
import {
	MAX_PROMPT_SUGGESTION_LENGTH,
	sanitizePromptSuggestion,
} from "../src/features/prompt-suggestion/model.ts";
import { isSupersededNextPromptExtension } from "../src/features/prompt-suggestion/supersede-next-prompt.ts";

describe("Prompt Suggestion user configuration (pi-ui.json)", () => {
	let tempRoot = "";
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempRoot = mkdtempSync(join(tmpdir(), "pi-ui-cfg-unit-"));
		process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent-a");
	});

	afterEach(() => {
		if (prevAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("resolves getAgentDir dynamically, defaults promptSuggestions to true, and survives malformed JSON", () => {
		expect(getPiUiConfigPath()).toBe(join(tempRoot, "agent-a", "pi-ui.json"));
		expect(loadPiUiUserConfig()).toEqual(DEFAULT_PI_UI_USER_CONFIG);
		expect(loadPiUiUserConfig().promptSuggestions).toBe(true);

		const secondDir = join(tempRoot, "agent-b");
		process.env.PI_CODING_AGENT_DIR = secondDir;
		expect(getPiUiConfigPath()).toBe(join(secondDir, "pi-ui.json"));

		updatePiUiUserConfig({ promptSuggestions: false });
		expect(loadPiUiUserConfig().promptSuggestions).toBe(false);

		writeFileSync(getPiUiConfigPath(), "{broken json", "utf8");
		expect(loadPiUiUserConfig()).toEqual(DEFAULT_PI_UI_USER_CONFIG);

		writeFileSync(getPiUiConfigPath(), JSON.stringify({ promptSuggestions: "invalid" }), "utf8");
		expect(loadPiUiUserConfig()).toEqual(DEFAULT_PI_UI_USER_CONFIG);
	});

	it("preserves sibling Settings Modal keys and dotfile symlinks on atomic updates", () => {
		const agentDir = join(tempRoot, "agent-symlink");
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const realTargetPath = join(tempRoot, "linked-target.json");
		writeFileSync(
			realTargetPath,
			`${JSON.stringify({ appearanceMode: "auto", statusBar: true, promptSuggestions: true }, null, 2)}\n`,
			"utf8",
		);
		updatePiUiUserConfig({ promptSuggestions: true });
		rmSync(getPiUiConfigPath(), { force: true });
		symlinkSync(realTargetPath, getPiUiConfigPath());

		const updated = updatePiUiUserConfig({ promptSuggestions: false });
		expect(updated.promptSuggestions).toBe(false);
		expect(lstatSync(getPiUiConfigPath()).isSymbolicLink()).toBe(true);
		expect(existsSync(realTargetPath)).toBe(true);

		const rawSaved = JSON.parse(readFileSync(realTargetPath, "utf8")) as Record<string, unknown>;
		expect(rawSaved).toEqual({
			appearanceMode: "auto",
			statusBar: true,
			promptSuggestions: false,
		});
	});
});

describe("sanitizePromptSuggestion", () => {
	it("trims surrounding quotes and backticks while preserving internal formatting and short replies", () => {
		expect(MAX_PROMPT_SUGGESTION_LENGTH).toBe(100);
		expect(sanitizePromptSuggestion('  "Запусти тесты и покажи отчёт"  ')).toBe(
			"Запусти тесты и покажи отчёт",
		);
		expect(sanitizePromptSuggestion("`'npm run check'`")).toBe("npm run check");
		expect(sanitizePromptSuggestion("«Покажи diff для composer.ts»")).toBe(
			"Покажи diff для composer.ts",
		);
		expect(sanitizePromptSuggestion("Run `npm test` on the worktree")).toBe(
			"Run `npm test` on the worktree",
		);
		expect(sanitizePromptSuggestion("Нет")).toBe("Нет");
		expect(sanitizePromptSuggestion("x".repeat(100))).toBe("x".repeat(100));
	});

	it("rejects empty strings, no-suggestion sentinels, multiline outputs, and strings over 100 chars", () => {
		expect(sanitizePromptSuggestion("")).toBeUndefined();
		expect(sanitizePromptSuggestion("   ")).toBeUndefined();
		expect(sanitizePromptSuggestion('""')).toBeUndefined();
		expect(sanitizePromptSuggestion("nothing")).toBeUndefined();
		expect(sanitizePromptSuggestion("(Nothing)")).toBeUndefined();
		expect(sanitizePromptSuggestion("[none]")).toBeUndefined();
		expect(sanitizePromptSuggestion("N/A")).toBeUndefined();
		expect(sanitizePromptSuggestion("Line one\nLine two")).toBeUndefined();
		expect(sanitizePromptSuggestion("Line one\rLine two")).toBeUndefined();
		expect(sanitizePromptSuggestion("x".repeat(101))).toBeUndefined();
	});
});

describe("isSupersededNextPromptExtension", () => {
	it("identifies external pi-next-prompt package paths, sourceInfo, and signature handlers without false positives", () => {
		expect(
			isSupersededNextPromptExtension({
				path: "/Users/dev/.pi/agent/npm/node_modules/pi-next-prompt/extensions/next-prompt.ts",
			}),
		).toBe(true);
		expect(
			isSupersededNextPromptExtension({
				path: "<inline:0>",
				sourceInfo: { source: "npm:pi-next-prompt" },
			}),
		).toBe(true);
		expect(
			isSupersededNextPromptExtension({
				path: "<inline:1>",
				handlers: new Map([
					[
						"agent_end",
						[
							function fakeHandler() {
								return "[Suggestion mode] Predict what the user will type next in this conversation.";
							},
						],
					],
				]),
			}),
		).toBe(true);
		expect(
			isSupersededNextPromptExtension({
				path: "/Users/dev/Projects/pi-ui/src/index.ts",
				handlers: new Map([["session_start", [() => {}]]]),
			}),
		).toBe(false);
	});
});


