import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	getAnimationElapsedMs,
	paintRunningCommandBar,
	paintRunningToolDiamond,
} from "../../shared/animation-scheduler.ts";
import { fgRgb, getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";
import {
	analyzeShell,
	isHarmlessRedirect,
	unwrapCommandWords,
	type ShellDialect,
} from "../../shared/shell-analysis.ts";
import { pathOf, type LookKind } from "./claude.ts";
import { isEmptyOutput, shellOutcome } from "./codex.ts";
import { GROK_DIAMOND, normalizeLineEndings, type RowStatus } from "./core.ts";
import {
	countEditChanges,
	formatResultLineSummary,
	getEditDiff,
	getEditPatch,
	isReadTextResult,
	readStartLine,
	splitReadFooter,
	summarizeCustomArguments,
	summarizeFailure,
} from "./invocation.ts";
import {
	parseCodeDiff,
	railComponent,
	renderArguments,
	renderCodeView,
	renderCodexDiff,
	renderOutput,
	trimDiffContext,
	type CodeDiffLine,
} from "./layout.ts";
import type { RowState, ToolArgs, ToolDensity } from "./types.ts";

export const COMMAND_PREVIEW_HEAD = 2;
export const COMMAND_PREVIEW_TAIL = 3;

const CODEMODE_SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n?/u;

export interface HeadTailPreview {
	readonly head: string[];
	readonly omitted: number;
	readonly tail: string[];
}

export function sliceHeadTailPreview(
	lines: readonly string[],
	headCount = COMMAND_PREVIEW_HEAD,
	tailCount = COMMAND_PREVIEW_TAIL,
): HeadTailPreview {
	const limit = headCount + tailCount;
	if (lines.length <= limit) {
		return {
			head: [...lines],
			omitted: 0,
			tail: [],
		};
	}
	return {
		head: lines.slice(0, headCount),
		omitted: lines.length - limit,
		tail: lines.slice(lines.length - tailCount),
	};
}

export interface ExtractedCommandOutput {
	readonly lines: string[];
	readonly exitCode?: number;
}

export function extractCommandOutput(
	name: string,
	rawOutput: string,
	isError: boolean,
	detailsCalls?: readonly { name?: unknown; args?: unknown; status?: unknown }[],
): ExtractedCommandOutput {
	let text = normalizeLineEndings(rawOutput);
	let exitCode: number | undefined;

	if (name === "codemode") {
		text = text.replace(CODEMODE_SCRIPT_HEADER, "");
	} else if ((name === "bash" || name === "powershell") && isError) {
		const outcome = shellOutcome(text);
		exitCode = outcome.exitCode;
		text = outcome.output;
	}

	const cleaned = stripTerminalSequences(text).replace(/\n+$/u, "");
	if (isEmptyOutput(cleaned)) {
		if (name === "codemode" && Array.isArray(detailsCalls) && detailsCalls.length > 0) {
			const callLines = detailsCalls.map((call) => {
				const icon =
					call.status === "ok"
						? "✓"
						: call.status === "error"
							? "✗"
							: call.status === "cancelled"
								? "⊘"
								: "…";
				const tool = typeof call.name === "string" ? call.name : "tool";
				const args = typeof call.args === "string" && call.args ? ` ${call.args}` : "";
				return `${icon} ${tool}${args}`;
			});
			return { lines: callLines, exitCode };
		}
		return { lines: [], exitCode };
	}

	const lines = cleaned.split("\n").map((line) => line.replace(/\t/gu, "   "));
	return { lines, exitCode };
}

const GROK_NEUTRAL_COMMANDS = new Set([
	"cd",
	"pushd",
	"popd",
	"pwd",
	"dirs",
	"set-location",
	"sl",
	"push-location",
	"pop-location",
	"get-location",
	"gl",
	"echo",
	"printf",
	"write-output",
	"write-host",
	"true",
	"false",
	":",
]);

const GROK_SEARCH_COMMANDS = new Set([
	"find",
	"fd",
	"fdfind",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"pt",
	"locate",
	"which",
	"whereis",
	"select-string",
	"sls",
]);

const GROK_LIST_COMMANDS = new Set(["ls", "dir", "tree", "du", "get-childitem", "gci"]);

const GROK_READ_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"bat",
	"batcat",
	"nl",
	"sed",
	"awk",
	"gawk",
	"mawk",
	"nawk",
	"jq",
	"yq",
	"wc",
	"stat",
	"file",
	"strings",
	"cut",
	"sort",
	"uniq",
	"tr",
	"diff",
	"cmp",
	"comm",
	"readlink",
	"realpath",
	"get-content",
	"gc",
	"type",
	"get-item",
	"gi",
	"get-itemproperty",
	"gp",
	"test-path",
	"where-object",
	"where",
	"?",
	"select-object",
	"select",
	"sort-object",
	"measure-object",
	"measure",
	"format-table",
	"ft",
	"format-list",
	"fl",
	"out-string",
]);

