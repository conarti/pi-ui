import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { stopAllAnimations } from "../../shared/animation-scheduler.ts";
import { clearHoverExcept } from "../../shared/runtime-hooks.ts";
import { hideSkillPreviewPopup, isSkillPreviewPopupVisible } from "../../shared/skill-tags.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { hideLinkTargetPopup, isLinkTargetPopupVisible } from "./link-target-popup.ts";
import { clearMarkdownCopyTimers, installMarkdownCardsAndHeadings } from "./markdown-cards.ts";
import {
	clearRecordedThinkingTimings,
	installAssistantTranscriptBlocks,
	noteThinkingTurnStart,
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

	let unsubscribePopupInput: (() => void) | undefined;

	pi.on("session_start", async (event, ctx) => {
		unsubscribePopupInput?.();
		unsubscribePopupInput = undefined;
		hideSkillPreviewPopup();
		hideLinkTargetPopup();
		if (event.reason !== "reload") {
			clearRecordedThinkingTimings();
			resetGlobalThinkingExpandState();
		}
		if (ctx.mode === "tui" && ctx.hasUI) {
			unsubscribePopupInput = ctx.ui.onTerminalInput((data) => {
				if (
					!isKeyRelease(data) &&
					(data === "\x1b" || matchesKey(data, "escape")) &&
					(isSkillPreviewPopupVisible() || isLinkTargetPopupVisible())
				) {
					hideSkillPreviewPopup();
					hideLinkTargetPopup();
					requestRender();
					return { consume: true };
				}
				return undefined;
			});
		}
	});

	pi.on("agent_start", async () => {
		noteThinkingTurnStart();
	});

	pi.on("turn_start", async () => {
		noteThinkingTurnStart();
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
		unsubscribePopupInput?.();
		unsubscribePopupInput = undefined;
		hideSkillPreviewPopup();
		hideLinkTargetPopup();
		stopThinkingWave();
		stopAllAnimations();
		clearRecordedThinkingTimings();
		resetGlobalThinkingExpandState();
		clearPendingUserMessageTimestamps();
		clearUserPromptCopyTimers();
		clearMarkdownCopyTimers();
		clearHoverExcept(undefined);
	});
}
