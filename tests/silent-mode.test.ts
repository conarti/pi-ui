import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Spacer, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderAnswerOnly } from "../src/features/tool-calls/silent.ts";
import { stopAllAnimations } from "../src/shared/animation-scheduler.ts";
import {
	createAssistantMessageEventStream,
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type AssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

const ZERO_USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("/silent mode transcript filtering (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		stopAllAnimations();
	});

	it("filters native MouseRegion thinking nodes and trailing spacers in renderAnswerOnly (pure Seam 2)", () => {
		const mdTheme = getMarkdownTheme();
		const contentContainer = new Container();
		contentContainer.addChild(new MouseRegion(new Text("Native thinking label", 1, 0), () => undefined));
		contentContainer.addChild(new Spacer(1));
		contentContainer.addChild(new Markdown("Native answer stays visible.", 2, 0, mdTheme));
		contentContainer.addChild(new Spacer(1));
		contentContainer.addChild(new Text("Trailing stop notice", 1, 0));

		const fullPlain = contentContainer.render(100).map(stripTerminalSequences).join("\n");
		expect(fullPlain).toContain("Native thinking label");
		expect(fullPlain).toContain("Native answer stays visible.");
		expect(fullPlain).toContain("Trailing stop notice");

		const filteredPlain = renderAnswerOnly(
			{ contentContainer },
			100,
			(w) => contentContainer.render(w),
		)
			.map(stripTerminalSequences)
			.join("\n");

		expect(filteredPlain).toContain("Native answer stays visible.");
		expect(filteredPlain).not.toContain("Native thinking label");
		expect(filteredPlain).not.toContain("Trailing stop notice");

		/* Исходный контейнер не мутируется необратимо и сохраняет все дочерние узлы после рендера */
		const afterPlain = contentContainer.render(100).map(stripTerminalSequences).join("\n");
		expect(afterPlain).toContain("Native thinking label");
		expect(afterPlain).toContain("Trailing stop notice");
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

		/* Базовое состояние (/silent off): видны блок размышлений, тул чтения, уведомления и ответ */
		const baselineText = harness.screen().text();
		expect(baselineText).toContain("Fix the login bug");
		expect(baselineText).toContain("Read src/auth.ts");
		expect(baselineText).toContain("Thought");
		expect(baselineText).toContain("Login bug is fixed.");
		expect(baselineText).toContain("Operation aborted");
		expect(baselineText).toContain("Extension custom notice ready");
		expect(baselineText).toContain("Chat status notice line");

		/* Включаем /silent on — в транскрипте остаются только промпт пользователя и финальный ответ */
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

		/* Запускаем стримящийся ход с одним только активным ThinkingBlock при включённом /silent */
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

		/* Выключаем /silent off — все скрытые карточки, размышления, тулы и уведомления возвращаются */
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