function normalizeProgramName(raw: string, dialect: ShellDialect): string {
	const base = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
	return dialect === "powershell" ? base.replace(/\.exe$/iu, "").toLowerCase() : base.toLowerCase();
}

function classifyReadOnlyGitExploration(args: readonly string[]): LookKind | undefined {
	let idx = 0;
	while (idx < args.length && args[idx]!.startsWith("-")) {
		const flag = args[idx]!;
		if (flag === "-C" || flag === "--git-dir" || flag === "--work-tree" || flag === "--namespace") {
			idx += 2;
		} else {
			idx += 1;
		}
	}
	const sub = args[idx];
	if (!sub) return undefined;
	if (sub === "grep") return "search";
	if (sub === "ls-files" || sub === "ls-tree") return "list";
	if (
		sub === "show" ||
		sub === "cat-file" ||
		sub === "blame" ||
		sub === "status" ||
		sub === "diff" ||
		sub === "log" ||
		sub === "rev-parse" ||
		sub === "describe"
	) {
		return "read";
	}
	return undefined;
}

export function classifyGrokShellExploration(
	command: string,
	dialect: ShellDialect = "bash",
): LookKind | undefined {
	const analysis = analyzeShell(command, dialect);
	if (!analysis.valid || analysis.opaque || analysis.effect.kind !== "read-only") {
		return undefined;
	}
	let hasSearch = false;
	let hasRead = false;
	let hasList = false;

	for (const cmd of analysis.commands) {
		if (!cmd.redirects.every(isHarmlessRedirect)) return undefined;
		const unwrapped = unwrapCommandWords(cmd.words);
		if (unwrapped.kind !== "command" || unwrapped.words.length === 0) continue;
		const program = normalizeProgramName(unwrapped.words[0]!, dialect);
		const rest = unwrapped.words.slice(1);
		if (GROK_NEUTRAL_COMMANDS.has(program)) continue;
		if (program === "git") {
			const gitKind = classifyReadOnlyGitExploration(rest);
			if (!gitKind) return undefined;
			if (gitKind === "search") hasSearch = true;
			else if (gitKind === "list") hasList = true;
			else hasRead = true;
			continue;
		}
		if ((program === "rg" || program === "ripgrep") && rest.includes("--files")) {
			hasList = true;
			continue;
		}
		if (GROK_SEARCH_COMMANDS.has(program)) hasSearch = true;
		else if (GROK_LIST_COMMANDS.has(program)) hasList = true;
		else if (GROK_READ_COMMANDS.has(program)) hasRead = true;
		else return undefined;
	}

	return hasList ? "list" : hasSearch ? "search" : hasRead ? "read" : undefined;
}

export function classifyGrokExploration(toolName: string, args: ToolArgs): LookKind | undefined {
	if (toolName === "read") return "read";
	if (toolName === "grep" || toolName === "find") return "search";
	if (toolName === "ls") return "list";
	if (toolName === "bash" || toolName === "powershell") {
		const cmd = typeof args.command === "string" ? args.command : "";
		if (!cmd.trim()) return undefined;
		return classifyGrokShellExploration(cmd, toolName === "powershell" ? "powershell" : "bash");
	}
	return undefined;
}

