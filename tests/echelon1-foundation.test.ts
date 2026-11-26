import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computePopupSurfaceBg,
	parseAnsiColorRgb,
	rgbHueDegrees,
	type RgbTuple,
} from "../src/shared/ansi.ts";
import {
	defaultHostExternalOpener,
	getActiveHostRuntime,
	resolveActiveExternalOpener,
} from "../src/shared/host-runtime.ts";
import { loadPiUiUserConfig } from "../src/shared/pi-ui-config.ts";
import { getSessionWorkflow } from "../src/shared/session-workflow.ts";
import {
	createInteractiveHarness,
	fauxAssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

function isForbiddenHue(rgb: RgbTuple): boolean {
	const { hue, saturation } = rgbHueDegrees(rgb);
	if (saturation <= 0.05) return false;
	return (hue >= 255 && hue <= 320) || (hue >= 165 && hue <= 198);
}

describe("Ticket #41 foundation end-to-end (real InteractiveMode)", () => {
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

	it("renders 100% English UI chrome, modals, tooltips, and command descriptions with zero Cyrillic", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 110,
			height: 30,
			responses: [
				fauxAssistantMessage("1. Inspect modules\n2. Verify tests"),
				fauxAssistantMessage("Selectable English response text."),
			],
		});

		const cyrillicRe = /[А-Яа-яЁё]/u;
		expect(cyrillicRe.test(harness.screen().text())).toBe(false);

		/* Все зарегистрированные команды расширений имеют английские описания без кириллицы */
		const commands = harness.session.extensionRunner?.getRegisteredCommands?.() ?? [];
		expect(commands.length).toBeGreaterThan(5);
		for (const cmd of commands) {
			expect(
				cyrillicRe.test(cmd.description ?? ""),
				`Cyrillic leaked in /${cmd.name}: ${cmd.description}`,
			).toBe(false);
		}

		/* Command Palette и Context Inspector полностью на английском */
		await harness.pressKey("\x0b");
		const paletteText = harness.screen().text();
		expect(paletteText).toContain("Command Palette");
		expect(paletteText).toContain("Search commands");
		expect(paletteText).toContain("Always-approve");
		expect(cyrillicRe.test(paletteText)).toBe(false);
		await harness.pressKey("\x1b");

		await harness.paste("/context", true);
		await harness.pressKey("\r");
		await harness.flush();
		const contextText = harness.screen().text();
		expect(contextText).toContain("Context Inspector");
		expect(contextText).toContain("Dialogue");
		expect(cyrillicRe.test(contextText)).toBe(false);
		await harness.pressKey("\x1b");

		/* Plan mode и Plan Studio полностью на английском */
		await harness.submitInput("/plan");
		await harness.submitInput("Draft an English plan");
		const studioText = harness.screen().text();
		expect(studioText).toContain("Plan Studio");
		expect(cyrillicRe.test(studioText)).toBe(false);
		await harness.pressKey("\x1b");

		/* Selection Hover Popup полностью на английском */
		await harness.submitInput("/always-approve");
		await harness.submitInput("Give selectable reply");
		const hit = harness.screen().findText("Selectable English");
		expect(hit).toBeDefined();
		await harness.mouseDrag(hit!.col, hit!.row, hit!.col + 12, hit!.row);
		const hoverText = harness.screen().text();
		expect(hoverText).toContain("╭ ❝ Quote ╮");
		expect(cyrillicRe.test(hoverText)).toBe(false);
	});

	it("migrates legacy tool-display.json transparently into pi-ui.json and updates preferences via /density, /shortcuts-bar, /slots, and Command Palette", async () => {
		const agentDir = allocateTempDir("pi-ui-migrate-e2e-");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "tool-display.json"),
			`${JSON.stringify({ density: "diff-focus" }, null, 2)}\n`,
			"utf8",
		);

		harness = await createInteractiveHarness({
			agentDir,
			width: 110,
			height: 30,
		});

		const configPath = join(agentDir, "pi-ui.json");
		expect(existsSync(configPath)).toBe(true);
		expect(loadPiUiUserConfig()).toMatchObject({
			toolDensity: "diff-focus",
			promptSuggestions: false,
			aiWorkingStatus: false,
			showShortcutsBar: true,
			responseMetrics: true,
			timestamps: "datetime",
			copyOnSelect: false,
			midTurnEnter: "queue",
			slotOwners: {},
		});

		await harness.submitInput("/density balanced");
		expect(loadPiUiUserConfig().toolDensity).toBe("balanced");

		await harness.submitInput("/shortcuts-bar off");
		expect(loadPiUiUserConfig().showShortcutsBar).toBe(false);
		await harness.submitInput("/shortcuts-bar status");
		expect(harness.screen().text()).toContain("Shortcuts Bar is currently off");

		await harness.submitInput("/slots footer custom-footer-ext");
		expect(loadPiUiUserConfig().slotOwners).toEqual({ footer: "custom-footer-ext" });
		await harness.submitInput("/slots status");
		expect(harness.screen().text()).toContain("footer=custom-footer-ext");

		await harness.submitInput("/slots clear");
		expect(loadPiUiUserConfig().slotOwners).toEqual({});

		/* Быстрый переключатель в Command Palette обновляет pi-ui.json */
		await harness.pressKey("\x0b");
		await harness.typeText("Copy on Select");
		await harness.pressKey("\r");
		await harness.flush();
		expect(loadPiUiUserConfig().copyOnSelect).toBe(true);
	});

	it("restores legacy code and safe session entries seamlessly and switches thinking level via /thinking", async () => {
		harness = await createInteractiveHarness({
			width: 100,
			height: 28,
			models: [{ id: "reasoning-legacy", name: "Reasoning Legacy", reasoning: true }],
			thinkingLevel: "off",
			setupSession(sm) {
				sm.appendCustomEntry("conarti-ui-state", {
					mode: "code",
					planRaw: "",
					planComments: {},
					planSteps: [],
					executingPlan: false,
				});
			},
		});
		expect(getSessionWorkflow().mode).toBe("always-approve");

		await harness.submitInput("/thinking medium");
		expect(harness.session.thinkingLevel).toBe("medium");

		await harness.dispose();
		harness = undefined;

		harness = await createInteractiveHarness({
			width: 100,
			height: 28,
			setupSession(sm) {
				sm.appendCustomEntry("conarti-ui-state", {
					mode: "safe",
					planRaw: "",
					planComments: {},
					planSteps: [],
					executingPlan: false,
				});
			},
		});
		expect(getSessionWorkflow().mode).toBe("auto");
	});

	it.each(["dark", "light"] as const)(
		"renders Modal Card and Hover Popup surfaces with elevated popupSurfaceBg (not toolPendingBg, zero purple/turquoise) in %s theme",
		async (themeMode) => {
			harness = await createInteractiveHarness({
				theme: themeMode,
				width: 106,
				height: 28,
				responses: [
					fauxAssistantMessage("Hoverable response snippet for popup background verification."),
				],
			});

			await harness.submitInput("Show response for popup surface check");
			const runtime = getActiveHostRuntime()!;
			const theme = runtime.theme();
			const expectedPopupBg = computePopupSurfaceBg(theme);
			const pendingBg = parseAnsiColorRgb(theme.getBgAnsi("toolPendingBg"));
			expect(isForbiddenHue(expectedPopupBg)).toBe(false);

			/* Modal Card (Command Palette) красит рамку и фон цветом popupSurfaceBg */
			await harness.pressKey("\x0b");
			const modalScreen = harness.screen();
			const titleHit = modalScreen.findText("Command Palette");
			expect(titleHit).toBeDefined();
			const titleBg = modalScreen.cellAt(titleHit!.row, titleHit!.col)?.bg;
			expect(titleBg).toEqual({
				kind: "rgb",
				r: expectedPopupBg[0],
				g: expectedPopupBg[1],
				b: expectedPopupBg[2],
			});
			if (pendingBg) {
				expect([expectedPopupBg[0], expectedPopupBg[1], expectedPopupBg[2]]).not.toEqual(pendingBg);
			}
			await harness.pressKey("\x1b");

			/* Hover Popup (Quote selection popup) красит фон цветом popupSurfaceBg */
			const textHit = harness.screen().findText("Hoverable response");
			expect(textHit).toBeDefined();
			await harness.mouseDrag(textHit!.col, textHit!.row, textHit!.col + 10, textHit!.row);
			const popupScreen = harness.screen();
			const popupHit = popupScreen.findText("╭ ❝ Quote ╮");
			expect(popupHit).toBeDefined();
			const popupBg = popupScreen.cellAt(popupHit!.row, popupHit!.col + 2)?.bg;
			expect(popupBg).toEqual({
				kind: "rgb",
				r: expectedPopupBg[0],
				g: expectedPopupBg[1],
				b: expectedPopupBg[2],
			});
		},
	);

	it("exposes injectable HostExternalOpener on InteractiveHarness and validates unsafe URL schemes in default opener", async () => {
		harness = await createInteractiveHarness({ width: 96, height: 24 });

		const opener = resolveActiveExternalOpener();
		expect(opener).toBe(getActiveHostRuntime()!.externalOpener);

		const urlRes = await opener.openUrl("https://github.com/conarti/pi-ui");
		const pathRes = await opener.openPath("src/shared/i18n.ts", { line: 10, column: 2 });
		expect(urlRes).toEqual({ ok: true });
		expect(pathRes).toEqual({ ok: true });
		expect(harness.openedExternals).toEqual([
			{ kind: "url", url: "https://github.com/conarti/pi-ui" },
			{ kind: "path", path: "src/shared/i18n.ts", line: 10, column: 2 },
		]);

		const customCalls: string[] = [];
		harness.setExternalOpener({
			async openUrl(url) {
				customCalls.push(`custom-url:${url}`);
				return { ok: true };
			},
			async openPath(filePath) {
				customCalls.push(`custom-path:${filePath}`);
				return { ok: false, error: "simulated denial" };
			},
		});
		expect(await resolveActiveExternalOpener().openUrl("https://pi.dev")).toEqual({ ok: true });
		expect(await resolveActiveExternalOpener().openPath("/tmp/missing")).toEqual({
			ok: false,
			error: "simulated denial",
		});
		expect(customCalls).toEqual(["custom-url:https://pi.dev", "custom-path:/tmp/missing"]);

		/* После dispose() дефолтный порт безопасно отклоняет небезопасные схемы без запуска процессов */
		await harness.dispose();
		harness = undefined;
		expect(resolveActiveExternalOpener()).toBe(defaultHostExternalOpener);
		expect((await defaultHostExternalOpener.openUrl("javascript:alert(1)")).ok).toBe(false);
		expect((await defaultHostExternalOpener.openUrl("")).ok).toBe(false);
		expect((await defaultHostExternalOpener.openPath("   ")).ok).toBe(false);
	});
});
