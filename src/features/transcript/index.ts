import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stopAllAnimations } from "../../shared/animation-scheduler.ts";
import { clearHoverExcept } from "../../shared/runtime-hooks.ts";
import { installMarkdownCardsAndHeadings } from "./markdown-cards.ts";
import {
	clearRecordedThinkingTimings,
	installAssistantTranscriptBlocks,
	observeAssistantThinkingMessage,
	stopThinkingWave,
} from "./thinking-block.ts";
import { installUserPromptCards } from "./user-prompt.ts";

export function registerTranscriptFeature(pi: ExtensionAPI): void {
	installMarkdownCardsAndHeadings();
	installUserPromptCards();
	installAssistantTranscriptBlocks();

	pi.on("session_start", async (event) => {
		if (event.reason !== "reload") {
			clearRecordedThinkingTimings();
		}
	});

	pi.on("message_start", async (event) => {
		observeAssistantThinkingMessage(event.message, true);
	});

	pi.on("message_update", async (event) => {
		observeAssistantThinkingMessage(event.message, true, event.assistantMessageEvent);
	});

	pi.on("message_end", async (event) => {
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
		clearHoverExcept(undefined);
	});
}