export interface ExplorationRowInput {
	toolName: string;
	toolCallId: string;
	args: unknown;
	result?: { isError?: boolean } | undefined;
	isPartial: boolean;
}

export interface GrokExplorationCounts {
	files: number;
	searches: number;
	directories: number;
}

export function countGrokExploration(rows: readonly ExplorationRowInput[]): GrokExplorationCounts {
	const readPaths = new Set<string>();
	let unnamedReads = 0;
	let searches = 0;
	let directories = 0;

	for (const row of rows) {
		const args: ToolArgs =
			typeof row.args === "object" && row.args !== null ? (row.args as ToolArgs) : {};
		const kind = classifyGrokExploration(row.toolName, args);
		if (kind === "read") {
			if (row.toolName === "read") {
				const p = pathOf(args).trim();
				if (p) readPaths.add(p);
				else unnamedReads += 1;
			} else {
				unnamedReads += 1;
			}
		} else if (kind === "search") {
			searches += 1;
		} else if (kind === "list") {
			directories += 1;
		}
	}

	return {
		files: readPaths.size + unnamedReads,
		searches,
		directories,
	};
}

export function formatGrokExploredSummary<TRow extends ExplorationRowInput>(
	rows: readonly TRow[],
	canRun: (row: TRow) => boolean = () => true,
): string {
	const { files, searches, directories } = countGrokExploration(rows);
	const running = rows.some((row) => (!row.result || row.isPartial) && canRun(row));
	const verb = running ? "Exploring" : "Explored";
	const parts: string[] = [];
	if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
	if (searches > 0) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
	if (directories > 0) {
		parts.push(`${directories} ${directories === 1 ? "directory" : "directories"}`);
	}
	return parts.length > 0 ? `${verb} ${parts.join(", ")}` : verb;
}

export interface GrokPalette {
	readonly theme: Theme;
	readonly light: boolean;
	readonly key: string;
	diamond(status: RowStatus, expanded: boolean): string;
	title(text: string, status: RowStatus, expanded: boolean): string;
	target(text: string, expanded: boolean): string;
	dim(text: string): string;
	body(text: string): string;
	rail(text: string): string;
}

export function grokPalette(fallbackTheme: Theme): GrokPalette {
	const theme = getActiveGlobalTheme(fallbackTheme);
	const light = isLightTheme(theme);
	const key = `${light ? "light" : "dark"}:${(theme as { name?: string })?.name ?? ""}:${theme.getFgAnsi?.("text") ?? ""}`;

	return {
		theme,
		light,
		key,
		diamond(status: RowStatus, expanded: boolean): string {
			if (status === "running") {
				return paintRunningToolDiamond({ theme, light, row: 0 });
			}
			if (status === "error") {
				return theme.fg("error", GROK_DIAMOND);
			}
			if (expanded && status === "success") {
				return light ? fgRgb(37, 99, 235, GROK_DIAMOND) : fgRgb(97, 175, 239, GROK_DIAMOND);
			}
			return light ? fgRgb(112, 128, 152, GROK_DIAMOND) : fgRgb(92, 110, 136, GROK_DIAMOND);
		},
		title(text: string, status: RowStatus, expanded: boolean): string {
			if (status === "error") {
				return theme.fg("error", expanded ? theme.bold(text) : text);
			}
			if (status === "running" || expanded) {
				const painted = light ? fgRgb(24, 48, 82, text) : fgRgb(172, 194, 222, text);
				return theme.bold(painted);
			}
			return light ? fgRgb(68, 86, 112, text) : fgRgb(136, 154, 178, text);
		},
		target(text: string, expanded: boolean): string {
			if (!text) return "";
			return light
				? fgRgb(expanded ? [29, 78, 216] : [56, 78, 108], text)
				: fgRgb(expanded ? [145, 195, 248] : [148, 168, 196], text);
		},
		dim(text: string): string {
			return light ? fgRgb(124, 140, 164, text) : fgRgb(84, 100, 124, text);
		},
		body(text: string): string {
			return light ? fgRgb(72, 90, 116, text) : fgRgb(128, 144, 168, text);
		},
		rail(text: string): string {
			return light ? fgRgb(124, 140, 164, text) : fgRgb(84, 100, 124, text);
		},
	};
}

