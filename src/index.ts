import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserFeature } from "./features/ask-user/index.ts";
import { mountComposer, setActiveComposerEditor } from "./features/chrome/composer.ts";
import { registerComposerWorkingAnimation } from "./features/chrome/working-indicator.ts";
import { mountSessionHeader } from "./features/chrome/header.ts";
import { registerCommandPaletteFeature } from "./features/command-palette/index.ts";
import { showContextInspector } from "./features/context-inspector/index.ts";
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
import { installKeyboardLayoutSupport } from "./shared/keyboard-layout.ts";
import { getSessionWorkflow } from "./shared/session-workflow.ts";
import { requestRender, resetUiActionBridge } from "./shared/ui-action-bridge.ts";
import { TranscriptTurnIndex } from "./shared/turn-index.ts";

export default function conartiPiUi(pi: ExtensionAPI): void {
	installKeyboardLayoutSupport(pi);

	// 0. Acquire shared Host Runtime once at session_start before feature listeners bind
	pi.on("session_start", async (_event, ctx) => {
		await acquireHostRuntime(ctx);
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

	/* 5. Command Palette (Ctrl+K / /palette) и фоновые Prompt Suggestion после модальных хуков */
	registerCommandPaletteFeature(pi);
	registerPromptSuggestionFeature(pi);

	pi.registerFlag("plan", {
		description: "Запустить сессию сразу в режиме Plan",
		type: "boolean",
		default: false,
	});

	pi.registerShortcut("alt+m", {
		description: "Переключить режим (Code / Plan / Auto-Safe)",
		handler: async (ctx) => cycleSessionMode(pi, ctx),
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Plan Mode / открыть Plan Studio",
		handler: async (ctx) => {
			const wf = getSessionWorkflow();
			if (wf.hasPlan()) await showPlanStudio(pi, ctx);
			else setSessionMode(pi, ctx, wf.mode === "plan" ? "code" : "plan");
		},
	});

	pi.registerCommand("context", {
		description: "Визуальный инспектор контекста, токенов и буфера компакта",
		handler: async (_args, ctx) => {
			await showContextInspector(pi, ctx);
		},
	});

	// 5. Fullscreen viewport shell: StickyPromptBar (top) + native ScrollView scrollbar + OutlineRail (right)
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

			const outlineRail = createOutlineRailSlot(ctx, shell, turnIndex);

			return {
				topSlot: stickyBar,
				rightRail: outlineRail,
			};
		});
	});

	pi.on("session_shutdown", () => {
		getSessionWorkflow().endAgentTurn();
		unsubscribeStickyKey?.();
		unsubscribeStickyKey = undefined;
		disposeShell?.();
		disposeShell = undefined;
		activeStickyBar = undefined;
		setActiveComposerEditor(undefined);
		disposeActiveHostRuntime();
		resetUiActionBridge();
	});
}
