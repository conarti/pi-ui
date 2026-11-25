import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import {
	loadPiUiUserConfig,
	updatePiUiUserConfig,
} from "../../shared/pi-ui-config.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import {
	getActiveComposerEditor,
	registerComposerPromptSuggestionBridge,
	type ComposerPromptSuggestionBridge,
} from "../chrome/composer.ts";
import { getActivePromptChipRegistry } from "../prompt-chips/index.ts";
import { withConartiInternalRegistration } from "../quotes/supersede-quote-blocks.ts";
import {
	extractAssistantTextContent,
	MAX_PROMPT_SUGGESTION_LENGTH,
	PROMPT_SUGGESTION_INSTRUCTION,
	sanitizePromptSuggestion,
} from "./model.ts";
import {
	installNextPromptSuperseder,
	isSupersededNextPromptExtension,
} from "./supersede-next-prompt.ts";

export {
	extractAssistantTextContent,
	MAX_PROMPT_SUGGESTION_LENGTH,
	PROMPT_SUGGESTION_INSTRUCTION,
	sanitizePromptSuggestion,
} from "./model.ts";
export {
	installNextPromptSuperseder,
	isSupersededNextPromptExtension,
} from "./supersede-next-prompt.ts";

const SUGGESTIONS_MODES = ["on", "off", "status"] as const;
const SUGGESTIONS_USAGE = "Использование: /suggestions [on|off]";

function resolveActiveTui() {
	return getActiveHostRuntime()?.tui ?? getActiveComposerEditor()?.getTui();
}

export function registerPromptSuggestionFeature(pi: ExtensionAPI): void {
	installNextPromptSuperseder(pi);
	let enabled = loadPiUiUserConfig().promptSuggestions;
	let activeSuggestion: string | undefined;
	let lastRequest: AgentMessage[] = [];
	let pendingController: AbortController | undefined;

	const clearPromptSuggestion = (options?: { resetContextPrefix?: boolean }): void => {
		pendingController?.abort();
		pendingController = undefined;
		if (options?.resetContextPrefix) {
			lastRequest = [];
		}
		if (activeSuggestion !== undefined) {
			activeSuggestion = undefined;
			requestRender();
		}
	};

	const bridge: ComposerPromptSuggestionBridge = {
		getSuggestion: () => (enabled ? activeSuggestion : undefined),
		hasActivePromptChips: () => getActivePromptChipRegistry().hasActiveDraftChips(),
		acceptSuggestion: () => {
			if (!enabled || !activeSuggestion) return undefined;
			const accepted = activeSuggestion;
			activeSuggestion = undefined;
			return accepted;
		},
		dismissSuggestion: () => {
			if (!activeSuggestion) return false;
			activeSuggestion = undefined;
			return true;
		},
	};

	registerComposerPromptSuggestionBridge(bridge);

	withConartiInternalRegistration(() => {
		pi.registerCommand("suggestions", {
			description: "Включить или выключить Prompt Suggestion (/suggestions [on|off])",
			getArgumentCompletions: (prefix) => {
				const typed = prefix.trimStart().toLowerCase();
				const items = SUGGESTIONS_MODES.filter(
					(choice) => choice.startsWith(typed) && choice !== typed.trimEnd(),
				).map((choice) => ({ value: choice, label: choice }));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const arg = args.trim().toLowerCase();
				if (arg === "status") {
					enabled = loadPiUiUserConfig().promptSuggestions;
					ctx.ui.notify(
						`Prompt Suggestion: ${enabled ? "включены (on)" : "выключены (off)"}`,
						"info",
					);
					return;
				}
				if (arg !== "" && arg !== "on" && arg !== "off") {
					ctx.ui.notify(SUGGESTIONS_USAGE, "warning");
					return;
				}

				const current = loadPiUiUserConfig().promptSuggestions;
				const next = arg === "on" ? true : arg === "off" ? false : !current;
				enabled = updatePiUiUserConfig({ promptSuggestions: next }).promptSuggestions;
				if (!enabled) {
					clearPromptSuggestion();
				} else {
					requestRender();
				}
				ctx.ui.notify(
					`Prompt Suggestion: ${enabled ? "включены (on)" : "выключены (off)"}`,
					"info",
				);
			},
		});

		pi.on("context_with_system", async (event) => {
			lastRequest = event.messages;
		});

		pi.on("agent_start", async () => {
			clearPromptSuggestion();
		});

		pi.on("session_tree", async () => {
			clearPromptSuggestion({ resetContextPrefix: true });
		});

		pi.on("session_compact", async () => {
			clearPromptSuggestion({ resetContextPrefix: true });
		});

		pi.on("input", async () => {
			clearPromptSuggestion();
			return { action: "continue" };
		});

		pi.on("user_bash", async () => {
			clearPromptSuggestion();
		});

		pi.on("session_start", async (event) => {
			enabled = loadPiUiUserConfig().promptSuggestions;
			registerComposerPromptSuggestionBridge(bridge);
			if (event.reason !== "reload") {
				clearPromptSuggestion({ resetContextPrefix: true });
			} else if (!enabled) {
				clearPromptSuggestion();
			}
		});

		pi.on("session_shutdown", async () => {
			clearPromptSuggestion({ resetContextPrefix: true });
		});

		pi.on("agent_end", async (event, ctx: ExtensionContext) => {
			if (!enabled || ctx.mode !== "tui" || !ctx.hasUI || !ctx.model) return;
			const reply = event.messages.at(-1);
			if (!reply || reply.role !== "assistant" || reply.stopReason !== "stop") return;
			if (ctx.hasPendingMessages()) return;
			const tui = resolveActiveTui();
			if (tui && hasBlockingModalOverlay(tui)) return;

			pendingController?.abort();
			const controller = new AbortController();
			pendingController = controller;

			const model = ctx.model;
			const level = pi.getThinkingLevel();
			const reasoning = model.reasoning && level !== "off" ? level : undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			const requestPrefix = [...lastRequest];
			const suggestionPrompt: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: PROMPT_SUGGESTION_INSTRUCTION }],
				timestamp: Date.now(),
			};

			/* Запрос запускается в фоне без await, чтобы индикатор работы Pi погас сразу по завершении ответа ассистента */
			void (async () => {
				try {
					const context = normalizeContext({
						messages: convertToLlm([...requestPrefix, reply, suggestionPrompt]),
					});
					const answer = await ctx.modelRegistry
						.streamSimple(model, context, {
							reasoning,
							maxTokens: 2000,
							sessionId,
							signal: controller.signal,
						})
						.result();

					if (controller.signal.aborted || !enabled || answer.stopReason !== "stop") {
						return;
					}
					const cleaned = sanitizePromptSuggestion(
						extractAssistantTextContent(answer.content),
					);
					if (!cleaned) return;

					activeSuggestion = cleaned;
					requestRender();
				} catch {
					/* Ошибки фонового предсказания намеренно игнорируются без уведомлений */
				} finally {
					if (pendingController === controller) {
						pendingController = undefined;
					}
				}
			})();
		});
	});
}
