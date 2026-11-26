import { homedir } from "node:os";
import {
	VERSION,
	type EntryRenderer,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	fgRgb,
	formatCompactTokens,
	getThemeSurfacePalette,
	themeFgRgb,
	type HitBox,
	type RgbTuple,
} from "../../shared/ansi.ts";
import { withConartiInternalRegistration } from "../../shared/extension-superseder.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { createModalCard, openModalCard, type ModalActionPill } from "../../shared/modal-card.ts";
import { loadPiUiUserConfig, updatePiUiUserConfig } from "../../shared/pi-ui-config.ts";
import { claimHover, copyToClipboard } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { ResponseMetricsRowComponent } from "./metrics-row.ts";
import {
	installLegacyMetricsAndWorkingSuperseder,
	markOwnedEntryRenderer,
} from "./supersede-legacy.ts";
import {
	aggregateSessionTelemetry,
	buildSessionUsageMarkdownTable,
	elapsedSinceLastUser,
	extractAssistantUsage,
	formatCompletionTimestamp,
	formatIntegerCount,
	formatMetricsDuration,
	formatMetricsRate,
	isMeaningfulAssistantUpdate,
	isPositiveCount,
	isRecord,
	isTextAssistantUpdate,
	isValidMs,
	LEGACY_STAMP_ENTRY_TYPE,
	METRICS_ENTRY_TYPE,
	normalizeLegacyPiStamp,
	normalizeResponseMetricsEntry,
	resolveTurnTtft,
	type ResponseMetricsData,
	type SessionTelemetrySummary,
} from "./telemetry.ts";

export {
	aggregateSessionTelemetry,
	buildSessionUsageMarkdownTable,
	computeStepMetrics,
	formatCompletionTimestamp,
	formatMetricsDuration,
	formatMetricsRate,
	LEGACY_STAMP_ENTRY_TYPE,
	METRICS_ENTRY_TYPE,
	normalizeLegacyPiStamp,
	normalizeResponseMetricsEntry,
	type ComputedStepMetrics,
	type ModelEffortSummary,
	type ResponseMetricsData,
	type SessionTelemetrySummary,
	type StepMetricsRecord,
	type TurnTelemetrySummary,
} from "./telemetry.ts";

export type ContextInspectorTab = "context" | "usage" | "session";

interface ContextWindowSnapshot {
	readonly totalTokens: number;
	readonly contextWindow: number;
	readonly percent: number;
	readonly systemTokens: number;
	readonly messageTokens: number;
	readonly reasoningAndOverheadTokens: number;
	readonly freeTokens: number;
	readonly toolCount: number;
	readonly skillCount: number;
	readonly modelLabel: string;
	readonly sessionId: string;
	readonly sessionTitle: string;
	readonly workingDir: string;
}

interface ActiveStepTiming {
	timestamp: number;
	firstContentAt?: number;
	firstTextAt?: number;
	lastContentAt?: number;
	lastToolcallDeltaAt?: number;
	replayToolWaitMs: number;
	toolExecutionStartedAt?: number;
	toolExecutionMs: number;
	streamedThinkingChars: number;
	streamDeltaCount: number;
}

interface FinalizedStepTiming {
	timestamp: number;
	completedAt: number;
	firstContentAt?: number;
	firstTextAt?: number;
	lastContentAt?: number;
	toolExecutionMs?: number;
	streamedThinkingChars: number;
	streamDeltaCount: number;
	timeSinceUserMs?: number;
}

const TABS: ReadonlyArray<{ readonly id: ContextInspectorTab; readonly labelKey: "context.tab.context" | "context.tab.usage" | "context.tab.session" }> = [
	{ id: "context", labelKey: "context.tab.context" },
	{ id: "usage", labelKey: "context.tab.usage" },
	{ id: "session", labelKey: "context.tab.session" },
];

function shortenHomePath(cwd: string): string {
	const home = homedir();
	if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
		const rest = cwd.slice(home.length);
		return rest ? `~${rest}` : "~";
	}
	return cwd;
}

function padRight(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return text + " ".repeat(width - w);
}

function padLeft(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return " ".repeat(width - w) + text;
}

function buildContextWindowSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	branch: readonly unknown[],
): ContextWindowSnapshot {
	const usage = ctx.getContextUsage?.();
	const contextWindow = Math.max(1, usage?.contextWindow ?? ctx.model?.contextWindow ?? 200_000);
	const sysPrompt = ctx.getSystemPrompt?.() ?? "";
	const systemChars = sysPrompt.length;

	let messageChars = 0;
	let overheadChars = 0;

	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const msg = entry.message;
		if (msg.role === "user") {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
			messageChars += content.length;
		} else if (msg.role === "assistant") {
			if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (!isRecord(part)) continue;
					if (part.type === "text" && typeof part.text === "string") {
						messageChars += part.text.length;
					} else if (part.type === "thinking" && typeof part.thinking === "string") {
						overheadChars += part.thinking.length;
					} else {
						overheadChars += JSON.stringify(part).length;
					}
				}
			}
		} else if (msg.role === "toolResult") {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
			overheadChars += content.length;
		}
	}

	const rawSys = Math.round(systemChars / 3.8);
	const rawMsg = Math.round(messageChars / 3.8);
	const rawOverhead = Math.round(overheadChars / 3.8);
	const rawSum = Math.max(1, rawSys + rawMsg + rawOverhead);

	const reportedTokens =
		typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0
			? Math.round(usage.tokens)
			: undefined;
	const totalTokens = reportedTokens !== undefined && reportedTokens > 0 ? reportedTokens : rawSys + rawMsg + rawOverhead;
	const scale = totalTokens > 0 ? totalTokens / rawSum : 1;

	const systemTokens = Math.min(totalTokens, Math.round(rawSys * scale));
	const reasoningAndOverheadTokens = Math.min(
		Math.max(0, totalTokens - systemTokens),
		Math.round(rawOverhead * scale),
	);
	const messageTokens = Math.max(0, totalTokens - systemTokens - reasoningAndOverheadTokens);
	const freeTokens = Math.max(0, contextWindow - totalTokens);
	const percent =
		typeof usage?.percent === "number" && Number.isFinite(usage.percent)
			? Math.max(0, Math.min(100, usage.percent))
			: Math.min(100, (totalTokens / contextWindow) * 100);

	const allTools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
	const skillMatches = sysPrompt.match(/<skill\b/gu);
	const skillCount = skillMatches ? skillMatches.length : 0;

	const sessionId =
		(ctx.sessionManager as unknown as { getSessionId?: () => string }).getSessionId?.() ??
		"local-session";
	const sessionTitle =
		ctx.sessionManager.getSessionName?.()?.trim() || shortenHomePath(ctx.cwd);
	const modelLabel = ctx.model ? `${ctx.model.name || ctx.model.id}` : "unknown";

	return {
		totalTokens,
		contextWindow,
		percent,
		systemTokens,
		messageTokens,
		reasoningAndOverheadTokens,
		freeTokens,
		toolCount: allTools.length,
		skillCount,
		modelLabel,
		sessionId,
		sessionTitle,
		workingDir: ctx.cwd,
	};
}

/**
 * Пересобирает смонтированные строки `Response Metrics` в ленте при живом изменении
 * настроек `responseMetrics` или `timestamps`.
 */
export function invalidateResponseMetricsRows(): void {
	const runtime = getActiveHostRuntime();
	const chatRoot = runtime?.chatContainer ?? runtime?.scroll?.children[0];
	if (chatRoot) {
		const visit = (node: unknown): void => {
			if (!node || typeof node !== "object") return;
			if (node.constructor?.name === "CustomEntryComponent") {
				const invalidatable = node as { invalidate?: () => void };
				invalidatable.invalidate?.();
				return;
			}
			const children = (node as { children?: unknown[] }).children;
			if (Array.isArray(children)) {
				for (const child of children) visit(child);
			}
		};
		visit(chatRoot);
	}
	requestRender();
}

function buildContextUsageLines(
	data: ContextWindowSnapshot,
	innerWidth: number,
	theme: Theme,
): string[] {
	const pal = getThemeSurfacePalette(theme);
	const dim = (s: string) => themeFgRgb(theme, pal.codeMetaFg, s);
	const bright = (s: string) => theme.bold(theme.fg("text", s));
	const val = (s: string) => theme.fg("text", s);

	const lines: string[] = [
		`${bright(data.modelLabel)}  ${dim("·")}  ${val(
			t("context.tokensLine", {
				used: formatCompactTokens(data.totalTokens),
				window: formatCompactTokens(data.contextWindow),
				percent: data.percent.toFixed(1),
			}),
		)}`,
		"",
	];

	/* Сетка 20x5 (100 ячеек ◆/◇ = 1% на ячейку) при стандартной ширине карточки */
	const cols = innerWidth >= 39 ? 20 : Math.max(10, Math.floor((innerWidth + 1) / 2));
	const rows = 5;
	const totalCells = cols * rows;
	const win = Math.max(1, data.contextWindow);
	const sysCells = Math.round((data.systemTokens / win) * totalCells);
	const msgCells = Math.round((data.messageTokens / win) * totalCells);
	const overheadCells = Math.round((data.reasoningAndOverheadTokens / win) * totalCells);
	const usedTotal = Math.min(
		totalCells,
		Math.max(data.totalTokens > 0 ? 1 : 0, sysCells + msgCells + overheadCells),
	);

	for (let r = 0; r < rows; r += 1) {
		const rowDiamonds: string[] = [];
		for (let c = 0; c < cols; c += 1) {
			const idx = r * cols + c;
			if (idx < sysCells) {
				rowDiamonds.push(themeFgRgb(theme, pal.accent, "◆"));
			} else if (idx < sysCells + msgCells) {
				rowDiamonds.push(themeFgRgb(theme, pal.accentBright, "◆"));
			} else if (idx < usedTotal) {
				rowDiamonds.push(themeFgRgb(theme, pal.info, "◆"));
			} else {
				rowDiamonds.push(themeFgRgb(theme, pal.freeBar, "◇"));
			}
		}
		lines.push(rowDiamonds.join(" "));
	}

	lines.push("");
	const labelCol = Math.max(16, Math.min(24, innerWidth - 22));
	const pct = (tokens: number) => `(${((tokens / win) * 100).toFixed(1)}%)`;
	const categoryRow = (dotRgb: RgbTuple | null, label: string, tokens: number): string => {
		const dot = dotRgb ? themeFgRgb(theme, dotRgb, "◆") : themeFgRgb(theme, pal.freeBar, "◇");
		const tokStr = t("context.tokensValue", { count: formatCompactTokens(tokens) });
		return `${dot} ${padRight(val(label), labelCol)}${dim(padLeft(tokStr, 13))}  ${dim(padLeft(pct(tokens), 7))}`;
	};

	lines.push(categoryRow(pal.accent, t("context.row.system"), data.systemTokens));
	lines.push(categoryRow(pal.accentBright, t("context.row.chat"), data.messageTokens));
	lines.push(categoryRow(pal.info, t("context.row.tools"), data.reasoningAndOverheadTokens));
	lines.push(categoryRow(null, t("context.row.free"), data.freeTokens));
	lines.push("");
	lines.push(dim(t("context.alreadyCounted")));
	lines.push(
		`${themeFgRgb(theme, pal.codeMetaFg, "◈")} ${padRight(val(t("context.row.toolDefs")), labelCol)}${dim(t("context.toolsCount", { count: data.toolCount }))}`,
	);
	lines.push(
		`${themeFgRgb(theme, pal.codeMetaFg, "◈")} ${padRight(val(t("context.row.skills")), labelCol)}${dim(t("context.skillsCount", { count: data.skillCount }))}`,
	);

	return lines;
}

