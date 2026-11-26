export {
	captureTerminalScreen,
	parseTerminalFrame,
	type CapturableTerminalTarget,
	type FrameRenderableTarget,
	type InlineImagePlacement,
	type TerminalCell,
	type TerminalColor,
	type TerminalScreenSnapshot,
} from "./terminal-screen.ts";
export {
	contentText,
	createAgentSession,
	createAssistantMessageEventStream,
	createInteractiveHarness,
	DEFAULT_EXTENSION_ENTRY,
	DEFAULT_THEMES_DIR,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	formatSgrMouse,
	getCurrentSystemPrompt,
	getCurrentTools,
	loadPackageThemes,
	registerFauxProvider,
	REPO_ROOT,
	SessionManager,
	VirtualTerminal,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type CustomStreamSimpleHandler,
	type FauxContentBlock,
	type FauxModelDefinition,
	type FauxProviderHandle,
	type FauxProviderState,
	type FauxResponseFactory,
	type FauxResponseStep,
	type FileEntry,
	type InteractiveHarness,
	type InteractiveHarnessOptions,
	type MouseButtonName,
	type MouseModifiers,
	type MutableClipboardState,
	type RecordedExternalOpen,
	type RecordedFauxCall,
	type SessionEntry,
	type SimpleStreamOptions,
	type TranscriptContext,
	type VirtualTerminalOptions,
} from "./interactive-harness.ts";

import type { InteractiveHarness, SessionEntry } from "./interactive-harness.ts";

export const ZERO_USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

export async function waitForCondition(
	predicate: () => boolean,
	timeoutMs = 1500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

export function findComposerTopRow(harness: InteractiveHarness): number {
	const screen = harness.screen();
	for (let r = screen.height - 1; r >= 0; r -= 1) {
		if (screen.cellAt(r, 0)?.char === "╭") {
			return r;
		}
	}
	throw new Error(`Composer top border row not found in:\n${screen.text()}`);
}

export function makeUserEntry(
	id: string,
	parentId: string | null,
	text: string,
	tsMs: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(tsMs).toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: tsMs,
		},
	};
}

export function makeAssistantEntry(
	id: string,
	parentId: string | null,
	text: string,
	tsMs: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(tsMs).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: tsMs,
		},
	};
}