export function formatGrokDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
		return undefined;
	}
	const rounded = Math.round(durationMs);
	if (rounded < 1000) {
		return `${rounded}ms`;
	}
	if (rounded < 60_000) {
		const sec = (rounded / 1000).toFixed(1);
		return `${sec.endsWith(".0") ? sec.slice(0, -2) : sec}s`;
	}
	const minutes = Math.floor(rounded / 60_000);
	const seconds = Math.round((rounded % 60_000) / 1000);
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function durationFromState(state: RowState, running: boolean): string | undefined {
	if (!running && state.durationMs !== undefined) {
		return formatGrokDuration(state.durationMs);
	}
	if (state.startedAt === undefined) return undefined;
	const elapsed = (running ? Date.now() : (state.endedAt ?? Date.now())) - state.startedAt;
	if (running && elapsed < 1000) return undefined;
	return formatGrokDuration(elapsed);
}

function singleLineText(raw: string, maxChars = 120): string {
	const cleaned = normalizeLineEndings(stripTerminalSequences(raw))
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (cleaned.length === 0) return "";
	const first = cleaned[0]!;
	const joined = cleaned.length > 1 ? `${first} …` : first;
	return joined.length > maxChars ? `${joined.slice(0, maxChars - 1).trimEnd()}…` : joined;
}

function summarizeCodemodeSource(args: ToolArgs): string {
	const code = typeof args.code === "string" ? normalizeLineEndings(stripTerminalSequences(args.code)) : "";
	if (!code.trim()) return "";
	const lines = code
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("//"));
	const first = lines[0] ?? "";
	if (!first) return "";
	return first.length > 72 ? `${first.slice(0, 71).trimEnd()}…` : first;
}

export function isCommandLikeTool(name: string): boolean {
	return name === "bash" || name === "powershell" || name === "codemode";
}

function formatParentheticalMeta(
	pal: GrokPalette,
	status: RowStatus,
	state: RowState,
	name: string,
): string {
	const running = status === "running";
	const duration = durationFromState(state, running);
	if (running) {
		return duration ? ` ${pal.dim(`(${duration})`)}` : "";
	}

	const grokMeta = state.grok;
	if (status === "error") {
		const parts: string[] = [];
		if (grokMeta?.exitCode !== undefined) parts.push(`exit ${grokMeta.exitCode}`);
		else parts.push("failed");
		if (duration) parts.push(duration);
		return ` ${pal.dim(`(${parts.join(" · ")})`)}`;
	}

	if ((name === "edit" || name === "write") && grokMeta?.changes) {
		const added = pal.theme.fg("toolDiffAdded", `+${grokMeta.changes.added}`);
		const removed = pal.theme.fg("toolDiffRemoved", `-${grokMeta.changes.removed}`);
		const durSuffix = duration ? pal.dim(` · ${duration}`) : "";
		return ` ${pal.dim("(")}${added}${pal.dim(" ")}${removed}${durSuffix}${pal.dim(")")}`;
	}

	const parts: string[] = [];
	if (grokMeta?.lineSummary) parts.push(grokMeta.lineSummary);
	if (duration) parts.push(duration);
	const base = parts.length > 0 ? ` ${pal.dim(`(${parts.join(" · ")})`)}` : "";
	const nested = grokMeta?.nestedSummary ? `${pal.dim(" · ")}${grokMeta.nestedSummary}` : "";
	return base + nested;
}

