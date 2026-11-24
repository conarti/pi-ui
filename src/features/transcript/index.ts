import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearHoverExcept } from "../../shared/runtime-hooks.ts";
import { installMarkdownCardsAndHeadings } from "./markdown-cards.ts";
import {
	installAssistantTranscriptBlocks,
	startThinkingWave,
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

	pi.on("message_start", async (event: any) => {
		if (event?.message?.role === "user") {
			recordPendingUserMessageTimestamp(event.message.timestamp ?? Date.now());
		}
	});

	pi.on("message_end", async (event: any) => {
		if (event?.message?.role === "user") {
			clearPendingUserMessageTimestamps();
		}
	});

	pi.on("agent_start", async () => {
		startThinkingWave();
	});

	pi.on("agent_end", async () => {
		stopThinkingWave();
	});

	pi.on("agent_settled", async () => {
		stopThinkingWave();
	});

	pi.on("session_shutdown", async () => {
		stopThinkingWave();
		clearPendingUserMessageTimestamps();
		clearUserPromptCopyTimers();
		clearHoverExcept(undefined);
	});
}
