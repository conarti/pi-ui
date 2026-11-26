import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	CustomEditor,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import piUiExtension from "../src/index.ts";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import { getPiUiConfigPath, loadPiUiUserConfig, updatePiUiUserConfig } from "../src/shared/pi-ui-config.ts";
import {
	createAssistantMessageEventStream,
	createInteractiveHarness,
	DEFAULT_EXTENSION_ENTRY,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type InteractiveHarness,
} from "./harness/index.ts";

async function waitForCondition(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

async function flushDeferredUi(harness: InteractiveHarness): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 30));
	await harness.flush();
	harness.flushFrame(true);
}

describe("Dynamic capability-based Slot Arbitration (ADR-0007)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function allocateTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(async () => {
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

	it("runs additive third-party extensions (unique command, tool, widget, shortcut, hook) without any arbitration prompt", async () => {
		let pingRan = 0;
		let shortcutRan = 0;
		let hookObservedMessages = 0;

		const additivePlugin: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerCommand("acme-ping", {
				description: "Ping from additive plugin",
				handler: async (_args, ctx) => {
					pingRan += 1;
					ctx.ui.notify("ACME_PONG_OK", "info");
				},
			});
			pi.registerShortcut("ctrl+alt+z", {
				description: "Additive plugin shortcut",
				handler: async (ctx) => {
					shortcutRan += 1;
					ctx.ui.notify("ACME_SHORTCUT_OK", "info");
				},
			});
			pi.registerTool({
				name: "acme_probe",
				label: "Acme probe",
				description: "Returns additive probe payload",
				parameters: Type.Object({ tag: Type.String() }),
				async execute(_id, params) {
					return {
						content: [{ type: "text", text: `ACME_PROBE:${params.tag}` }],
						details: {},
					};
				},
			});
			pi.on("session_start", (_event, ctx) => {
				if (ctx.mode === "tui" && ctx.hasUI) {
					ctx.ui.setWidget("acme-banner", ["ACME_WIDGET_VISIBLE"]);
				}
			});
			pi.on("message_end", () => {
				hookObservedMessages += 1;
			});
		};

		harness = await createInteractiveHarness({
			width: 110,
			height: 32,
			extensionFactories: [additivePlugin],
			responses: [
				fauxAssistantMessage([fauxToolCall("acme_probe", { tag: "alpha" }, { id: "call-acme-1" })]),
				fauxAssistantMessage([fauxText("Additive run complete.")]),
			],
		});

		await flushDeferredUi(harness);
		const initialScreen = harness.screen().text();
		expect(initialScreen).not.toContain("Slot Arbitration");
		expect(initialScreen).toContain("ACME_WIDGET_VISIBLE");

		await harness.submitInput("/acme-ping");
		expect(pingRan).toBe(1);
		expect(harness.screen().text()).toContain("ACME_PONG_OK");

		/* Ctrl+Alt+Z (CSI-u) */
		await harness.pressKey("\x1b[122;7u");
		await harness.flush();
		expect(shortcutRan).toBe(1);

		await harness.prompt("run probe");
		expect(hookObservedMessages).toBeGreaterThan(0);
		expect(harness.screen().text()).toContain("Additive run complete.");
		expect(existsSync(getPiUiConfigPath())).toBe(false);
	});

	it("surfaces a third-party footer collision once in Slot Arbitration, hot-swaps footer live, persists pi-ui.json, and does not re-prompt on subsequent launch", async () => {
		const agentDir = allocateTempDir("pi-ui-slot-footer-");

		const makeExternalFooterPlugin = (): ExtensionFactory => (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				if (ctx.mode === "tui" && ctx.hasUI) {
					ctx.ui.setFooter(() => ({
						invalidate() {},
						render: (width: number) => [
							"THIRD_PARTY_FOOTER_ACTIVE".padEnd(width, " ").slice(0, width),
						],
					}));
				}
			});
		};

		/* 1. Загрузка после @conarti/pi-ui: появляется Modal Card "Slot Arbitration" */
		harness = await createInteractiveHarness({
			agentDir,
			width: 110,
			height: 32,
			extensionFactories: [makeExternalFooterPlugin()],
		});

		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		const modalText = harness.screen().text();
		expect(modalText).toContain("Slot Arbitration");
		expect(modalText).toContain("Footer");
		expect(modalText).toContain("@conarti/pi-ui");

		/* Переключаем владельца footer на сторонний плагин клавишей → и применяем Enter */
		await harness.pressKey("\x1b[C");
		await harness.flush();
		await harness.pressKey("\r");
		await flushDeferredUi(harness);

		const afterApply = harness.screen().text();
		expect(afterApply).not.toContain("Slot Arbitration");
		expect(afterApply).toContain("THIRD_PARTY_FOOTER_ACTIVE");

		const saved = loadPiUiUserConfig();
		expect(saved.slotOwners.footer).toBeDefined();
		expect(saved.slotOwners.footer).not.toBe("@conarti/pi-ui");
		const persistedRaw = JSON.parse(readFileSync(getPiUiConfigPath(), "utf8"));
		expect(persistedRaw.slotOwners.footer).toBe(saved.slotOwners.footer);

		/* /reload сохраняет выбор и не открывает модалку повторно */
		await harness.reload();
		await flushDeferredUi(harness);
		expect(harness.screen().text()).not.toContain("Slot Arbitration");
		expect(harness.screen().text()).toContain("THIRD_PARTY_FOOTER_ACTIVE");

		await harness.dispose();
		harness = undefined;

		/* 2. Повторный запуск в обратном порядке загрузки (сторонний плагин ДО @conarti/pi-ui) не показывает модалку */
		harness = await createInteractiveHarness({
			agentDir,
			width: 110,
			height: 32,
			loadDefaultExtension: false,
			extensionFactories: [makeExternalFooterPlugin(), piUiExtension],
		});

		await flushDeferredUi(harness);
		const relaunchScreen = harness.screen().text();
		expect(relaunchScreen).not.toContain("Slot Arbitration");
		expect(relaunchScreen).toContain("THIRD_PARTY_FOOTER_ACTIVE");
	});

	it("keeps a saved owner when same-named local extension paths change order", async () => {
		const agentDir = allocateTempDir("pi-ui-slot-path-owner-");
		const plugins = ["FIRST_PATH_FOOTER", "SECOND_PATH_FOOTER"].map((label) => {
			const path = join(allocateTempDir("pi-ui-local-plugin-"), "status.ts");
			writeFileSync(path, `export default function(pi) {
	pi.on("session_start", (_event, ctx) => ctx.ui.setFooter(() => ({ invalidate() {}, render: () => [${JSON.stringify(label)}] })));
}`);
			return path;
		});
		harness = await createInteractiveHarness({ agentDir, additionalExtensionPaths: plugins });
		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		await harness.pressKey("\x1b[C");
		await harness.pressKey("\r");
		await flushDeferredUi(harness);
		const selected = harness.screen().text().match(/(?:FIRST|SECOND)_PATH_FOOTER/)?.[0];
		expect(selected).toBeDefined();
		await harness.dispose();
		harness = await createInteractiveHarness({ agentDir, additionalExtensionPaths: [...plugins].reverse() });
		await flushDeferredUi(harness);
		expect(harness.screen().text()).not.toContain("Slot Arbitration");
		expect(harness.screen().text()).toContain(selected!);
	});

	it("batches header, footer, editor, and workingIndicator collisions into one mouse-operable modal and hot-swaps all four live without restart", async () => {
		const agentDir = allocateTempDir("pi-ui-slot-all-singletons-");
		let activeStream: AssistantMessageEventStream | undefined;

		const contendingSuitePlugin: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				if (ctx.mode !== "tui" || !ctx.hasUI) return;
				ctx.ui.setHeader(() => ({
					invalidate() {},
					render: (width: number) => [
						"TP_CUSTOM_HEADER_BANNER".padEnd(width, " ").slice(0, width),
					],
				}));
				ctx.ui.setFooter(() => ({
					invalidate() {},
					render: (width: number) => [
						"TP_CUSTOM_FOOTER_STRIP".padEnd(width, " ").slice(0, width),
					],
				}));
				ctx.ui.setEditorComponent((tui, editorTheme, kb) => {
					class ThirdPartyEditor extends CustomEditor {
						override render(width: number): string[] {
							return [
								"TP_CUSTOM_EDITOR_FRAME".padEnd(width, " ").slice(0, width),
								...super.render(width),
							];
						}
					}
					return new ThirdPartyEditor(tui, editorTheme, kb);
				});
				ctx.ui.setWorkingIndicator({ frames: ["[TP-SPIN]"] });
			});
		};

		harness = await createInteractiveHarness({
			agentDir,
			width: 112,
			height: 36,
			extensionFactories: [contendingSuitePlugin],
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				activeStream = stream;
				return stream;
			},
		});

		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		const modalScreen = harness.screen();
		const modalText = modalScreen.text();
		expect(modalText).toContain("4 slots");
		expect(modalText).toContain("Footer (footer)");
		expect(modalText).toContain("Header (header)");
		expect(modalText).toContain("Composer Editor (editor)");
		expect(modalText).toContain("Working Indicator (workingIndicator)");

		/* Кликаем мышкой по пилюлям стороннего владельца (inline-1) для всех четырёх слотов */
		const ownerHits: Array<{ col: number; row: number }> = [];
		for (let r = 0; r < modalScreen.height; r += 1) {
			const rowStr = modalScreen.rowText(r);
			const idx = rowStr.indexOf("○ inline-1");
			if (idx !== -1) {
				ownerHits.push({ col: idx + 2, row: r });
			}
		}
		expect(ownerHits.length).toBe(4);
		for (const hit of ownerHits) {
			await harness.mouseClick(hit.col, hit.row);
			await harness.flush();
		}

		/* Кликаем мышкой по кнопке Apply в футере модальной карточки */
		const applyHit = harness.screen().findText("Apply");
		expect(applyHit).toBeDefined();
		await harness.mouseClick(applyHit!.col + 1, applyHit!.row);
		await flushDeferredUi(harness);

		const externalActiveText = harness.screen().text();
		expect(externalActiveText).not.toContain("Slot Arbitration");
		expect(externalActiveText).toContain("TP_CUSTOM_HEADER_BANNER");
		expect(externalActiveText).toContain("TP_CUSTOM_FOOTER_STRIP");
		expect(externalActiveText).toContain("TP_CUSTOM_EDITOR_FRAME");
		expect(loadPiUiUserConfig().slotOwners).toEqual({
			footer: "inline-1",
			header: "inline-1",
			editor: "inline-1",
			workingIndicator: "inline-1",
		});

		/* Живое переключение обратно на @conarti/pi-ui через /slots без перезапуска Pi */
		await harness.submitInput("/slots header @conarti/pi-ui");
		await flushDeferredUi(harness);
		expect(harness.screen().text()).not.toContain("TP_CUSTOM_HEADER_BANNER");

		await harness.submitInput("/slots footer @conarti/pi-ui");
		await flushDeferredUi(harness);
		expect(harness.screen().text()).not.toContain("TP_CUSTOM_FOOTER_STRIP");

		await harness.submitInput("/slots editor @conarti/pi-ui");
		await flushDeferredUi(harness);
		expect(harness.screen().text()).not.toContain("TP_CUSTOM_EDITOR_FRAME");

		/* Проверяем живое переключение workingIndicator прямо во время активного стриминга */
		const turnPromise = harness.prompt("stream check");
		await waitForCondition(() => activeStream !== undefined);
		const streamMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Working step" }],
			api: "faux-slot-stream",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		activeStream!.push({ type: "start", partial: streamMsg });
		activeStream!.push({ type: "thinking_start", contentIndex: 0, partial: streamMsg });
		await flushDeferredUi(harness);
		expect(harness.screen().text()).toContain("[TP-SPIN]");

		/* Переключаем workingIndicator на @conarti/pi-ui прямо в ходе ответа */
		await harness.submitInput("/slots workingIndicator @conarti/pi-ui");
		await flushDeferredUi(harness);
		const swappedWorkingText = harness.screen().text();
		expect(swappedWorkingText).not.toContain("[TP-SPIN]");
		expect(swappedWorkingText).toContain("✦");

		activeStream!.push({ type: "done", reason: "stop", message: streamMsg });
		activeStream!.end(streamMsg);
		await turnPromise;
		await flushDeferredUi(harness);

		/* Открытие Slot Arbitration через Command Palette (/slots) и обратное переключение footer */
		await harness.pressKey("\x0b");
		await harness.flush();
		await harness.typeText("Slot Arbitration");
		await harness.pressKey("\r");
		await flushDeferredUi(harness);
		expect(harness.screen().text()).toContain("Slot Arbitration");
		await harness.pressKey("\x1b[C");
		await harness.pressKey("\r");
		await flushDeferredUi(harness);
		expect(harness.screen().text()).toContain("TP_CUSTOM_FOOTER_STRIP");
	});

	it("arbitrates colliding /commands, shortcuts, and custom toolRenderers live while ignoring core-tool wrappers and additive registrations", async () => {
		const agentDir = allocateTempDir("pi-ui-slot-named-");
		let thirdPartyContextCmdCount = 0;
		let thirdPartyAltMCount = 0;
		let additiveCmdCount = 0;

		const namedCollisionPlugin: ExtensionFactory = (pi: ExtensionAPI) => {
			/* Аддитивная команда не должна попадать в арбитраж */
			pi.registerCommand("third-party-only", {
				description: "Additive command",
				handler: async (_args, ctx) => {
					additiveCmdCount += 1;
					ctx.ui.notify("ADDITIVE_CMD_RAN", "info");
				},
			});
			/* Коллизия по точному имени команды /context */
			pi.registerCommand("context", {
				description: "Third-party context viewer",
				handler: async (_args, ctx) => {
					thirdPartyContextCmdCount += 1;
					ctx.ui.notify("TP_CONTEXT_COMMAND_RAN", "info");
				},
			});
			/* Коллизия по точному шорткату alt+m */
			pi.registerShortcut("alt+m", {
				description: "Third-party alt+m action",
				handler: async (ctx) => {
					thirdPartyAltMCount += 1;
					ctx.ui.notify("TP_ALTM_SHORTCUT_RAN", "info");
				},
			});
			/* Провайдерская обёртка на core-tool (bash) НЕ должна вызывать арбитраж;
			   а коллизия на кастомном туле @conarti/pi-ui (ask_user_question) ДОЛЖНА */
			pi.registerToolRenderer((name, next) => {
				if (name === "bash") {
					return {
						renderCall: () => new Text("PROVIDER_BASH_WRAPPER", 0, 0),
						renderResult: () => new Text("PROVIDER_BASH_RESULT", 0, 0),
					};
				}
				if (name === "ask_user_question") {
					return {
						renderCall: () => new Text("TP_ASK_USER_RENDERER", 0, 0),
						renderResult: () => new Text("TP_ASK_USER_RESULT", 0, 0),
					};
				}
				return next();
			});
		};

		harness = await createInteractiveHarness({
			agentDir,
			width: 112,
			height: 34,
			extensionFactories: [namedCollisionPlugin],
		});

		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		const modalText = harness.screen().text();
		expect(modalText).toContain("Command /context");
		expect(modalText).toContain("Shortcut alt+m");
		expect(modalText).toContain("Tool Renderer ask_user_question");
		expect(modalText).not.toContain("third-party-only");
		expect(modalText).not.toContain("bash");

		/* Подтверждаем дефолт @conarti/pi-ui для всех трёх слотов */
		await harness.pressKey("\r");
		await flushDeferredUi(harness);
		expect(harness.screen().text()).not.toContain("Slot Arbitration");

		/* Аддитивная команда работает свободно */
		await harness.submitInput("/third-party-only");
		expect(additiveCmdCount).toBe(1);
		expect(harness.screen().text()).toContain("ADDITIVE_CMD_RAN");

		/* Сейчас /context и alt+m принадлежат @conarti/pi-ui */
		const openCtx1 = harness.submitInput("/context");
		await waitForCondition(() => harness!.screen().text().includes("Context Inspector"));
		expect(thirdPartyContextCmdCount).toBe(0);
		await harness.pressKey("\x1b");
		await openCtx1;
		await flushDeferredUi(harness);

		await harness.pressKey("\x1bm");
		await flushDeferredUi(harness);
		expect(thirdPartyAltMCount).toBe(0);
		expect(harness.screen().text()).toContain("Session Mode");
		await harness.pressKey("\x1b");
		await flushDeferredUi(harness);

		/* Живое переключение command:context и shortcut:alt+m на inline-1 без перезапуска Pi */
		await harness.submitInput("/slots command:context inline-1");
		await harness.submitInput("/slots shortcut:alt+m inline-1");
		await harness.submitInput("/slots toolRenderer:ask_user_question inline-1");
		await flushDeferredUi(harness);

		await harness.submitInput("/context");
		await flushDeferredUi(harness);
		expect(thirdPartyContextCmdCount).toBe(1);
		expect(harness.screen().text()).toContain("TP_CONTEXT_COMMAND_RAN");

		await harness.pressKey("\x1bm");
		await flushDeferredUi(harness);
		expect(thirdPartyAltMCount).toBe(1);
		expect(harness.screen().text()).toContain("TP_ALTM_SHORTCUT_RAN");

		harness.session.setActiveToolsByName(["bash", "ask_user_question"]);
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("bash", { command: "echo slot-probe" }, { id: "slot-shell" }),
				fauxToolCall("ask_user_question", {
					questions: [{ header: "UI", question: "Which view?", options: [{ label: "Summary" }, { label: "Details" }] }],
				}, { id: "slot-ask" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Slot probe finished."),
		]);
		const turn = harness.submitInput("Check tool renderer ownership");
		await waitForCondition(() => harness!.screen().text().includes("Which view?"));
		const option = harness.screen().findText("Summary")!;
		await harness.mouseClick(option.col, option.row);
		await turn;
		const transcript = harness.screen();
		expect(transcript.findText("TP_ASK_USER_RENDERER")).toBeDefined();
		expect(transcript.findText("echo slot-probe")).toBeDefined();
		expect(transcript.findText("PROVIDER_BASH_WRAPPER")).toBeUndefined();

		/* Обратное живое переключение на @conarti/pi-ui */
		await harness.submitInput("/slots command:context @conarti/pi-ui");
		await harness.submitInput("/slots shortcut:alt+m @conarti/pi-ui");
		await flushDeferredUi(harness);

		const openCtx2 = harness.submitInput("/context");
		await waitForCondition(() => harness!.screen().text().includes("Context Inspector"));
		expect(thirdPartyContextCmdCount).toBe(1);
		await harness.pressKey("\x1b");
		await openCtx2;
	});

	it("arbitrates an editor replacement even if its extension read or called the current factory", async () => {
		const plugin: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				const previous = ctx.ui.getEditorComponent();
				ctx.ui.setEditorComponent((tui, theme, keys) => {
					previous?.(tui, theme, keys);
					return new class extends CustomEditor {
						override render(width: number): string[] {
							return ["REPLACEMENT_EDITOR", ...super.render(width)];
						}
					}(tui, theme, keys);
				});
			});
		};
		harness = await createInteractiveHarness({ width: 108, height: 30, extensionFactories: [plugin] });
		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		expect(harness.screen().text()).toContain("Editor");
		expect(harness.screen().text()).not.toContain("REPLACEMENT_EDITOR");
		await harness.pressKey("\x1b[C");
		await harness.pressKey("\r");
		await flushDeferredUi(harness);
		expect(harness.screen().text()).toContain("REPLACEMENT_EDITOR");
	});

	it("does not collide with a differently cased command name", async () => {
		harness = await createInteractiveHarness({ extensionFactories: [(pi) => {
			pi.registerCommand("Stats", {
				description: "Case-sensitive command",
				handler: async (_args, ctx) => ctx.ui.notify("CAPITALIZED_STATS", "info"),
			});
		}] });
		await flushDeferredUi(harness);
		expect(harness.screen().text()).not.toContain("Slot Arbitration");
		await harness.submitInput("/Stats");
		expect(harness.screen().text()).toContain("CAPITALIZED_STATS");
	});

	it("batches and switches locally dispatched Composer and Sticky Prompt shortcuts", async () => {
		const plugin: ExtensionFactory = (pi) => {
			for (const chord of ["ctrl+l", "alt+t", "alt+s"] as const) {
				pi.registerShortcut(chord, {
					description: `Third-party ${chord}`,
					handler: async (ctx) => ctx.ui.notify(`THIRD_PARTY_${chord}`, "info"),
				});
			}
		};
		harness = await createInteractiveHarness({ width: 112, height: 32, extensionFactories: [plugin] });
		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		for (const chord of ["ctrl+l", "alt+t", "alt+s"]) {
			expect(harness.screen().text()).toContain(`Shortcut ${chord}`);
		}
		await harness.pressKey("\r");
		for (const [chord, sequence] of [["ctrl+l", "\x0c"], ["alt+t", "\x1bt"], ["alt+s", "\x1bs"]] as const) {
			await harness.submitInput(`/slots shortcut:${chord} inline-1`);
			await harness.pressKey(sequence);
			expect(harness.screen().text()).toContain(`THIRD_PARTY_${chord}`);
		}
	});

	it("arbitrates Ctrl+K live even though Pi reserves that chord for the editor", async () => {
		const plugin: ExtensionFactory = (pi) => pi.registerShortcut("ctrl+k", {
			description: "Third-party picker",
			handler: async (ctx) => ctx.ui.notify("THIRD_PARTY_CTRL_K", "info"),
		});
		harness = await createInteractiveHarness({ width: 112, height: 32, extensionFactories: [plugin] });
		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		expect(harness.screen().text()).toContain("Shortcut ctrl+k");
		await harness.pressKey("\r");
		await harness.pressKey("\x0b");
		expect(harness.screen().text()).toContain("Command Palette");
		await harness.pressKey("\x1b");
		await harness.submitInput("/slots shortcut:ctrl+k inline-1");
		await harness.pressKey("\x0b");
		expect(harness.screen().text()).toContain("THIRD_PARTY_CTRL_K");
		expect(harness.screen().findText("Command Palette")).toBeUndefined();
	});

	it("arbitrates third-party metrics entry renderers without removing unrelated commands", async () => {
		const thirdParty: ExtensionFactory = (pi) => {
			pi.registerEntryRenderer("response-metrics", () => new Text("THIRD_PARTY_METRICS", 0, 0));
			pi.registerEntryRenderer("pi-stamp", () => new Text("THIRD_PARTY_STAMP", 0, 0));
			pi.registerCommand("report-health", {
				description: "Independent health check",
				handler: async (_args, ctx) => ctx.ui.notify("HEALTH_CHECK_PASSED", "info"),
			});
		};
		harness = await createInteractiveHarness({ width: 112, height: 32, extensionFactories: [thirdParty] });
		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		expect(harness.screen().text()).toContain("Entry Renderer response-metrics");
		await harness.pressKey("\r");
		await harness.submitInput("/report-health");
		expect(harness.screen().text()).toContain("HEALTH_CHECK_PASSED");
	});

	it("silently supersedes absorbed legacy first-party scripts without triggering Slot Arbitration", async () => {
		const scriptsDir = allocateTempDir("pi-ui-legacy-scripts-");
		mkdirSync(scriptsDir, { recursive: true });
		const legacyQuotePath = join(scriptsDir, "pi-quote-blocks.ts");
		const legacyMetricsPath = join(scriptsDir, "response-metrics.ts");
		const legacyNextPromptPath = join(scriptsDir, "pi-next-prompt.ts");
		const legacyWorkingStatusPath = join(scriptsDir, "embed-working-status.ts");
		writeFileSync(
			legacyQuotePath,
			`export default function(pi) {
	pi.registerCommand("quote", { description: "Quote blocks legacy", handler: async () => {} });
	pi.registerShortcut("alt+q", { description: "Quote selected text as a block", handler: async () => {} });
}\n`,
			"utf8",
		);
		writeFileSync(
			legacyMetricsPath,
			`export default function(pi) {
	pi.registerCommand("metrics", { description: "Legacy metrics", handler: async () => {} });
	pi.registerEntryRenderer("pi-stamp:turn-metrics", () => ({ invalidate() {}, render: () => ["legacy"] }));
}\n`,
			"utf8",
		);
		writeFileSync(
			legacyNextPromptPath,
			`export default function(pi) {
	pi.on("session_start", (_e, ctx) => {
		if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
	});
}\n`,
			"utf8",
		);
		writeFileSync(
			legacyWorkingStatusPath,
			`export default function(pi) {
	pi.on("session_start", (_e, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget("embed-working-status", ["legacy"]);
	});
}\n`,
			"utf8",
		);

		harness = await createInteractiveHarness({
			width: 100,
			height: 30,
			additionalExtensionPaths: [
				legacyQuotePath,
				legacyMetricsPath,
				legacyNextPromptPath,
				legacyWorkingStatusPath,
			],
		});

		await flushDeferredUi(harness);
		expect(harness.screen().text()).not.toContain("Slot Arbitration");
	});

	it("resolves colliding capabilities non-blockingly in headless/print mode using saved pi-ui.json or @conarti/pi-ui default", async () => {
		const cwd = allocateTempDir("pi-ui-headless-cwd-");
		const agentDir = allocateTempDir("pi-ui-headless-agent-");
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;

		try {
			let tpHits = 0;
			const collidingHeadlessPlugin: ExtensionFactory = (pi: ExtensionAPI) => {
				pi.registerCommand("context", {
					description: "Headless colliding context",
					handler: async () => {
						tpHits += 1;
					},
				});
			};

			const rawFaux = fauxProvider({
				provider: "faux",
				api: "faux-headless-slot-test",
				models: [
					{
						id: "faux-1",
						name: "Faux",
						reasoning: false,
						input: ["text"],
						contextWindow: 64000,
						maxTokens: 4096,
					},
				],
			});
			const modelRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: join(agentDir, "models.json"),
			});
			modelRuntime.registerNativeProvider(rawFaux.provider);
			await modelRuntime.refresh({ allowNetwork: false });
			new ModelRegistry(modelRuntime);

			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({ quietStartup: true } as never, {
					projectTrusted: true,
				}),
				resourceLoaderOptions: {
					noExtensions: true,
					additionalExtensionPaths: [DEFAULT_EXTENSION_ENTRY],
					extensionFactories: [collidingHeadlessPlugin],
					noThemes: true,
					noSkills: true,
					noPromptTemplates: true,
					noContextFiles: true,
				},
			});
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
				model: rawFaux.getModel(),
			});
			await session.bindExtensions({ mode: "print" });

			/* По умолчанию без сохранённого выбора побеждает @conarti/pi-ui неблокирующе */
			const defaultCmd = session.extensionRunner.getCommand("context");
			expect(defaultCmd).toBeDefined();
			await defaultCmd!.handler("", session.extensionRunner.createCommandContext());
			expect(tpHits).toBe(0);

			/* С сохранённым выбором в pi-ui.json неблокирующе побеждает сторонний владелец */
			updatePiUiUserConfig({ slotOwners: { "command:context": "inline-1" } });
			const externalCmd = session.extensionRunner.getCommand("context");
			expect(externalCmd).toBeDefined();
			await externalCmd!.handler("", session.extensionRunner.createCommandContext());
			expect(tpHits).toBe(1);

			session.dispose();
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
	});

	it("arbitrates colliding custom messageRenderers live on exact customType matches while letting additive messageRenderers pass through", async () => {
		const agentDir = allocateTempDir("pi-ui-slot-msg-renderer-");
		const piUiWithCustomMsg: ExtensionFactory = (pi: ExtensionAPI) => {
			piUiExtension(pi);
			pi.registerMessageRenderer("pi-ui-custom-notice", () => new Text("PI_UI_CUSTOM_NOTICE", 0, 0));
		};
		const thirdPartyMsgPlugin: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerMessageRenderer("pi-ui-custom-notice", () => new Text("TP_CUSTOM_NOTICE", 0, 0));
			pi.registerMessageRenderer("tp-only-notice", () => new Text("TP_ADDITIVE_NOTICE", 0, 0));
			pi.registerCommand("show-notices", {
				handler: async () => {
					pi.sendMessage({ customType: "pi-ui-custom-notice", content: "Contended", display: true });
					pi.sendMessage({ customType: "tp-only-notice", content: "Additive", display: true });
				},
			});
		};

		harness = await createInteractiveHarness({
			agentDir,
			width: 108,
			height: 30,
			loadDefaultExtension: false,
			extensionFactories: [piUiWithCustomMsg, thirdPartyMsgPlugin],
		});

		await waitForCondition(() => harness!.screen().text().includes("Slot Arbitration"));
		const modalText = harness.screen().text();
		expect(modalText).toContain("Message Renderer pi-ui-custom-notice");
		expect(modalText).not.toContain("tp-only-notice");

		/* Переключаем messageRenderer на стороннего владельца клавишей → и Enter */
		await harness.pressKey("\x1b[C");
		await harness.pressKey("\r");
		await flushDeferredUi(harness);

		await harness.submitInput("/show-notices");
		expect(harness.screen().findText("TP_CUSTOM_NOTICE")).toBeDefined();
		expect(harness.screen().findText("TP_ADDITIVE_NOTICE")).toBeDefined();
		expect(harness.screen().findText("PI_UI_CUSTOM_NOTICE")).toBeUndefined();

		/* Живое обратное переключение на @conarti/pi-ui через /slots */
		await harness.submitInput("/slots messageRenderer:pi-ui-custom-notice @conarti/pi-ui");
		await flushDeferredUi(harness);
		await harness.submitInput("/show-notices");
		expect(harness.screen().findText("PI_UI_CUSTOM_NOTICE")).toBeDefined();
	});
});