function buildHeaderParts(
	name: string,
	args: ToolArgs,
	status: RowStatus,
): { verb: string; target: string } {
	const path = pathOf(args);
	const running = status === "running";
	const failed = status === "error";

	switch (name) {
		case "read":
			return {
				verb: failed ? "Failed read" : running ? "Reading" : "Read",
				target: path,
			};
		case "grep": {
			const pat = typeof args.pattern === "string" ? singleLineText(args.pattern, 60) : "…";
			return {
				verb: failed ? "Failed grep" : running ? "Searching" : "Searched",
				target: path ? `/${pat}/ in ${path}` : `/${pat}/`,
			};
		}
		case "find": {
			const pat = typeof args.pattern === "string" ? singleLineText(args.pattern, 60) : "…";
			return {
				verb: failed ? "Failed find" : running ? "Finding" : "Found",
				target: path ? `${pat} in ${path}` : pat,
			};
		}
		case "ls":
			return {
				verb: failed ? "Failed ls" : running ? "Listing" : "Listed",
				target: path || ".",
			};
		case "edit":
			return {
				verb: failed ? "Failed to edit" : running ? "Editing" : "Edited",
				target: path,
			};
		case "write":
			return {
				verb: failed ? "Failed to write" : running ? "Writing" : "Wrote",
				target: path,
			};
		case "bash":
		case "powershell": {
			const rawCmd = typeof args.command === "string" ? singleLineText(args.command, 100) : "";
			return {
				verb: failed ? "Failed" : running ? "Running" : "Ran",
				target: rawCmd || name,
			};
		}
		case "codemode": {
			const snippet = summarizeCodemodeSource(args);
			return {
				verb: failed ? "Failed" : running ? "Running" : "Ran",
				target: snippet ? `codemode ${snippet}` : "codemode",
			};
		}
		default: {
			const argText = summarizeCustomArguments(args);
			return {
				verb: failed ? `Failed ${name}` : running ? `Calling ${name}` : name,
				target: argText,
			};
		}
	}
}

class GrokLiveLines implements Component {
	private cache?: { key: string; width: number; lines: string[] };