function buildSessionUsageLines(
	telemetry: SessionTelemetrySummary,
	innerWidth: number,
	theme: Theme,
): string[] {
	const pal = getThemeSurfacePalette(theme);
	const dim = (s: string) => themeFgRgb(theme, pal.codeMetaFg, s);
	const bright = (s: string) => theme.bold(theme.fg("text", s));
	const val = (s: string) => theme.fg("text", s);
	const accent = (s: string) => themeFgRgb(theme, pal.accentBright, s);

	const cacheSuffix =
		telemetry.cacheReadTokens > 0
			? dim(t("context.usage.cachedSuffix", { count: formatIntegerCount(telemetry.cacheReadTokens) }))
			: "";
	const reasoningSuffix =
		telemetry.reasoningTokens > 0
			? dim(t("context.usage.reasoningSuffix", { count: formatIntegerCount(telemetry.reasoningTokens) }))
			: "";
	const apiTimeSuffix = dim(
		t("context.usage.apiTimeSuffix", { duration: formatMetricsDuration(telemetry.apiTimeMs) }),
	);

	const lines: string[] = [
		bright(t("context.usageHeader")),
		`  ${padRight(dim(t("context.usage.input")), 16)}${val(formatIntegerCount(telemetry.inputTokens))}${cacheSuffix}`,
		`  ${padRight(dim(t("context.usage.output")), 16)}${val(formatIntegerCount(telemetry.outputTokens))}${reasoningSuffix}`,
		`  ${padRight(dim(t("context.usage.total")), 16)}${val(formatIntegerCount(telemetry.totalTokens))}`,
		`  ${padRight(dim(t("context.usage.calls")), 16)}${val(String(telemetry.modelCalls))}${apiTimeSuffix}`,
		`  ${padRight(dim(t("context.usage.cost")), 16)}${val(`$${telemetry.costTotal.toFixed(4)}`)}`,
	];

	if (telemetry.modelGroups.length === 0 && telemetry.turnSummaries.length === 0) {
		lines.push("");
		lines.push(dim(t("context.usage.empty")));
		return lines;
	}

	if (telemetry.modelGroups.length > 0) {
		lines.push("");
		lines.push(bright(t("context.usage.byModel")));
		const modelCol = Math.max(14, Math.min(28, innerWidth - 36));
		lines.push(
			dim(
				`${padRight(t("context.usage.byModel"), modelCol)}  ${padLeft(t("context.usage.column.calls"), 5)}  ${padLeft(t("context.usage.column.ttft"), 7)}  ${padLeft(t("context.usage.column.rate"), 9)}  ${padLeft(t("context.usage.column.api"), 7)}`,
			),
		);
		for (const group of telemetry.modelGroups) {
			const ttft = group.medianTtftMs !== undefined ? formatMetricsDuration(group.medianTtftMs) : "-";
			const rateVal = group.medianStreamTps ?? group.medianEffectiveTps;
			const rate = rateVal !== undefined ? `${formatMetricsRate(rateVal)} t/s` : "-";
			const api = formatMetricsDuration(group.apiTimeMs);
			lines.push(
				`${val(padRight(group.label, modelCol))}  ${val(padLeft(String(group.calls), 5))}  ${dim(padLeft(ttft, 7))}  ${accent(padLeft(rate, 9))}  ${dim(padLeft(api, 7))}`,
			);
		}
	}

	if (telemetry.turnSummaries.length > 0) {
		lines.push("");
		lines.push(bright(t("context.usage.byTurn")));
		const turnModelCol = Math.max(12, Math.min(24, innerWidth - 34));
		lines.push(
			dim(
				`${padRight(t("context.usage.column.turn"), 5)}  ${padRight(t("context.usage.column.model"), turnModelCol)}  ${padLeft(t("context.usage.column.ttft"), 7)}  ${padLeft(t("context.usage.column.rate"), 9)}  ${padLeft(t("context.usage.column.duration"), 7)}`,
			),
		);
		for (const turn of telemetry.turnSummaries) {
			const ttft = turn.ttftMs !== undefined ? formatMetricsDuration(turn.ttftMs) : "-";
			const tps = turn.tps !== undefined ? `${formatMetricsRate(turn.tps)} t/s` : "-";
			const dur = formatMetricsDuration(turn.durationMs);
			lines.push(
				`${dim(padRight(`#${turn.turnIndex}`, 5))}  ${val(padRight(turn.model, turnModelCol))}  ${dim(padLeft(ttft, 7))}  ${accent(padLeft(tps, 9))}  ${dim(padLeft(dur, 7))}`,
			);
		}
	}

	return lines;
}

