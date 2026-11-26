import { formatTranscriptTimestamp } from "../../shared/transcript-timestamp.ts";

export { formatTranscriptTimestamp as formatCompletionTimestamp };

export const METRICS_ENTRY_TYPE = "response-metrics";
export const LEGACY_STAMP_ENTRY_TYPE = "pi-stamp";

const MIN_STREAM_DECODE_MS = 100;
const MIN_STREAM_OUTPUT_TOKENS = 2;

export interface ResponseMetricsData {
	readonly version: 1;
	readonly timestamp: number;
	readonly completedAt: number;
	readonly firstContentAt?: number;
	readonly firstTextAt?: number;
	readonly timeSinceUserMs?: number;
	readonly outputTokens?: number;
	readonly reasoningTokens?: number;
	readonly inputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly model?: string;
	readonly thinkingLevel?: string;
	readonly stopReason?: string;
}

export interface ComputedStepMetrics {
	readonly totalMs: number;
	readonly ttftMs?: number;
	readonly firstTextMs?: number;
	readonly decodeMs?: number;
	readonly streamTps?: number;
	readonly effectiveTps?: number;
}

export interface StepMetricsRecord {
	readonly turnIndex: number;
	readonly data: ResponseMetricsData;
	readonly computed: ComputedStepMetrics;
}

export interface ModelEffortSummary {
	readonly label: string;
	readonly calls: number;
	readonly medianTtftMs?: number;
	readonly medianStreamTps?: number;
	readonly medianEffectiveTps?: number;
	readonly apiTimeMs: number;
	readonly outputTokens: number;
	readonly reasoningTokens: number;
}

export interface TurnTelemetrySummary {
	readonly turnIndex: number;
	readonly model: string;
	readonly thinkingLevel?: string;
	readonly stepCount: number;
	readonly ttftMs?: number;
	readonly tps?: number;
	readonly durationMs: number;
	readonly outputTokens: number;
	readonly reasoningTokens: number;
	readonly completedAt: number;
}

