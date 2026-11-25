/**
 * PROTOTYPE (throwaway branch: prototype/thinking-and-tool-calls)
 * Native English-first response metrics row + contextual working-phase observer + Session Speed Modal Card.
 * Compatible with historical `response-metrics` and `pi-stamp` entries.
 */
import { basename } from "node:path";
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, isLightTheme, renderPill } from "../../shared/ansi.ts";
import {
	matchesExtensionSourcePath,
	registerSupersededExtensionPredicate,
	withConartiInternalRegistration,
} from "../../shared/extension-superseder.ts";
import { createModalCard, openModalCard } from "../../shared/modal-card.ts";
import { claimHover, copyToClipboard } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import {
	beginWorkingTurn,
	getPrototypeVariant,
	isPrototypeActive,
	isResponseMetricsEnabled,
	markWorkingPhase,
	setResponseMetricsEnabled,
	summarizeLiveThinkingIntent,
	type PrototypeVariant,
} from "./prototype-state.ts";

export const METRICS_ENTRY_TYPE = "response-metrics";
export const LEGACY_STAMP_ENTRY_TYPE = "pi-stamp";
export const TTFT_PULSE_MARKER = Symbol.for("conarti.pi-ui.ttft-pulse");

const MIN_STREAM_DECODE_MS = 100;
const MIN_STREAM_OUTPUT_TOKENS = 2;
const MIN_THINKING_GAP_MS = 300;

export interface ResponseMetricsData {
	version: 1;
	timestamp: number;
	completedAt: number;
	firstContentAt?: number;
	firstTextAt?: number;
	timeSinceUserMs?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	model?: string;
	thinkingLevel?: string;
	stopReason?: string;
}

export interface ComputedMetrics {
	totalMs: number;
	ttftMs?: number;
	firstTextMs?: number;
	decodeMs?: number;
	streamTps?: number;
	effectiveTps?: number;
}

interface ActiveTiming {
	timestamp: number;
	firstContentAt?: number;
	firstTextAt?: number;
}

