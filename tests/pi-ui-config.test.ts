import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PI_UI_USER_CONFIG,
	getLegacyToolDisplayConfigPath,
	getPiUiConfigPath,
	loadPiUiUserConfig,
	parsePiUiUserConfig,
	TOOL_DENSITY_PRESETS,
	updatePiUiUserConfig,
} from "../src/shared/pi-ui-config.ts";

describe("Unified pi-ui.json config and legacy migration (pure seam)", () => {
	let prevAgentDir: string | undefined;
	let tempRoot: string;

	beforeEach(() => {
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempRoot = mkdtempSync(join(tmpdir(), "pi-ui-config-"));
		process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
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

	it("returns Echelon 1 defaults with promptSuggestions and aiWorkingStatus off on fresh installs", () => {
		expect(TOOL_DENSITY_PRESETS).toEqual([
			"balanced",
			"compact",
			"grouped",
			"diff-focus",
			"detailed",
		]);
		expect(DEFAULT_PI_UI_USER_CONFIG).toEqual({
			toolDensity: "balanced",
			responseMetrics: true,
			timestamps: "datetime",
			outlineTimestamps: true,
			copyOnSelect: false,
			showShortcutsBar: true,
			midTurnEnter: "queue",
			promptSuggestions: false,
			aiWorkingStatus: false,
			slotOwners: {},
		});
		expect(loadPiUiUserConfig()).toEqual(DEFAULT_PI_UI_USER_CONFIG);
		expect(existsSync(getPiUiConfigPath())).toBe(false);
	});

	it("preserves explicit promptSuggestions: true and validates invalid field values safely", () => {
		const parsed = parsePiUiUserConfig({
			toolDensity: "diff-focus",
			responseMetrics: false,
			timestamps: "time",
			outlineTimestamps: false,
			copyOnSelect: true,
			showShortcutsBar: false,
			midTurnEnter: "steer",
			promptSuggestions: true,
			aiWorkingStatus: true,
			slotOwners: { footer: "third-party-status", invalid: 42, empty: "" },
		});
		expect(parsed).toEqual({
			toolDensity: "diff-focus",
			responseMetrics: false,
			timestamps: "time",
			outlineTimestamps: false,
			copyOnSelect: true,
			showShortcutsBar: false,
			midTurnEnter: "steer",
			promptSuggestions: true,
			aiWorkingStatus: true,
			slotOwners: { footer: "third-party-status" },
		});

		expect(
			parsePiUiUserConfig({
				toolDensity: "unknown",
				timestamps: "epoch",
				midTurnEnter: "instant",
				promptSuggestions: "yes",
				slotOwners: ["bad"],
			}),
		).toEqual(DEFAULT_PI_UI_USER_CONFIG);
	});

	it("performs one-time transparent migration from legacy tool-display.json without overriding existing pi-ui.json keys", () => {
		const agentDir = join(tempRoot, "agent");
		mkdirSync(agentDir, { recursive: true });
		const legacyPath = getLegacyToolDisplayConfigPath();
		expect(legacyPath).toBe(join(agentDir, "tool-display.json"));

		writeFileSync(
			legacyPath,
			`${JSON.stringify({ density: "diff-focus", extraLegacy: true }, null, 2)}\n`,
			"utf8",
		);
		writeFileSync(
			getPiUiConfigPath(),
			`${JSON.stringify({ promptSuggestions: true, futureKey: "keep-me" }, null, 2)}\n`,
			"utf8",
		);

		const migrated = loadPiUiUserConfig();
		expect(migrated.toolDensity).toBe("diff-focus");
		expect(migrated.promptSuggestions).toBe(true);

		const savedDisk = JSON.parse(readFileSync(getPiUiConfigPath(), "utf8")) as Record<string, unknown>;
		expect(savedDisk).toMatchObject({
			toolDensity: "diff-focus",
			promptSuggestions: true,
			futureKey: "keep-me",
		});

		/* После однократной миграции повторное изменение legacy-файла не перезаписывает pi-ui.json */
		writeFileSync(legacyPath, `${JSON.stringify({ density: "compact" }, null, 2)}\n`, "utf8");
		expect(loadPiUiUserConfig().toolDensity).toBe("diff-focus");
	});

	it("writes through a dangling relative symlink chain", () => {
		const agentDir = join(tempRoot, "agent");
		mkdirSync(agentDir);
		const intermediate = join(tempRoot, "dotfiles-link.json");
		const target = join(tempRoot, "dotfiles", "settings.json");
		symlinkSync("../dotfiles-link.json", getPiUiConfigPath());
		symlinkSync("dotfiles/settings.json", intermediate);

		updatePiUiUserConfig({ toolDensity: "grouped" });

		expect(lstatSync(getPiUiConfigPath()).isSymbolicLink()).toBe(true);
		expect(lstatSync(intermediate).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ toolDensity: "grouped" });
	});

	it("preserves symlinks, file permissions, and forward-compatible sibling keys across updates", () => {
		const agentDir = join(tempRoot, "agent-symlink");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(agentDir, { recursive: true });

		const realTarget = join(tempRoot, "dotfiles-pi-ui.json");
		writeFileSync(
			realTarget,
			`${JSON.stringify({ appearanceMode: "auto", futureFlag: 123, promptSuggestions: true }, null, 2)}\n`,
			"utf8",
		);
		chmodSync(realTarget, 0o640);
		symlinkSync(realTarget, getPiUiConfigPath());

		const updated = updatePiUiUserConfig({
			toolDensity: "grouped",
			showShortcutsBar: false,
			slotOwners: { header: "custom-header" },
		});

		expect(updated.toolDensity).toBe("grouped");
		expect(updated.showShortcutsBar).toBe(false);
		expect(updated.promptSuggestions).toBe(true);
		expect(updated.slotOwners).toEqual({ header: "custom-header" });
		expect(lstatSync(getPiUiConfigPath()).isSymbolicLink()).toBe(true);
		expect(statSync(realTarget).mode & 0o777).toBe(0o640);
		expect(JSON.parse(readFileSync(realTarget, "utf8"))).toEqual({
			appearanceMode: "auto",
			futureFlag: 123,
			promptSuggestions: true,
			toolDensity: "grouped",
			showShortcutsBar: false,
			slotOwners: { header: "custom-header" },
		});
	});
});