	constructor(
		private readonly computeKey: (width: number, pal: GrokPalette) => string,
		private readonly draw: (width: number, pal: GrokPalette) => string[],
		private readonly fallbackTheme: Theme,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const safeWidth = Math.max(1, width);
		const pal = grokPalette(this.fallbackTheme);
		const key = `${pal.key}|${this.computeKey(safeWidth, pal)}`;
		if (!this.cache || this.cache.key !== key || this.cache.width !== safeWidth) {
			const raw = this.draw(safeWidth, pal);
			this.cache = {
				key,
				width: safeWidth,
				lines: raw.map((line) =>
					visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "…") : line,
				),
			};
		}
		return this.cache.lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

export function renderGrokCall(options: {
	name: string;
	args: ToolArgs;
	theme: Theme;
	state: RowState;
	getStatus: () => RowStatus;
	syncRunning: (running: boolean) => void;
}): Component {
	const { name, args, theme, state, getStatus, syncRunning } = options;
	/* Активируем подписку на 30 fps таймер сразу при создании строки для активного вызова. */
	syncRunning(getStatus() === "running");

	return new GrokLiveLines(
		() => {
			const status = getStatus();
			syncRunning(status === "running");
			const expanded = state.expanded === true;
			const elapsedBucket = status === "running" ? String(getAnimationElapsedMs()) : "settled";
			const g = state.grok;
			return [
				status,
				expanded ? "1" : "0",
				elapsedBucket,
				state.durationMs ?? "",
				state.endedAt ?? "",
				g?.exitCode ?? "",
				g?.changes ? `${g.changes.added}/${g.changes.removed}` : "",
				g?.lineSummary ?? "",
				g?.nestedSummary ?? "",
			].join("|");
		},
		(width, pal) => {
			const status = getStatus();
			const expanded = state.expanded === true;
			const diamond = pal.diamond(status, expanded);
			const { verb, target } = buildHeaderParts(name, args, status);
			const styledVerb = pal.title(verb, status, expanded);
			const styledTarget = target ? ` ${pal.target(target, expanded)}` : "";
			const meta = formatParentheticalMeta(pal, status, state, name);
			const head = ` ${diamond} ${styledVerb}${styledTarget}${meta}`;
			const lines = [truncateToWidth(head, width, "…")];

			if (expanded && !isCommandLikeTool(name) && name !== "read" && name !== "edit" && name !== "write" && name !== "grep" && name !== "find" && name !== "ls") {
				if (Object.keys(args).length > 0) {
					lines.push(...renderArguments(args, pal.theme, pal.rail("   │ ")).render(width));
				}
			}
			return lines;
		},
		theme,
	);
}

export function countDiffChangesFromResult(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
): { lines: CodeDiffLine[]; changes: { added: number; removed: number } } {
	const patch = getEditPatch(result);
	const displayDiff = getEditDiff(result);
	const parsed = parseCodeDiff(patch, displayDiff);
	if (parsed.length > 0) {
		let added = 0;
		let removed = 0;
		for (const line of parsed) {
			if (line.kind === "add") added += 1;
			else if (line.kind === "remove") removed += 1;
		}
		return { lines: parsed, changes: { added, removed } };
	}
	if (name === "edit") {
		return {
			lines: [],
			changes: countEditChanges(result) ?? { added: 0, removed: 0 },
		};
	}
	const content = typeof args.content === "string" ? normalizeLineEndings(args.content).replace(/\n$/u, "") : "";
	const writeLines: CodeDiffLine[] = content
		? content.split("\n").map((line, index) => ({
				kind: "add",
				lineNumber: index + 1,
				content: line.replace(/\t/gu, "   "),
				hunk: 0,
			}))
		: [];
	return {
		lines: writeLines,
		changes: { added: writeLines.length, removed: 0 },
	};
}

export function renderGrokResult(options: {
	name: string;
	args: ToolArgs;
	result: AgentToolResult<unknown>;
	output: string;
	theme: Theme;
	state: RowState;
	isError: boolean;
	isPartial: boolean;
	getDensity: () => ToolDensity;
	canRun: () => boolean;
	syncRunning: (running: boolean) => void;
	author?: (expanded: boolean) => Component | undefined;
	nestedSummary?: string;
}): Component {
	const {
		name,
		args,
		result,
		output,
		theme,
		state,
		isError,
		isPartial,
		getDensity,
		canRun,
		syncRunning,
		author,
		nestedSummary,
	} = options;

	const cmdLike = isCommandLikeTool(name);
	const detailsCalls = (result.details as { calls?: readonly { name?: unknown; args?: unknown; status?: unknown }[] } | undefined)?.calls;
	const extractedCmd = cmdLike ? extractCommandOutput(name, output, isError, detailsCalls) : undefined;
	const diffInfo =
		!isPartial && !isError && (name === "edit" || name === "write")
			? countDiffChangesFromResult(name, args, result)
			: undefined;

	let lineSummary: string | undefined;
	if (!isPartial && !isError) {
		if (cmdLike) {
			const count = extractedCmd?.lines.length ?? 0;
			lineSummary = count > 0 ? `${count} ${count === 1 ? "line" : "lines"}` : undefined;
		} else if (name !== "edit" && name !== "write") {
			lineSummary = output ? formatResultLineSummary(name, args, result, output) : undefined;
		}
	}

	state.grok = {
		exitCode: extractedCmd?.exitCode,
		changes: diffInfo?.changes,
		lineSummary,
		nestedSummary,
		failureReason: isError && !isPartial ? summarizeFailure(name, output) : undefined,
	};

	return new GrokLiveLines(
		() => {
			const running = isPartial && canRun();
			syncRunning(running);
			const density = getDensity();
			const expanded = state.expanded === true;
			const elapsedBucket = running ? String(getAnimationElapsedMs()) : "settled";
			return `${density}|${expanded ? "1" : "0"}|${running ? "1" : "0"}|${elapsedBucket}|${nestedSummary ?? ""}`;
		},
		(width, pal) => {
			const running = isPartial && canRun();
			const expanded = state.expanded === true;
			const density = getDensity();
			const rail = pal.rail("   │ ");
			const avail = Math.max(1, width - 5);

			if (running) {
				if (!cmdLike) return [];
				const lines = extractedCmd?.lines ?? [];
				if (lines.length === 0) {
					const bar = paintRunningCommandBar(1, { theme: pal.theme, light: pal.light });
					return [`   ${bar} ${pal.dim(truncateToWidth("Running…", avail, "…"))}`];
				}
				const sliced = expanded
					? { head: lines, omitted: 0, tail: [] }
					: sliceHeadTailPreview(lines);
				const entries: Array<{ text: string; dim?: boolean }> = [
					...sliced.head.map((t) => ({ text: t })),
					...(sliced.omitted > 0 ? [{ text: "…", dim: true }] : []),
					...sliced.tail.map((t) => ({ text: t })),
				];
				return entries.map((entry, idx) => {
					const bar = paintRunningCommandBar(idx + 1, { theme: pal.theme, light: pal.light });
					const painted = entry.dim
						? pal.dim("…")
						: pal.body(truncateToWidth(entry.text, avail, "…"));
					return `   ${bar} ${painted}`;
				});
			}

			if (!expanded) {
				if ((name === "edit" || name === "write") && !isError) {
					if (density === "compact") return [];
					const allLines = diffInfo?.lines ?? [];
					const contextual = name === "edit" ? trimDiffContext(allLines, 2) : allLines;
					if (contextual.length === 0) return [];
					const maxPreview = 12;
					const rendered = [
						...(renderCodexDiff(contextual, pathOf(args), pal.theme, rail, maxPreview)?.render(
							width,
						) ?? []),
					];
					if (contextual.length > maxPreview) {
						rendered.push(`${rail}${pal.dim("…")}`);
					}
					return rendered;
				}

				if (cmdLike) {
					if (density !== "detailed") return [];
					const lines = extractedCmd?.lines ?? [];
					if (lines.length === 0) return [];
					const sliced = sliceHeadTailPreview(lines);
					const entries: Array<{ text: string; dim?: boolean }> = [
						...sliced.head.map((t) => ({ text: t })),
						...(sliced.omitted > 0 ? [{ text: "…", dim: true }] : []),
						...sliced.tail.map((t) => ({ text: t })),
					];
					return entries.map((entry) => {
						if (entry.dim) return `${rail}${pal.dim("…")}`;
						const clipped = truncateToWidth(entry.text, avail, "…");
						return `${rail}${isError ? pal.theme.fg("error", clipped) : pal.body(clipped)}`;
					});
				}

				if (isError && state.grok?.failureReason) {
					return [
						truncateToWidth(`${rail}${pal.theme.fg("error", state.grok.failureReason)}`, width, "…"),
					];
				}
				return [];
			}

			if (author) {
				try {
					const comp = author(true);
					if (comp) return [...railComponent(comp, pal.theme, rail).render(width)];
				} catch {
					/* При сбое стороннего рендерера падаем обратно на текстовый вывод. */
				}
			}

			if (name === "read" && !isError && isReadTextResult(result)) {
				const { body, footer } = splitReadFooter(output);
				const view = renderCodeView(body, pathOf(args), pal.theme, {
					startLine: readStartLine(args.offset),
					footer,
					rail,
				});
				if (view) return [...view.render(width)];
			}

			if ((name === "edit" || name === "write") && !isError) {
				const allLines = diffInfo?.lines ?? [];
				const fullDiff = renderCodexDiff(allLines, pathOf(args), pal.theme, rail);
				if (fullDiff) return [...fullDiff.render(width)];
			}

			if (cmdLike) {
				const outRows: string[] = [];
				if (name === "codemode" && typeof args.code === "string" && args.code.trim()) {
					const codeView = renderCodeView(args.code, "script.js", pal.theme, { rail });
					if (codeView) outRows.push(...codeView.render(width));
				} else if ((name === "bash" || name === "powershell") && typeof args.command === "string" && args.command.includes("\n")) {
					for (const cmdLine of normalizeLineEndings(args.command).split("\n")) {
						outRows.push(`${rail}${pal.target(`$ ${cmdLine}`, true)}`);
					}
				}
				const lines = extractedCmd?.lines ?? [];
				if (lines.length > 0) {
					const fullText = lines.join("\n");
					const renderedOut = renderOutput(fullText, pal.theme, isError, rail);
					if (renderedOut) outRows.push(...renderedOut.render(width));
				} else if (!isError) {
					outRows.push(`${rail}${pal.dim("(no output)")}`);
				}
				return outRows;
			}

			return [...(renderOutput(output, pal.theme, isError, rail)?.render(width) ?? [])];
		},
		theme,
	);
}