function buildSessionInfoLines(
	data: ContextWindowSnapshot,
	turnCount: number,
	theme: Theme,
): string[] {
	const pal = getThemeSurfacePalette(theme);
	const dim = (s: string) => themeFgRgb(theme, pal.codeMetaFg, s);
	const val = (s: string) => theme.fg("text", s);

	const contextSummary = `${formatIntegerCount(data.totalTokens)} / ${formatIntegerCount(data.contextWindow)} tokens (${data.percent.toFixed(1)}%)`;

	return [
		`${dim(`${t("context.info.title")}:`)}`,
		`  ${val(data.sessionTitle)}`,
		`${dim(`${t("context.info.piVersion")}:`)} ${val(VERSION)}`,
		`${dim(`${t("context.info.sessionId")}:`)}`,
		`  ${val(data.sessionId)}`,
		`${dim(`${t("context.info.workingDir")}:`)}`,
		`  ${val(data.workingDir)}`,
		`${dim(`${t("context.info.model")}:`)} ${val(data.modelLabel)}`,
		`${dim(`${t("context.info.turn")}:`)} ${val(String(turnCount))}`,
		`${dim(`${t("context.info.context")}:`)} ${val(contextSummary)}`,
	];
}

function formatSessionInfoClipboardText(data: ContextWindowSnapshot, turnCount: number): string {
	return [
		`${t("context.info.title")}: ${data.sessionTitle}`,
		`${t("context.info.piVersion")}: ${VERSION}`,
		`${t("context.info.sessionId")}: ${data.sessionId}`,
		`${t("context.info.workingDir")}: ${data.workingDir}`,
		`${t("context.info.model")}: ${data.modelLabel}`,
		`${t("context.info.turn")}: ${turnCount}`,
		`${t("context.info.context")}: ${formatIntegerCount(data.totalTokens)} / ${formatIntegerCount(data.contextWindow)} tokens (${data.percent.toFixed(1)}%)`,
	].join("\n");
}

