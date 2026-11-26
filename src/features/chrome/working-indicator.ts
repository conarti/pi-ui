import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	POLARIS_STAR,
	activateAnimationSurface,
	deactivateAnimationSurface,
	getAnimationElapsedMs,
	paintGlimmerSweepText,
	renderComposerWorkingFrame,
	stopAllAnimations,
	type WaveSampleOptions,
} from "../../shared/animation-scheduler.ts";
import { fgRgb, getActiveGlobalTheme, isLightTheme, type HitBox } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { t } from "../../shared/i18n.ts";
import {
	isSlotOwnedByPiUi,
	PI_UI_OWNER_ID,
	registerSlotOwnershipChangeListener,
} from "../../shared/slot-arbitration.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";

const COMPOSER_SURFACE_KEY = "composer.working-indicator";
const WORKING_CONTROLLER_KEY = Symbol.for("conarti.pi-ui.composer-working-controller.v2");

export const WORKING_CONTEXTUAL_HOLD_MS = 4500;
export const WORKING_TOOL_COMPLETION_HOLD_MS = 1800;

export const WORKING_VERBS: readonly string[] = [
	"Tinkering…",
	"Simmering…",
	"Unspooling…",
	"Dovetailing…",
	"Steeping…",
	"Refracting…",
	"Whittling…",
	"Sifting…",
	"Triangulating…",
	"Burnishing…",
	"Noodling…",
	"Distilling…",
	"Spelunking…",
	"Weaving…",
	"Percolating…",
	"Sketching…",
	"Tempering…",
	"Untangling…",
	"Decanting…",
	"Stargazing…",
	"Kneading…",
	"Charting…",
	"Riffing…",
	"Sculpting…",
	"Infusing…",
	"Mulling…",
	"Calibrating…",
	"Forging…",
];

export type WorkingPhase = "idle" | "ttft" | "thinking" | "tool" | "text";

export interface WorkingStatusSnapshot {
	readonly active: boolean;
	readonly phase: WorkingPhase;
	readonly label: string;
	readonly turnVerb: string;
	readonly elapsedMs: number;
	readonly elapsedText: string;
}

