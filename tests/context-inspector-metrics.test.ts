import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LEGACY_STAMP_ENTRY_TYPE,
	METRICS_ENTRY_TYPE,
	type ResponseMetricsData,
} from "../src/features/context-inspector/telemetry.ts";
import { getActiveHostRuntime } from "../src/shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../src/shared/modal-card.ts";
import {
	createAssistantMessageEventStream,
	createInteractiveHarness,
	DEFAULT_EXTENSION_ENTRY,
	fauxAssistantMessage,
	makeAssistantEntry,
	makeUserEntry,
	type AssistantMessage,
	type InteractiveHarness,
} from "./harness/index.ts";

function makeStreamAssistant(
	content: AssistantMessage["content"],
	opts: {
		timestamp: number;
		stopReason?: AssistantMessage["stopReason"];
		model?: string;
		usage?: Partial<AssistantMessage["usage"]>;
	},
): AssistantMessage {
	const baseUsage = {
		input: 400,
		output: 120,
		cacheRead: 600,
		cacheWrite: 0,
		reasoning: 30,
		totalTokens: 1_120,
		cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0, total: 0.0035 },
		...opts.usage,
	};
	return {
		role: "assistant",
		content,
		api: "faux-api",
		provider: "faux",
		model: opts.model ?? "faux-1",
		usage: baseUsage,
		stopReason: opts.stopReason ?? "stop",
		timestamp: opts.timestamp,
	};
}

function createDeferredStreamQueue() {
	const created: Array<ReturnType<typeof createAssistantMessageEventStream>> = [];
	const waiters: Array<(stream: ReturnType<typeof createAssistantMessageEventStream>) => void> = [];
	return {
		handler: () => {
			const stream = createAssistantMessageEventStream();
			const waiter = waiters.shift();
			if (waiter) waiter(stream);
			else created.push(stream);
			return stream;
		},
		nextStream: (): Promise<ReturnType<typeof createAssistantMessageEventStream>> => {
			const existing = created.shift();
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve) => waiters.push(resolve));
		},
	};
}

async function openSlashWithoutWaiting(harness: InteractiveHarness, cmd: string): Promise<void> {
	await harness.paste(cmd, true);
	await harness.pressKey("\r");
	await harness.flush();
}

