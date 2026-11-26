import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { CLASSIC_RESULT_PREFIX, classicFailure, lookHint, lookKind, pathOf, type LookKind } from "./classic-rows.ts";
import {
	TAIL_BULLET,
	TAIL_INDENT,
	TAIL_MARGIN,
	TAIL_PREVIEW_ROWS,
	TAIL_RESULT_PREFIX,
	tailDisclosure,
	exploreActions,
	exploreFailure,
	exploreLines,
	openExplorations,
	paintSegments,
	shellOutcome,
	wrapSegments,
	type ExploreAction,
	type Segment,
} from "./exploration-tail.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { getActiveHostRuntime, type HostRuntimeHandle } from "../../shared/host-runtime.ts";
import { hookMethod } from "../../shared/runtime-hooks.ts";
import { markSelectionChrome } from "../../shared/selection-copy.ts";
import { formatDurationMs, type RowStatus } from "./core.ts";
import {
	densityPalette,
	formatAllGroupedSummary,
	formatDensityDuration,
} from "./density.ts";
import { getTextResult, hasImageContent } from "./invocation.ts";
import { outputPadLines } from "./layout.ts";
import { chromePainter, paintIndicator } from "./palette.ts";
import type { ToolRuntime } from "./runtime.ts";
import { findChat, isKind, isSilent } from "./silent.ts";
import { captureViewport } from "./viewport.ts";
import type { ToolArgs, ToolDensity } from "./types.ts";

/** Claude Code's words for each way of looking around, in the order it lists them. */
const PHRASES: ReadonlyArray<{ kind: LookKind; running: string; done: string; singular: string; plural: string }> = [
	{ kind: "search", running: "searching for", done: "searched for", singular: "pattern", plural: "patterns" },
	{ kind: "read", running: "reading", done: "read", singular: "file", plural: "files" },
	{ kind: "list", running: "listing", done: "listed", singular: "directory", plural: "directories" },
];

/** A click opens one group; Ctrl+O opens every row and its output, which is rarely what a reader wants here. */
export const EXPAND_HINT = "(click to expand)";

/** The fields of Pi's tool row a group summary reads. */
export interface ToolRowLike {
	toolName: string;
	toolCallId: string;
	args: unknown;
	result?: AgentToolResult<unknown> & { isError?: boolean; durationMs?: number };
	isPartial: boolean;
	expanded: boolean;
	/** Present on Pi 1.1+ tool components, absent on legacy hosts. */
	outputPad?: number;
	render(width: number): string[];
	handleMouse?(event: unknown): unknown;
	invalidate(): void;
	setExpanded?(expanded: boolean): void;
}

/** Whether a call without its result can still get one; the row itself answers the same way. */
export type CanRun = (row: ToolRowLike) => boolean;

const ALWAYS_RUNS: CanRun = () => true;

/**
 * A call with no result yet runs, unless it can no longer get one: restored from
 * the session without it, or left without it when its run ended. Then it waits,
 * as its row shows.
 */
export function memberStatus(row: ToolRowLike, canRun: CanRun = ALWAYS_RUNS): RowStatus {
	if (!row.result || row.isPartial) return canRun(row) ? "running" : "pending";
	return row.result.isError ? "error" : "success";
}

function argsOf(row: ToolRowLike): ToolArgs {
	return typeof row.args === "object" && row.args !== null ? row.args as ToolArgs : {};
}

const kinds = new WeakMap<object, { args: unknown; fingerprint: string; kind: LookKind | undefined }>();

function kindOf(row: ToolRowLike): LookKind | undefined {
	const fingerprint = rowArgsFingerprint(row);
	const cached = kinds.get(row);
	if (cached && cached.args === row.args && cached.fingerprint === fingerprint) return cached.kind;
	const kind = lookKind(row.toolName, argsOf(row));
	kinds.set(row, { args: row.args, fingerprint, kind });
	return kind;
}

/* Кэш привязан к версии аргументов, потому что команда может измениться во время стриминга. */
const explorations = new WeakMap<object, { args: unknown; actions: ExploreAction[] | undefined }>();

