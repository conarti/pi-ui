import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stopAllAnimations } from "../../shared/animation-scheduler.ts";
import { clearHoverExcept } from "../../shared/runtime-hooks.ts";
import { clearMarkdownCopyTimers, installMarkdownCardsAndHeadings } from "./markdown-cards.ts";
import {
	clearRecordedThinkingTimings,
	installAssistantTranscriptBlocks,
	observeAssistantThinkingMessage,
	resetGlobalThinkingExpandState,
	stopThinkingWave,
} from "./thinking-block.ts";
import {
	clearPendingUserMessageTimestamps,
	clearUserPromptCopyTimers,
	installUserPromptCards,
	recordPendingUserMessageTimestamp,
} from "./user-prompt.ts";

export function registerTranscriptFeature(pi: ExtensionAPI): void {
	installMarkdownCardsAndHeadings();
	installUserPromptCards();
	installAssistantTranscriptBlocks();

	pi.on("session_start", async (event) => {
		if (event.reason !== "reload") {
			clearRecordedThinkingTimings();
			resetGlobalThinkingExpandState();
		}
	});

	pi.on("message_start", async (event: any) => {
		if (event?.message?.role === "user") {
			recordPendingUserMessageTimestamp(event.message.timestamp ?? Date.now());
		}
		observeAssistantThinkingMessage(event.message, true);
	});

	pi.on("message_update", async (event) => {
		observeAssistantThinkingMessage(event.message, true, event.assistantMessageEvent);
	});

	pi.on("message_end", async (event: any) => {
		if (event?.message?.role === "user") {
			clearPendingUserMessageTimestamps();
		}
		observeAssistantThinkingMessage(event.message, false);
	});

	pi.on("agent_end", async () => {
		stopThinkingWave();
		stopAllAnimations();
	});

	pi.on("agent_settled", async () => {
		stopThinkingWave();
		stopAllAnimations();
	});

	pi.on("session_shutdown", async () => {
		stopThinkingWave();
		stopAllAnimations();
		clearRecordedThinkingTimings();
		clearPendingUserMessageTimestamps();
		clearUserPromptCopyTimers();
		clearMarkdownCopyTimers();
		clearHoverExcept(undefined);
	});
}