describe("Absorbed Response Metrics and unified 3-tab Context Inspector (real InteractiveMode)", () => {
	let harness: InteractiveHarness | undefined;
	const tempDirs: string[] = [];

	function allocateTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		vi.useRealTimers();
		if (harness) {
			await harness.dispose();
			harness = undefined;
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("silently neutralizes standalone response-metrics and embed-working-status extensions in both load orders while preserving historical pi-stamp history", async () => {
		const extDir = allocateTempDir("pi-ui-legacy-metrics-");
		mkdirSync(extDir, { recursive: true });
		const legacyMetricsPath = join(extDir, "response-metrics.ts");
		const legacyWorkingPath = join(extDir, "embed-working-status.ts");

		writeFileSync(
			legacyMetricsPath,
			`
import { Text } from "@earendil-works/pi-tui";
export default function (pi) {
	pi.registerEntryRenderer("response-metrics", () => new Text("LEGACY_METRICS_ROW", 0, 0));
	pi.registerEntryRenderer("pi-stamp", () => new Text("LEGACY_STAMP_ROW", 0, 0));
	pi.registerCommand("stats", {
		description: "Legacy stats command",
		handler: async (_args, ctx) => {
			ctx.ui.notify("LEGACY_STATS_TRIGGERED", "warning");
		},
	});
	pi.on("turn_end", () => {
		pi.appendEntry("response-metrics", { version: 1, timestamp: 1, completedAt: 2, legacyMarker: true });
	});
}
`,
			"utf8",
		);

		writeFileSync(
			legacyWorkingPath,
			`
export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingMessage("LEGACY_WORKING_BANNER");
		ctx.ui.setWidget("embed-working-status", ["LEGACY_WORKING_WIDGET"]);
	});
	pi.on("agent_start", (_event, ctx) => {
		ctx.ui.setWorkingMessage("LEGACY_WORKING_ACTIVE");
	});
}
`,
			"utf8",
		);

		const now = new Date();
		const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 30, 0).getTime();

		for (const order of ["before", "after"] as const) {
			const extensionPaths =
				order === "before"
					? [legacyMetricsPath, legacyWorkingPath, DEFAULT_EXTENSION_ENTRY]
					: [DEFAULT_EXTENSION_ENTRY, legacyMetricsPath, legacyWorkingPath];

			harness = await createInteractiveHarness({
				theme: "dark",
				width: 100,
				height: 30,
				loadDefaultExtension: false,
				additionalExtensionPaths: extensionPaths,
				initialEntries: [
					makeUserEntry("u-hist", null, "Historical prompt", t0),
					makeAssistantEntry("a-hist", "u-hist", "Historical assistant answer", t0 + 2_500),
					{
						type: "custom",
						id: "s-hist",
						parentId: "a-hist",
						timestamp: new Date(t0 + 2_500).toISOString(),
						customType: LEGACY_STAMP_ENTRY_TYPE,
						data: {
							role: "assistant",
							timestamp: t0 + 100,
							firstContentAt: t0 + 600,
							completedAt: t0 + 2_500,
							timeSinceUserMs: 2_500,
							outputTokens: 120,
							metadata: { model: "legacy-model-v1", thinkingLevel: "medium" },
						},
					} as never,
				],
				responses: [fauxAssistantMessage(`Fresh reply (${order})`)],
			});

			const initialText = harness.screen().text();
			expect(initialText).not.toContain("LEGACY_METRICS_ROW");
			expect(initialText).not.toContain("LEGACY_STAMP_ROW");
			expect(initialText).not.toContain("LEGACY_WORKING_BANNER");
			expect(initialText).not.toContain("LEGACY_WORKING_WIDGET");
			expect(initialText).toContain("Worked for 2.5s");

			await harness.submitInput(`New turn (${order})`);
			const afterTurnText = harness.screen().text();
			expect(afterTurnText).not.toContain("LEGACY_METRICS_ROW");
			expect(afterTurnText).not.toContain("LEGACY_WORKING_ACTIVE");

			const metricsEntries = harness.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom" && e.customType === METRICS_ENTRY_TYPE);
			expect(metricsEntries).toHaveLength(1);
			expect(
				(metricsEntries[0] as { data?: { legacyMarker?: boolean } }).data?.legacyMarker,
			).toBeUndefined();

			await harness.dispose();
			harness = undefined;
		}
	});

	it("renders per-step TTFT and tok/s on both intermediate toolUse steps and final response rows without requiring hover, excludes tool wait and unstreamed reasoning from speed, and keeps quiet timestamp fallback when responseMetrics = false", async () => {
		vi.useFakeTimers();
		const baseTime = new Date(2026, 10, 25, 19, 56, 0).getTime();
		vi.setSystemTime(baseTime);

		const queue = createDeferredStreamQueue();
		const width = 100;
		const projDir = allocateTempDir("pi-ui-metrics-turn-");
		writeFileSync(join(projDir, "hello.txt"), "hello world\n", "utf8");

		harness = await createInteractiveHarness({
			theme: "dark",
			cwd: projDir,
			width,
			height: 36,
			thinkingLevel: "medium",
			streamSimple: () => queue.handler(),
		});
		vi.runOnlyPendingTimers();

		const turnPromise = harness.submitInput("Read hello.txt and summarize");

		/* Шаг 1: промежуточный toolUse (ttft 0.4s, 60 out tokens за 1.5s -> 40 tok/s, без Worked for) */
		const stream1 = await queue.nextStream();
		const tStep1Start = Date.now();
		stream1.push({
			type: "start",
			partial: makeStreamAssistant([], { timestamp: tStep1Start }),
		});
		vi.advanceTimersByTime(400);
		const tc1 = {
			type: "toolCall" as const,
			id: "tc-read-1",
			name: "read",
			arguments: { path: "hello.txt" },
		};
		stream1.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: tc1,
			partial: makeStreamAssistant([tc1], { timestamp: tStep1Start, stopReason: "toolUse" }),
		});
		await harness.flush();
		vi.advanceTimersByTime(1_100);
		const msg1 = makeStreamAssistant([tc1], {
			timestamp: tStep1Start,
			stopReason: "toolUse",
			usage: { input: 300, cacheRead: 500, output: 60, reasoning: 0, totalTokens: 860 },
		});
		stream1.push({ type: "done", reason: "toolUse", message: msg1 });
		stream1.end(msg1);

		/* Шаг 2: финальный ответ (ttft 0.5s, decode 2.0s, 100 out tokens (20 нестримившихся reasoning + 80 текстовых -> 40 tok/s стрима), всего 4.0s) */
		const stream2 = await queue.nextStream();
		const midScreenText = harness.screen().text();
		expect(midScreenText).not.toContain("Worked for");
		expect(midScreenText).toContain("ttft 0.4s · 40 tok/s");

		const tStep2Start = Date.now();
		stream2.push({
			type: "start",
			partial: makeStreamAssistant([], { timestamp: tStep2Start }),
		});
		vi.advanceTimersByTime(500);
		const partial2 = makeStreamAssistant([{ type: "text", text: "Summary: hello world." }], {
			timestamp: tStep2Start,
		});
		stream2.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Summary: hello world.",
			partial: partial2,
		});
		await harness.flush();
		vi.advanceTimersByTime(2_000);
		const msg2 = makeStreamAssistant([{ type: "text", text: "Summary: hello world." }], {
			timestamp: tStep2Start,
			stopReason: "stop",
			usage: { input: 400, cacheRead: 800, output: 100, reasoning: 20, totalTokens: 1_300 },
		});
		stream2.push({ type: "done", reason: "stop", message: msg2 });
		stream2.end(msg2);

		await turnPromise;
		vi.runOnlyPendingTimers();

		/* В истории записаны оба шага (toolUse + stop); промежуточный показывает ttft + tok/s, финальный — Worked for + ttft + tok/s */
		const recordedMetrics = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === METRICS_ENTRY_TYPE);
		expect(recordedMetrics).toHaveLength(2);
		expect((recordedMetrics[0] as { data?: ResponseMetricsData }).data?.stopReason).toBe("toolUse");
		expect((recordedMetrics[1] as { data?: ResponseMetricsData }).data?.stopReason).toBe("stop");

		const screenAtRest = harness.screen();
		const workedMatches = screenAtRest.text().match(/Worked for/g) ?? [];
		expect(workedMatches).toHaveLength(1);
		expect(screenAtRest.text()).toContain("ttft 0.4s · 40 tok/s");

		const workedHit = screenAtRest.findText("Worked for 4s");
		expect(workedHit).toBeDefined();
		expect(workedHit!.col).toBe(4);

		const rowAtRest = screenAtRest.rowText(workedHit!.row);
		expect(rowAtRest).toContain("Worked for 4s · ttft 0.5s · 40 tok/s");
		expect(rowAtRest.slice(width - 2)).toBe("  ");
		const expectedTimestamp = "25 Nov, 19:56";
		expect(rowAtRest.slice(width - 2 - expectedTimestamp.length, width - 2)).toBe(expectedTimestamp);

		/* Проза Markdown выше сохраняет полную ширину без наложенного timestamp на строке 0 */
		const proseHit = screenAtRest.findText("Summary: hello world.");
		expect(proseHit).toBeDefined();
		expect(proseHit!.col).toBe(4);
		expect(screenAtRest.rowText(proseHit!.row)).not.toContain(expectedTimestamp);

		const rowCountBeforeHover = screenAtRest.rowText(workedHit!.row + 1);
		await harness.mouseMove(workedHit!.col + 3, workedHit!.row);
		const screenHovered = harness.screen();
		const hoveredRow = screenHovered.rowText(workedHit!.row);
		expect(hoveredRow).toContain("Worked for 4s · ttft 0.5s · 40 tok/s");
		expect(hoveredRow.slice(width - 2)).toBe("  ");
		expect(hoveredRow.slice(width - 2 - expectedTimestamp.length, width - 2)).toBe(expectedTimestamp);
		expect(screenHovered.rowText(workedHit!.row + 1)).toBe(rowCountBeforeHover);

		await harness.mouseMove(0, 0);

		/* Клик по Worked for открывает Context Inspector сразу на вкладке Session usage (без дубликата) */
		await harness.mouseClick(workedHit!.col + 3, workedHit!.row);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		const modalText = harness.screen().text();
		expect(modalText).toContain("Context Inspector");
		expect(modalText).toContain("Session usage (since start or last resume)");
		expect(modalText).toContain("Model calls:");
		expect(modalText).toContain("Model + Effort");
		expect(modalText).toContain("faux-1 (medium)");
		expect(modalText).toMatch(/#1[^\n]*0\.4s/u);
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		/* При responseMetrics = false (/metrics off) скрываются и промежуточные метрики, и Worked for, остаётся тихий timestamp */
		await harness.submitInput("/metrics off");
		const offScreen = harness.screen();
		expect(offScreen.text()).not.toContain("Worked for 4s");
		expect(offScreen.text()).not.toContain("ttft 0.4s");
		const proseAfterOff = offScreen.findText("Summary: hello world.")!;
		const tsOnlyRow = offScreen.rowText(proseAfterOff.row + 2);
		expect(tsOnlyRow.slice(width - 2 - expectedTimestamp.length, width - 2)).toBe(expectedTimestamp);
		expect(tsOnlyRow.slice(0, width - 2 - expectedTimestamp.length).trim()).toBe("");
		expect(tsOnlyRow.slice(width - 2)).toBe("  ");
	});

	it("includes cache-warming usage in session token and cost totals", async () => {
		harness = await createInteractiveHarness({ width: 100, height: 34 });
		harness.sessionManager.appendUsage("cache_warm", "faux", "faux-1", {
			input: 1000, output: 4, cacheRead: 200, cacheWrite: 60, totalTokens: 1264,
			cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0.025, total: 0.125 },
		});
		await openSlashWithoutWaiting(harness, "/stats");
		expect(harness.screen().text()).toMatch(/Total tokens:\s+1,264/);
		expect(harness.screen().text()).toMatch(/Cost:\s+\$0\.1250/);
		await harness.pressKey("\x1b");
	});

	it("opens unified 3-tab Context Inspector via /context, Header click, /stats, and /metrics with full keyboard and mouse interaction across all 3 tabs", async () => {
		const now = new Date();
		const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 20, 0).getTime();

		const extraEntries: unknown[] = [];
		let parentId: string | null = null;
		for (let i = 1; i <= 10; i += 1) {
			const uId = `u-${i}`;
			const aId = `a-${i}`;
			const mId = `m-${i}`;
			const stepStart = t0 + i * 10_000;
			extraEntries.push(makeUserEntry(uId, parentId, `Prompt number ${i}`, stepStart));
			extraEntries.push({
				type: "message",
				id: aId,
				parentId: uId,
				timestamp: new Date(stepStart + 3_000).toISOString(),
				message: {
					role: "assistant",
					model: i % 2 === 0 ? "model-beta" : "model-alpha",
					stopReason: "stop",
					content: [{ type: "text", text: `Answer number ${i}` }],
					usage: {
						input: 500,
						cacheRead: 1_000,
						cacheWrite: 0,
						output: 150,
						reasoning: 40,
						totalTokens: 1_650,
						cost: { input: 0.001, output: 0.002, cacheRead: 0.0002, cacheWrite: 0, total: 0.0032 },
					},
					timestamp: stepStart + 100,
				},
			});
			extraEntries.push({
				type: "custom",
				id: mId,
				parentId: aId,
				timestamp: new Date(stepStart + 3_000).toISOString(),
				customType: METRICS_ENTRY_TYPE,
				data: {
					version: 1,
					timestamp: stepStart + 100,
					firstContentAt: stepStart + 600,
					completedAt: stepStart + 3_100,
					timeSinceUserMs: 3_100,
					outputTokens: 150,
					reasoningTokens: 40,
					inputTokens: 500,
					cacheReadTokens: 1_000,
					model: i % 2 === 0 ? "model-beta" : "model-alpha",
					thinkingLevel: i % 2 === 0 ? "high" : "low",
					stopReason: "stop",
				} satisfies ResponseMetricsData,
			});
			parentId = mId;
		}

		const width = 104;
		harness = await createInteractiveHarness({
			theme: "dark",
			width,
			height: 26,
			initialEntries: extraEntries as never,
		});

		/* 1. /context открывает Context usage с сеткой 20x5 (100 ◆/◇) и секцией Already counted above */
		await openSlashWithoutWaiting(harness, "/context");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		const ctxTabScreen = harness.screen();
		const ctxTabText = ctxTabScreen.text();
		expect(ctxTabText).toContain("Context usage");
		expect(ctxTabText).toContain("Session usage");
		expect(ctxTabText).toContain("Session info");
		expect(ctxTabText).toContain("System prompt");
		expect(ctxTabText).toContain("Messages");
		expect(ctxTabText).toContain("Reasoning & overhead");
		expect(ctxTabText).toContain("Free");
		expect(ctxTabText).toContain("Already counted above");
		expect(ctxTabText).toContain("Tool definitions");
		expect(ctxTabText).toContain("Skills");

		/* Проверяем 5 строк по 20 символов ◆/◇ = 100 ячеек */
		const diamondRows = Array.from({ length: ctxTabScreen.height }, (_, r) => ctxTabScreen.rowText(r))
			.filter((row) => (row.match(/[◆◇]/g)?.length ?? 0) === 20);
		expect(diamondRows).toHaveLength(5);

		/* 2. Переключение вкладок клавиатурой (Tab) -> Session usage, прокрутка ↑/↓ и wheel, копирование MD по m */
		await harness.pressKey("\t");
		const usageTabText = harness.screen().text();
		expect(usageTabText).toContain("Session usage (since start or last resume)");
		expect(usageTabText).toContain("Input tokens:");
		expect(usageTabText).toContain("cached");
		expect(usageTabText).toContain("Output tokens:");
		expect(usageTabText).toContain("reasoning");
		expect(usageTabText).toContain("Total tokens:");
		expect(usageTabText).toContain("Model calls:");
		expect(usageTabText).toContain("API time:");
		expect(usageTabText).toContain("Cost:");
		expect(usageTabText).toContain("model-alpha (low)");
		expect(usageTabText).toContain("model-beta (high)");

		const scrollBeforeModalWheel = getActiveHostRuntime()!.scroll!.scrollTop;
		const usageBeforeWheel = harness.screen().text();
		expect(usageBeforeWheel).toContain("1..16/");
		expect(/[А-Яа-яЁё]/u.test(usageBeforeWheel)).toBe(false);
		const usageHeaderHit = harness.screen().findText("Session usage (since")!;
		await harness.mouseWheel("down", usageHeaderHit.col, usageHeaderHit.row + 2);
		expect(getActiveHostRuntime()!.scroll!.scrollTop).toBe(scrollBeforeModalWheel);
		const usageAfterWheel = harness.screen().text();
		expect(usageAfterWheel).toContain("3..18/");
		await harness.pressKey("\x1b[B");
		expect(harness.screen().text()).toContain("4..19/");
		await harness.pressKey("\x1b[A");
		expect(harness.screen().text()).toContain("3..18/");

		const copyMdPill = harness.screen().findText("Copy Markdown")!;
		await harness.mouseClick(copyMdPill.col + 2, copyMdPill.row);
		expect(harness.screen().text()).toContain("✓ Copied MD");
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toContain("| Model + Effort |");

		await harness.pressKey("m");
		const mdClipboard = await getActiveHostRuntime()!.clipboard.readText?.();
		expect(mdClipboard).toContain("| Model + Effort | Calls | Med TTFT | Stream tok/s | API time | Output (reasoning) |");
		expect(mdClipboard).toContain("model-alpha (low)");
		expect(mdClipboard).toContain("| Turn | Model | TTFT | tok/s | Duration | Output |");

		/* 3. Клик мышью по вкладке Session info -> проверка всех полей, копирование по y и c + кнопки мыши */
		const infoTabHit = harness.screen().findText("Session info")!;
		await harness.mouseClick(infoTabHit.col + 2, infoTabHit.row);
		const infoText = harness.screen().text();
		expect(infoText).toContain("Title:");
		expect(infoText).toContain("Pi version:");
		expect(infoText).toContain("Session ID:");
		expect(infoText).toContain("Working directory:");
		expect(infoText).toContain("Model:");
		expect(infoText).toContain("Turn:");
		expect(infoText).toContain("Context:");

		await harness.pressKey("y");
		const allInfoClip = await getActiveHostRuntime()!.clipboard.readText?.();
		expect(allInfoClip).toContain("Pi version:");
		expect(allInfoClip).toContain("Session ID:");
		expect(allInfoClip).toContain(harness.cwd);

		await harness.pressKey("c");
		const sessionIdClip = await getActiveHostRuntime()!.clipboard.readText?.();
		expect(sessionIdClip).toBe(harness.sessionManager.getSessionId());

		/* Клик по кнопке [Copy all · y] в футере */
		const copyAllPill = harness.screen().findText("Copy all")!;
		await harness.mouseClick(copyAllPill.col + 2, copyAllPill.row);
		expect(await getActiveHostRuntime()!.clipboard.readText?.()).toContain("Working directory:");

		/* Закрытие кликом по стандартизированному крестику [×] в заголовке */
		const closeHit = harness.screen().findText("[×]")!;
		expect(closeHit).toBeDefined();
		await harness.mouseClick(closeHit.col + 1, closeHit.row);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		/* 4. /stats и /metrics открывают сразу вкладку Session usage */
		await openSlashWithoutWaiting(harness, "/stats");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Session usage (since start or last resume)");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		await openSlashWithoutWaiting(harness, "/metrics");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Session usage (since start or last resume)");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);

		/* 5. Клик по индикатору контекста в Header открывает Context Inspector на вкладке Context usage */
		await harness.mouseClick(width - 4, 1);
		expect(hasBlockingModalOverlay(harness.tui)).toBe(true);
		expect(harness.screen().text()).toContain("Already counted above");
		await harness.pressKey("\x1b");
		expect(hasBlockingModalOverlay(harness.tui)).toBe(false);
	});
});