function exploreOf(row: ToolRowLike): ExploreAction[] | undefined {
	const cached = explorations.get(row);
	if (cached && cached.args === row.args) return cached.actions;
	const actions = exploreActions(row.toolName, argsOf(row));
	explorations.set(row, { args: row.args, actions });
	return actions;
}

function lastRunning(rows: readonly ToolRowLike[], canRun: CanRun): ToolRowLike | undefined {
	for (let index = rows.length - 1; index >= 0; index--) {
		if (memberStatus(rows[index]!, canRun) === "running") return rows[index];
	}
	return undefined;
}

/**
 * How many patterns, files, and directories a group covers, counted as Claude Code
 * counts them: files by distinct path, and reads by command only when no file was read.
 */
export function countGroup(rows: readonly ToolRowLike[]): Record<LookKind, number> {
	const counts: Record<LookKind, number> = { search: 0, read: 0, list: 0 };
	const paths = new Set<string>();
	let readCommands = 0;
	for (const row of rows) {
		const kind = kindOf(row);
		if (kind === "read" && row.toolName === "read") paths.add(pathOf(argsOf(row)));
		else if (kind === "read") readCommands++;
		else if (kind) counts[kind]++;
	}
	counts.read = paths.size > 0 ? paths.size : readCommands;
	return counts;
}

/**
 * "Searched for 2 patterns, read 3 files". While any call in the group still runs,
 * every verb reads in progress. `bold` marks the counts, as Claude Code does.
 */
