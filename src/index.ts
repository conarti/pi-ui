import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserFeature } from "./features/ask-user/index.ts";
import {
	getActiveComposerEditor,
	mountComposer,
	setActiveComposerEditor,
} from "./features/chrome/composer.ts";
import {
	closeActiveComposerPopover,
	openComposerPopover,
} from "./features/chrome/composer-popovers.ts";
import { resetMidTurnQueueUi } from "./features/chrome/mid-turn-queue.ts";
import { disposeShortcutsBar, mountShortcutsBar } from "./features/chrome/shortcuts-bar.ts";
import { registerComposerWorkingAnimation } from "./features/chrome/working-indicator.ts";
import { createPinnedSessionHeaderSlot, mountSessionHeader } from "./features/chrome/header.ts";
import { registerCommandPaletteFeature } from "./features/command-palette/index.ts";
import { registerContextInspectorFeature } from "./features/context-inspector/index.ts";
import { createOutlineRailSlot, registerOutlineCommands } from "./features/outline-rail/index.ts";
import {
	applyModeTools,
	cycleSessionMode,
	registerPlanStudioFeature,
	setSessionMode,
	updatePlanWidget,
} from "./features/plan-studio/index.ts";
import { showPlanStudio } from "./features/plan-studio/studio-overlay.ts";
import {
	bindStickyExpandKey,
	getStickyConfig,
	registerStickyPromptCommands,
	StickyPromptBar,
} from "./features/sticky-prompt/index.ts";
import { registerToolCallsFeature } from "./features/tool-calls/index.ts";
import { registerPromptChipsFeature } from "./features/prompt-chips/index.ts";
import { registerPromptSuggestionFeature } from "./features/prompt-suggestion/index.ts";
import { registerQuotesFeature } from "./features/quotes/index.ts";
import { registerTranscriptFeature } from "./features/transcript/index.ts";
import { acquireHostRuntime, disposeActiveHostRuntime } from "./shared/host-runtime.ts";
import { t } from "./shared/i18n.ts";
import {
	installKeyboardLayoutSupport,
	registerOptionShortcutChord,
} from "./shared/keyboard-layout.ts";
import { loadPiUiUserConfig, updatePiUiUserConfig } from "./shared/pi-ui-config.ts";
import {
	getSessionWorkflow,
	syncThinkingCycleKeybinding,
} from "./shared/session-workflow.ts";
import { requestRender, resetUiActionBridge } from "./shared/ui-action-bridge.ts";
import { TranscriptTurnIndex } from "./shared/turn-index.ts";

