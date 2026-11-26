import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { withConartiInternalRegistration } from "../../shared/extension-superseder.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import {
	loadPiUiUserConfig,
	updatePiUiUserConfig,
} from "../../shared/pi-ui-config.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { t } from "../../shared/i18n.ts";
import {
	getActiveComposerEditor,
	registerFeatureComposerHooks,
	type ComposerHooks,
	type PiUiComposerEditor,
} from "../chrome/composer.ts";
import { getActivePromptChipRegistry } from "../prompt-chips/index.ts";
import {
	extractAssistantTextContent,
	MAX_PROMPT_SUGGESTION_LENGTH,
	PROMPT_SUGGESTION_INSTRUCTION,
	sanitizePromptSuggestion,
} from "./model.ts";
import {
	installExternalSuggestionSuperseder,
	isSupersededExternalSuggestionExtension,
} from "./supersede-external.ts";

export {
	extractAssistantTextContent,
	MAX_PROMPT_SUGGESTION_LENGTH,
	PROMPT_SUGGESTION_INSTRUCTION,
	sanitizePromptSuggestion,
} from "./model.ts";
export {
	installExternalSuggestionSuperseder,
	isSupersededExternalSuggestionExtension,
} from "./supersede-external.ts";

const SUGGESTIONS_MODES = ["on", "off"] as const;
const SUGGESTION_BRIDGE_KEY = Symbol.for("conarti.pi-ui.prompt-suggestion-bridge.v1");

interface PromptSuggestionBridge {
	hasActive(): boolean;
	accept(editor: PiUiComposerEditor): boolean;
	dismiss(): boolean;
}

function getSuggestionBridgeSlot(): { bridge?: PromptSuggestionBridge } {
	const g = globalThis as Record<symbol, { bridge?: PromptSuggestionBridge } | undefined>;
	if (!g[SUGGESTION_BRIDGE_KEY]) {
		g[SUGGESTION_BRIDGE_KEY] = {};
	}
	return g[SUGGESTION_BRIDGE_KEY]!;
}

export function hasActivePromptSuggestion(): boolean {
	return getSuggestionBridgeSlot().bridge?.hasActive() ?? false;
}

export function acceptActivePromptSuggestion(editor: PiUiComposerEditor): boolean {
	return getSuggestionBridgeSlot().bridge?.accept(editor) ?? false;
}

export function dismissActivePromptSuggestion(): boolean {
	return getSuggestionBridgeSlot().bridge?.dismiss() ?? false;
}

function resolveActiveTui() {
	return getActiveHostRuntime()?.tui ?? getActiveComposerEditor()?.getTui();
}

export function registerPromptSuggestionFeature(pi: ExtensionAPI): void {
	installExternalSuggestionSuperseder(pi);
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

	const suggestionComposerHooks: ComposerHooks = {
		hasDraftAttachments: () => getActivePromptChipRegistry().hasActiveDraftChips(),
		getEmptyPlaceholder: () => {
			if (!enabled || !activeSuggestion) return undefined;
			return loadPiUiUserConfig().showShortcutsBar
				? activeSuggestion
				: `${activeSuggestion} [Tab]`;
		},
		onEmptyPlaceholderClick: (editor) => {
			if (!enabled || !activeSuggestion) return false;
			const accepted = activeSuggestion;
			activeSuggestion = undefined;
			editor.acceptTextWithUndoSnapshot(accepted);
			return true;
		},
		interceptEmptyDraftInput: (data, editor) => {
			if (!enabled || !activeSuggestion) return false;
			if (matchesKey(data, "tab") || matchesKey(data, "right")) {
				const accepted = activeSuggestion;
				activeSuggestion = undefined;
				editor.acceptTextWithUndoSnapshot(accepted);
				return true;
			}
			if ((data === "\x1b" || matchesKey(data, "escape")) && editor.isSessionIdle()) {
				activeSuggestion = undefined;
				return true;
			}
			return false;
		},
	};

	getSuggestionBridgeSlot().bridge = {
		hasActive: () => Boolean(enabled && activeSuggestion),
		accept: (editor) => {
			if (!enabled || !activeSuggestion) return false;
			const accepted = activeSuggestion;
			activeSuggestion = undefined;
			editor.acceptTextWithUndoSnapshot(accepted);
			return true;
		},
		dismiss: () => {
			if (!activeSuggestion) return false;
			activeSuggestion = undefined;
			requestRender();
			return true;
		},
	};

	registerFeatureComposerHooks("prompt-suggestion", suggestionComposerHooks);

	withConartiInternalRegistration(() => {
		pi.registerCommand("suggestions", {
			description: t("suggestions.command"),
			getArgumentCompletions: (prefix) => {
				const typed = prefix.trimStart().toLowerCase();
				const items = SUGGESTIONS_MODES.filter(
					(choice) => choice.startsWith(typed) && choice !== typed.trimEnd(),
				).map((choice) => ({ value: choice, label: choice }));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const arg = args.trim().toLowerCase();
				if (arg !== "" && arg !== "on" && arg !== "off") {
					ctx.ui.notify(t("suggestions.usage"), "warning");
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
					t("suggestions.toggled", { state: enabled ? t("state.on") : t("state.off") }),
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
			registerFeatureComposerHooks("prompt-suggestion", suggestionComposerHooks);
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

			/* Запрос запускается в фоне без await, но после микротаска повторно проверяет модалки, открытые в agent_end */
			void (async () => {
				try {
					await Promise.resolve();
					const activeTui = resolveActiveTui();
					if (
						controller.signal.aborted ||
						!enabled ||
						ctx.hasPendingMessages() ||
						(activeTui && hasBlockingModalOverlay(activeTui))
					) {
						return;
					}

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

					const postStreamTui = resolveActiveTui();
					if (
						controller.signal.aborted ||
						!enabled ||
						answer.stopReason !== "stop" ||
						(postStreamTui && hasBlockingModalOverlay(postStreamTui))
					) {
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
