import { describe, expect, it } from "vitest";
import {
	aggregateSessionTelemetry,
	buildSessionUsageMarkdownTable,
	computeStepMetrics,
	formatCompletionTimestamp,
	formatMetricsDuration,
	formatMetricsRate,
	LEGACY_STAMP_ENTRY_TYPE,
	METRICS_ENTRY_TYPE,
	normalizeLegacyPiStamp,
	type ResponseMetricsData,
} from "../src/features/context-inspector/telemetry.ts";

describe("Telemetry aggregation, legacy pi-stamp normalization, and formatting (pure seam)", () => {
	it("computes TTFT, decode duration, stream tok/s, and effective tok/s accurately with safety bounds", () => {
		const computed = computeStepMetrics({
			timestamp: 1_000,
			firstContentAt: 1_500,
			firstTextAt: 2_000,
			completedAt: 5_500,
			outputTokens: 200,
		});
		expect(computed).toBeDefined();
		expect(computed!.totalMs).toBe(4_500);
		expect(computed!.ttftMs).toBe(500);
		expect(computed!.firstTextMs).toBe(1_000);
		expect(computed!.decodeMs).toBe(4_000);
		expect(computed!.streamTps).toBeCloseTo(50, 5);
		expect(computed!.effectiveTps).toBeCloseTo(200 / 4.5, 5);

		const tooShort = computeStepMetrics({
			timestamp: 1_000,
			firstContentAt: 1_010,
			completedAt: 1_050,
			outputTokens: 100,
		});
		expect(tooShort?.streamTps).toBeUndefined();
		expect(tooShort?.effectiveTps).toBeUndefined();

		expect(computeStepMetrics({ timestamp: 5_000, completedAt: 4_000 })).toBeUndefined();
	});

	it("normalizes historical pi-stamp entries (assistant with nested metadata, user marker, and malformed payloads)", () => {
		const assistantLegacy = normalizeLegacyPiStamp({
			role: "assistant",
			timestamp: 10_000,
			firstContentAt: 10_600,
			completedAt: 14_600,
			timeSinceUserMs: 6_200,
			metadata: {
				outputTokens: 240,
				reasoningTokens: 80,
				inputTokens: 1_200,
				cacheReadTokens: 900,
				model: "claude-sonnet-4",
				thinkingLevel: "high",
				stopReason: "stop",
			},
		});
		expect(assistantLegacy).toEqual({
			version: 1,
			timestamp: 10_000,
			firstContentAt: 10_600,
			completedAt: 14_600,
			timeSinceUserMs: 6_200,
			outputTokens: 240,
			reasoningTokens: 80,
			inputTokens: 1_200,
			cacheReadTokens: 900,
			model: "claude-sonnet-4",
			thinkingLevel: "high",
			stopReason: "stop",
		});

		expect(normalizeLegacyPiStamp({ role: "user", timestamp: 9_000 })).toEqual({
			userTimestamp: 9_000,
		});
		expect(normalizeLegacyPiStamp({ role: "assistant", timestamp: 9_000 })).toBeUndefined();
		expect(normalizeLegacyPiStamp(null)).toBeUndefined();
	});

	it("aggregates multi-step tool turns, legacy pi-stamp entries, token totals, per-Model+Effort medians, and per-Turn breakdown without sample fabrication", () => {
		const empty = aggregateSessionTelemetry([]);
		expect(empty.records).toEqual([]);
		expect(empty.modelGroups).toEqual([]);
		expect(empty.turnSummaries).toEqual([]);
		expect(empty.modelCalls).toBe(0);
		expect(empty.totalTokens).toBe(0);

		const t0 = 1_700_000_000_000;
		const branch: unknown[] = [
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: "Inspect codebase", timestamp: t0 },
			},
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					model: "alpha-model",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					usage: {
						input: 500,
						cacheRead: 1_500,
						cacheWrite: 0,
						output: 80,
						reasoning: 20,
						totalTokens: 2_080,
						cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0, total: 0.0035 },
					},
					timestamp: t0 + 100,
				},
			},
			{
				type: "custom",
				id: "m1",
				customType: METRICS_ENTRY_TYPE,
				data: {
					version: 1,
					timestamp: t0 + 100,
					firstContentAt: t0 + 500,
					completedAt: t0 + 2_100,
					outputTokens: 80,
					reasoningTokens: 20,
					inputTokens: 500,
					cacheReadTokens: 1_500,
					model: "alpha-model",
					thinkingLevel: "medium",
					stopReason: "toolUse",
				} satisfies ResponseMetricsData,
			},
			{
				type: "message",
				id: "a2",
				message: {
					role: "assistant",
					model: "alpha-model",
					stopReason: "stop",
					content: [{ type: "text", text: "Done inspecting." }],
					usage: {
						input: 600,
						cacheRead: 2_000,
						cacheWrite: 100,
						output: 180,
						reasoning: 50,
						totalTokens: 2_880,
						cost: { input: 0.002, output: 0.004, cacheRead: 0.0005, cacheWrite: 0, total: 0.0065 },
					},
					timestamp: t0 + 3_000,
				},
			},
			{
				type: "custom",
				id: "m2",
				customType: METRICS_ENTRY_TYPE,
				data: {
					version: 1,
					timestamp: t0 + 3_000,
					firstContentAt: t0 + 3_800,
					completedAt: t0 + 7_400,
					timeSinceUserMs: 7_400,
					outputTokens: 180,
					reasoningTokens: 50,
					inputTokens: 600,
					cacheReadTokens: 2_000,
					model: "alpha-model",
					thinkingLevel: "medium",
					stopReason: "stop",
				} satisfies ResponseMetricsData,
			},
			{
				type: "message",
				id: "u2",
				message: { role: "user", content: "Legacy turn", timestamp: t0 + 20_000 },
			},
			{
				type: "message",
				id: "a3",
				message: {
					role: "assistant",
					model: "beta-model",
					stopReason: "stop",
					content: [{ type: "text", text: "Legacy response." }],
					usage: {
						input: 300,
						cacheRead: 0,
						cacheWrite: 0,
						output: 120,
						totalTokens: 420,
						cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
					},
					timestamp: t0 + 20_100,
				},
			},
			{
				type: "custom",
				id: "s1",
				customType: LEGACY_STAMP_ENTRY_TYPE,
				data: {
					role: "assistant",
					timestamp: t0 + 20_100,
					firstContentAt: t0 + 20_700,
					completedAt: t0 + 23_700,
					timeSinceUserMs: 3_700,
					outputTokens: 120,
					metadata: { model: "beta-model", thinkingLevel: "low" },
				},
			},
		];

		const summary = aggregateSessionTelemetry(branch);
		expect(summary.turnCount).toBe(2);
		expect(summary.modelCalls).toBe(3);
		expect(summary.inputTokens).toBe(500 + 1_500 + 600 + 2_000 + 100 + 300);
		expect(summary.cacheReadTokens).toBe(3_500);
		expect(summary.outputTokens).toBe(380);
		expect(summary.reasoningTokens).toBe(70);
		expect(summary.totalTokens).toBe(summary.inputTokens + summary.outputTokens);
		expect(summary.costTotal).toBeCloseTo(0.012, 6);
		expect(summary.apiTimeMs).toBe(2_000 + 4_400 + 3_600);
		expect(summary.records).toHaveLength(3);

		expect(summary.modelGroups).toHaveLength(2);
		expect(summary.modelGroups[0]!.label).toBe("alpha-model (medium)");
		expect(summary.modelGroups[0]!.calls).toBe(2);
		expect(summary.modelGroups[0]!.medianTtftMs).toBe(600);
		expect(summary.modelGroups[0]!.medianStreamTps).toBe(50);

		expect(summary.turnSummaries).toHaveLength(2);
		expect(summary.turnSummaries[0]!.turnIndex).toBe(1);
		expect(summary.turnSummaries[0]!.durationMs).toBe(7_400);
		expect(summary.turnSummaries[0]!.stepCount).toBe(2);
		expect(summary.turnSummaries[1]!.turnIndex).toBe(2);
		expect(summary.turnSummaries[1]!.durationMs).toBe(3_700);
		expect(summary.turnSummaries[1]!.model).toBe("beta-model");

		const md = buildSessionUsageMarkdownTable(summary);
		expect(md).toContain("| Model + Effort | Calls | Med TTFT | Stream tok/s | API time | Output (reasoning) |");
		expect(md).toContain("| alpha-model (medium) | 2 | 0.6s | 50 | 6.4s | 260 (70) |");
		expect(md).toContain("| Turn | Model | TTFT | tok/s | Duration | Output |");
		expect(md).toContain("| #1 | alpha-model | 0.4s | 50 | 7.4s | 260 |");
		expect(md).toContain("| #2 | beta-model | 0.6s | 40 | 3.7s | 120 |");
	});

	it("formats durations, rates, and assistant completion timestamps across datetime, cross-year, time, and off modes", () => {
		expect(formatMetricsDuration(0)).toBe("0s");
		expect(formatMetricsDuration(420)).toBe("0.4s");
		expect(formatMetricsDuration(2_000)).toBe("2s");
		expect(formatMetricsDuration(65_000)).toBe("1m 5s");
		expect(formatMetricsDuration(3_665_000)).toBe("1h 1m 5s");

		expect(formatMetricsRate(0.05)).toBe("<0.1");
		expect(formatMetricsRate(42.0)).toBe("42");
		expect(formatMetricsRate(42.36)).toBe("42.4");

		const now = new Date(2026, 10, 26, 12, 0, 0);
		const sameYear = new Date(2026, 10, 25, 19, 56, 0).getTime();
		const priorYear = new Date(2025, 10, 25, 19, 56, 0).getTime();

		expect(formatCompletionTimestamp(sameYear, "datetime", now)).toBe("25 Nov, 19:56");
		expect(formatCompletionTimestamp(priorYear, "datetime", now)).toBe("25 Nov 2025, 19:56");
		expect(formatCompletionTimestamp(sameYear, "time", now)).toBe("19:56");
		expect(formatCompletionTimestamp(sameYear, "off", now)).toBe("");
	});
});
