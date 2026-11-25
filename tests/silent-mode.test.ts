import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import {
	createAssistantMessageEventStream,
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	ZERO_USAGE,
	type AssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

describe("/silent mode transcript filtering (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		stopAllAnimations();
	});

	it("filters collapsed Thinking headers and trailing error/stop notices in real InteractiveMode without mutating the underlying message container", async () => {
		harness = await createInteractiveHarness({
			theme: "dark",
			width: 104,
			height: 30,
			thinkingLevel: "medium",
			responses: [
				fauxAssistantMessage(
					[
						fauxThinking("Internal reasoning block"),
						{ type: "text", text: "Native answer stays visible." },
					],
					{ stopReason: "aborted", errorMessage: "Cancelled" },
				),
			],
		});

		await harness.submitInput("Check answer-only filtering");

		const fullText = harness.screen().text();
		expect(fullText).toContain("Thought");
		expect(fullText).toContain("Native answer stays visible.");
		expect(fullText).toContain("Operation aborted");

		await harness.submitInput("/silent on");
		const silentText = harness.screen().text();
		expect(silentText).toContain("Native answer stays visible.");
		expect(silentText).not.toContain("Thought");
		expect(silentText).not.toContain("Operation aborted");

		await harness.submitInput("/silent off");
		const restoredText = harness.screen().text();
		expect(restoredText).toContain("Thought");
		expect(restoredText).toContain("Native answer stays visible.");
		expect(restoredText).toContain("Operation aborted");
	});

	it("hides animated & collapsed ThinkingBlock, intermediate turns, tool rows, custom messages, and status notices in real InteractiveMode, then restores them on /silent off", async () => {
		let pendingStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		let resolveStreamReady: (() => void) | undefined;

		harness = await createInteractiveHarness({
			theme: "dark",
			width: 110,
			height: 38,
			thinkingLevel: "medium",
			extensionFactories: [
				(pi) => {
					pi.registerCommand("emit-test-notices", {
						description: "Emit custom message and UI status notice for silent-mode test",
						handler: async (_args, ctx) => {
							pi.sendMessage({
								customType: "ext-notice",
								content: "Extension custom notice ready",
								display: true,
							});
							ctx.ui.notify("Chat status notice line", "info");
						},
					});
				},
			],
			responses: [
				fauxAssistantMessage(
					[
						fauxThinking("Checking auth handler"),
						fauxToolCall("read", { path: "src/auth.ts" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxThinking("Analyzing auth token validation"),
						{ type: "text", text: "Login bug is fixed." },
					],
					{ stopReason: "aborted", errorMessage: "Cancelled by user" },
				),
			],
		});

		writeFileSync(join(harness.cwd, "auth-fixture.txt"), "ok\n", "utf8");
		writeFileSync(join(harness.cwd, "src-auth.ts"), "export const auth = true;\n", "utf8");
		await harness.session.executeBash("mkdir -p src && cp src-auth.ts src/auth.ts");

		await harness.submitInput("Fix the login bug");
		await harness.submitInput("/emit-test-notices");

		const baselineText = harness.screen().text();
		expect(baselineText).toContain("Fix the login bug");
		expect(baselineText).toContain("Read src/auth.ts");
		expect(baselineText).toContain("Thought");
		expect(baselineText).toContain("Login bug is fixed.");
		expect(baselineText).toContain("Operation aborted");
		expect(baselineText).toContain("Extension custom notice ready");
		expect(baselineText).toContain("Chat status notice line");

		await harness.submitInput("/silent on");
		const silentText = harness.screen().text();
		expect(silentText).toContain("Fix the login bug");
		expect(silentText).toContain("Login bug is fixed.");
		expect(silentText).not.toContain("Read src/auth.ts");
		expect(silentText).not.toContain("Thought");
		expect(silentText).not.toContain("Analyzing auth token validation");
		expect(silentText).not.toContain("Operation aborted");
		expect(silentText).not.toContain("Extension custom notice ready");
		expect(silentText).not.toContain("Chat status notice line");

		const streamReady = new Promise<void>((resolve) => {
			resolveStreamReady = resolve;
		});
		harness.setStreamSimple((_m, _c, opts) => {
			const st = createAssistantMessageEventStream();
			pendingStream = st;
			opts?.signal?.addEventListener(
				"abort",
				() => {
					const aborted: AssistantMessage = {
						role: "assistant",
						content: [],
						api: "faux",
						provider: "faux",
						model: "faux-1",
						usage: ZERO_USAGE,
						stopReason: "aborted",
						timestamp: Date.now(),
					};
					st.push({ type: "error", reason: "aborted", error: aborted });
					st.end(aborted);
				},
				{ once: true },
			);
			resolveStreamReady?.();
			return st;
		});

		const streamingTurn = harness.submitInput("Second silent question");
		await streamReady;

		const ts = Date.now();
		const partialMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Streaming deep reasoning..." }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: ts,
		};
		pendingStream!.push({ type: "start", partial: { ...partialMsg, content: [] } });
		pendingStream!.push({ type: "thinking_start", contentIndex: 0, partial: partialMsg });
		pendingStream!.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Streaming deep reasoning...",
			partial: partialMsg,
		});
		await harness.flush();

		const midSilentText = harness.screen().text();
		expect(midSilentText).toContain("Second silent question");
		expect(midSilentText).not.toContain("Thinking…");
		expect(midSilentText).not.toContain("Streaming deep reasoning");

		const doneMsg: AssistantMessage = {
			...partialMsg,
			content: [
				{ type: "thinking", thinking: "Streaming deep reasoning..." },
				{ type: "text", text: "Second concise answer." },
			],
		};
		pendingStream!.push({
			type: "thinking_end",
			contentIndex: 0,
			content: "Streaming deep reasoning...",
			partial: partialMsg,
		});
		pendingStream!.push({ type: "done", reason: "stop", message: doneMsg });
		pendingStream!.end(doneMsg);
		await streamingTurn;

		expect(harness.screen().text()).toContain("Second concise answer.");
		expect(harness.screen().text()).not.toContain("Thought");

		await harness.submitInput("/silent off");
		const restoredText = harness.screen().text();
		expect(restoredText).toContain("Read src/auth.ts");
		expect(restoredText).toContain("Thought");
		expect(restoredText).toContain("Login bug is fixed.");
		expect(restoredText).toContain("Operation aborted");
		expect(restoredText).toContain("Extension custom notice ready");
		expect(restoredText).toContain("Chat status notice line");
		expect(restoredText).toContain("Second concise answer.");
	});
});
