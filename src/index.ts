import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserFeature } from "./features/ask-user/index.ts";
import { mountComposer } from "./features/chrome/composer.ts";
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

	// 1. Transcript cards: user prompts (`┃ ›`), two-tone code cards + Copy, wave Thinking, clean headings
	registerTranscriptFeature(pi);
	registerComposerWorkingAnimation(pi);
	registerPromptChipsFeature(pi);

	// 2. Compact / Claude / Codex tool call renderers, codemode summaries & silent mode
	registerToolCallsFeature(pi);

	// 3. Interactive ask_user_question questionnaire (compatible with non-capturing overlays)
	registerAskUserFeature(pi);

	// 4. Zero-fluff Plan Studio (line-pinned comments) & Auto-Safe mode
	registerPlanStudioFeature(pi);

	// 5. Command Palette (`Ctrl+K` / `/palette`) & Context Inspector (`/context`)
	registerCommandPaletteFeature(pi);

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
			const turnIndex = new TranscriptTurnIndex({
				shell,
				getBranch: () => ctx.sessionManager.getBranch(),
			});

			const stickyBar = new StickyPromptBar(shell, turnIndex, getStickyConfig());
			activeStickyBar = stickyBar;
			unsubscribeStickyKey = bindStickyExpandKey(ctx, shell, stickyBar);

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
		disposeActiveHostRuntime();
		resetUiActionBridge();
	});
}