interface FinalizedTiming extends ActiveTiming {
	completedAt: number;
	timeSinceUserMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isValidMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeCount(value: unknown): value is number {
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

export function computeMetrics(data: {
	timestamp: number;
	completedAt: number;
	firstContentAt?: number;
	firstTextAt?: number;
	outputTokens?: number;
}): ComputedMetrics | undefined {
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
	const effectiveTps =
		outputTokens !== undefined && totalMs > 0 ? outputTokens / (totalMs / 1000) : undefined;
	const streamTps =
		outputTokens !== undefined &&
		outputTokens >= MIN_STREAM_OUTPUT_TOKENS &&
		decodeMs !== undefined &&
		decodeMs >= MIN_STREAM_DECODE_MS
			? outputTokens / (decodeMs / 1000)
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
	if (rate > 0 && rate < 0.1) return "<0.1";
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

export function formatTokenCount(n: number): string {
	return Math.round(n)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatClockTime(timestamp: number, includeSeconds = false): string {
	const d = new Date(timestamp);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	if (!includeSeconds) return `${hh}:${mm}`;
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function formatFullDateTime(timestamp: number): string {
	const d = new Date(timestamp);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day} · ${formatClockTime(timestamp, true)}`;
}

export function normalizeLegacyPiStamp(
	raw: unknown,
): ResponseMetricsData | { userTimestamp: number } | undefined {
	if (!isRecord(raw) || !isValidMs(raw.timestamp)) return undefined;
	if (raw.role === "user") {
		return { userTimestamp: raw.timestamp };
	}
	if (raw.role !== "assistant" || !isValidMs(raw.completedAt)) return undefined;

	const meta = isRecord(raw.metadata) ? raw.metadata : undefined;
	const outputTokens = isPositiveCount(raw.outputTokens)
		? raw.outputTokens
		: isPositiveCount(meta?.outputTokens)
			? meta.outputTokens
			: undefined;

	return {
		version: 1,
		timestamp: raw.timestamp,
		completedAt: raw.completedAt,
		...(isValidMs(raw.firstContentAt) ? { firstContentAt: raw.firstContentAt } : {}),
		...(isValidMs(raw.timeSinceUserMs) ? { timeSinceUserMs: raw.timeSinceUserMs } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(isPositiveCount(meta?.reasoningTokens) ? { reasoningTokens: meta.reasoningTokens } : {}),
		...(isPositiveCount(meta?.inputTokens) ? { inputTokens: meta.inputTokens } : {}),
		...(isPositiveCount(meta?.cacheReadTokens) ? { cacheReadTokens: meta.cacheReadTokens } : {}),
	};
}

function buildExpandedDetailParts(data: ResponseMetricsData, computed: ComputedMetrics): string[] {
	const detailParts: string[] = [];
	if (computed.streamTps !== undefined && computed.effectiveTps !== undefined) {
		detailParts.push(`eff ${formatMetricsRate(computed.effectiveTps)} tok/s`);
	}
	if (computed.decodeMs !== undefined) {
		detailParts.push(`stream ${formatMetricsDuration(computed.decodeMs)}`);
	}
	detailParts.push(`total ${formatMetricsDuration(computed.totalMs)}`);
	if (
		computed.firstTextMs !== undefined &&
		computed.ttftMs !== undefined &&
		computed.firstTextMs - computed.ttftMs >= MIN_THINKING_GAP_MS
	) {
		detailParts.push(`first text ${formatMetricsDuration(computed.firstTextMs)}`);
	}
	if (isPositiveCount(data.outputTokens)) {
		const reas = isPositiveCount(data.reasoningTokens)
			? ` (r ${formatTokenCount(data.reasoningTokens)})`
			: "";
		detailParts.push(`out ${formatTokenCount(data.outputTokens)}${reas}`);
	}
	if (isPositiveCount(data.inputTokens)) {
		const cache = isPositiveCount(data.cacheReadTokens)
			? ` (cache ${formatTokenCount(data.cacheReadTokens)})`
			: "";
		detailParts.push(`in ${formatTokenCount(data.inputTokens)}${cache}`);
	}
	return detailParts;
}

function formatLegacyMetricsLines(data: ResponseMetricsData, expanded: boolean): string[] {
	const computed = computeMetrics(data);
	const primaryParts: string[] = [formatFullDateTime(data.timestamp)];

	if (computed?.ttftMs !== undefined) {
		primaryParts.push(`ttft ${formatMetricsDuration(computed.ttftMs)}`);
	}
	if (computed?.streamTps !== undefined) {
		primaryParts.push(`${formatMetricsRate(computed.streamTps)} tok/s`);
	} else if (computed?.effectiveTps !== undefined) {
		primaryParts.push(`eff ${formatMetricsRate(computed.effectiveTps)} tok/s`);
	}
	if (isValidMs(data.timeSinceUserMs)) {
		primaryParts.push(`since user ${formatMetricsDuration(data.timeSinceUserMs)}`);
	} else if (computed) {
		primaryParts.push(`total ${formatMetricsDuration(computed.totalMs)}`);
	}

	const lines = [primaryParts.join(" · ")];
	if (expanded && computed) {
		const details = buildExpandedDetailParts(data, computed);
		if (details.length > 0) lines.push(details.join(" · "));
	}
	return lines;
}

export class ResponseMetricsRowComponent implements Component {
	private hovered = false;

	constructor(
		private readonly data: ResponseMetricsData,
		private readonly expanded: boolean,
		private readonly themeRef: Theme,
		private readonly onOpenSummary: () => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 8 || !isResponseMetricsEnabled()) return [];
		const variant: PrototypeVariant = getPrototypeVariant();
		if (variant === "off") {
			return formatLegacyMetricsLines(this.data, this.expanded).flatMap((source) =>
				wrapTextWithAnsi(this.themeRef.fg("dim", source), width).map((line) => {
					const pad = " ".repeat(Math.max(0, width - visibleWidth(line)));
					return `${pad}${line}`;
				}),
			);
		}
		if (this.data.stopReason === "toolUse") return [];

		const computed = computeMetrics(this.data);
		if (!computed) return [];

		const light = isLightTheme(this.themeRef);
		/* Оставляем справа 4 колонки под Outline Rail (width - 3 .. width - 2) и скроллбар (width - 1) */
		const rightClearance = width >= 48 ? 4 : 1;
		const usableWidth = Math.max(8, width - rightClearance);
		const padFullWidth = (line: string): string =>
			line + " ".repeat(Math.max(0, width - visibleWidth(line)));

		const elapsedMs = isValidMs(this.data.timeSinceUserMs)
			? this.data.timeSinceUserMs
			: computed.totalMs;
		const speedLabel =
			computed.streamTps !== undefined
				? `${formatMetricsRate(computed.streamTps)} tok/s`
				: computed.effectiveTps !== undefined
					? `eff ${formatMetricsRate(computed.effectiveTps)} tok/s`
					: undefined;
		const ttftLabel =
			computed.ttftMs !== undefined ? `ttft ${formatMetricsDuration(computed.ttftMs)}` : undefined;
		const totalLabel = formatMetricsDuration(elapsedMs);
		const timeLabel = formatClockTime(this.data.completedAt || this.data.timestamp);

		const dimFg = (s: string) =>
			light ? fgRgb(120, 134, 156, s) : fgRgb(104, 118, 142, s);
		const valFg = (s: string) =>
			this.hovered
				? light
					? fgRgb(29, 78, 216, s)
					: fgRgb(145, 198, 252, s)
				: light
					? fgRgb(78, 94, 118, s)
					: fgRgb(136, 152, 178, s);
		const accentFg = (s: string) =>
			light ? fgRgb(37, 99, 235, s) : fgRgb(110, 182, 248, s);
		const sep = dimFg(" · ");

		const lines: string[] = [];

		if (variant === "A") {
			const parts: string[] = [
				`${this.hovered ? accentFg("◈") : dimFg("✓")} ${valFg(`Worked for ${totalLabel}`)}`,
			];
			if (ttftLabel) parts.push(dimFg(ttftLabel));
			if (speedLabel) parts.push(valFg(speedLabel));
			parts.push(dimFg(timeLabel));
			if (this.hovered) {
				parts.push(accentFg("stats ↗"));
			}
			const row = truncateToWidth(`  ${parts.join(sep)}`, usableWidth, "…");
			lines.push(padFullWidth(row));
		} else if (variant === "B") {
			const rightParts: string[] = [];
			if (speedLabel) rightParts.push(valFg(speedLabel));
			if (ttftLabel) rightParts.push(dimFg(ttftLabel));
			rightParts.push(valFg(`turn ${totalLabel}`));
			rightParts.push(this.hovered ? accentFg("stats ↗") : dimFg(timeLabel));
			const leadGlyph = this.hovered ? accentFg("❖") : dimFg("❖");
			const rightBlock = `  ${leadGlyph} ${rightParts.join(sep)}`;
			const rightW = visibleWidth(rightBlock);
			const ruleBudget = Math.max(0, usableWidth - rightW - 2);
			const ruleColor = (s: string) =>
				this.hovered
					? light
						? fgRgb(147, 197, 253, s)
						: fgRgb(62, 88, 126, s)
					: light
						? fgRgb(212, 222, 236, s)
						: fgRgb(46, 56, 74, s);
			if (ruleBudget >= 6) {
				const rule = `  ${ruleColor("┄".repeat(ruleBudget))}`;
				const full = truncateToWidth(`${rule}${rightBlock}`, usableWidth, "…");
				lines.push(padFullWidth(full));
			} else {
				const pad = " ".repeat(Math.max(0, usableWidth - rightW));
				const full = truncateToWidth(`${pad}${rightBlock}`, usableWidth, "…");
				lines.push(padFullWidth(full));
			}
		} else {
			/* Variant C: two-zone instrument strip with right clearance */
			const leftMeta: string[] = [dimFg(formatClockTime(this.data.completedAt || this.data.timestamp, true))];
			if (this.data.model) {
				const eff = this.data.thinkingLevel ? ` (${this.data.thinkingLevel})` : "";
				leftMeta.push(valFg(`${this.data.model}${eff}`));
			}
			if (isPositiveCount(this.data.outputTokens)) {
				const r = isPositiveCount(this.data.reasoningTokens)
					? ` · r ${formatTokenCount(this.data.reasoningTokens)}`
					: "";
				leftMeta.push(dimFg(`out ${formatTokenCount(this.data.outputTokens)}${r}`));
			}
			const leftStr = `  ${leftMeta.join(sep)}`;

			const pills: string[] = [];
			if (computed.ttftMs !== undefined) {
				pills.push(
					renderPill(`TTFT ${formatMetricsDuration(computed.ttftMs)}`, {
						theme: this.themeRef,
						hovered: false,
					}),
				);
			}
			if (speedLabel) {
				pills.push(
					renderPill(speedLabel, {
						theme: this.themeRef,
						active: this.hovered,
						hovered: this.hovered,
						variant: "primary",
					}),
				);
			}
			pills.push(
				renderPill(`Turn ${totalLabel}`, {
					theme: this.themeRef,
					hovered: false,
				}),
			);
			pills.push(
				renderPill("Stats ↗", {
					theme: this.themeRef,
					hovered: this.hovered,
					active: this.hovered,
					variant: "secondary",
				}),
			);
			const rightStr = pills.join(" ");
			const rightW = visibleWidth(rightStr);
			const maxLeft = Math.max(0, usableWidth - rightW - 2);
			const clippedLeft = maxLeft >= 10 ? truncateToWidth(leftStr, maxLeft, "…") : "";
			const gap = " ".repeat(Math.max(1, usableWidth - visibleWidth(clippedLeft) - rightW));
			const combined = truncateToWidth(`${clippedLeft}${gap}${rightStr}`, usableWidth, "…");
			lines.push(padFullWidth(combined));
		}

		if (this.expanded) {
			const details = buildExpandedDetailParts(this.data, computed);
			if (details.length > 0) {
				const detailText = dimFg(details.join(" · "));
				if (variant === "A") {
					const dRow = truncateToWidth(`    ${detailText}`, usableWidth, "…");
					lines.push(padFullWidth(dRow));
				} else {
					const clipped = truncateToWidth(detailText, usableWidth, "…");
					const pad = " ".repeat(Math.max(0, usableWidth - visibleWidth(clipped)));
					lines.push(padFullWidth(`${pad}${clipped}`));
				}
			}
		}

		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!isResponseMetricsEnabled() || getPrototypeVariant() === "off") return undefined;
		if (event.type === "move") {
			claimHover(this, () => {
				if (this.hovered) {
					this.hovered = false;
					requestRender();
				}
			});
			if (!this.hovered) {
				this.hovered = true;
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}
		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			this.onOpenSummary();
			return { handled: true, render: true };
		}
		return undefined;
	}
}

/* ── Session Speed & Tokens Summary Modal Card (/stats | /metrics | click) ─ */

interface TurnMetricsRecord {
	turnIndex: number;
	data: ResponseMetricsData;
	computed: ComputedMetrics;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function padCell(text: string, width: number, align: "left" | "right" = "left"): string {
	const clipped = truncateToWidth(text, width, "…");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return align === "right" ? `${pad}${clipped}` : `${clipped}${pad}`;
}

export function collectSessionMetrics(branch: readonly unknown[]): {
	records: TurnMetricsRecord[];
	usedSampleData: boolean;
} {
	const records: TurnMetricsRecord[] = [];
	let turnCounter = 0;

	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (
			entry.type === "message" &&
			isRecord(entry.message) &&
			entry.message.role === "user"
		) {
			turnCounter += 1;
			continue;
		}
		if (entry.type !== "custom") continue;
		let data: ResponseMetricsData | undefined;
		if (entry.customType === METRICS_ENTRY_TYPE && isRecord(entry.data)) {
			data = entry.data as unknown as ResponseMetricsData;
		} else if (entry.customType === LEGACY_STAMP_ENTRY_TYPE) {
			const norm = normalizeLegacyPiStamp(entry.data);
			if (norm && !("userTimestamp" in norm)) data = norm;
		}
		if (!data) continue;
		const computed = computeMetrics(data);
		if (!computed) continue;
		records.push({
			turnIndex: Math.max(1, turnCounter || records.length + 1),
			data,
			computed,
		});
	}

	if (records.length > 0) {
		return { records, usedSampleData: false };
	}

	const now = Date.now();
	const samples: ResponseMetricsData[] = [
		{
			version: 1,
			timestamp: now - 42_000,
			firstContentAt: now - 41_350,
			firstTextAt: now - 38_900,
			completedAt: now - 35_200,
			timeSinceUserMs: 6800,
			outputTokens: 640,
			reasoningTokens: 210,
			inputTokens: 18_400,
			cacheReadTokens: 14_200,
			model: "gemini-4-carbon",
			thinkingLevel: "high",
			stopReason: "stop",
		},
		{
			version: 1,
			timestamp: now - 18_000,
			firstContentAt: now - 17_520,
			firstTextAt: now - 16_100,
			completedAt: now - 12_900,
			timeSinceUserMs: 5100,
			outputTokens: 520,
			reasoningTokens: 140,
			inputTokens: 21_100,
			cacheReadTokens: 18_900,
			model: "gemini-4-carbon",
			thinkingLevel: "high",
			stopReason: "stop",
		},
	];

	return {
		records: samples.map((d, idx) => ({
			turnIndex: idx + 1,
			data: d,
			computed: computeMetrics(d)!,
		})),
		usedSampleData: true,
	};
}

function buildMarkdownSummaryTable(records: readonly TurnMetricsRecord[]): string {
	const byModel = new Map<string, TurnMetricsRecord[]>();
	for (const rec of records) {
		const model = rec.data.model ?? "unknown";
		const eff = rec.data.thinkingLevel ? ` (${rec.data.thinkingLevel})` : "";
		const key = `${model}${eff}`;
		const bucket = byModel.get(key) ?? [];
		bucket.push(rec);
		byModel.set(key, bucket);
	}

	const lines: string[] = [
		"| Model + Effort | Calls | Med TTFT | Stream tok/s | Eff tok/s | Output (reasoning) |",
		"|---|---:|---:|---:|---:|---:|",
	];

	for (const [modelKey, group] of byModel.entries()) {
		const ttfts = group.map((g) => g.computed.ttftMs).filter((v): v is number => v !== undefined);
		const streams = group.map((g) => g.computed.streamTps).filter((v): v is number => v !== undefined);
		const effs = group.map((g) => g.computed.effectiveTps).filter((v): v is number => v !== undefined);
		const outSum = group.reduce((acc, g) => acc + (g.data.outputTokens ?? 0), 0);
		const reasSum = group.reduce((acc, g) => acc + (g.data.reasoningTokens ?? 0), 0);
		const ttftCell = ttfts.length > 0 ? formatMetricsDuration(median(ttfts)) : "-";
		const streamCell = streams.length > 0 ? formatMetricsRate(median(streams)) : "-";
		const effCell = effs.length > 0 ? formatMetricsRate(median(effs)) : "-";
		const outCell = outSum > 0
			? `${formatTokenCount(outSum)}${reasSum > 0 ? ` (${formatTokenCount(reasSum)})` : ""}`
			: "-";
		lines.push(`| ${modelKey} | ${group.length} | ${ttftCell} | ${streamCell} | ${effCell} | ${outCell} |`);
	}

	lines.push("");
	lines.push("| Turn | Model | TTFT | Stream tok/s | Eff tok/s | Duration | Output (reasoning) |");
	lines.push("|---:|---|---:|---:|---:|---:|---:|");
	for (const rec of records) {
		const model = rec.data.model ?? "unknown";
		const ttft = rec.computed.ttftMs !== undefined ? formatMetricsDuration(rec.computed.ttftMs) : "-";
		const st = rec.computed.streamTps !== undefined ? formatMetricsRate(rec.computed.streamTps) : "-";
		const ef = rec.computed.effectiveTps !== undefined ? formatMetricsRate(rec.computed.effectiveTps) : "-";
		const dur = formatMetricsDuration(rec.data.timeSinceUserMs ?? rec.computed.totalMs);
		const out = rec.data.outputTokens
			? `${formatTokenCount(rec.data.outputTokens)}${rec.data.reasoningTokens ? ` (${formatTokenCount(rec.data.reasoningTokens)})` : ""}`
			: "-";
		lines.push(`| #${rec.turnIndex} | ${model} | ${ttft} | ${st} | ${ef} | ${dur} | ${out} |`);
	}
	return lines.join("\n");
}

export async function openResponseMetricsModal(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") return;

	await openModalCard<void>(
		ctx,
		(tui, theme, _kb, done) => {
			const card = createModalCard();
			let scrollOffset = 0;
			let copiedFlash = false;

			const buildBody = (innerW: number): { lines: string[]; markdown: string; sample: boolean } => {
				const branch = ctx.sessionManager.getBranch();
				const { records, usedSampleData } = collectSessionMetrics(branch);
				const markdown = buildMarkdownSummaryTable(records);
				const light = isLightTheme(theme);
				const accent = (s: string) => (light ? fgRgb(37, 99, 235, s) : fgRgb(118, 186, 250, s));
				const head = (s: string) => theme.bold(s);
				const dim = (s: string) => theme.fg("dim", s);

				const body: string[] = [];
				if (usedSampleData) {
					body.push(
						dim("No recorded responses in the current branch yet - showing sample layout."),
					);
					body.push("");
				}

				body.push(accent("By Model + Effort (medians):"));
				const modelCol = Math.max(16, Math.min(30, innerW - 46));
				body.push(
					dim(
						`${padCell("Model + Effort", modelCol)}  ${padCell("Calls", 5, "right")}  ${padCell("TTFT", 7, "right")}  ${padCell("Stream", 11, "right")}  ${padCell("Eff", 11, "right")}  ${padCell("Out (r)", 13, "right")}`,
					),
				);

				const byModel = new Map<string, TurnMetricsRecord[]>();
				for (const rec of records) {
					const m = rec.data.model ?? "unknown";
					const eff = rec.data.thinkingLevel ? ` (${rec.data.thinkingLevel})` : "";
					const key = `${m}${eff}`;
					const arr = byModel.get(key) ?? [];
					arr.push(rec);
					byModel.set(key, arr);
				}

				for (const [modelKey, group] of byModel.entries()) {
					const ttfts = group.map((g) => g.computed.ttftMs).filter((v): v is number => v !== undefined);
					const streams = group.map((g) => g.computed.streamTps).filter((v): v is number => v !== undefined);
					const effs = group.map((g) => g.computed.effectiveTps).filter((v): v is number => v !== undefined);
					const outSum = group.reduce((acc, g) => acc + (g.data.outputTokens ?? 0), 0);
					const reasSum = group.reduce((acc, g) => acc + (g.data.reasoningTokens ?? 0), 0);
					body.push(
						`${head(padCell(modelKey, modelCol))}  ${padCell(String(group.length), 5, "right")}  ${padCell(ttfts.length ? formatMetricsDuration(median(ttfts)) : "-", 7, "right")}  ${accent(padCell(streams.length ? `${formatMetricsRate(median(streams))} t/s` : "-", 11, "right"))}  ${padCell(effs.length ? `${formatMetricsRate(median(effs))} t/s` : "-", 11, "right")}  ${padCell(outSum > 0 ? `${formatTokenCount(outSum)}${reasSum > 0 ? ` (${formatTokenCount(reasSum)})` : ""}` : "-", 13, "right")}`,
					);
				}

				body.push("");
				body.push(accent("Recent Calls in Branch:"));
				const turnModelCol = Math.max(12, Math.min(24, innerW - 50));
				body.push(
					dim(
						`${padCell("Turn", 5)}  ${padCell("Model", turnModelCol)}  ${padCell("TTFT", 7, "right")}  ${padCell("Stream", 11, "right")}  ${padCell("Eff", 11, "right")}  ${padCell("Time", 8, "right")}  ${padCell("Out (r)", 13, "right")}`,
					),
				);

				for (const rec of records.slice(-30)) {
					const m = rec.data.model ?? "unknown";
					const ttft = rec.computed.ttftMs !== undefined ? formatMetricsDuration(rec.computed.ttftMs) : "-";
					const st = rec.computed.streamTps !== undefined ? `${formatMetricsRate(rec.computed.streamTps)} t/s` : "-";
					const ef = rec.computed.effectiveTps !== undefined ? `${formatMetricsRate(rec.computed.effectiveTps)} t/s` : "-";
					const dur = formatMetricsDuration(rec.data.timeSinceUserMs ?? rec.computed.totalMs);
					const out = rec.data.outputTokens
						? `${formatTokenCount(rec.data.outputTokens)}${rec.data.reasoningTokens ? ` (${formatTokenCount(rec.data.reasoningTokens)})` : ""}`
						: "-";
					body.push(
						`${dim(padCell(`#${rec.turnIndex}`, 5))}  ${padCell(m, turnModelCol)}  ${padCell(ttft, 7, "right")}  ${accent(padCell(st, 11, "right"))}  ${padCell(ef, 11, "right")}  ${padCell(dur, 8, "right")}  ${padCell(out, 13, "right")}`,
					);
				}

				return { lines: body, markdown, sample: usedSampleData };
			};

			let latestMarkdown = "";

			const copySummary = () => {
				if (!latestMarkdown) return;
				copyToClipboard(latestMarkdown);
				copiedFlash = true;
				tui.requestRender();
			};

			return {
				invalidate() {},
				render(width: number): string[] {
					const innerW = Math.max(24, width - 4);
					const built = buildBody(innerW);
					latestMarkdown = built.markdown;
					const maxVisible = 16;
					const maxOffset = Math.max(0, built.lines.length - maxVisible);
					scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
					const visibleLines = built.lines.slice(scrollOffset, scrollOffset + maxVisible);
					const enabled = isResponseMetricsEnabled();

					return card.render(width, theme, {
						title: "❖ Session Speed & Tokens",
						headerMeta:
							maxOffset > 0
								? `${scrollOffset + 1}..${Math.min(built.lines.length, scrollOffset + maxVisible)}/${built.lines.length}`
								: `${built.sample ? "sample" : "live"}`,
						closable: true,
						onClose: () => done(undefined),
						bodyLines: visibleLines,
						footerPills: [
							{
								id: "copy-table",
								label: copiedFlash ? "✓ Copied Markdown" : "Copy Table · C",
								variant: copiedFlash ? "success" : "primary",
								active: copiedFlash,
								onClick: copySummary,
							},
							{
								id: "toggle-row",
								label: enabled ? "Metrics Row: On · M" : "Metrics Row: Off · M",
								variant: enabled ? "secondary" : "neutral",
								active: enabled,
								onClick: () => {
									setResponseMetricsEnabled(!isResponseMetricsEnabled());
									tui.requestRender();
								},
							},
							{
								id: "close",
								label: "Close · Esc",
								onClick: () => done(undefined),
							},
						],
					});
				},
				handleInput(data: string): void {
					if (isKeyRelease(data)) return;
					if (matchesKey(data, "escape") || data === "q" || data === "Q") {
						done(undefined);
						return;
					}
					if (matchesKey(data, "up") || data === "k") {
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down") || data === "j") {
						scrollOffset += 1;
						tui.requestRender();
						return;
					}
					if (data === "c" || data === "C" || data === "с" || data === "С") {
						copySummary();
						return;
					}
					if (data === "m" || data === "M" || data === "ь" || data === "Ь") {
						setResponseMetricsEnabled(!isResponseMetricsEnabled());
						tui.requestRender();
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const modalHit = card.handleMouse(event);
					if (modalHit.handled) {
						return { handled: true, render: modalHit.render };
					}
					const evType = String(event.type);
					if (evType === "wheel" || evType === "mouse_wheel_up" || evType === "mouse_wheel_down") {
						const dy =
							evType === "mouse_wheel_up"
								? -2
								: evType === "mouse_wheel_down"
									? 2
									: ((event as unknown as { deltaY?: number }).deltaY ?? 0) < 0
										? -2
										: 2;
						scrollOffset = Math.max(0, scrollOffset + dy);
						return { handled: true, render: true };
					}
					return undefined;
				},
			};
		},
		{
			width: "84%",
			maxHeight: "82%",
			anchor: "center",
		},
	);
}

/* ── Lifecycle hooks and contextual Working Summary extraction ───────────── */

function elapsedSinceLastUser(entries: readonly unknown[], completedAt: number): number | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "user") continue;
		const ts = entry.message.timestamp;
		return isValidMs(ts) && ts <= completedAt ? completedAt - ts : undefined;
	}
	return undefined;
}

function extractUsage(message: unknown): {
	outputTokens?: number;
	reasoningTokens?: number;
	inputTokens?: number;
	cacheReadTokens?: number;
} {
	if (!isRecord(message) || !isRecord(message.usage)) return {};
	const u = message.usage;
	return {
		...(isPositiveCount(u.output) ? { outputTokens: u.output } : {}),
		...(isNonNegativeCount(u.reasoning) && u.reasoning > 0 ? { reasoningTokens: u.reasoning } : {}),
		...(isPositiveCount(u.input) ? { inputTokens: u.input } : {}),
		...(isPositiveCount(u.cacheRead) ? { cacheReadTokens: u.cacheRead } : {}),
	};
}

function describeToolAction(toolName: string, rawArgs: unknown): string {
	const args = isRecord(rawArgs) ? rawArgs : {};
	if (typeof args.toolSummary === "string" && args.toolSummary.trim()) {
		const s = args.toolSummary.trim();
		return s.endsWith("…") ? s : `${s}…`;
	}
	const rawPath =
		typeof args.path === "string"
			? args.path
			: typeof args.file_path === "string"
				? args.file_path
				: "";
	const shortPath = rawPath ? basename(rawPath) || rawPath : "";

	switch (toolName) {
		case "read":
			return shortPath ? `Reading ${shortPath}…` : "Reading file…";
		case "edit":
			return shortPath ? `Editing ${shortPath}…` : "Editing file…";
		case "write":
			return shortPath ? `Writing ${shortPath}…` : "Writing file…";
		case "grep":
		case "find": {
			const pat = typeof args.pattern === "string" ? args.pattern.slice(0, 28) : "";
			return pat ? `Searching ${pat}…` : "Searching codebase…";
		}
		case "ls":
			return shortPath ? `Listing ${shortPath}…` : "Listing files…";
		case "bash":
		case "powershell": {
			const cmd = typeof args.command === "string" ? args.command.trim().split(/\s+/u).slice(0, 3).join(" ") : "";
			return cmd ? `Running ${cmd.slice(0, 32)}…` : "Running command…";
		}
		case "codemode":
			return "Running batched tools…";
		default:
			return `Calling ${toolName}…`;
	}
}

function extractLatestThinkingFromMessage(message: unknown): string | undefined {
	if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
	for (let i = message.content.length - 1; i >= 0; i--) {
		const block = message.content[i];
		if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string") {
			return summarizeLiveThinkingIntent(block.thinking);
		}
	}
	return undefined;
}