export function summarizeGroup(
	rows: readonly ToolRowLike[],
	bold: (text: string) => string = (text) => text,
	canRun: CanRun = ALWAYS_RUNS,
): string {
	const counts = countGroup(rows);
	const running = lastRunning(rows, canRun) !== undefined;
	const text = PHRASES.filter((phrase) => counts[phrase.kind] > 0)
		.map((phrase) => {
			const count = counts[phrase.kind];
			return `${running ? phrase.running : phrase.done} ${bold(String(count))} ${count === 1 ? phrase.singular : phrase.plural}`;
		})
		.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** While a call runs, the line under its group names what it looks at. */
export function groupHint(rows: readonly ToolRowLike[], canRun: CanRun = ALWAYS_RUNS): string | undefined {
	const running = lastRunning(rows, canRun);
	if (!running) return undefined;
	return lookHint(running.toolName, argsOf(running)) || undefined;
}

/** Claude Code keeps a failure in view beneath the folded group. */
export function groupFailures(rows: readonly ToolRowLike[]): string[] {
	return rows.filter((row) => memberStatus(row) === "error")
		.map((row) => classicFailure(row.toolName, getTextResult(row.result!)).headline);
}

/**
 * A finished group's lines, and everything they were drawn from. Only a group with
 * no running row is kept, so every row in it has its final result.
 */
type HeaderCache = {
	paint: string;
	width: number;
	expanded: boolean;
	hostExpanded: boolean;
	rows: readonly ToolRowLike[];
	args: unknown[];
	fingerprints: string[];
	results: unknown[];
	lines: string[];
};

type GroupState = { expanded: boolean; lastHostExpanded: boolean; header?: HeaderCache };

/** The colors a group line is drawn in, resolved once per frame rather than once per group. */
type Paint = { theme: Theme; chrome: (text: string) => string; key: string };

/** Theme colors a group line uses; a theme that changes any of them draws the lines anew. */
const PAINT_COLORS = ["toolTitle", "error", "success", "muted", "dim", "text", "borderMuted", "accent"] as const;

function rowArgsFingerprint(row: ToolRowLike): string {
	const a = argsOf(row);
	const cmd = typeof a.command === "string" ? a.command : "";
	const pat = typeof a.pattern === "string" ? a.pattern : "";
	return `${pathOf(a)}\0${cmd}\0${pat}`;
}

function headerStill(cache: HeaderCache, rows: readonly ToolRowLike[], paint: string, width: number, expanded: boolean): boolean {
	if (cache.paint !== paint || cache.width !== width || cache.expanded !== expanded
		|| cache.hostExpanded !== rows[0]?.expanded || cache.rows.length !== rows.length) return false;
	return rows.every((row, index) => row === cache.rows[index] && row.args === cache.args[index]
		&& rowArgsFingerprint(row) === cache.fingerprints[index]
		&& row.result === cache.results[index]);
}

/** A run of tool rows drawn as one summary line, which a click or Ctrl+O opens into the rows themselves. */
export class ToolGroupComponent extends Container {
	constructor(
		readonly rows: readonly ToolRowLike[],
		/** Every child the group folded, in order: its tool rows and the thinking between them. */
		members: readonly unknown[],
		private readonly state: GroupState,
		private readonly draw: (rows: readonly ToolRowLike[], width: number, expanded: boolean) => string[],
		private readonly onToggle: (expanded: boolean) => void,
		/** Lines beneath an opened group's members, which a click closes too. */
		footer?: (width: number) => string[],
		compactTree = false,
	) {
		super();
		/* Сворачивание одной строки внутри раскрытой группы не должно закрывать всю группу целиком. */
		const hostExpanded = rows[0]!.expanded;
		const uniformHostExpanded = rows.every((row) => row.expanded === hostExpanded);
		if (uniformHostExpanded && state.lastHostExpanded !== hostExpanded) {
			state.lastHostExpanded = hostExpanded;
			state.expanded = hostExpanded;
		}
		let lastHeaderLines: string[] = [];
		const toggleGroup = () => {
			captureViewport();
			this.state.expanded = !this.state.expanded;
			this.onToggle(this.state.expanded);
			return { handled: true };
		};
		const handleHeaderMouse = (event: { type?: string; button?: string; y?: number }) => {
			if (event.button !== "left") return undefined;
			if (
				event.y === 0 &&
				lastHeaderLines.length > 1 &&
				stripTerminalSequences(lastHeaderLines[0] ?? "").trim() === ""
			) {
				return undefined;
			}
			if (event.type === "press") return { handled: true, render: false };
			if (event.type !== "click") return undefined;
			return toggleGroup();
		};
		const handleFooterMouse = (event: { type?: string; button?: string }) => {
			if (event.button !== "left") return undefined;
			if (event.type === "press") return { handled: true, render: false };
			if (event.type !== "click") return undefined;
			return toggleGroup();
		};
		this.addChild({
			render: (width) => {
				lastHeaderLines = this.draw(this.rows, width, this.state.expanded);
				return lastHeaderLines;
			},
			invalidate() {},
			handleMouse: handleHeaderMouse,
		} as Component);
		if (!state.expanded) return;
		if (compactTree) {
			/* В раскрытой группе пресетов Tool Density рисуем дочерние шаги компактным деревом `│ …` без пустых строк. */
			for (const member of members) {
				if (isKind(member, ToolExecutionComponent) || isKind(member, AssistantMessageComponent)) {
					const comp = member as Component;
					let strippedTopBlank = false;
					let guideWidth = 0;
					let removedMargins: number[] = [];
					this.addChild({
						render: (w: number) => {
							const outer = computeOuterCanvasMargin(w);
							guideWidth = outer + 2;
							const rendered = comp.render(w);
							strippedTopBlank =
								rendered.length > 1 && stripTerminalSequences(rendered[0] ?? "").trim() === "";
							const body = strippedTopBlank ? rendered.slice(1) : rendered;
							const hostTheme = getActiveHostRuntime()?.ctx.ui.theme as Theme | undefined;
							const guideText = `${" ".repeat(outer)}│ `;
							const guide = hostTheme ? densityPalette(hostTheme).rail(guideText) : guideText;
							removedMargins = body.map((line) => Math.min(guideWidth, /^ */u.exec(line)![0].length));
							return body.map((line, row) => truncateToWidth(
								`${guide}${line.slice(removedMargins[row])}`, w, "…",
							));
						},
						invalidate: () => comp.invalidate(),
						handleMouse: (ev: unknown) => {
							if (typeof (comp as { handleMouse?: (e: unknown) => unknown }).handleMouse !== "function") {
								return undefined;
							}
							const mouseEv = ev as { x?: number; y?: number };
							const xOffset = (removedMargins[mouseEv.y ?? 0] ?? 0) - guideWidth;
							return (comp as { handleMouse: (e: unknown) => unknown }).handleMouse({
								...mouseEv,
								...(typeof mouseEv.x === "number" ? { x: Math.max(0, mouseEv.x + xOffset) } : {}),
								...(typeof mouseEv.y === "number"
									? { y: mouseEv.y + (strippedTopBlank ? 1 : 0) }
									: {}),
							});
						},
					} as Component);
				} else if (!isKind(member, Spacer)) {
					this.addChild(member as Component);
				}
			}
		} else {
			for (const member of members) this.addChild(member as Component);
		}
		if (footer) this.addChild({ render: footer, invalidate() {}, handleMouse: handleFooterMouse } as Component);
	}
}

export type GroupStyle = "density" | "classic-rows" | "exploration-tail";
export type GroupBucket = "all" | "explore" | "edit" | "command" | "custom";

function resolveRowGroupBucket(
	child: unknown,
	style: GroupStyle,
	density: ToolDensity = "balanced",
): GroupBucket | undefined {
	if (!isKind(child, ToolExecutionComponent)) return undefined;
	const row = child as ToolRowLike;
	/* Строки с инлайн-изображениями никогда не складываем в свёрнутую текстовую группу. */
	if (hasImageContent(row.result)) return undefined;

	if (style === "exploration-tail") {
		return exploreOf(row) !== undefined ? "explore" : undefined;
	}
	if (style === "classic-rows") {
		return kindOf(row) !== undefined ? "explore" : undefined;
	}
	if (density === "compact") {
		return "all";
	}
	if (density === "grouped") {
		if (kindOf(row) !== undefined) return "explore";
		if (row.toolName === "edit" || row.toolName === "write") return "edit";
		if (
			row.toolName === "bash" ||
			row.toolName === "powershell" ||
			row.toolName === "codemode"
		) {
			return "command";
		}
		return "custom";
	}
	return kindOf(row) !== undefined ? "explore" : undefined;
}

type AssistantLike = {
	isStreaming?: boolean;
	thinkingVisibilityOverrides?: Map<number, boolean>;
	lastMessage?: { content?: Array<{ type: string; text?: string; thinking?: string }> };
};

function isUnexpandedTextlessAssistant(child: unknown): AssistantLike | undefined {
	if (!isKind(child, AssistantMessageComponent)) return undefined;
	const assistant = child as AssistantLike;
	/* Стримящийся или вручную раскрытый Thinking не сворачиваем внутрь группы. */
	if (assistant.isStreaming) return undefined;
	if (assistant.thinkingVisibilityOverrides) {
		for (const hidden of assistant.thinkingVisibilityOverrides.values()) {
			if (hidden === false) return undefined;
		}
	}
	const content = assistant.lastMessage?.content ?? [];
	if (content.some((block) => block.type === "text" && block.text?.trim())) return undefined;
	return assistant;
}

/** Текстово-пустой шаг ассистента с реальным блоком `thinking`, который можно сложить в Compact-группу. */
function isThinkingOnly(child: unknown): boolean {
	const assistant = isUnexpandedTextlessAssistant(child);
	if (!assistant) return false;
	const content = assistant.lastMessage?.content ?? [];
	return content.some((block) => block.type === "thinking" && block.thinking?.trim());
}

/* Строки хоста и шаги без видимого текста не разрывают последовательность вызовов. */
function isFoldable(child: unknown): boolean {
	return isUnexpandedTextlessAssistant(child) !== undefined || isKind(child, Text) || isKind(child, Spacer);
}

export function groupChildren(
	children: readonly unknown[],
	makeGroup: (rows: ToolRowLike[], members: unknown[]) => Component,
	style: GroupStyle = "classic-rows",
	density: ToolDensity = "balanced",
): unknown[] {
	const grouped: unknown[] = [];
	let rows: ToolRowLike[] = [];
	let members: unknown[] = [];
	let pending: unknown[] = [];
	let leadingThinking: unknown[] = [];
	let currentBucket: GroupBucket | undefined;
	const allowLeadThinkingFold = style === "density" && density === "compact";

	const flush = () => {
		const hasLeadThought = leadingThinking.some((item) => isThinkingOnly(item));
		if (style === "density" && rows.length === 1 && !hasLeadThought) {
			grouped.push(...leadingThinking, ...members);
		} else if (rows.length > 0) {
			grouped.push(makeGroup(rows, [...leadingThinking, ...members]));
		} else if (leadingThinking.length > 0) {
			grouped.push(...leadingThinking);
		}
		rows = [];
		members = [];
		leadingThinking = [];
		currentBucket = undefined;
	};
	for (const child of children) {
		const bucket = resolveRowGroupBucket(child, style, density);
		if (bucket !== undefined) {
			if (currentBucket !== undefined && currentBucket !== bucket) {
				flush();
			}
			currentBucket = bucket;
			rows.push(child as ToolRowLike);
			members.push(...pending, child);
			pending = [];
			continue;
		}
		if (rows.length === 0 && allowLeadThinkingFold && isFoldable(child)) {
			leadingThinking.push(child);
			continue;
		}
		if (rows.length > 0 && isFoldable(child)) {
			pending.push(child);
			continue;
		}
		flush();
		grouped.push(...pending, child);
		pending = [];
	}
	flush();
	grouped.push(...pending);
	return grouped;
}

/** Claude and Codex styles: runs of reads, searches, and listings fold into one group each. */
export class ToolGroupController {
	private context: ExtensionContext | undefined;
	private readonly states = new WeakMap<object, GroupState>();
	/** This frame's colors, set as the chat starts drawing. */
	private paint: Paint | undefined;
	/** Asks the runtime, which knows which run each call belongs to, as the call's own row does. */
	private readonly canRun: CanRun = (row) => this.runtime.canRun(row.toolCallId);

	constructor(private readonly runtime: ToolRuntime) {}

	bind(ctx: ExtensionContext, host?: HostRuntimeHandle): void {
		this.dispose();
		this.context = ctx;
		const resolvedHost = host ?? getActiveHostRuntime();
		const chat = resolvedHost?.chatContainer ?? (resolvedHost ? findChat(resolvedHost.tui) : undefined);
		if (chat && resolvedHost) {
			const isGroupStyle = (style: string): style is GroupStyle =>
				style === "density" || style === "classic-rows" || style === "exploration-tail";
			hookMethod(chat, "render", "classic.groups", (self, args, original) => {
				const style = this.runtime.config.style;
				if (!this.context || isSilent() || !isGroupStyle(style)) return original.apply(self, args);
				const children = self.children as unknown[];
				this.paint = this.resolvePaint();
				openExplorations.clear();
				self.children = groupChildren(
					children,
					(rows, members) => this.makeGroup(rows, members, resolvedHost.tui),
					style,
					this.runtime.config.density,
				);
				try {
					return original.apply(self, args);
				} finally {
					self.children = children;
					this.paint = undefined;
				}
			});
			hookMethod(chat, "handleMouse", "density.groups.mouse", (self, args, original) => {
				const style = this.runtime.config.style;
				const event = args[0] as { width?: number } | undefined;
				if (
					this.context &&
					!isSilent() &&
					isGroupStyle(style) &&
					typeof event?.width === "number" &&
					(self as { childLines?: { width?: number } }).childLines?.width !== event.width
				) {
					self.render(event.width);
				}
				return original.apply(self, args);
			});
		}
	}

	dispose(): void {
		this.context = undefined;
	}

	private makeGroup(rows: ToolRowLike[], members: unknown[], tui: { requestRender(): void }): Component {
		const key = rows[0]!;
		let state = this.states.get(key);
		if (!state) {
			state = { expanded: key.expanded, lastHostExpanded: key.expanded };
			this.states.set(key, state);
		}
		const groupState = state;
		const draw = (group: readonly ToolRowLike[], width: number, expanded: boolean) => {
			const pad = group[0]?.outputPad;
			return outputPadLines(
				this.drawCached(group, width + (pad === 0 ? 1 : 0), expanded, groupState, members),
				width,
				pad,
			);
		};
		if (this.runtime.config.style !== "exploration-tail") {
			return new ToolGroupComponent(
				rows,
				members,
				state,
				draw,
				() => tui.requestRender(),
				undefined,
				this.runtime.config.style === "density",
			);
		}
		/* Общая кнопка сворачивания заменяет кнопки отдельных вызовов в раскрытой группе. */
		const toggle = (expanded: boolean) => {
			for (const row of rows) row.setExpanded?.(expanded);
			tui.requestRender();
		};
		const footer = (width: number) => {
			const theme = this.paint?.theme ?? this.context?.ui.theme;
			const pad = rows[0]?.outputPad;
			const available = width + (pad === 0 ? 1 : 0);
			return theme ? outputPadLines([truncateToWidth(theme.fg("dim", tailDisclosure(available, true)), Math.max(1, available), "…")], width, pad) : [];
		};
		const group = new ToolGroupComponent(rows, members, state, draw, toggle, footer);
		/* Вызов, добавленный в уже раскрытую группу, наследует её состояние. */
		if (state.expanded) {
			for (const row of rows) {
				openExplorations.add(row.toolCallId);
				if (!row.expanded) row.setExpanded?.(true);
			}
		}
		return group;
	}

	private resolvePaint(): Paint | undefined {
		const theme = this.context?.ui.theme;
		if (!theme) return undefined;
		const chrome = chromePainter(theme);
		const densityKey =
			this.runtime.config.style === "density"
				? `${this.runtime.config.density}:${densityPalette(theme).key}`
				: "";
		// The style is part of the key: a group drawn in one style is never reused in another.
		const key =
			this.runtime.config.style +
			densityKey +
			PAINT_COLORS.map((color) => theme.fg(color, "x")).join("") +
			theme.bold("x") +
			chrome("x");
		return { theme, chrome, key };
	}

	/**
	 * A finished group draws the same lines until one of its rows, the width, the
	 * expansion, or the theme changes, so those lines are kept. A running group's
	 * line pulses and counts time, so it is drawn every frame.
	 */
	private drawCached(
		rows: readonly ToolRowLike[],
		width: number,
		expanded: boolean,
		state: GroupState,
		members: readonly unknown[] = rows,
	): string[] {
		const paint = this.paint ?? this.resolvePaint();
		if (!paint) return [];
		if (lastRunning(rows, this.canRun)) return this.draw(rows, width, expanded, paint, members);
		if (state.header && headerStill(state.header, rows, paint.key, width, expanded)) return state.header.lines;
		const lines = this.draw(rows, width, expanded, paint, members);
		state.header = {
			paint: paint.key,
			width,
			expanded,
			hostExpanded: rows[0]!.expanded,
			rows: [...rows],
			args: rows.map((row) => row.args),
			fingerprints: rows.map(rowArgsFingerprint),
			results: rows.map((row) => row.result),
			lines,
		};
		return lines;
	}

	/** Claude's quiet completed exploration; active and interrupted calls keep a status cue. */
	private draw(
		rows: readonly ToolRowLike[],
		width: number,
		expanded: boolean,
		paint: Paint,
		members: readonly unknown[] = rows,
	): string[] {
		if (this.runtime.config.style === "density") {
			return this.drawDensity(rows, width, expanded, paint, members);
		}
		if (this.runtime.config.style === "exploration-tail") return this.drawTail(rows, width, expanded, paint);
		/* При раскрытии мышью сохраняем заголовок как точку для обратного клика. */
		if (expanded && rows[0]?.expanded) return [];
		const { theme, chrome } = paint;
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
		const running = lastRunning(rows, this.canRun);
		const statuses = rows.map((row) => memberStatus(row, this.canRun));
		// A call that waits for a result it will never get leaves the group waiting too.
		const status: RowStatus = running ? "running" : statuses.includes("error") ? "error"
			: statuses.includes("pending") ? "pending" : "success";
		const summary = summarizeGroup(rows, (count) => theme.bold(count), this.canRun);
		let title = status === "success"
			? `   ${chrome(summary)}`
			: ` ${paintIndicator(theme, status, this.runtime.frame)} ${theme.fg("toolTitle", summary)}`;
		if (running) {
			// The folded row is not drawn, so its group keeps the animation clock going.
			this.runtime.keepAnimating(running.toolCallId);
			const started = this.runtime.timing(running.toolCallId)?.startedAt;
			const elapsed = started === undefined ? 0 : Date.now() - started;
			title += `${elapsed >= 2000 ? chrome(` · ${formatDurationMs(elapsed)}`) : ""}…`;
		}
		if (!expanded) title += chrome(` ${EXPAND_HINT}`);
		const lines = ["", fit(title)];
		const hintText = groupHint(rows, this.canRun);
		if (hintText) lines.push(fit(chrome(`${CLASSIC_RESULT_PREFIX}${hintText}`)));
		if (!expanded) for (const failure of groupFailures(rows)) lines.push(fit(chrome(CLASSIC_RESULT_PREFIX) + theme.fg("error", failure)));
		return lines;
	}

	/**
	 * Codex's exploration: `• Exploring` while a call runs and `• Explored` after,
	 * then a line for what each call did, three rows of them until the group opens.
	 * A failed call says so at the end of its line and in the head's count.
	 */
	private drawTail(rows: readonly ToolRowLike[], width: number, expanded: boolean, paint: Paint): string[] {
		const { theme } = paint;
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
		const running = lastRunning(rows, this.canRun);
		const statuses = rows.map((row) => memberStatus(row, this.canRun));
		if (running) this.runtime.keepAnimating(running.toolCallId);
		const bullet = running ? paintIndicator(theme, "running", this.runtime.frame, TAIL_BULLET)
			: statuses.includes("pending") ? paintIndicator(theme, "pending", 0, TAIL_BULLET) : theme.fg("dim", TAIL_BULLET);
		let nonzeroExits = 0;
		let failed = 0;
		rows.forEach((row, index) => {
			if (!row.result || row.isPartial) return;
			const exitCode = row.toolName === "bash" || row.toolName === "powershell"
				? shellOutcome(getTextResult(row.result)).exitCode : undefined;
			if (exitCode !== undefined) {
				if (exitCode !== 0) nonzeroExits++;
			} else if (statuses[index] === "error") failed++;
		});
		let head = `${TAIL_MARGIN}${bullet} ${theme.bold(running ? "Exploring" : "Explored")}`;
		if (nonzeroExits > 0) head += theme.bold(` · ${nonzeroExits} ${nonzeroExits === 1 ? "nonzero exit" : "nonzero exits"}`);
		if (failed > 0) head += theme.bold(theme.fg("error", ` · ${failed} failed`));
		/* Пустые строки уже входят в вывод отдельных вызовов. */
		if (expanded) return [];
		const lines = ["", fit(head)];
		const calls = rows.map((row) => {
			const actions = exploreOf(row) ?? [];
			const failure = row.result && !row.isPartial
				? exploreFailure(row.toolName, getTextResult(row.result), row.result.isError === true, actions) : undefined;
			return { actions, failure };
		});
		const details: string[] = [];
		for (const line of exploreLines(calls)) {
			const verb = `${line.verb} `;
			const segments: Segment[] = line.parts.map((part) => ({ text: part.text, color: part.dim ? "dim" : undefined }));
			if (line.failure) segments.push({ text: line.failure.text, color: line.failure.quiet ? "dim" : "error" });
			const available = Math.max(1, width - visibleWidth(TAIL_INDENT) - verb.length);
			wrapSegments(segments, available, available).forEach((row, index) => {
				details.push((index === 0 ? theme.fg("accent", verb) : " ".repeat(verb.length)) + paintSegments(row, theme));
			});
		}
		details.slice(0, TAIL_PREVIEW_ROWS).forEach((row, index) => {
			lines.push(fit(theme.fg("dim", index === 0 ? TAIL_RESULT_PREFIX : TAIL_INDENT) + row));
		});
		lines.push(fit(theme.fg("dim", tailDisclosure(width, false))));
		return lines;
	}

	private drawDensity(
		rows: readonly ToolRowLike[],
		width: number,
		expanded: boolean,
		paint: Paint,
		members: readonly unknown[] = rows,
	): string[] {
		const pal = densityPalette(paint.theme);
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
		const running = lastRunning(rows, this.canRun);
		const statuses = rows.map((row) => memberStatus(row, this.canRun));

		for (const [idx, row] of rows.entries()) {
			if (statuses[idx] === "running") {
				this.runtime.syncIndicator(row.toolCallId, true, () => row.invalidate());
			} else {
				this.runtime.syncIndicator(row.toolCallId, false, () => {});
			}
		}

		const failedCount = statuses.filter((s) => s === "error").length;
		const allFailed = failedCount > 0 && failedCount === rows.length;
		/* При частичной ошибке заголовок остаётся нейтральным; красным красится только счётчик `N failed`. */
		const status: RowStatus = running
			? "running"
			: allFailed
				? "error"
				: statuses.includes("pending")
					? "pending"
					: "success";

		const groupedInfo = formatAllGroupedSummary(rows, this.canRun);
		const diamond = pal.diamond(status, expanded);
		const styledSummary = pal.title(groupedInfo.summary, status, expanded);
		const foldedThoughts =
			this.runtime.config.density === "compact"
				? members.filter((member) => isThinkingOnly(member)).length
				: 0;

		let diffBadge = "";
		if (groupedInfo.changes && !running) {
			const plus = pal.theme.fg("toolDiffAdded", `+${groupedInfo.changes.added}`);
			const minus = pal.theme.fg("toolDiffRemoved", `-${groupedInfo.changes.removed}`);
			diffBadge = ` ${plus} ${minus}`;
		}

		let meta = "";
		if (running) {
			const started = this.runtime.timing(running.toolCallId)?.startedAt;
			const elapsed = started !== undefined ? Date.now() - started : 0;
			const dur = elapsed >= 1000 ? formatDensityDuration(elapsed) : undefined;
			if (dur) meta = ` ${pal.dim(`(${dur})`)}`;
		} else {
			let totalMs = 0;
			let hasDuration = false;
			for (const row of rows) {
				const explicitMs = row.result?.durationMs;
				const timing = this.runtime.timing(row.toolCallId);
				const rowMs =
					typeof explicitMs === "number" && Number.isFinite(explicitMs) && explicitMs >= 0
						? explicitMs
						: timing?.durationMs !== undefined
							? timing.durationMs
							: timing?.startedAt !== undefined && timing?.endedAt !== undefined
								? timing.endedAt - timing.startedAt
								: undefined;
				if (rowMs !== undefined) {
					totalMs += rowMs;
					hasDuration = true;
				}
			}
			const styledParts: string[] = [];
			if (foldedThoughts > 0) {
				styledParts.push(pal.dim(`${foldedThoughts} ${foldedThoughts === 1 ? "thought" : "thoughts"}`));
			}
			if (failedCount > 0) {
				styledParts.push(
					allFailed
						? pal.dim(`${failedCount} failed`)
						: pal.theme.fg("error", `${failedCount} failed`),
				);
			}
			const dur = hasDuration ? formatDensityDuration(totalMs) : undefined;
			if (dur) styledParts.push(pal.dim(dur));
			if (styledParts.length > 0) {
				meta = ` ${pal.dim("(")}${styledParts.join(pal.dim(" · "))}${pal.dim(")")}`;
			}
		}

		const margin = " ".repeat(computeOuterCanvasMargin(width) + 2);
		const title = fit(`${margin}${diamond} ${styledSummary}${diffBadge}${meta}`);
		return ["", !expanded && getActiveHostRuntime()?.isFullscreen ? markSelectionChrome(title) : title];
	}
}
