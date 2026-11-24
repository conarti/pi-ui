import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearHoverExcept } from "../../shared/runtime-hooks.ts";
import { installMarkdownCardsAndHeadings } from "./markdown-cards.ts";
import {
	installAssistantTranscriptBlocks,
	startThinkingWave,
	stopThinkingWave,
} from "./thinking-block.ts";
import { installUserPromptCards } from "./user-prompt.ts";

export function registerTranscriptFeature(pi: ExtensionAPI): void {
	installMarkdownCardsAndHeadings();
	installUserPromptCards();
	installAssistantTranscriptBlocks();

	pi.on("agent_start", async () => {
		startThinkingWave();
	});

	pi.on("agent_end", async () => {
		stopThinkingWave();
	});

	pi.on("session_shutdown", async () => {
		stopThinkingWave();
		clearHoverExcept(undefined);
	});
}
