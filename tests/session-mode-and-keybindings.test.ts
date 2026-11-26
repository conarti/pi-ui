import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getSessionWorkflow,
	MODE_META,
	normalizeSessionMode,
	syncThinkingCycleKeybinding,
} from "../src/shared/session-workflow.ts";
import {
	createInteractiveHarness,
	type InteractiveHarness,
} from "./harness/index.ts";

describe("Canonical Session Mode & Shift+Tab / Alt+T keybindings", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function allocateTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
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

	it("normalizes canonical and legacy Session Mode names and exposes English MODE_META labels", () => {
		expect(normalizeSessionMode("always-approve")).toBe("always-approve");
		expect(normalizeSessionMode("code")).toBe("always-approve");
		expect(normalizeSessionMode("plan")).toBe("plan");
		expect(normalizeSessionMode("auto")).toBe("auto");
		expect(normalizeSessionMode("safe")).toBe("auto");
		expect(normalizeSessionMode("unknown")).toBeUndefined();

		expect(MODE_META["always-approve"].label).toBe("Always-approve");
		expect(MODE_META.plan.label).toBe("Plan");
		expect(MODE_META.auto.label).toBe("Auto");
	});

	it("synchronizes app.thinking.cycle to alt+t when unconfigured or still shift+tab without clobbering custom bindings", () => {
		const dir = allocateTempDir("pi-ui-kb-sync-");
		const kbPath = join(dir, "keybindings.json");

		expect(syncThinkingCycleKeybinding(dir)).toBe(true);
		expect(JSON.parse(readFileSync(kbPath, "utf8"))).toEqual({
			"app.thinking.cycle": "alt+t",
		});

		writeFileSync(
			kbPath,
			`${JSON.stringify({ "app.thinking.cycle": "shift+tab", "app.session.new": "ctrl+shift+n" }, null, 2)}\n`,
			"utf8",
		);
		expect(syncThinkingCycleKeybinding(dir)).toBe(true);
		expect(JSON.parse(readFileSync(kbPath, "utf8"))).toEqual({
			"app.thinking.cycle": "alt+t",
			"app.session.new": "ctrl+shift+n",
		});

		writeFileSync(
			kbPath,
			`${JSON.stringify({ "app.thinking.cycle": "ctrl+shift+t" }, null, 2)}\n`,
			"utf8",
		);
		expect(syncThinkingCycleKeybinding(dir)).toBe(false);
		expect(JSON.parse(readFileSync(kbPath, "utf8"))).toEqual({
			"app.thinking.cycle": "ctrl+shift+t",
		});
	});

	it("synchronizes keybindings through dangling relative symlinks without replacing the links", () => {
		const dir = allocateTempDir("pi-ui-kb-links-");
		const path = join(dir, "keybindings.json");
		symlinkSync("indirection.json", path);
		symlinkSync("dotfiles/keys.json", join(dir, "indirection.json"));
		expect(syncThinkingCycleKeybinding(dir)).toBe(true);
		expect(lstatSync(path).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(dir, "indirection.json")).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(join(dir, "dotfiles", "keys.json"), "utf8"))).toEqual({ "app.thinking.cycle": "alt+t" });
	});

	it("cycles Session Mode on Shift+Tab without changing thinking level, cycles thinking on Alt+T across RU/EN layouts, and supports canonical slash commands", async () => {
		const agentDir = allocateTempDir("pi-ui-mode-e2e-");
		mkdirSync(agentDir, { recursive: true });
		harness = await createInteractiveHarness({
			agentDir,
			models: [
				{
					id: "reasoning-1",
					name: "Reasoning Test",
					reasoning: true,
				},
			],
			thinkingLevel: "off",
			width: 100,
			height: 28,
		});

		const wf = getSessionWorkflow();
		expect(wf.mode).toBe("always-approve");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(existsSync(join(agentDir, "keybindings.json"))).toBe(true);

		/* Shift+Tab переключает Session Mode Always-approve -> Plan -> Auto -> Always-approve без смены thinking */
		await harness.pressKey("\x1b[Z");
		expect(wf.mode).toBe("plan");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.screen().text()).toContain("Plan");

		await harness.pressKey("\x1b[Z");
		expect(wf.mode).toBe("auto");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.screen().text()).toContain("Auto");

		await harness.pressKey("\x1b[Z");
		expect(wf.mode).toBe("always-approve");
		expect(harness.session.thinkingLevel).toBe("off");

		/* Alt+T (EN), macOS Option+T (†) и кириллический Alt+Е открывают поповер Thinking */
		await harness.pressKey("\x1b[116;3u");
		expect(harness.screen().text()).toContain("Thinking");
		await harness.pressKey("\x1b[B");
		await harness.pressKey("\r");
		const levelAfterEn = harness.session.thinkingLevel;
		expect(levelAfterEn).not.toBe("off");
		expect(wf.mode).toBe("always-approve");

		await harness.pressKey("\x1b[1077;3u");
		expect(harness.screen().text()).toContain("Thinking");
		await harness.pressKey("\x1b[B");
		await harness.pressKey("\r");
		const levelAfterRu = harness.session.thinkingLevel;
		expect(levelAfterRu).not.toBe(levelAfterEn);
		expect(wf.mode).toBe("always-approve");

		await harness.pressKey("†");
		expect(harness.screen().text()).toContain("Thinking");
		await harness.pressKey("\x1b[B");
		await harness.pressKey("\r");
		const levelAfterOption = harness.session.thinkingLevel;
		expect(levelAfterOption).not.toBe(levelAfterRu);

		/* Канонические slash-команды /plan, /auto, /always-approve и /mode */
		await harness.submitInput("/plan");
		expect(wf.mode).toBe("plan");
		await harness.submitInput("/auto");
		expect(wf.mode).toBe("auto");
		await harness.submitInput("/always-approve");
		expect(wf.mode).toBe("always-approve");
		await harness.submitInput("/mode auto");
		expect(wf.mode).toBe("auto");
		await harness.submitInput("/mode always-approve");
		expect(wf.mode).toBe("always-approve");
	});
});
