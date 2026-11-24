import { afterEach, describe, expect, it } from "vitest";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Spacer, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import conartiPiUi from "../src/index.ts";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";

function renderPlain(component: { render(width: number): readonly string[] }, width = 100): string {
	return component.render(width).map(stripTerminalSequences).join("\n");
}

function makeAssistantMessage(content: unknown[], extra: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	} as any;
}

describe("/silent mode transcript filtering", () => {
	let harness: ExtensionHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.runCommand("silent", "off");
			await harness.shutdownSession();
			harness = undefined;
		}
	});

	it("hides custom animated & collapsed ThinkingBlock, native MouseRegion thinking, intermediate turns, tool rows, and notices, then restores them when turned off", async () => {
		harness = createExtensionHarness({ theme: "dark", width: 100, height: 32 });
		harness.mount(conartiPiUi);
		await harness.startSession();

		const mdTheme = getMarkdownTheme();

		// 1. User prompt
		const userPrompt = new UserMessageComponent("Fix the login bug", mdTheme);

		// 2. Intermediate assistant turn with thinking + toolCall
		const intermediateTurn = new AssistantMessageComponent(
			makeAssistantMessage([
				{ type: "thinking", thinking: "Checking auth handler" },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "src/auth.ts" } },
			]),
			false,
			mdTheme,
		);

		// 3. Tool execution row
		const toolRow = new ToolExecutionComponent(
			"read",
			"tc-1",
			{ path: "src/auth.ts" },
			undefined,
			undefined,
			harness.tui.asTui(),
			harness.ctx.cwd,
		);

		// 4. Extension custom notice
		const customNotice = new CustomMessageComponent(
			{ role: "custom", customType: "ext-notice", content: "Content ready", display: true, timestamp: Date.now() },
			undefined,
			mdTheme,
		);

		// 5. Final assistant turn with collapsed custom ThinkingBlock + answer + stop notice
		const finalTurn = new AssistantMessageComponent(
			makeAssistantMessage(
				[
					{ type: "thinking", thinking: "Analyzing auth token validation" },
					{ type: "text", text: "Login bug is fixed." },
				],
				{ stopReason: "aborted", errorMessage: "Cancelled by user" },
			),
			false,
			mdTheme,
		);

		// 6. Streaming assistant turn with ONLY an animated custom ThinkingBlock
		const streamingThinkingTurn = new AssistantMessageComponent(undefined, false, mdTheme);
		streamingThinkingTurn.updateContent(
			makeAssistantMessage([{ type: "thinking", thinking: "Streaming deep reasoning..." }]),
			true,
		);

		// 7. Native MouseRegion thinking node + trailing spacer + answer
		const nativeThinkingTurn = new AssistantMessageComponent(undefined, false, mdTheme);
		const nativeContent = (nativeThinkingTurn as any).contentContainer;
		nativeContent.clear();
		nativeContent.addChild(new MouseRegion(new Text("Native thinking label", 1, 0), () => undefined));
		nativeContent.addChild(new Spacer(1));
		nativeContent.addChild(new Markdown("Native answer stays visible.", 2, 0, mdTheme));

		// 8. Chat-level status notice directly in chatContainer
		const chatNoticeSpacer = new Spacer(1);
		const chatNotice = new Text("Reloaded extensions", 1, 0);

		harness.tui.chatContainer.addChild(userPrompt);
		harness.tui.chatContainer.addChild(intermediateTurn);
		harness.tui.chatContainer.addChild(toolRow);
		harness.tui.chatContainer.addChild(customNotice);
		harness.tui.chatContainer.addChild(chatNoticeSpacer);
		harness.tui.chatContainer.addChild(chatNotice);
		harness.tui.chatContainer.addChild(finalTurn);
		harness.tui.chatContainer.addChild(streamingThinkingTurn);
		harness.tui.chatContainer.addChild(nativeThinkingTurn);

		// Baseline (silent OFF): thinking blocks, notices, and answers are all visible
		expect(renderPlain(finalTurn)).toContain("Thought");
		expect(renderPlain(finalTurn)).toContain("Login bug is fixed.");
		expect(renderPlain(finalTurn)).toContain("Cancelled by user");
		expect(renderPlain(streamingThinkingTurn)).toContain("Thinking…");
		expect(renderPlain(nativeThinkingTurn)).toContain("Native thinking label");
		expect(renderPlain(harness.tui.chatContainer)).toContain("Reloaded extensions");

		// Enable /silent
		await harness.runCommand("silent", "on");

		// User prompt stays visible
		expect(renderPlain(userPrompt)).toContain("Fix the login bug");

		// Intermediate assistant turn, tool row, and custom notice are completely hidden
		expect(intermediateTurn.render(100)).toEqual([]);
		expect(toolRow.render(100)).toEqual([]);
		expect(customNotice.render(100)).toEqual([]);

		// Final turn hides collapsed ThinkingBlock + stop notice, keeps only final answer
		const silentFinal = renderPlain(finalTurn);
		expect(silentFinal).toContain("Login bug is fixed.");
		expect(silentFinal).not.toContain("Thought");
		expect(silentFinal).not.toContain("Analyzing auth token validation");
		expect(silentFinal).not.toContain("Cancelled by user");

		// Streaming-only animated ThinkingBlock turn is completely hidden (no stray blank spacer)
		expect(streamingThinkingTurn.render(100)).toEqual([]);

		// Native MouseRegion thinking + spacer hidden, answer kept
		const silentNative = renderPlain(nativeThinkingTurn);
		expect(silentNative).toContain("Native answer stays visible.");
		expect(silentNative).not.toContain("Native thinking label");

		// Chat-level notices hidden in chatContainer render
		const silentChat = renderPlain(harness.tui.chatContainer);
		expect(silentChat).toContain("Fix the login bug");
		expect(silentChat).toContain("Login bug is fixed.");
		expect(silentChat).toContain("Native answer stays visible.");
		expect(silentChat).not.toContain("Reloaded extensions");
		expect(silentChat).not.toContain("Content ready");
		expect(silentChat).not.toContain("Thought");
		expect(silentChat).not.toContain("Thinking…");

		// Turn /silent OFF: full content is restored
		await harness.runCommand("silent", "off");

		expect(renderPlain(finalTurn)).toContain("Thought");
		expect(renderPlain(finalTurn)).toContain("Login bug is fixed.");
		expect(renderPlain(finalTurn)).toContain("Cancelled by user");
		expect(renderPlain(streamingThinkingTurn)).toContain("Thinking…");
		expect(renderPlain(nativeThinkingTurn)).toContain("Native thinking label");
		expect(toolRow.render(100).length).toBeGreaterThan(0);
		expect(customNotice.render(100).length).toBeGreaterThan(0);
		expect(renderPlain(harness.tui.chatContainer)).toContain("Reloaded extensions");
	});
});