export async function showContextInspector(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialTab: ContextInspectorTab = "context",
): Promise<void> {
	if (ctx.mode !== "tui") return;

	const entries = ctx.sessionManager.getEntries();
	const branch = ctx.sessionManager.getBranch();
	const data = buildContextWindowSnapshot(pi, ctx, branch);
	const telemetry = aggregateSessionTelemetry(branch, data.modelLabel, entries);
	const markdownTable = buildSessionUsageMarkdownTable(telemetry);
	const sessionInfoText = formatSessionInfoClipboardText(data, telemetry.turnCount);

	await openModalCard<void>(
		ctx,
		(tui, theme, _kb, done) => {
			const card = createModalCard();
			let activeTab: ContextInspectorTab = initialTab;
			let scrollOffset = 0;
			let maxScrollOffset = 0;
			let copiedBadge: "markdown" | "all" | "id" | null = null;
			let copiedTimer: ReturnType<typeof setTimeout> | undefined;
			let hoveredTabId: ContextInspectorTab | null = null;
			let tabHits: HitBox[] = [];
			const tabHoverOwner = {};

			const clearCopiedTimer = () => {
				if (copiedTimer !== undefined) {
					clearTimeout(copiedTimer);
					copiedTimer = undefined;
				}
			};

			const flashCopied = (kind: "markdown" | "all" | "id") => {
				clearCopiedTimer();
				copiedBadge = kind;
				tui.requestRender();
				copiedTimer = setTimeout(() => {
					if (copiedBadge === kind) {
						copiedBadge = null;
						tui.requestRender();
					}
					copiedTimer = undefined;
				}, 1500);
			};

			const copyMarkdownSummary = () => {
				copyToClipboard(markdownTable);
				flashCopied("markdown");
			};

			const copySessionId = () => {
				copyToClipboard(data.sessionId);
				flashCopied("id");
			};

			const copyAllSessionInfo = () => {
				copyToClipboard(sessionInfoText);
				flashCopied("all");
			};

			const switchTab = (next: ContextInspectorTab) => {
				if (activeTab === next) return;
				activeTab = next;
				scrollOffset = 0;
				tui.requestRender();
			};

			const stepTab = (delta: 1 | -1) => {
				const idx = TABS.findIndex((tab) => tab.id === activeTab);
				const next = TABS[(idx + delta + TABS.length) % TABS.length]!.id;
				switchTab(next);
			};

			const closeModal = () => {
				clearCopiedTimer();
				done(undefined);
			};

			const comp: Component & {
				handleInput?(input: string): void;
				handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
			} = {
				invalidate() {},
				render(width: number): string[] {
					const pal = getThemeSurfacePalette(theme);
					const safeWidth = Math.max(24, width);
					const innerWidth = Math.max(20, safeWidth - 4);
					const dim = (s: string) => themeFgRgb(theme, pal.codeMetaFg, s);

					tabHits = [];
					const tabParts: string[] = [];
					let cursorX = 0;
					for (let i = 0; i < TABS.length; i += 1) {
						const tab = TABS[i]!;
						const label = t(tab.labelKey);
						const isActive = activeTab === tab.id;
						const isHovered = hoveredTabId === tab.id;
						const styled = isActive
							? theme.bold(themeFgRgb(theme, pal.accentBright, label))
							: isHovered
								? theme.fg("text", label)
								: dim(label);
						const labelW = visibleWidth(label);
						/* Модальная рамка добавляет "│ " слева (2 колонки), верхняя рамка занимает y = 0 */
						tabHits.push({
							id: tab.id,
							xStart: 2 + cursorX,
							xEnd: 2 + cursorX + labelW,
							y: 1,
							onClick: () => switchTab(tab.id),
						});
						tabParts.push(styled);
						cursorX += labelW + 3;
					}
					const tabBarRow = tabParts.join("   ");
					const dividerRow = theme.fg("borderMuted", "─".repeat(innerWidth));

					const allContentLines =
						activeTab === "context"
							? buildContextUsageLines(data, innerWidth, theme)
							: activeTab === "usage"
								? buildSessionUsageLines(telemetry, innerWidth, theme)
								: buildSessionInfoLines(data, telemetry.turnCount, theme);

					const termRows = tui.terminal?.rows ?? 32;
					const maxVisibleBody = Math.max(6, Math.min(18, termRows - 10));
					maxScrollOffset = Math.max(0, allContentLines.length - maxVisibleBody);
					scrollOffset = Math.max(0, Math.min(scrollOffset, maxScrollOffset));
					const visibleContent = allContentLines.slice(scrollOffset, scrollOffset + maxVisibleBody);

					const headerMeta =
						maxScrollOffset > 0
							? dim(
									`${scrollOffset + 1}..${Math.min(allContentLines.length, scrollOffset + maxVisibleBody)}/${allContentLines.length}`,
								)
							: undefined;

					const footerPills: ModalActionPill[] = [];
					if (activeTab === "usage") {
						footerPills.push({
							id: "copy-markdown",
							label:
								copiedBadge === "markdown"
									? t("context.pill.copiedMarkdown")
									: t("context.pill.copyMarkdown"),
							variant: copiedBadge === "markdown" ? "success" : "primary",
							active: true,
							onClick: copyMarkdownSummary,
						});
					} else if (activeTab === "session") {
						footerPills.push({
							id: "copy-all",
							label:
								copiedBadge === "all" ? t("context.pill.copiedAll") : t("context.pill.copyAll"),
							variant: copiedBadge === "all" ? "success" : "primary",
							active: true,
							onClick: copyAllSessionInfo,
						});
						footerPills.push({
							id: "copy-id",
							label:
								copiedBadge === "id" ? t("context.pill.copiedId") : t("context.pill.copyId"),
							variant: copiedBadge === "id" ? "success" : "secondary",
							onClick: copySessionId,
						});
					} else {
						footerPills.push({
							id: "copy-id",
							label:
								copiedBadge === "id" ? t("context.pill.copiedId") : t("context.pill.copyId"),
							variant: copiedBadge === "id" ? "success" : "secondary",
							onClick: copySessionId,
						});
					}
					footerPills.push({
						id: "close",
						label: t("context.pill.close"),
						variant: "neutral",
						onClick: closeModal,
					});

					return card.render(safeWidth, theme, {
						title: fgRgb(pal.accentBright, theme.bold(t("context.title"))),
						headerMeta,
						closable: true,
						onClose: closeModal,
						bodyLines: [tabBarRow, dividerRow, ...visibleContent],
						borderVariant: "primary",
						footerPills,
					});
				},
				handleInput(input: string): void {
					if (isKeyRelease(input)) return;
					if (matchesKey(input, "escape") || input === "q" || input === "Q") {
						closeModal();
						return;
					}
					if (matchesKey(input, "tab") || matchesKey(input, "right")) {
						stepTab(1);
						return;
					}
					if (matchesKey(input, "shift+tab") || matchesKey(input, "left")) {
						stepTab(-1);
						return;
					}
					if (matchesKey(input, "up")) {
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(input, "down")) {
						scrollOffset = Math.min(maxScrollOffset, scrollOffset + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(input, "pageUp")) {
						scrollOffset = Math.max(0, scrollOffset - 6);
						tui.requestRender();
						return;
					}
					if (matchesKey(input, "pageDown")) {
						scrollOffset = Math.min(maxScrollOffset, scrollOffset + 6);
						tui.requestRender();
						return;
					}
					if (input === "m" || input === "M") {
						copyMarkdownSummary();
						return;
					}
					if (input === "y" || input === "Y") {
						copyAllSessionInfo();
						return;
					}
					if (input === "c" || input === "C") {
						copySessionId();
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.type === "wheel" && event.wheelDelta) {
						const delta = event.wheelDelta < 0 ? -2 : 2;
						const next = Math.max(0, Math.min(maxScrollOffset, scrollOffset + delta));
						const changed = next !== scrollOffset;
						scrollOffset = next;
						return { handled: true, render: changed };
					}

					const hitTab = tabHits.find(
						(h) => event.y === h.y && event.x >= h.xStart && event.x < h.xEnd,
					);

					if (event.type === "move") {
						const cardOutcome = card.handleMouse(event);
						const nextTabHover = hitTab ? (hitTab.id as ContextInspectorTab) : null;
						if (nextTabHover !== null) {
							claimHover(tabHoverOwner, () => {
								if (hoveredTabId !== null) {
									hoveredTabId = null;
									tui.requestRender();
								}
							});
						}
						const tabChanged = nextTabHover !== hoveredTabId;
						hoveredTabId = nextTabHover;
						return { handled: true, render: cardOutcome.render || tabChanged };
					}

					if (event.button === "left") {
						if (event.type === "press" && hitTab) {
							return { handled: true, render: false };
						}
						if (event.type === "click" && hitTab) {
							hitTab.onClick();
							return { handled: true, render: true };
						}
					}

					const cardOutcome = card.handleMouse(event);
					return { handled: true, render: cardOutcome.render };
				},
			};

			return comp;
		},
		{ width: 76, minWidth: 44, anchor: "center", margin: 2 },
	);
}

export function registerContextInspectorFeature(pi: ExtensionAPI): void {
	installLegacyMetricsAndWorkingSuperseder();

	let activeCtx: ExtensionContext | undefined;
	let tuiActive = false;
	let activeStepTiming: ActiveStepTiming | undefined;
	let finalizedStepTiming: FinalizedStepTiming | undefined;
	let activeThinkingLevel: string | undefined;
	let turnUserSubmittedAt: number | undefined;

	const openSessionUsageTab = () => {
		if (activeCtx) {
			void showContextInspector(pi, activeCtx, "usage");
		}
	};

	const metricsRowCache = new WeakMap<object, ResponseMetricsRowComponent>();

	withConartiInternalRegistration(() => {
		const metricsRenderer: EntryRenderer<ResponseMetricsData> = markOwnedEntryRenderer(
			(entry, _options, theme) => {
				const data = normalizeResponseMetricsEntry(entry.data);
				if (!data) {
					return undefined;
				}
				const cfg = loadPiUiUserConfig();
				if (data.stopReason === "toolUse") {
					if (!cfg.responseMetrics || !isPositiveCount(data.outputTokens)) {
						return undefined;
					}
				} else if (!cfg.responseMetrics && !formatCompletionTimestamp(data.completedAt, cfg.timestamps)) {
					return undefined;
				}
				const existing = metricsRowCache.get(entry);
				if (existing) {
					existing.setTheme(theme);
					return existing;
				}
				const created = new ResponseMetricsRowComponent(
					data,
					theme,
					openSessionUsageTab,
					() => resolveTurnTtft(activeCtx?.sessionManager.getBranch() ?? [], entry.id),
				);
				metricsRowCache.set(entry, created);
				return created;
			},
		);

		const legacyStampRenderer: EntryRenderer<unknown> = markOwnedEntryRenderer(
			(entry, _options, theme) => {
				const normalized = normalizeLegacyPiStamp(entry.data);
				if (!normalized || "userTimestamp" in normalized) {
					return undefined;
				}
				const cfg = loadPiUiUserConfig();
				if (normalized.stopReason === "toolUse") {
					if (!cfg.responseMetrics || !isPositiveCount(normalized.outputTokens)) {
						return undefined;
					}
				} else if (
					!cfg.responseMetrics &&
					!formatCompletionTimestamp(normalized.completedAt, cfg.timestamps)
				) {
					return undefined;
				}
				const existing = metricsRowCache.get(entry);
				if (existing) {
					existing.setTheme(theme);
					return existing;
				}
				const created = new ResponseMetricsRowComponent(
					normalized,
					theme,
					openSessionUsageTab,
					() => resolveTurnTtft(activeCtx?.sessionManager.getBranch() ?? [], entry.id),
				);
				metricsRowCache.set(entry, created);
				return created;
			},
		);

		pi.registerEntryRenderer(METRICS_ENTRY_TYPE, metricsRenderer);
		pi.registerEntryRenderer(LEGACY_STAMP_ENTRY_TYPE, legacyStampRenderer);

		pi.on("session_start", (_event, ctx) => {
			activeCtx = ctx;
			tuiActive = ctx.mode === "tui";
			activeStepTiming = undefined;
			finalizedStepTiming = undefined;
			activeThinkingLevel = undefined;
			turnUserSubmittedAt = undefined;
		});

		pi.on("agent_start", (_event, ctx) => {
			activeCtx = ctx;
			if (turnUserSubmittedAt === undefined) {
				turnUserSubmittedAt = Date.now();
			}
		});

		pi.on("turn_start", (_event, ctx) => {
			activeCtx = ctx;
			activeStepTiming = undefined;
			finalizedStepTiming = undefined;
			activeThinkingLevel =
				typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
		});

		pi.on("message_start", (event) => {
			if (!tuiActive) return;
			if (event.message.role === "user") {
				turnUserSubmittedAt = isValidMs(event.message.timestamp)
					? event.message.timestamp
					: Date.now();
				return;
			}
			if (event.message.role === "assistant" && isValidMs(event.message.timestamp)) {
				activeStepTiming = {
					timestamp: event.message.timestamp,
					replayToolWaitMs: 0,
					toolExecutionMs: 0,
					streamedThinkingChars: 0,
					streamDeltaCount: 0,
				};
				finalizedStepTiming = undefined;
			}
		});

		pi.on("message_update", (event) => {
			if (!tuiActive || event.message.role !== "assistant") return;
			if (!activeStepTiming || activeStepTiming.timestamp !== event.message.timestamp) return;

			const now = Date.now();
			const subEvent = event.assistantMessageEvent;
			if (activeStepTiming.firstContentAt === undefined && isMeaningfulAssistantUpdate(subEvent)) {
				activeStepTiming.firstContentAt = now;
			}
			if (activeStepTiming.firstTextAt === undefined && isTextAssistantUpdate(subEvent)) {
				activeStepTiming.firstTextAt = now;
			}
			if (isRecord(subEvent) && typeof subEvent.type === "string") {
				if (
					(subEvent.type === "thinking_delta" ||
						subEvent.type === "text_delta" ||
						subEvent.type === "toolcall_delta") &&
					typeof subEvent.delta === "string" &&
					subEvent.delta.length > 0
				) {
					activeStepTiming.lastContentAt = now;
					activeStepTiming.streamDeltaCount += 1;
					if (subEvent.type === "thinking_delta") {
						activeStepTiming.streamedThinkingChars += subEvent.delta.length;
					} else if (subEvent.type === "toolcall_delta") {
						activeStepTiming.lastToolcallDeltaAt = now;
					}
				} else if (subEvent.type === "toolcall_end") {
					if (
						activeStepTiming.lastToolcallDeltaAt !== undefined &&
						now - activeStepTiming.lastToolcallDeltaAt >= 50
					) {
						activeStepTiming.replayToolWaitMs += now - activeStepTiming.lastToolcallDeltaAt;
					}
					activeStepTiming.lastToolcallDeltaAt = undefined;
				} else if (
					(subEvent.type === "text_end" || subEvent.type === "thinking_end") &&
					typeof subEvent.content === "string" &&
					subEvent.content.length > 0
				) {
					activeStepTiming.lastContentAt = now;
				}
			}
		});

		pi.on("tool_execution_start", () => {
			if (!tuiActive || !activeStepTiming) return;
			if (activeStepTiming.toolExecutionStartedAt === undefined) {
				activeStepTiming.toolExecutionStartedAt = Date.now();
			}
		});

		pi.on("tool_execution_end", () => {
			if (!tuiActive || !activeStepTiming) return;
			if (activeStepTiming.toolExecutionStartedAt !== undefined) {
				activeStepTiming.toolExecutionMs += Math.max(
					0,
					Date.now() - activeStepTiming.toolExecutionStartedAt,
				);
				activeStepTiming.toolExecutionStartedAt = undefined;
			}
		});

		pi.on("message_end", (event, ctx) => {
			if (!tuiActive || event.message.role !== "assistant" || !isValidMs(event.message.timestamp)) {
				return;
			}
			const completedAt = Math.max(event.message.timestamp, Date.now());
			const matching =
				activeStepTiming?.timestamp === event.message.timestamp ? activeStepTiming : undefined;
			if (matching?.toolExecutionStartedAt !== undefined) {
				matching.toolExecutionMs += Math.max(0, completedAt - matching.toolExecutionStartedAt);
				matching.toolExecutionStartedAt = undefined;
			}
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
			const lastContentAt =
				matching?.lastContentAt !== undefined &&
				matching.lastContentAt >= event.message.timestamp &&
				matching.lastContentAt <= completedAt
					? matching.lastContentAt
					: undefined;
			const totalToolWaitMs =
				(matching?.toolExecutionMs ?? 0) + (matching?.replayToolWaitMs ?? 0);

			const branchElapsed = elapsedSinceLastUser(ctx.sessionManager.getBranch(), completedAt);
			const trackedElapsed =
				turnUserSubmittedAt !== undefined && turnUserSubmittedAt <= completedAt
					? completedAt - turnUserSubmittedAt
					: undefined;
			const timeSinceUserMs = branchElapsed ?? trackedElapsed;

			finalizedStepTiming = {
				timestamp: event.message.timestamp,
				completedAt,
				...(firstContentAt !== undefined ? { firstContentAt } : {}),
				...(firstTextAt !== undefined ? { firstTextAt } : {}),
				...(lastContentAt !== undefined ? { lastContentAt } : {}),
				...(totalToolWaitMs > 0 ? { toolExecutionMs: totalToolWaitMs } : {}),
				streamedThinkingChars: matching?.streamedThinkingChars ?? 0,
				streamDeltaCount: matching?.streamDeltaCount ?? 0,
				...(timeSinceUserMs !== undefined ? { timeSinceUserMs } : {}),
			};
			activeStepTiming = undefined;
		});

		pi.on("turn_end", (event) => {
			const timing = finalizedStepTiming;
			const thinkingLevel = activeThinkingLevel;
			activeStepTiming = undefined;
			finalizedStepTiming = undefined;
			activeThinkingLevel = undefined;

			if (!tuiActive || event.message.role !== "assistant") return;
			if (!timing || timing.timestamp !== event.message.timestamp) return;

			const stopReason =
				isRecord(event.message) && typeof event.message.stopReason === "string"
					? event.message.stopReason
					: undefined;
			const isFinalTurn = stopReason !== "toolUse";
			const usage = extractAssistantUsage(event.message);
			const model =
				isRecord(event.message) && typeof event.message.model === "string"
					? event.message.model
					: undefined;

			const entry: ResponseMetricsData = {
				version: 1,
				timestamp: timing.timestamp,
				completedAt: timing.completedAt,
				...(timing.firstContentAt !== undefined ? { firstContentAt: timing.firstContentAt } : {}),
				...(timing.firstTextAt !== undefined ? { firstTextAt: timing.firstTextAt } : {}),
				...(timing.lastContentAt !== undefined ? { lastContentAt: timing.lastContentAt } : {}),
				...(timing.toolExecutionMs !== undefined && timing.toolExecutionMs > 0
					? { toolExecutionMs: timing.toolExecutionMs }
					: {}),
				streamedThinkingChars: timing.streamedThinkingChars,
				streamDeltaCount: timing.streamDeltaCount,
				...(isFinalTurn && timing.timeSinceUserMs !== undefined
					? { timeSinceUserMs: timing.timeSinceUserMs }
					: {}),
				...usage,
				...(model !== undefined ? { model } : {}),
				...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
				...(stopReason !== undefined ? { stopReason } : {}),
			};

			pi.appendEntry<ResponseMetricsData>(METRICS_ENTRY_TYPE, entry);
		});

		pi.on("agent_end", () => {
			activeStepTiming = undefined;
			finalizedStepTiming = undefined;
			activeThinkingLevel = undefined;
			turnUserSubmittedAt = undefined;
		});

		pi.on("session_shutdown", () => {
			tuiActive = false;
			activeCtx = undefined;
			activeStepTiming = undefined;
			finalizedStepTiming = undefined;
			activeThinkingLevel = undefined;
			turnUserSubmittedAt = undefined;
		});

		pi.registerCommand("context", {
			description: t("context.command"),
			handler: async (_args, ctx) => {
				activeCtx = ctx;
				await showContextInspector(pi, ctx, "context");
			},
		});

		pi.registerCommand("stats", {
			description: t("context.statsCommand"),
			handler: async (_args, ctx) => {
				activeCtx = ctx;
				await showContextInspector(pi, ctx, "usage");
			},
		});

		pi.registerCommand("metrics", {
			description: t("context.metricsCommand"),
			getArgumentCompletions: (prefix) => {
				const typed = prefix.trimStart().toLowerCase();
				const choices = ["on", "off", "toggle"];
				const items = choices
					.filter((choice) => choice.startsWith(typed) && choice !== typed.trimEnd())
					.map((choice) => ({ value: choice, label: choice }));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				activeCtx = ctx;
				const trimmed = args.trim().toLowerCase();
				if (trimmed === "on" || trimmed === "true") {
					updatePiUiUserConfig({ responseMetrics: true });
					invalidateResponseMetricsRows();
					ctx.ui.notify(t("metrics.enabledNotify"), "info");
					return;
				}
				if (trimmed === "off" || trimmed === "false") {
					updatePiUiUserConfig({ responseMetrics: false });
					invalidateResponseMetricsRows();
					ctx.ui.notify(t("metrics.disabledNotify"), "info");
					return;
				}
				if (trimmed === "toggle") {
					const next = !loadPiUiUserConfig().responseMetrics;
					updatePiUiUserConfig({ responseMetrics: next });
					invalidateResponseMetricsRows();
					ctx.ui.notify(next ? t("metrics.enabledNotify") : t("metrics.disabledNotify"), "info");
					return;
				}
				if (trimmed !== "") {
					ctx.ui.notify(t("metrics.usageNotify"), "warning");
					return;
				}
				await showContextInspector(pi, ctx, "usage");
			},
		});
	});
}