export interface SessionTelemetrySummary {
	readonly turnCount: number;
	readonly modelCalls: number;
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly outputTokens: number;
	readonly reasoningTokens: number;
	readonly totalTokens: number;
	readonly costTotal: number;
	readonly apiTimeMs: number;
	readonly records: readonly StepMetricsRecord[];
	readonly modelGroups: readonly ModelEffortSummary[];
	readonly turnSummaries: readonly TurnTelemetrySummary[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isValidMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isPositiveCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isNonNegativeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isMeaningfulAssistantUpdate(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (
		value.type === "text_delta" ||
		value.type === "thinking_delta" ||
		value.type === "toolcall_delta"
	) {
		return typeof value.delta === "string" && value.delta.length > 0;
	}
	if (value.type === "text_end" || value.type === "thinking_end") {
		return typeof value.content === "string" && value.content.length > 0;
	}
	return value.type === "toolcall_end" && isRecord(value.toolCall);
}

export function isTextAssistantUpdate(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text_delta") {
		return typeof value.delta === "string" && value.delta.length > 0;
	}
	if (value.type === "text_end") {
		return typeof value.content === "string" && value.content.length > 0;
	}
	return false;
}

export function computeStepMetrics(data: {
	timestamp: number;
	completedAt: number;
	firstContentAt?: number;
	firstTextAt?: number;
	outputTokens?: number;
}): ComputedStepMetrics | undefined {
	if (
		!isValidMs(data.timestamp) ||
		!isValidMs(data.completedAt) ||
		data.completedAt < data.timestamp
	) {
		return undefined;
	}
	const totalMs = data.completedAt - data.timestamp;
	const firstContentAt = isValidMs(data.firstContentAt) ? data.firstContentAt : undefined;
	const hasFirstContent =
		firstContentAt !== undefined &&
		firstContentAt >= data.timestamp &&
		firstContentAt <= data.completedAt;
	const ttftMs = hasFirstContent ? firstContentAt - data.timestamp : undefined;
	const decodeMs = hasFirstContent ? data.completedAt - firstContentAt : undefined;

	const firstTextAt = isValidMs(data.firstTextAt) ? data.firstTextAt : undefined;
	const hasFirstText =
		firstTextAt !== undefined &&
		firstTextAt >= data.timestamp &&
		firstTextAt <= data.completedAt;
	const firstTextMs = hasFirstText ? firstTextAt - data.timestamp : undefined;

	const outputTokens = isPositiveCount(data.outputTokens) ? data.outputTokens : undefined;
	const hasEnoughOutput =
		outputTokens !== undefined && outputTokens >= MIN_STREAM_OUTPUT_TOKENS;
	const streamTps =
		hasEnoughOutput && decodeMs !== undefined && decodeMs >= MIN_STREAM_DECODE_MS
			? outputTokens / (decodeMs / 1000)
			: undefined;
	const effectiveTps =
		hasEnoughOutput && totalMs >= MIN_STREAM_DECODE_MS
			? outputTokens / (totalMs / 1000)
			: undefined;

	return {
		totalMs,
		...(ttftMs !== undefined ? { ttftMs } : {}),
		...(firstTextMs !== undefined ? { firstTextMs } : {}),
		...(decodeMs !== undefined ? { decodeMs } : {}),
		...(streamTps !== undefined ? { streamTps } : {}),
		...(effectiveTps !== undefined ? { effectiveTps } : {}),
	};
}

export function formatMetricsRate(rate: number): string {
	if (!Number.isFinite(rate) || rate <= 0) return "0";
	if (rate < 0.1) return "<0.1";
	return rate.toFixed(1).replace(/\.0$/u, "");
}

export function formatMetricsDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 60_000) {
		if (Math.round(ms / 100) === 600) return "1m 0s";
		return `${(ms / 1000).toFixed(1).replace(/\.0$/u, "")}s`;
	}
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${totalSeconds % 60}s`;
}

export function formatIntegerCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

export function normalizeResponseMetricsEntry(raw: unknown): ResponseMetricsData | undefined {
	if (!isRecord(raw) || !isValidMs(raw.timestamp) || !isValidMs(raw.completedAt)) {
		return undefined;
	}
	return {
		version: 1,
		timestamp: raw.timestamp,
		completedAt: raw.completedAt,
		...(isValidMs(raw.firstContentAt) ? { firstContentAt: raw.firstContentAt } : {}),
		...(isValidMs(raw.firstTextAt) ? { firstTextAt: raw.firstTextAt } : {}),
		...(isValidMs(raw.timeSinceUserMs) ? { timeSinceUserMs: raw.timeSinceUserMs } : {}),
		...(isPositiveCount(raw.outputTokens) ? { outputTokens: raw.outputTokens } : {}),
		...(isPositiveCount(raw.reasoningTokens) ? { reasoningTokens: raw.reasoningTokens } : {}),
		...(isPositiveCount(raw.inputTokens) ? { inputTokens: raw.inputTokens } : {}),
		...(isPositiveCount(raw.cacheReadTokens) ? { cacheReadTokens: raw.cacheReadTokens } : {}),
		...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
		...(typeof raw.thinkingLevel === "string" && raw.thinkingLevel.trim()
			? { thinkingLevel: raw.thinkingLevel.trim() }
			: {}),
		...(typeof raw.stopReason === "string" && raw.stopReason.trim()
			? { stopReason: raw.stopReason.trim() }
			: {}),
	};
}

/**
 * Нормализует исторические записи `pi-stamp` в канонический формат `ResponseMetricsData`,
 * сохраняя обратную совместимость с сессиями до объединения модулей.
 */
export function normalizeLegacyPiStamp(
	raw: unknown,
): ResponseMetricsData | { readonly userTimestamp: number } | undefined {
	if (!isRecord(raw) || !isValidMs(raw.timestamp)) return undefined;
	if (raw.role === "user") {
		return { userTimestamp: raw.timestamp };
	}
	if (raw.role !== undefined && raw.role !== "assistant") return undefined;
	if (!isValidMs(raw.completedAt)) return undefined;

	const meta = isRecord(raw.metadata) ? raw.metadata : undefined;
	const outputTokens = isPositiveCount(raw.outputTokens)
		? raw.outputTokens
		: isPositiveCount(meta?.outputTokens)
			? meta.outputTokens
			: undefined;
	const reasoningTokens = isPositiveCount(raw.reasoningTokens)
		? raw.reasoningTokens
		: isPositiveCount(meta?.reasoningTokens)
			? meta.reasoningTokens
			: undefined;
	const inputTokens = isPositiveCount(raw.inputTokens)
		? raw.inputTokens
		: isPositiveCount(meta?.inputTokens)
			? meta.inputTokens
			: undefined;
	const cacheReadTokens = isPositiveCount(raw.cacheReadTokens)
		? raw.cacheReadTokens
		: isPositiveCount(meta?.cacheReadTokens)
			? meta.cacheReadTokens
			: undefined;
	const model =
		typeof raw.model === "string" && raw.model.trim()
			? raw.model.trim()
			: typeof meta?.model === "string" && meta.model.trim()
				? meta.model.trim()
				: undefined;
	const thinkingLevel =
		typeof raw.thinkingLevel === "string" && raw.thinkingLevel.trim()
			? raw.thinkingLevel.trim()
			: typeof meta?.thinkingLevel === "string" && meta.thinkingLevel.trim()
				? meta.thinkingLevel.trim()
				: undefined;
	const stopReason =
		typeof raw.stopReason === "string" && raw.stopReason.trim()
			? raw.stopReason.trim()
			: typeof meta?.stopReason === "string" && meta.stopReason.trim()
				? meta.stopReason.trim()
				: undefined;

	return {
		version: 1,
		timestamp: raw.timestamp,
		completedAt: raw.completedAt,
		...(isValidMs(raw.firstContentAt) ? { firstContentAt: raw.firstContentAt } : {}),
		...(isValidMs(raw.firstTextAt) ? { firstTextAt: raw.firstTextAt } : {}),
		...(isValidMs(raw.timeSinceUserMs) ? { timeSinceUserMs: raw.timeSinceUserMs } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(model !== undefined ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		...(stopReason !== undefined ? { stopReason } : {}),
	};
}

export function extractAssistantUsage(message: unknown): {
	outputTokens?: number;
	reasoningTokens?: number;
	inputTokens?: number;
	cacheReadTokens?: number;
} {
	if (!isRecord(message) || !isRecord(message.usage)) return {};
	const u = message.usage;
	return {
		...(isPositiveCount(u.output) ? { outputTokens: u.output } : {}),
		...(isPositiveCount(u.reasoning) ? { reasoningTokens: u.reasoning } : {}),
		...(isPositiveCount(u.input) ? { inputTokens: u.input } : {}),
		...(isPositiveCount(u.cacheRead) ? { cacheReadTokens: u.cacheRead } : {}),
	};
}

export function elapsedSinceLastUser(
	entries: readonly unknown[],
	completedAt: number,
): number | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "user") continue;
		const ts = entry.message.timestamp;
		return isValidMs(ts) && ts <= completedAt ? completedAt - ts : undefined;
	}
	return undefined;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function readStepMetrics(entry: Record<string, unknown>) {
	if (entry.type !== "custom") return undefined;
	const data = entry.customType === METRICS_ENTRY_TYPE
		? normalizeResponseMetricsEntry(entry.data)
		: entry.customType === LEGACY_STAMP_ENTRY_TYPE ? normalizeLegacyPiStamp(entry.data) : undefined;
	if (!data || "userTimestamp" in data) return undefined;
	const computed = computeStepMetrics(data);
	return computed ? { data, computed } : undefined;
}

function computeTurnTtft(steps: readonly Pick<StepMetricsRecord, "data" | "computed">[]): number | undefined {
	const firstContent = steps.find((step) => step.computed.ttftMs !== undefined);
	return firstContent && firstContent.data.timestamp - steps[0]!.data.timestamp + firstContent.computed.ttftMs!;
}

export function resolveTurnTtft(branch: readonly unknown[], finalEntryId: string): number | undefined {
	const end = branch.findLastIndex((entry) => isRecord(entry) && entry.id === finalEntryId);
	const steps: NonNullable<ReturnType<typeof readStepMetrics>>[] = [];
	for (let index = end; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!isRecord(entry)) continue;
		if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") break;
		const step = readStepMetrics(entry);
		if (step) steps.push(step);
	}
	return computeTurnTtft(steps.reverse());
}

export function aggregateSessionTelemetry(
	branch: readonly unknown[],
	fallbackModel = "unknown",
): SessionTelemetrySummary {
	let turnCount = 0;
	let modelCalls = 0;
	let inputTokens = 0;
	let cacheReadTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let costTotal = 0;
	const records: StepMetricsRecord[] = [];
	const turnUserTimestamp = new Map<number, number>();

	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type === "message" && isRecord(entry.message)) {
			const msg = entry.message;
			if (msg.role === "user") {
				turnCount += 1;
				if (isValidMs(msg.timestamp)) {
					turnUserTimestamp.set(turnCount, msg.timestamp);
				}
			} else if (msg.role === "assistant") {
				modelCalls += 1;
				if (isRecord(msg.usage)) {
					const u = msg.usage;
					const uncachedIn = isNonNegativeCount(u.input) ? u.input : 0;
					const cacheRead = isNonNegativeCount(u.cacheRead) ? u.cacheRead : 0;
					const cacheWrite = isNonNegativeCount(u.cacheWrite) ? u.cacheWrite : 0;
					inputTokens += uncachedIn + cacheRead + cacheWrite;
					cacheReadTokens += cacheRead;
					outputTokens += isNonNegativeCount(u.output) ? u.output : 0;
					reasoningTokens += isNonNegativeCount(u.reasoning) ? u.reasoning : 0;
					if (isRecord(u.cost) && isNonNegativeCount(u.cost.total)) {
						costTotal += u.cost.total;
					}
				}
			}
			continue;
		}

		const step = readStepMetrics(entry);
		if (step) records.push({ turnIndex: Math.max(1, turnCount || records.length + 1), ...step });
	}

	const apiTimeMs = records.reduce((acc, rec) => acc + rec.computed.totalMs, 0);
	const effectiveModelCalls = Math.max(modelCalls, records.length);

	const byModel = new Map<string, StepMetricsRecord[]>();
	for (const rec of records) {
		const model = rec.data.model ?? fallbackModel;
		const effort = rec.data.thinkingLevel ? ` (${rec.data.thinkingLevel})` : "";
		const key = `${model}${effort}`;
		const bucket = byModel.get(key) ?? [];
		bucket.push(rec);
		byModel.set(key, bucket);
	}

	const modelGroups: ModelEffortSummary[] = [];
	for (const [label, group] of byModel.entries()) {
		const ttfts = group
			.map((item) => item.computed.ttftMs)
			.filter((v): v is number => v !== undefined);
		const streams = group
			.map((item) => item.computed.streamTps)
			.filter((v): v is number => v !== undefined);
		const effectives = group
			.map((item) => item.computed.effectiveTps)
			.filter((v): v is number => v !== undefined);
		const groupApiMs = group.reduce((acc, item) => acc + item.computed.totalMs, 0);
		const groupOut = group.reduce((acc, item) => acc + (item.data.outputTokens ?? 0), 0);
		const groupReas = group.reduce((acc, item) => acc + (item.data.reasoningTokens ?? 0), 0);
		modelGroups.push({
			label,
			calls: group.length,
			...(ttfts.length > 0 ? { medianTtftMs: median(ttfts) } : {}),
			...(streams.length > 0 ? { medianStreamTps: median(streams) } : {}),
			...(effectives.length > 0 ? { medianEffectiveTps: median(effectives) } : {}),
			apiTimeMs: groupApiMs,
			outputTokens: groupOut,
			reasoningTokens: groupReas,
		});
	}

	const byTurn = new Map<number, StepMetricsRecord[]>();
	for (const rec of records) {
		const bucket = byTurn.get(rec.turnIndex) ?? [];
		bucket.push(rec);
		byTurn.set(rec.turnIndex, bucket);
	}

	const turnSummaries: TurnTelemetrySummary[] = [];
	for (const [turnIndex, steps] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
		const finalStep = steps[steps.length - 1]!;
		const firstStep = steps[0]!;
		const userTs = turnUserTimestamp.get(turnIndex);
		const durationMs =
			isValidMs(finalStep.data.timeSinceUserMs)
				? finalStep.data.timeSinceUserMs
				: userTs !== undefined && finalStep.data.completedAt >= userTs
					? finalStep.data.completedAt - userTs
					: steps.reduce((acc, s) => acc + s.computed.totalMs, 0);

		const ttftMs = computeTurnTtft(steps);
		const tps =
			finalStep.computed.streamTps ??
			finalStep.computed.effectiveTps ??
			firstStep.computed.streamTps ??
			firstStep.computed.effectiveTps;

		const turnOut = steps.reduce((acc, s) => acc + (s.data.outputTokens ?? 0), 0);
		const turnReas = steps.reduce((acc, s) => acc + (s.data.reasoningTokens ?? 0), 0);

		turnSummaries.push({
			turnIndex,
			model: finalStep.data.model ?? fallbackModel,
			...(finalStep.data.thinkingLevel ? { thinkingLevel: finalStep.data.thinkingLevel } : {}),
			stepCount: steps.length,
			...(ttftMs !== undefined ? { ttftMs } : {}),
			...(tps !== undefined ? { tps } : {}),
			durationMs,
			outputTokens: turnOut,
			reasoningTokens: turnReas,
			completedAt: finalStep.data.completedAt,
		});
	}

	return {
		turnCount,
		modelCalls: effectiveModelCalls,
		inputTokens,
		cacheReadTokens,
		outputTokens,
		reasoningTokens,
		totalTokens: inputTokens + outputTokens,
		costTotal,
		apiTimeMs,
		records,
		modelGroups,
		turnSummaries,
	};
}

export function buildSessionUsageMarkdownTable(summary: SessionTelemetrySummary): string {
	const lines: string[] = [
		"| Model + Effort | Calls | Med TTFT | Stream tok/s | API time | Output (reasoning) |",
		"|---|---:|---:|---:|---:|---:|",
	];

	for (const group of summary.modelGroups) {
		const ttft = group.medianTtftMs !== undefined ? formatMetricsDuration(group.medianTtftMs) : "-";
		const rate =
			group.medianStreamTps !== undefined
				? formatMetricsRate(group.medianStreamTps)
				: group.medianEffectiveTps !== undefined
					? formatMetricsRate(group.medianEffectiveTps)
					: "-";
		const apiTime = formatMetricsDuration(group.apiTimeMs);
		const output =
			group.outputTokens > 0
				? `${formatIntegerCount(group.outputTokens)}${group.reasoningTokens > 0 ? ` (${formatIntegerCount(group.reasoningTokens)})` : ""}`
				: "-";
		lines.push(`| ${group.label} | ${group.calls} | ${ttft} | ${rate} | ${apiTime} | ${output} |`);
	}

	lines.push("");
	lines.push("| Turn | Model | TTFT | tok/s | Duration | Output |");
	lines.push("|---:|---|---:|---:|---:|---:|");

	for (const turn of summary.turnSummaries) {
		const ttft = turn.ttftMs !== undefined ? formatMetricsDuration(turn.ttftMs) : "-";
		const tps = turn.tps !== undefined ? formatMetricsRate(turn.tps) : "-";
		const dur = formatMetricsDuration(turn.durationMs);
		const out = turn.outputTokens > 0 ? formatIntegerCount(turn.outputTokens) : "-";
		lines.push(`| #${turn.turnIndex} | ${turn.model} | ${ttft} | ${tps} | ${dur} | ${out} |`);
	}

	return lines.join("\n");
}