function cleanActionText(raw: string, maxChars = 46): string | undefined {
	const cleaned = stripTerminalSequences(raw)
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/[*_#~[\]()]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
	if (!cleaned) return undefined;
	if (cleaned.length <= maxChars) return cleaned;
	const cut = cleaned.slice(0, maxChars - 1).replace(/\s+\S*$/u, "");
	return `${cut || cleaned.slice(0, maxChars - 1)}…`;
}

function ensureEllipsis(text: string): string {
	const trimmed = text.replace(/\.{3}$/u, "…").trim();
	if (!trimmed) return "";
	return trimmed.endsWith("…") ? trimmed : `${trimmed}…`;
}

/**
 * Извлекает последний явный заголовок (`**Heading**` или `### Heading`) из потока мыслей вне fenced-блоков
 * без фонового расхода токенов.
 */
export function extractThinkingHeading(rawThinking: string): string | undefined {
	if (!rawThinking || !rawThinking.trim()) return undefined;
	const lines = rawThinking.replace(/\r\n?/gu, "\n").split("\n");
	let inFence = false;
	let latest: string | undefined;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^(?:`{3,}|~{3,})/u.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const boldMatch = /^\*\*([^*]{3,60})\*\*(?::|\s|$)/u.exec(line);
		if (boldMatch?.[1]) {
			const cleaned = cleanActionText(boldMatch[1], 44);
			if (cleaned) latest = ensureEllipsis(cleaned);
			continue;
		}

		const mdMatch = /^#{1,6}\s+(.{3,60})$/u.exec(line);
		if (mdMatch?.[1]) {
			const cleaned = cleanActionText(mdMatch[1], 44);
			if (cleaned) latest = ensureEllipsis(cleaned);
		}
	}

	return latest;
}

function formatRelativeTargetPath(rawPath: unknown, cwd?: string): string | undefined {
	if (typeof rawPath !== "string") return undefined;
	const trimmed = rawPath.trim().replace(/^@/u, "");
	if (!trimmed) return undefined;
	const home = homedir();
	let display = trimmed;
	if (cwd && isAbsolute(trimmed)) {
		const rel = relative(cwd, trimmed);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
			display = rel;
		}
	}
	if (display === home) {
		display = "~";
	} else if (display.startsWith(`${home}/`) || display.startsWith(`${home}\\`)) {
		display = `~/${display.slice(home.length + 1)}`;
	}
	display = display.replaceAll("\\", "/").replace(/^\.\//u, "");
	return truncateToWidth(display, 34, "…");
}

function humanizeToolName(toolName: string, args: Record<string, unknown>): string {
	const routed =
		(toolName === "mcp" || toolName.startsWith("mcp__")) && typeof args.tool === "string"
			? args.tool
			: toolName;
	return stripTerminalSequences(routed)
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/^mcp__/iu, "")
		.replace(/[_-]mcp$/iu, "")
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.replace(/([a-z\d])([A-Z])/gu, "$1 $2")
		.replace(/[_-]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * Формирует человекочитаемое описание шага инструмента для строки `Working`:
 * приоритет у `toolSummary`/`toolAction`, иначе семантическое действие с относительным путём.
 */
export function formatWorkingToolAction(
	toolName: string,
	rawArgs: unknown,
	cwd?: string,
): string {
	const args =
		typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};

	const explicitSummary =
		typeof args.toolSummary === "string"
			? args.toolSummary
			: typeof args.toolAction === "string"
				? args.toolAction
				: undefined;
	if (explicitSummary) {
		const cleaned = cleanActionText(explicitSummary, 46);
		if (cleaned) return ensureEllipsis(cleaned);
	}

	const relPath = formatRelativeTargetPath(args.path ?? args.file_path ?? args.target, cwd);
	switch (toolName) {
		case "read":
			return relPath ? t("working.reading", { target: relPath }) : t("working.readingFile");
		case "edit":
			return relPath ? t("working.editing", { target: relPath }) : t("working.editingFile");
		case "write":
			return relPath ? t("working.writing", { target: relPath }) : t("working.writingFile");
		case "grep": {
			const pat = typeof args.pattern === "string" ? cleanActionText(args.pattern, 24) : undefined;
			const target = pat || relPath;
			return target ? t("working.searching", { target }) : t("working.searchingFiles");
		}
		case "find": {
			const pat = typeof args.pattern === "string" ? cleanActionText(args.pattern, 24) : undefined;
			const target = pat || relPath;
			return target ? t("working.finding", { target }) : t("working.findingFiles");
		}
		case "ls":
			return relPath ? t("working.listing", { target: relPath }) : t("working.listingDirectory");
		case "bash":
		case "powershell": {
			const cmd =
				typeof args.command === "string"
					? cleanActionText(args.command.split("\n")[0] ?? "", 34)
					: undefined;
			return cmd ? t("working.running", { target: cmd }) : t("working.runningCommand");
		}
		case "codemode":
			return t("working.runningBatch");
		default: {
			const label = humanizeToolName(toolName, args);
			return label ? ensureEllipsis(truncateToWidth(t("working.using", { target: label }), 44, "…")) : t("working.runningTool");
		}
	}
}

export function formatWorkingElapsed(elapsedMs: number): string {
	if (!Number.isFinite(elapsedMs) || elapsedMs < 100) return "0.1s";
	if (elapsedMs < 10_000) return `${(elapsedMs / 1000).toFixed(1)}s`;
	if (elapsedMs < 60_000) return `${Math.round(elapsedMs / 1000)}s`;
	const totalSec = Math.floor(elapsedMs / 1000);
	const mins = Math.floor(totalSec / 60);
	const rem = totalSec % 60;
	return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

export class WorkingStatusController {
	private phase: WorkingPhase = "idle";
	private turnStartedAt: number | undefined;
	private turnVerbSeed = Math.floor(Math.random() * WORKING_VERBS.length);
	private currentTurnVerb = WORKING_VERBS[0]!;
	private contextualSummary: string | undefined;
	private contextualUpdatedAt: number | undefined;
	private contextualExpiresAt: number | undefined;
	private readonly activeTools = new Map<string, string>();

	isActive(): boolean {
		return this.phase !== "idle";
	}

	beginTurn(now = Date.now()): void {
		this.phase = "ttft";
		this.turnStartedAt = now;
		this.turnVerbSeed = (this.turnVerbSeed + 5 + Math.floor(Math.abs(now) % 7)) % WORKING_VERBS.length;
		this.currentTurnVerb = WORKING_VERBS[this.turnVerbSeed] ?? WORKING_VERBS[0]!;
		this.contextualSummary = undefined;
		this.contextualUpdatedAt = undefined;
		this.contextualExpiresAt = undefined;
		this.activeTools.clear();
	}

	onThinkingDelta(fullThinkingText: string, now = Date.now()): void {
		if (this.phase === "idle") {
			this.beginTurn(now);
		}
		this.phase = "thinking";
		const heading = extractThinkingHeading(fullThinkingText);
		if (heading) {
			this.tryAdoptContextualSummary(heading, now);
		}
	}

	onToolStart(
		toolCallId: string,
		toolName: string,
		args: unknown,
		cwd?: string,
		now = Date.now(),
	): void {
		if (this.phase === "idle") {
			this.beginTurn(now);
		}
		this.phase = "tool";
		const action = formatWorkingToolAction(toolName, args, cwd);
		this.activeTools.set(toolCallId, action);
		this.tryAdoptContextualSummary(action, now);
	}

	onToolEnd(toolCallId: string, now = Date.now()): void {
		this.activeTools.delete(toolCallId);
		if (this.phase === "idle") return;
		const remaining = [...this.activeTools.values()].at(-1);
		if (remaining) {
			this.tryAdoptContextualSummary(remaining, now);
			return;
		}
		if (this.contextualSummary) {
			this.contextualExpiresAt = Math.max(
				now + WORKING_TOOL_COMPLETION_HOLD_MS,
				(this.contextualUpdatedAt ?? now) + WORKING_CONTEXTUAL_HOLD_MS,
			);
		}
	}

	onTextStream(now = Date.now()): void {
		if (this.phase === "idle") {
			this.beginTurn(now);
		}
		this.phase = "text";
		this.contextualSummary = t("working.drafting");
		this.contextualUpdatedAt = now;
		this.contextualExpiresAt = undefined;
	}

	endTurn(): void {
		this.phase = "idle";
		this.turnStartedAt = undefined;
		this.contextualSummary = undefined;
		this.contextualUpdatedAt = undefined;
		this.contextualExpiresAt = undefined;
		this.activeTools.clear();
	}

	snapshot(now = Date.now()): WorkingStatusSnapshot {
		if (this.phase === "idle") {
			return {
				active: false,
				phase: "idle",
				label: "",
				turnVerb: this.currentTurnVerb,
				elapsedMs: 0,
				elapsedText: "0.1s",
			};
		}

		if (
			this.contextualSummary &&
			this.contextualExpiresAt !== undefined &&
			now >= this.contextualExpiresAt
		) {
			this.contextualSummary = undefined;
			this.contextualUpdatedAt = undefined;
			this.contextualExpiresAt = undefined;
		}

		const elapsedMs =
			this.turnStartedAt !== undefined ? Math.max(0, now - this.turnStartedAt) : 0;
		const label =
			this.phase === "text"
				? t("working.drafting")
				: this.contextualSummary ?? this.currentTurnVerb;

		return {
			active: true,
			phase: this.phase,
			label,
			turnVerb: this.currentTurnVerb,
			elapsedMs,
			elapsedText: formatWorkingElapsed(elapsedMs),
		};
	}

	private tryAdoptContextualSummary(nextSummary: string, now: number): void {
		if (
			this.contextualSummary &&
			this.contextualExpiresAt !== undefined &&
			now >= this.contextualExpiresAt
		) {
			this.contextualSummary = undefined;
			this.contextualUpdatedAt = undefined;
			this.contextualExpiresAt = undefined;
		}
		if (this.contextualSummary === nextSummary) {
			this.contextualExpiresAt = undefined;
			return;
		}
		if (
			this.contextualSummary &&
			this.contextualUpdatedAt !== undefined &&
			now - this.contextualUpdatedAt < WORKING_CONTEXTUAL_HOLD_MS
		) {
			return;
		}
		this.contextualSummary = nextSummary;
		this.contextualUpdatedAt = now;
		this.contextualExpiresAt = undefined;
	}
}

interface ComposerWorkingState {
	ctx?: ExtensionContext;
	suppressed?: boolean;
	controller: WorkingStatusController;
}

function getWorkingState(): ComposerWorkingState {
	const g = globalThis as Record<symbol, ComposerWorkingState | undefined>;
	if (!g[WORKING_CONTROLLER_KEY]) {
		g[WORKING_CONTROLLER_KEY] = {
			controller: new WorkingStatusController(),
		};
	}
	return g[WORKING_CONTROLLER_KEY]!;
}

export function getWorkingStatusController(): WorkingStatusController {
	return getWorkingState().controller;
}

export function isComposerWorkingSuppressed(): boolean {
	return getWorkingState().suppressed === true || !isSlotOwnedByPiUi("workingIndicator");
}

export function buildWaveIndicator(options?: WaveSampleOptions): WorkingIndicatorOptions {
	return {
		frames: [renderComposerWorkingFrame(options)],
	};
}

export interface RenderWorkingRowOptions {
	readonly theme?: Theme;
	readonly now?: number;
	readonly animElapsedMs?: number;
	readonly snapshot?: WorkingStatusSnapshot;
	readonly stopHovered?: boolean;
	readonly customText?: string;
	readonly onStop?: () => void;
}

/**
 * Рендерит спокойную строку статуса `Working` над Composer:
 * слева с `x = 4` — `✦ <step>` с 30fps каустической волной, справа — `<turn elapsed> [stop]`.
 */
export function renderWorkingStatusRow(
	width: number,
	options: RenderWorkingRowOptions = {},
): { readonly line: string; readonly stopHit?: HitBox } {
	if (width <= 0) return { line: "" };
	const theme = options.theme ?? getActiveGlobalTheme();
	const light = isLightTheme(theme);
	const animMs = options.animElapsedMs ?? getAnimationElapsedMs();
	const snap = options.snapshot ?? getWorkingStatusController().snapshot(options.now);

	const outerPad = computeOuterCanvasMargin(width);
	const leftPad = Math.min(width - 1, outerPad + 2);
	const rightPad = outerPad;
	const leftMargin = " ".repeat(leftPad);
	const rightMargin = " ".repeat(rightPad);

	const stopLabel = t("working.stop");
	const elapsedPlain = snap.elapsedText;
	const stopStyled = options.stopHovered
		? light
			? fgRgb(220, 38, 38, stopLabel)
			: fgRgb(248, 113, 113, stopLabel)
		: light
			? fgRgb(100, 116, 139, stopLabel)
			: fgRgb(118, 134, 158, stopLabel);
	const elapsedStyled = light
		? fgRgb(124, 138, 160, elapsedPlain)
		: fgRgb(104, 118, 142, elapsedPlain);

	const rightCluster = `${elapsedStyled} ${stopStyled}`;
	const rightClusterW = visibleWidth(rightCluster);
	const stopW = visibleWidth(stopLabel);

	const innerAvail = Math.max(1, width - leftPad - rightPad);
	const showRight = innerAvail >= rightClusterW + 6;
	const minGap = showRight ? 2 : 0;
	const leftBudget = showRight ? Math.max(1, innerAvail - rightClusterW - minGap) : innerAvail;

	const rawStep = options.customText?.trim() || snap.label || WORKING_VERBS[0]!;
	const leftPlain = options.customText?.trim()
		? stripTerminalSequences(rawStep)
		: `${POLARIS_STAR} ${rawStep}`;
	const clippedLeft = truncateToWidth(leftPlain, leftBudget, "…");
	const leftStyled = options.customText?.trim()
		? truncateToWidth(options.customText.trim(), leftBudget, "…")
		: paintGlimmerSweepText(clippedLeft, {
				theme,
				light,
				elapsedMs: animMs,
				charsPerSecond: 17,
				leadPad: 7,
				trailPad: 13,
			});
	const leftW = visibleWidth(leftStyled);

	if (!showRight) {
		const row = `${leftMargin}${leftStyled}`;
		return {
			line: row + " ".repeat(Math.max(0, width - visibleWidth(row))),
		};
	}

	const gapSpaces = Math.max(1, width - leftPad - leftW - rightClusterW - rightPad);
	const stopXStart = leftPad + leftW + gapSpaces + visibleWidth(elapsedPlain) + 1;
	const stopHit: HitBox = {
		id: "working-stop",
		xStart: stopXStart,
		xEnd: stopXStart + stopW,
		onClick: () => {
			options.onStop?.();
		},
	};

	const line = `${leftMargin}${leftStyled}${" ".repeat(gapSpaces)}${rightCluster}${rightMargin}`;
	const padTail = Math.max(0, width - visibleWidth(line));
	return {
		line: padTail > 0 ? `${line}${" ".repeat(padTail)}` : line,
		stopHit,
	};
}

export function bindComposerWorkingIndicator(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const state = getWorkingState();
	state.ctx = ctx;
	deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
	if (state.suppressed) return;
	/* Однокадровый индикатор не запускает 80ms таймер в Loader хоста */
	ctx.ui.setWorkingIndicator(buildWaveIndicator({ theme: ctx.ui.theme }));
	if (ctx.isIdle?.() === false) {
		if (!state.controller.isActive()) {
			state.controller.beginTurn();
		}
		startComposerWorkingWave();
	}
}

export function setComposerWorkingSuppressed(suppressed: boolean, ctx?: ExtensionContext): void {
	const state = getWorkingState();
	state.suppressed = suppressed;
	if (suppressed) {
		deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
		return;
	}
	const targetCtx = ctx ?? state.ctx;
	if (targetCtx && targetCtx.mode === "tui" && targetCtx.hasUI) {
		targetCtx.ui.setWorkingIndicator(buildWaveIndicator({ theme: targetCtx.ui.theme }));
		if (targetCtx.isIdle?.() === false) {
			if (!state.controller.isActive()) {
				state.controller.beginTurn();
			}
			startComposerWorkingWave();
		}
	}
}

export function restoreDefaultWorkingIndicator(ctx?: ExtensionContext): void {
	const state = getWorkingState();
	if (state.ctx && (!ctx || state.ctx === ctx)) {
		setComposerWorkingSuppressed(false, ctx ?? state.ctx);
		return;
	}
	state.suppressed = false;
	ctx?.ui.setWorkingIndicator();
}

export function startComposerWorkingWave(): void {
	const state = getWorkingState();
	const ctx = state.ctx;
	if (isComposerWorkingSuppressed() || !ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
	activateAnimationSurface(COMPOSER_SURFACE_KEY, () => {
		const current = getWorkingState();
		const activeCtx = current.ctx;
		if (isComposerWorkingSuppressed() || !activeCtx || activeCtx.mode !== "tui" || !activeCtx.hasUI) {
			deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
			return;
		}
		requestRender();
	});
}

export function stopComposerWorkingWave(clearContext = false): void {
	deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
	if (clearContext) {
		const state = getWorkingState();
		state.ctx = undefined;
		state.suppressed = false;
	}
}

function extractLatestThinkingText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (let i = content.length - 1; i >= 0; i -= 1) {
		const item = content[i] as { type?: unknown; thinking?: unknown } | undefined;
		if (item?.type === "thinking") {
			if (typeof item.thinking === "string" && item.thinking.trim()) {
				parts.unshift(item.thinking);
			}
		} else if (parts.length > 0) {
			break;
		}
	}
	return parts.join("\n\n");
}

export function registerComposerWorkingAnimation(pi: ExtensionAPI): void {
	registerSlotOwnershipChangeListener("workingIndicator.wave", (slotId, ownerId) => {
		if (slotId !== "workingIndicator") return;
		if (ownerId !== PI_UI_OWNER_ID) {
			deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
			return;
		}
		const state = getWorkingState();
		if (state.ctx && state.ctx.isIdle?.() === false && !state.suppressed) {
			if (!state.controller.isActive()) {
				state.controller.beginTurn();
			}
			startComposerWorkingWave();
		}
	});

	pi.on("agent_start", () => {
		getWorkingStatusController().beginTurn();
		startComposerWorkingWave();
	});

	pi.on("turn_start", () => {
		const ctrl = getWorkingStatusController();
		if (!ctrl.isActive()) {
			ctrl.beginTurn();
		}
		startComposerWorkingWave();
	});

	pi.on("message_update", (event) => {
		const ctrl = getWorkingStatusController();
		const type = event.assistantMessageEvent?.type;
		if (type === "thinking_start" || type === "thinking_delta") {
			ctrl.onThinkingDelta(extractLatestThinkingText(event.message));
		} else if (type === "text_start" || type === "text_delta") {
			ctrl.onTextStream();
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (typeof event.toolName !== "string") return;
		getWorkingStatusController().onToolStart(
			event.toolCallId,
			event.toolName,
			event.args,
			ctx?.cwd,
		);
	});

	pi.on("tool_execution_end", (event) => {
		getWorkingStatusController().onToolEnd(event.toolCallId);
	});

	pi.on("agent_end", () => {
		getWorkingStatusController().endTurn();
		stopComposerWorkingWave(false);
		stopAllAnimations();
	});

	pi.on("agent_settled", () => {
		getWorkingStatusController().endTurn();
		stopComposerWorkingWave(false);
		stopAllAnimations();
	});

	pi.on("session_shutdown", () => {
		getWorkingStatusController().endTurn();
		stopComposerWorkingWave(true);
		stopAllAnimations();
	});
}