export function registerResponseMetricsFeature(pi: ExtensionAPI): void {
	registerSupersededExtensionPredicate("response-metrics", (ext) =>
		matchesExtensionSourcePath(ext, /(?:^|[\\/])response-metrics\.[cm]?[jt]s$/i),
	);

	let activeCtx: ExtensionContext | undefined;
	let tuiActive = false;
	let activeTiming: ActiveTiming | undefined;
	let finalizedTiming: FinalizedTiming | undefined;
	let activeThinkingLevel: string | undefined;

	const triggerSummaryModal = () => {
		if (activeCtx) {
			void openResponseMetricsModal(activeCtx);
		}
	};

	withConartiInternalRegistration(() => {
		const metricsRenderer: EntryRenderer<ResponseMetricsData> = (entry, options, theme) => {
			const data = entry.data;
			if (!isRecord(data) || !isValidMs(data.timestamp) || !isValidMs(data.completedAt)) {
				return undefined;
			}
			if (!isResponseMetricsEnabled()) return undefined;
			if (isPrototypeActive() && data.stopReason === "toolUse") {
				return undefined;
			}
			return new ResponseMetricsRowComponent(
				data as ResponseMetricsData,
				options.expanded,
				theme,
				triggerSummaryModal,
			);
		};

		const legacyStampRenderer: EntryRenderer<unknown> = (entry, options, theme) => {
			const normalized = normalizeLegacyPiStamp(entry.data);
			if (!normalized || "userTimestamp" in normalized) return undefined;
			if (!isResponseMetricsEnabled()) return undefined;
			return new ResponseMetricsRowComponent(
				normalized,
				options.expanded,
				theme,
				triggerSummaryModal,
			);
		};

		pi.registerEntryRenderer(METRICS_ENTRY_TYPE, metricsRenderer);
		pi.registerEntryRenderer(LEGACY_STAMP_ENTRY_TYPE, legacyStampRenderer);

		pi.on("session_start", (_event, ctx) => {
			activeCtx = ctx;
			tuiActive = ctx.mode === "tui";
			activeTiming = undefined;
			finalizedTiming = undefined;
			activeThinkingLevel = undefined;
		});

		pi.on("agent_start", (_event, ctx) => {
			activeCtx = ctx;
			beginWorkingTurn(Date.now());
		});

		pi.on("turn_start", (_event, ctx) => {
			activeCtx = ctx;
			activeTiming = undefined;
			finalizedTiming = undefined;
			activeThinkingLevel =
				typeof (ctx as unknown as { thinkingLevel?: unknown }).thinkingLevel === "string"
					? ((ctx as unknown as { thinkingLevel: string }).thinkingLevel)
					: undefined;
		});

		pi.on("message_start", (event) => {
			if (!tuiActive || event.message.role !== "assistant" || !isValidMs(event.message.timestamp)) {
				return;
			}
			activeTiming = { timestamp: event.message.timestamp };
			finalizedTiming = undefined;
		});

		pi.on("message_update", (event) => {
			if (!tuiActive || event.message.role !== "assistant") return;
			const now = Date.now();
			const subEvent = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;

			if (isMeaningfulAssistantUpdate(subEvent)) {
				if (subEvent?.type === "thinking_delta" || subEvent?.type === "thinking_end") {
					const intent = extractLatestThinkingFromMessage(event.message);
					markWorkingPhase("thinking", { now, summary: intent ?? "Thinking…" });
				} else if (subEvent?.type === "toolcall_delta" || subEvent?.type === "toolcall_end") {
					markWorkingPhase("tool", { now });
				} else if (subEvent?.type === "text_delta" || subEvent?.type === "text_end") {
					markWorkingPhase("text", { now, summary: "Responding…" });
				}
			}

			if (!activeTiming || activeTiming.timestamp !== event.message.timestamp) {
				return;
			}
			if (activeTiming.firstContentAt === undefined && isMeaningfulAssistantUpdate(subEvent)) {
				activeTiming.firstContentAt = now;
			}
			if (activeTiming.firstTextAt === undefined && isTextAssistantUpdate(subEvent)) {
				activeTiming.firstTextAt = now;
			}
		});

		pi.on("tool_execution_start", (event) => {
			const rawArgs = (event as { args?: unknown }).args;
			markWorkingPhase("tool", { summary: describeToolAction(event.toolName, rawArgs) });
		});

		pi.on("message_end", (event, ctx) => {
			if (!tuiActive || event.message.role !== "assistant" || !isValidMs(event.message.timestamp)) {
				return;
			}
			const completedAt = Date.now();
			if (completedAt < event.message.timestamp) {
				activeTiming = undefined;
				finalizedTiming = undefined;
				return;
			}
			const matching =
				activeTiming?.timestamp === event.message.timestamp ? activeTiming : undefined;
			const firstContentAt =
				matching?.firstContentAt !== undefined &&
				matching.firstContentAt >= event.message.timestamp &&
				matching.firstContentAt <= completedAt
					? matching.firstContentAt
					: undefined;
			const firstTextAt =
				matching?.firstTextAt !== undefined &&
				matching.firstTextAt >= event.message.timestamp &&
				matching.firstTextAt <= completedAt
					? matching.firstTextAt
					: undefined;
			const timeSinceUserMs = elapsedSinceLastUser(ctx.sessionManager.getBranch(), completedAt);

			finalizedTiming = {
				timestamp: event.message.timestamp,
				completedAt,
				...(firstContentAt !== undefined ? { firstContentAt } : {}),
				...(firstTextAt !== undefined ? { firstTextAt } : {}),
				...(timeSinceUserMs !== undefined ? { timeSinceUserMs: timeSinceUserMs } : {}),
			};
			activeTiming = undefined;
		});

		pi.on("turn_end", (event) => {
			const timing = finalizedTiming;
			const thinkingLevel = activeThinkingLevel;
			activeTiming = undefined;
			finalizedTiming = undefined;
			activeThinkingLevel = undefined;

			if (!tuiActive || event.message.role !== "assistant") return;
			if (!timing || timing.timestamp !== event.message.timestamp) return;

			const isNonToolUse = event.message.stopReason !== "toolUse";
			const usage = extractUsage(event.message);
			const model =
				isRecord(event.message) && typeof event.message.model === "string"
					? event.message.model
					: undefined;
			const stopReason =
				isRecord(event.message) && typeof event.message.stopReason === "string"
					? event.message.stopReason
					: undefined;

			const entry: ResponseMetricsData = {
				version: 1,
				timestamp: timing.timestamp,
				completedAt: timing.completedAt,
				...(timing.firstContentAt !== undefined ? { firstContentAt: timing.firstContentAt } : {}),
				...(timing.firstTextAt !== undefined ? { firstTextAt: timing.firstTextAt } : {}),
				...(isNonToolUse && timing.timeSinceUserMs !== undefined
					? { timeSinceUserMs: timing.timeSinceUserMs }
					: {}),
				...usage,
				...(model !== undefined ? { model } : {}),
				...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
				...(stopReason !== undefined ? { stopReason } : {}),
			};

			if (!process.env.VITEST || isPrototypeActive()) {
				pi.appendEntry<ResponseMetricsData>(METRICS_ENTRY_TYPE, entry);
			}
		});

		pi.on("agent_end", () => {
			markWorkingPhase("idle");
			activeTiming = undefined;
			finalizedTiming = undefined;
			activeThinkingLevel = undefined;
		});

		pi.on("session_shutdown", () => {
			markWorkingPhase("idle");
			tuiActive = false;
			activeCtx = undefined;
			activeTiming = undefined;
			finalizedTiming = undefined;
			activeThinkingLevel = undefined;
		});

		const handleMetricsCommand = async (args: string, ctx: ExtensionContext) => {
			activeCtx = ctx;
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "on" || trimmed === "true") {
				setResponseMetricsEnabled(true);
				ctx.ui.notify("Response metrics row enabled.", "info");
				return;
			}
			if (trimmed === "off" || trimmed === "false") {
				setResponseMetricsEnabled(false);
				ctx.ui.notify("Response metrics row hidden.", "info");
				return;
			}
			if (trimmed === "toggle") {
				const next = !isResponseMetricsEnabled();
				setResponseMetricsEnabled(next);
				ctx.ui.notify(
					next ? "Response metrics row enabled." : "Response metrics row hidden.",
					"info",
				);
				return;
			}
			await openResponseMetricsModal(ctx);
		};

		pi.registerCommand("metrics", {
			description: "Open Session Speed & Tokens summary modal (or /metrics on|off)",
			handler: handleMetricsCommand,
		});

		pi.registerCommand("stats", {
			description: "Open Session Speed & Tokens summary modal",
			handler: handleMetricsCommand,
		});
	});
}