function registerUnifiedConfigCommands(pi: ExtensionAPI): void {
	const toggleChoices = ["on", "off", "status"] as const;
	pi.registerCommand("shortcuts-bar", {
		description: t("shortcutsBar.command"),
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const items = toggleChoices
				.filter((choice) => choice.startsWith(typed) && choice !== typed.trimEnd())
				.map((choice) => ({ value: choice, label: choice }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				const current = loadPiUiUserConfig().showShortcutsBar;
				ctx.ui.notify(
					t("shortcutsBar.status", { state: current ? t("state.on") : t("state.off") }),
					"info",
				);
				return;
			}
			if (arg !== "" && arg !== "on" && arg !== "off") {
				ctx.ui.notify(t("shortcutsBar.usage"), "warning");
				return;
			}
			const current = loadPiUiUserConfig().showShortcutsBar;
			const next = arg === "on" ? true : arg === "off" ? false : !current;
			const updated = updatePiUiUserConfig({ showShortcutsBar: next });
			requestRender();
			ctx.ui.notify(
				t("shortcutsBar.toggled", {
					state: updated.showShortcutsBar ? t("state.on") : t("state.off"),
				}),
				"info",
			);
		},
	});

	pi.registerCommand("slots", {
		description: t("slots.command"),
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const choices = ["status", "clear"];
			const items = choices
				.filter((choice) => choice.startsWith(typed) && choice !== typed.trimEnd())
				.map((choice) => ({ value: choice, label: choice }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const parts = trimmed ? trimmed.split(/\s+/) : [];
			const sub = parts[0]?.toLowerCase() ?? "";

			if (sub === "" || sub === "status") {
				const owners = loadPiUiUserConfig().slotOwners;
				const pairs = Object.entries(owners);
				if (pairs.length === 0) {
					ctx.ui.notify(t("slots.empty"), "info");
				} else {
					ctx.ui.notify(
						t("slots.status", {
							entries: pairs.map(([slot, owner]) => `${slot}=${owner}`).join(", "),
						}),
						"info",
					);
				}
				return;
			}

			if (sub === "clear" || sub === "reset") {
				updatePiUiUserConfig({ slotOwners: {} });
				mountShortcutsBar(pi, ctx);
				requestRender();
				ctx.ui.notify(t("slots.cleared"), "info");
				return;
			}

			if (parts.length === 2) {
				const [slot, owner] = parts as [string, string];
				const existing = loadPiUiUserConfig().slotOwners;
				updatePiUiUserConfig({ slotOwners: { ...existing, [slot]: owner } });
				if (slot === "footer") {
					mountShortcutsBar(pi, ctx);
				}
				requestRender();
				ctx.ui.notify(t("slots.updated", { slot, owner }), "info");
				return;
			}

			ctx.ui.notify(t("slots.usage"), "warning");
		},
	});
}

export default function conartiPiUi(pi: ExtensionAPI): void {
	/* Синхронизируем app.thinking.cycle -> alt+t до чтения keybindings.json в InteractiveMode */
	syncThinkingCycleKeybinding();
	installKeyboardLayoutSupport(pi);
	registerOptionShortcutChord("alt+t");

	/* 0. Получаем общий Host Runtime один раз при session_start до подписки фич */
	pi.on("session_start", async (_event, ctx) => {
		const synced = syncThinkingCycleKeybinding();
		const runtime = await acquireHostRuntime(ctx);
		if (synced) {
			runtime?.keybindings?.reload?.();
		}
	});

	/* 1. Карточки транскрипта, волновая анимация, Prompt Chips и цитаты */
	registerTranscriptFeature(pi);
	registerComposerWorkingAnimation(pi);
	registerPromptChipsFeature(pi);
	registerQuotesFeature(pi);

	/* 2. Рендереры вызовов тулов, сводки codemode и тихий режим */
	registerToolCallsFeature(pi);

	/* 3. Интерактивный опросник ask_user_question */
	registerAskUserFeature(pi);

	/* 4. Режим планирования с построчными комментариями и защита вызовов тулов */
	registerPlanStudioFeature(pi);

	/* 5. Command Palette (Ctrl+K / /palette), телеметрия + Context Inspector, конфиг-команды и Prompt Suggestion */
	registerCommandPaletteFeature(pi);
	registerContextInspectorFeature(pi);
	registerUnifiedConfigCommands(pi);
	registerPromptSuggestionFeature(pi);

	pi.registerFlag("plan", {
		description: t("sessionMode.flag.plan"),
		type: "boolean",
		default: false,
	});

	pi.registerShortcut("shift+tab", {
		description: t("sessionMode.shortcut.cycle"),
		handler: async (ctx) => cycleSessionMode(pi, ctx),
	});

	pi.registerShortcut("alt+m", {
		description: t("sessionMode.shortcut.cycle"),
		handler: async (ctx) => openComposerPopover(pi, ctx, "mode"),
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: t("sessionMode.shortcut.planStudio"),
		handler: async (ctx) => {
			const wf = getSessionWorkflow();
			if (wf.hasPlan()) await showPlanStudio(pi, ctx);
			else setSessionMode(pi, ctx, wf.mode === "plan" ? "always-approve" : "plan");
		},
	});

	/* 6. Оболочка fullscreen viewport: StickyPromptBar (сверху) и OutlineRail (справа) */
	let activeStickyBar: StickyPromptBar | undefined;
	let disposeShell: (() => void) | undefined;
	let unsubscribeStickyKey: (() => void) | undefined;

	registerStickyPromptCommands(pi, () => activeStickyBar);
	registerOutlineCommands(pi, () => requestRender());

	const refreshViewport = () => requestRender();
	const resetViewport = () => {
		activeStickyBar?.reset();
		refreshViewport();
	};

	pi.on("message_start", refreshViewport);
	pi.on("message_update", refreshViewport);
	pi.on("message_end", refreshViewport);
	pi.on("agent_end", refreshViewport);
	pi.on("session_tree", resetViewport);
	pi.on("session_compact", resetViewport);

	pi.on("session_start", async (event, ctx) => {
		unsubscribeStickyKey?.();
		unsubscribeStickyKey = undefined;
		disposeShell?.();
		disposeShell = undefined;
		activeStickyBar = undefined;

		const wf = getSessionWorkflow();
		const entries = ctx.sessionManager.getEntries?.() ?? [];
		const { restored } = wf.restore(entries, pi.getFlag("plan") === true);

		applyModeTools(pi, wf.mode, {
			inferMissingOnPlanRestore: restored || event.reason === "reload",
		});
		if (!restored && wf.mode === "plan" && (wf.withheldWriteTools?.length ?? 0) > 0) {
			wf.persist(pi);
		}
		mountSessionHeader(pi, ctx);
		mountComposer(pi, ctx);
		mountShortcutsBar(pi, ctx);
		updatePlanWidget(pi, ctx);

		const hostRuntime = await acquireHostRuntime(ctx);
		disposeShell = hostRuntime?.mountViewportSlots((shell) => {
			unsubscribeStickyKey?.();
			unsubscribeStickyKey = undefined;

			const turnIndex = new TranscriptTurnIndex({
				shell,
				getBranch: () => ctx.sessionManager.getBranch(),
			});

			const stickyBar = new StickyPromptBar(shell, turnIndex, getStickyConfig());
			activeStickyBar = stickyBar;
			const unbindKey = bindStickyExpandKey(ctx, shell, stickyBar);
			unsubscribeStickyKey = unbindKey;

			const origStickyDispose = stickyBar.dispose.bind(stickyBar);
			stickyBar.dispose = () => {
				unbindKey();
				if (unsubscribeStickyKey === unbindKey) {
					unsubscribeStickyKey = undefined;
				}
				if (activeStickyBar === stickyBar) {
					activeStickyBar = undefined;
				}
				origStickyDispose();
			};

			const pinnedHeader = createPinnedSessionHeaderSlot(pi, ctx);
			const outlineRail = createOutlineRailSlot(ctx, shell, turnIndex);

			return {
				pinnedHeader,
				topSlot: stickyBar,
				rightRail: outlineRail,
			};
		});
	});

	pi.on("session_shutdown", () => {
		closeActiveComposerPopover();
		resetMidTurnQueueUi();
		disposeShortcutsBar();
		getSessionWorkflow().endAgentTurn();
		unsubscribeStickyKey?.();
		unsubscribeStickyKey = undefined;
		disposeShell?.();
		disposeShell = undefined;
		activeStickyBar = undefined;
		getActiveComposerEditor()?.dispose();
		setActiveComposerEditor(undefined);
		disposeActiveHostRuntime();
		resetUiActionBridge();
	});
}
