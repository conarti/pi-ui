import { generateUnifiedPatch, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	Image,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	getAnimationElapsedMs,
	sampleBreathingWaveRgb,
} from "../../shared/animation-scheduler.ts";
import { getActiveGlobalTheme, isLightTheme, type RgbTuple } from "../../shared/ansi.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import {
	getPrototypeSettledGlyph,
	getPrototypeVariant,
	isPrototypeActive,
	samplePrototypeRunningGlyph,
} from "../transcript/prototype-state.ts";
import { colorizeRgb } from "./color.ts";
import {
	classifyShellCommand as classifyShellExploration,
	lookKind as classifyExploration,
	pathOf,
	type LookKind,
} from "./claude.ts";
import { isEmptyOutput, shellOutcome } from "./codex.ts";
import { TOOL_DIAMOND, normalizeLineEndings, type RowStatus } from "./core.ts";
import {
	countEditChanges,
	formatResultLineSummary,
	getEditDiff,
	getEditPatch,
	hasImageContent,
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
import { buildPrototypeStepHeaderParts } from "./step-summaries.ts";
import type { RowState, ToolArgs, ToolDensity } from "./types.ts";

export const COMMAND_PREVIEW_HEAD = 2;
export const COMMAND_PREVIEW_TAIL = 3;

const CODEMODE_SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n?/u;

function rawCodemodeOutputFromBlocks(result: AgentToolResult<unknown>, fallbackOutput: string): string {
	const [first, ...rest] = result.content;
	if (first?.type === "text" && /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/u.test(normalizeLineEndings(first.text))) {
		return rest
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => normalizeLineEndings(item.text))
			.join("\n")
			.trimEnd();
	}
	return fallbackOutput;
}

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

function formatCodemodeCallLines(
	detailsCalls?: readonly { name?: unknown; args?: unknown; status?: unknown }[],
): string[] {
	if (!Array.isArray(detailsCalls) || detailsCalls.length === 0) return [];
	return detailsCalls.map((call) => {
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
}

export function extractCommandOutput(
	name: string,
	rawOutput: string,
	isError: boolean,
	detailsCalls?: readonly { name?: unknown; args?: unknown; status?: unknown }[],
	truncationMeta?: { truncated?: boolean; fullOutputPath?: string },
): ExtractedCommandOutput {
	let text = normalizeLineEndings(rawOutput);
	let exitCode: number | undefined;

	if (name === "codemode") {
		text = text.replace(CODEMODE_SCRIPT_HEADER, "");
		text = text.replace(/^<console_output>\n([\s\S]*?)\n<\/console_output>\s*$/u, "$1");
	} else if (name === "bash" || name === "powershell") {
		if (isError) {
			const outcome = shellOutcome(text);
			exitCode = outcome.exitCode;
			text = outcome.output;
		}
		if ((truncationMeta?.truncated || truncationMeta?.fullOutputPath) && text.trimEnd().endsWith("]")) {
			const trimmed = text.trimEnd();
			const footerStart = trimmed.lastIndexOf("\n\n[");
			if (
				footerStart !== -1 &&
				(!truncationMeta.fullOutputPath || trimmed.slice(footerStart).includes(truncationMeta.fullOutputPath))
			) {
				text = trimmed.slice(0, footerStart);
			}
		}
	}

	const cleaned = stripTerminalSequences(text).replace(/\n+$/u, "");
	if (isEmptyOutput(cleaned)) {
		if (name === "codemode") {
			const callLines = formatCodemodeCallLines(detailsCalls);
			if (callLines.length > 0) return { lines: callLines, exitCode };
		}
		return { lines: [], exitCode };
	}

	const lines = cleaned.split("\n").map((line) => line.replace(/\t/gu, "   "));
	return { lines, exitCode };
}

export { classifyExploration, classifyShellExploration };

export interface ExplorationRowInput {
	toolName: string;
	toolCallId: string;
	args: unknown;
	result?: { isError?: boolean } | undefined;
	isPartial: boolean;
}

export interface DensityExplorationCounts {
	files: number;
	searches: number;
	directories: number;
}

export function countExploration(rows: readonly ExplorationRowInput[]): DensityExplorationCounts {
	const readPaths = new Set<string>();
	let unnamedReads = 0;
	let searches = 0;
	let directories = 0;

	for (const row of rows) {
		const args: ToolArgs =
			typeof row.args === "object" && row.args !== null ? (row.args as ToolArgs) : {};
		const kind = classifyExploration(row.toolName, args);
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

export function formatExploredSummary<TRow extends ExplorationRowInput>(
	rows: readonly TRow[],
	canRun: (row: TRow) => boolean = () => true,
): string {
	const { files, searches, directories } = countExploration(rows);
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

export interface DensityGroupSummary {
	readonly summary: string;
	readonly changes?: { added: number; removed: number };
}

export function formatAllGroupedSummary<
	TRow extends ExplorationRowInput & {
		result?: AgentToolResult<unknown> & { isError?: boolean };
	},
>(
	rows: readonly TRow[],
	canRun: (row: TRow) => boolean = () => true,
): DensityGroupSummary {
	const variant = getPrototypeVariant();
	const running = rows.some((row) => (!row.result || row.isPartial) && canRun(row));
	const editedPaths = new Set<string>();
	let unnamedEdits = 0;
	let commandCount = 0;
	let customCount = 0;
	let totalAdded = 0;
	let totalRemoved = 0;
	const exploreRows: TRow[] = [];

	for (const row of rows) {
		const args: ToolArgs =
			typeof row.args === "object" && row.args !== null ? (row.args as ToolArgs) : {};
		if (classifyExploration(row.toolName, args) !== undefined) {
			exploreRows.push(row);
			continue;
		}
		if (row.toolName === "edit" || row.toolName === "write") {
			const p = pathOf(args).trim();
			if (p) editedPaths.add(p);
			else unnamedEdits += 1;
			if (row.result && !row.isPartial && !row.result.isError) {
				const diff = countDiffChangesFromResult(row.toolName, args, row.result);
				totalAdded += diff.changes.added;
				totalRemoved += diff.changes.removed;
			}
			continue;
		}
		if (
			row.toolName === "bash" ||
			row.toolName === "powershell" ||
			row.toolName === "codemode"
		) {
			commandCount += 1;
			continue;
		}
		customCount += 1;
	}

	const editCount = editedPaths.size + unnamedEdits;
	const { files: expFiles, searches: expSearches, directories: expDirs } =
		countExploration(exploreRows);

	if (variant === "C") {
		const enParts: string[] = [];
		if (editCount > 0) {
			enParts.push(
				`${running ? "Editing" : "Edited"}: ${editCount} ${editCount === 1 ? "file" : "files"}`,
			);
		}
		if (commandCount > 0) {
			enParts.push(
				`${running ? "Running" : "Ran"}: ${commandCount} ${commandCount === 1 ? "cmd" : "cmds"}`,
			);
		}
		if (expFiles + expSearches + expDirs > 0) {
			const eItems: string[] = [];
			if (expFiles > 0) eItems.push(`${expFiles} ${expFiles === 1 ? "file" : "files"}`);
			if (expSearches > 0) eItems.push(`${expSearches} ${expSearches === 1 ? "search" : "searches"}`);
			if (expDirs > 0) eItems.push(`${expDirs} ${expDirs === 1 ? "dir" : "dirs"}`);
			enParts.push(`${running ? "Exploring" : "Explored"}: ${eItems.join(", ")}`);
		}
		if (customCount > 0) {
			enParts.push(`${customCount} ${customCount === 1 ? "tool" : "tools"}`);
		}
		return {
			summary: enParts.join(" · ") || (running ? "Running…" : "Completed"),
			changes: totalAdded > 0 || totalRemoved > 0 ? { added: totalAdded, removed: totalRemoved } : undefined,
		};
	}

	/* Если все вызовы в группе — исследовательские, сохраняем чистый формат Explored */
	if (editCount === 0 && commandCount === 0 && customCount === 0) {
		return { summary: formatExploredSummary(rows, canRun) };
	}

	const clauses: string[] = [];
	if (editCount > 0) {
		clauses.push(
			`${running ? "Editing" : "Edited"} ${editCount} ${editCount === 1 ? "file" : "files"}`,
		);
	}
	if (commandCount > 0) {
		const verb = clauses.length === 0 ? (running ? "Running" : "Ran") : running ? "running" : "ran";
		clauses.push(`${verb} ${commandCount} ${commandCount === 1 ? "command" : "commands"}`);
	}
	if (expFiles + expSearches + expDirs > 0) {
		const expParts: string[] = [];
		if (expFiles > 0) expParts.push(`${expFiles} ${expFiles === 1 ? "file" : "files"}`);
		if (expSearches > 0) expParts.push(`${expSearches} ${expSearches === 1 ? "search" : "searches"}`);
		if (expDirs > 0) expParts.push(`${expDirs} ${expDirs === 1 ? "dir" : "dirs"}`);
		const verb =
			clauses.length === 0 ? (running ? "Exploring" : "Explored") : running ? "exploring" : "explored";
		clauses.push(`${verb} ${expParts.join(", ")}`);
	}
	if (customCount > 0) {
		const verb = clauses.length === 0 ? (running ? "Calling" : "Called") : "called";
		clauses.push(`${verb} ${customCount} ${customCount === 1 ? "tool" : "tools"}`);
	}

	return {
		summary: clauses.join(", "),
		changes:
			totalAdded > 0 || totalRemoved > 0
				? { added: totalAdded, removed: totalRemoved }
				: undefined,
	};
}

export interface DensityPalette {
	readonly theme: Theme;
	readonly light: boolean;
	readonly key: string;
	diamond(status: RowStatus, expanded: boolean, hovered?: boolean): string;
	title(text: string, status: RowStatus, expanded: boolean, hovered?: boolean): string;
	target(text: string, expanded: boolean, hovered?: boolean): string;
	dim(text: string): string;
	body(text: string): string;
	rail(text: string): string;
}

function paintDensityRgb(theme: Theme, rgb: RgbTuple, text: string): string {
	return colorizeRgb(theme, { r: rgb[0], g: rgb[1], b: rgb[2] }, text);
}

function paintDensityWaveGlyph(theme: Theme, light: boolean, row: number, glyph: string): string {
	const rgb = sampleBreathingWaveRgb(row, { theme, light });
	return paintDensityRgb(theme, rgb, glyph);
}

export function densityPalette(fallbackTheme: Theme): DensityPalette {
	const theme = getActiveGlobalTheme(fallbackTheme);
	const light = isLightTheme(theme);
	const colorMode = theme.getColorMode?.() ?? "truecolor";
	const variant = getPrototypeVariant();
	const protoOn = variant !== "off";
	const settledGlyph = protoOn ? getPrototypeSettledGlyph(variant) : TOOL_DIAMOND;
	const key = `${variant}:${light ? "light" : "dark"}:${colorMode}:${(theme as { name?: string })?.name ?? ""}:${theme.getFgAnsi?.("text") ?? ""}`;

	return {
		theme,
		light,
		key,
		diamond(status: RowStatus, expanded: boolean, hovered = false): string {
			if (status === "running") {
				if (protoOn) {
					return samplePrototypeRunningGlyph(0, { theme, light, variant });
				}
				return paintDensityWaveGlyph(theme, light, 0, TOOL_DIAMOND);
			}
			if (status === "error") {
				return theme.fg("error", settledGlyph);
			}
			if (hovered || (expanded && status === "success")) {
				return paintDensityRgb(theme, light ? [37, 99, 235] : [97, 175, 239], settledGlyph);
			}
			return paintDensityRgb(theme, light ? [112, 128, 152] : [92, 110, 136], settledGlyph);
		},
		title(text: string, status: RowStatus, expanded: boolean, hovered = false): string {
			if (status === "error") {
				return theme.fg("error", expanded ? theme.bold(text) : text);
			}
			if (hovered) {
				return paintDensityRgb(theme, light ? [29, 78, 216] : [156, 204, 250], text);
			}
			if (status === "running" || expanded) {
				const painted = paintDensityRgb(theme, light ? [24, 48, 82] : [172, 194, 222], text);
				return theme.bold(painted);
			}
			return paintDensityRgb(theme, light ? [68, 86, 112] : [136, 154, 178], text);
		},
		target(text: string, expanded: boolean, hovered = false): string {
			if (!text) return "";
			return paintDensityRgb(
				theme,
				light
					? hovered || expanded
						? [29, 78, 216]
						: [56, 78, 108]
					: hovered || expanded
						? [145, 195, 248]
						: [148, 168, 196],
				text,
			);
		},
		dim(text: string): string {
			return paintDensityRgb(theme, light ? [124, 140, 164] : [84, 100, 124], text);
		},
		body(text: string): string {
			return paintDensityRgb(theme, light ? [72, 90, 116] : [128, 144, 168], text);
		},
		rail(text: string): string {
			return paintDensityRgb(theme, light ? [124, 140, 164] : [84, 100, 124], text);
		},
	};
}

export function formatDensityDuration(durationMs: number | undefined): string | undefined {
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
		return formatDensityDuration(state.durationMs);
	}
	if (state.startedAt === undefined) return undefined;
	const elapsed = (running ? Date.now() : (state.endedAt ?? Date.now())) - state.startedAt;
	if (running && elapsed < 1000) return undefined;
	return formatDensityDuration(elapsed);
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

/**
 * Formats the complete, untruncated shell command (both 1-line and multi-line) wrapped
 * cleanly within `avail` under `rail`, so expanding a truncated command row NEVER loses
 * any flags, arguments, or quoted prompts.
 */
function formatWrappedShellCommandRows(
	rawCommand: string,
	pal: DensityPalette,
	rail: string,
	avail: number,
): string[] {
	const cleaned = normalizeLineEndings(stripTerminalSequences(rawCommand)).trimEnd();
	if (!cleaned) return [];
	const wrapWidth = Math.max(8, avail - 2);
	const out: string[] = [];
	const logicalLines = cleaned.split("\n");
	for (let lineIdx = 0; lineIdx < logicalLines.length; lineIdx++) {
		const logical = logicalLines[lineIdx]!;
		const chunks = logical.length > 0 ? wrapTextWithAnsi(logical, wrapWidth) : [""];
		for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
			const prefix = lineIdx === 0 && chunkIdx === 0 ? "$ " : "  ";
			out.push(`${rail}${pal.target(`${prefix}${chunks[chunkIdx]!}`, true)}`);
		}
	}
	return out;
}

function formatParentheticalMeta(
	pal: DensityPalette,
	status: RowStatus,
	state: RowState,
	name: string,
	liveNestedSummary?: string,
): string {
	const running = status === "running";
	const duration = durationFromState(state, running);
	if (running) {
		return duration ? ` ${pal.dim(`(${duration})`)}` : "";
	}

	const densityMeta = state.density;
	if (status === "error") {
		const parts: string[] = [];
		if (densityMeta?.exitCode !== undefined) parts.push(`exit ${densityMeta.exitCode}`);
		else parts.push("failed");
		if (duration) parts.push(duration);
		return ` ${pal.dim(`(${parts.join(" · ")})`)}`;
	}

	if ((name === "edit" || name === "write") && densityMeta?.changes) {
		const added = pal.theme.fg("toolDiffAdded", `+${densityMeta.changes.added}`);
		const removed = pal.theme.fg("toolDiffRemoved", `-${densityMeta.changes.removed}`);
		const durSuffix = duration ? pal.dim(` · ${duration}`) : "";
		return ` ${pal.dim("(")}${added}${pal.dim(" ")}${removed}${durSuffix}${pal.dim(")")}`;
	}

	const resolvedNested = liveNestedSummary ?? densityMeta?.nestedSummary;
	const suppressInternalLineCount =
		isPrototypeActive() && name === "codemode" && Boolean(resolvedNested);
	const parts: string[] = [];
	if (densityMeta?.lineSummary && !suppressInternalLineCount) parts.push(densityMeta.lineSummary);
	if (duration) parts.push(duration);
	const base = parts.length > 0 ? ` ${pal.dim(`(${parts.join(" · ")})`)}` : "";
	const nested = resolvedNested ? `${pal.dim(" · ")}${resolvedNested}` : "";
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

class DensityLiveLines implements Component {
	private cache?: { key: string; width: number; lines: string[] };
	private hovered = false;

	constructor(
		private readonly computeKey: (width: number, pal: DensityPalette, hovered: boolean) => string,
		private readonly draw: (width: number, pal: DensityPalette, hovered: boolean) => string[],
		private readonly fallbackTheme: Theme,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const safeWidth = Math.max(1, width);
		const pal = densityPalette(this.fallbackTheme);
		const key = `${pal.key}|${this.hovered ? "h1" : "h0"}|${this.computeKey(safeWidth, pal, this.hovered)}`;
		if (!this.cache || this.cache.key !== key || this.cache.width !== safeWidth) {
			const raw = this.draw(safeWidth, pal, this.hovered);
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!isPrototypeActive() || event.type !== "move") return undefined;
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
		return undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

export function renderDensityCall(options: {
	name: string;
	args: ToolArgs;
	theme: Theme;
	state: RowState;
	getStatus: () => RowStatus;
	syncRunning: (running: boolean) => void;
	getNestedSummary?: () => string | undefined;
	getStepSummary?: () => string | undefined;
	cwd?: string;
}): Component {
	const { name, args, theme, state, getStatus, syncRunning, getNestedSummary, getStepSummary, cwd } = options;
	syncRunning(getStatus() === "running");

	const resolveHeader = (status: RowStatus, expanded = false) =>
		isPrototypeActive()
			? buildPrototypeStepHeaderParts({
					name,
					args,
					status,
					rawPath: pathOf(args),
					stepSummary: getStepSummary?.(),
					cwd,
					expanded,
					summarizeCustomArgs: summarizeCustomArguments,
				})
			: buildHeaderParts(name, args, status);

	return new DensityLiveLines(
		() => {
			const status = getStatus();
			syncRunning(status === "running");
			const expanded = state.expanded === true;
			const elapsedBucket = status === "running" ? String(getAnimationElapsedMs()) : "settled";
			const d = state.density;
			const { verb, target } = resolveHeader(status, expanded);
			const liveNested = getNestedSummary?.() ?? d?.nestedSummary ?? "";
			return [
				status,
				expanded ? "1" : "0",
				d ? "1" : "0",
				elapsedBucket,
				verb,
				target,
				state.durationMs ?? "",
				state.endedAt ?? "",
				d?.exitCode ?? "",
				d?.changes ? `${d.changes.added}/${d.changes.removed}` : "",
				d?.lineSummary ?? "",
				liveNested,
			].join("|");
		},
		(width, pal, hovered) => {
			const status = getStatus();
			const expanded = state.expanded === true;
			const diamond = pal.diamond(status, expanded, hovered);
			const { verb, target } = resolveHeader(status, expanded);
			const styledVerb = pal.title(verb, status, expanded, hovered);
			const styledTarget = target ? ` ${pal.target(target, expanded, hovered)}` : "";
			const meta = formatParentheticalMeta(pal, status, state, name, getNestedSummary?.());
			const variant = getPrototypeVariant();
			const protoOn = variant !== "off";
			const rightGuard = protoOn && width >= 48 ? 4 : 0;
			const usableWidth = Math.max(8, width - rightGuard);
			const hoverChevron =
				hovered && protoOn
					? ` ${pal.dim(expanded ? "⌄" : "›")}`
					: "";
			const leadPrefix = protoOn ? "  " : " ";
			const head = `${leadPrefix}${diamond} ${styledVerb}${styledTarget}${meta}${hoverChevron}`;
			const lines =
				expanded && protoOn && visibleWidth(head) > usableWidth
					? wrapTextWithAnsi(head, Math.max(8, usableWidth - 4)).map((chunk, idx) =>
							idx === 0 ? chunk : `    ${chunk}`,
						)
					: [truncateToWidth(head, usableWidth, "…")];

			const argRail = pal.rail(protoOn ? "    │ " : "   │ ");
			const railAvail = Math.max(8, usableWidth - (protoOn ? 6 : 5));

			if (!protoOn && status === "running" && isCommandLikeTool(name) && !state.density) {
				const subPad = "   ";
				const bar = paintDensityWaveGlyph(pal.theme, pal.light, 1, "▎");
				lines.push(`${subPad}${bar} ${pal.dim(truncateToWidth("Running…", railAvail, "…"))}`);
			}

			/* While a command/script is still running before any result arrives, expanding the call
			   immediately reveals the full untruncated command or script. */
			if (expanded && protoOn && !state.density && isCommandLikeTool(name)) {
				if ((name === "bash" || name === "powershell") && typeof args.command === "string" && args.command.trim()) {
					lines.push(...formatWrappedShellCommandRows(args.command, pal, argRail, railAvail));
				} else if (name === "codemode" && typeof args.code === "string" && args.code.trim()) {
					const codeView = renderCodeView(args.code, "script.js", pal.theme, { rail: argRail });
					if (codeView) lines.push(...codeView.render(usableWidth));
				}
			}

			/* If a grep/find header used a human stepSummary, show the exact pattern & path when expanded */
			if (expanded && protoOn && (name === "grep" || name === "find") && typeof args.pattern === "string" && getStepSummary?.()) {
				const p = pathOf(args);
				const detail = p ? `pattern: ${args.pattern}  path: ${p}` : `pattern: ${args.pattern}`;
				for (const w of wrapTextWithAnsi(detail, railAvail)) {
					lines.push(`${argRail}${pal.dim(w)}`);
				}
			}

			if (expanded && !isCommandLikeTool(name) && name !== "read" && name !== "edit" && name !== "write" && name !== "grep" && name !== "find" && name !== "ls") {
				if (Object.keys(args).length > 0) {
					lines.push(...renderArguments(args, pal.theme, argRail).render(usableWidth));
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
	previousWriteContent?: string,
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
	if (name === "write" && previousWriteContent !== undefined) {
		const oldNorm = normalizeLineEndings(previousWriteContent);
		const newNorm = typeof args.content === "string" ? normalizeLineEndings(args.content) : "";
		if (oldNorm === newNorm) {
			return { lines: [], changes: { added: 0, removed: 0 } };
		}
		const generatedPatch = generateUnifiedPatch(pathOf(args) || "file", oldNorm, newNorm, 4);
		const parsedWrite = parseCodeDiff(generatedPatch);
		let added = 0;
		let removed = 0;
		for (const line of parsedWrite) {
			if (line.kind === "add") added += 1;
			else if (line.kind === "remove") removed += 1;
		}
		return { lines: parsedWrite, changes: { added, removed } };
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

export function renderDensityResult(options: {
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
	previousWriteContent?: string;
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
		previousWriteContent,
	} = options;

	const cmdLike = isCommandLikeTool(name);
	const rawDetails = result.details as
		| {
				calls?: readonly { name?: unknown; args?: unknown; status?: unknown }[];
				fullOutputPath?: unknown;
				truncation?: { truncated?: unknown };
		  }
		| undefined;
	const detailsCalls = rawDetails?.calls;
	const truncationMeta =
		!isPartial && (rawDetails?.fullOutputPath !== undefined || rawDetails?.truncation?.truncated === true)
			? {
					truncated: rawDetails?.truncation?.truncated === true,
					fullOutputPath: typeof rawDetails?.fullOutputPath === "string" ? rawDetails.fullOutputPath : undefined,
				}
			: undefined;
	const effectiveOutput = name === "codemode" ? rawCodemodeOutputFromBlocks(result, output) : output;
	const extractedCmd = cmdLike
		? extractCommandOutput(name, effectiveOutput, isError, detailsCalls, truncationMeta)
		: undefined;
	const diffInfo =
		!isPartial && !isError && (name === "edit" || name === "write")
			? countDiffChangesFromResult(name, args, result, previousWriteContent)
			: undefined;

	let lineSummary: string | undefined;
	if (!isPartial && !isError) {
		if (hasImageContent(result)) {
			lineSummary = formatResultLineSummary(name, args, result, output);
		} else if (cmdLike) {
			const count = extractedCmd?.lines.length ?? 0;
			lineSummary = count > 0 ? `${count} ${count === 1 ? "line" : "lines"}` : undefined;
		} else if (name !== "edit" && name !== "write") {
			lineSummary = output ? formatResultLineSummary(name, args, result, output) : undefined;
		}
	}

	state.density = {
		exitCode: extractedCmd?.exitCode,
		changes: diffInfo?.changes,
		lineSummary,
		nestedSummary,
		failureReason: isError && !isPartial ? summarizeFailure(name, output) : undefined,
	};

	return new DensityLiveLines(
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
			const protoOn = isPrototypeActive();
			const rightGuard = protoOn && width >= 48 ? 4 : 0;
			const usableWidth = Math.max(8, width - rightGuard);
			const rail = pal.rail(protoOn ? "    │ " : "   │ ");
			const avail = Math.max(1, usableWidth - (protoOn ? 6 : 5));

			if (running) {
				if (!cmdLike) return [];
				const cmdHeaderRows: string[] = [];
				if (expanded && protoOn) {
					if ((name === "bash" || name === "powershell") && typeof args.command === "string" && args.command.trim()) {
						cmdHeaderRows.push(...formatWrappedShellCommandRows(args.command, pal, rail, avail));
					} else if (name === "codemode" && typeof args.code === "string" && args.code.trim()) {
						const codeView = renderCodeView(args.code, "script.js", pal.theme, { rail });
						if (codeView) cmdHeaderRows.push(...codeView.render(usableWidth));
					}
				}
				const lines = extractedCmd?.lines ?? [];
				if (lines.length === 0) {
					const subLead = protoOn ? "    " : "   ";
					const bar = paintDensityWaveGlyph(pal.theme, pal.light, 1, "▎");
					return [...cmdHeaderRows, `${subLead}${bar} ${pal.dim(truncateToWidth("Running…", avail, "…"))}`];
				}
				if (expanded && protoOn) {
					const renderedOut = renderOutput(lines.join("\n"), pal.theme, isError, rail);
					return [...cmdHeaderRows, ...(renderedOut?.render(usableWidth) ?? [])];
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
					const bar = paintDensityWaveGlyph(pal.theme, pal.light, idx + 1, "▎");
					const painted = entry.dim
						? pal.dim("…")
						: pal.body(truncateToWidth(entry.text, avail, "…"));
					return `   ${bar} ${painted}`;
				});
			}

			if (!expanded) {
				if (hasImageContent(result) && !isError) {
					/* На терминалах с Kitty/iTerm2 сам ToolExecutionComponent рисует нативный Image ниже заголовка. */
					if (getCapabilities().images) return [];
					const imgBlocks = result.content.filter(
						(item): item is { type: "image"; data: string; mimeType: string } =>
							item?.type === "image" &&
							typeof (item as { data?: unknown }).data === "string" &&
							typeof (item as { mimeType?: unknown }).mimeType === "string",
					);
					return imgBlocks.flatMap((img) =>
						new Image(
							img.data,
							img.mimeType,
							{ fallbackColor: (s) => pal.dim(s) },
							{ maxWidthCells: Math.min(60, avail) },
						)
							.render(avail)
							.map((line) => `${rail}${line}`),
					);
				}

				if ((name === "edit" || name === "write") && !isError) {
					if (density === "compact" || density === "grouped" || density === "balanced") return [];
					const allLines = diffInfo?.lines ?? [];
					const hasContext = allLines.some((line) => line.kind === "context");
					const contextual = hasContext ? trimDiffContext(allLines, 2) : allLines;
					if (contextual.length === 0) return [];
					const maxPreview = 12;
					const fullPreview =
						renderCodexDiff(contextual, pathOf(args), pal.theme, rail)?.render(width) ?? [];
					if (fullPreview.length > maxPreview) {
						return [...fullPreview.slice(0, maxPreview), `${rail}${pal.dim("…")}`];
					}
					return [...fullPreview];
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

				if (isError && state.density?.failureReason) {
					return [
						truncateToWidth(`${rail}${pal.theme.fg("error", state.density.failureReason)}`, width, "…"),
					];
				}
				return [];
			}

			if (author) {
				try {
					const comp = author(true);
					if (comp) {
						const rendered = railComponent(comp, pal.theme, rail).render(width);
						if (rendered.length > 0) return [...rendered];
					}
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
					if (codeView) outRows.push(...codeView.render(usableWidth));
				} else if (
					(name === "bash" || name === "powershell") &&
					typeof args.command === "string" &&
					(protoOn ? args.command.trim().length > 0 : args.command.includes("\n"))
				) {
					if (protoOn) {
						outRows.push(...formatWrappedShellCommandRows(args.command, pal, rail, avail));
					} else {
						for (const cmdLine of normalizeLineEndings(args.command).split("\n")) {
							outRows.push(`${rail}${pal.target(`$ ${cmdLine}`, true)}`);
						}
					}
				}
				const nestedCallLines = name === "codemode" ? formatCodemodeCallLines(detailsCalls) : [];
				const lines = extractedCmd?.lines ?? [];
				const linesAlreadyAreCalls =
					nestedCallLines.length > 0 &&
					lines.length === nestedCallLines.length &&
					lines.every((line, idx) => line === nestedCallLines[idx]);
				if (nestedCallLines.length > 0 && !linesAlreadyAreCalls) {
					for (const callLine of nestedCallLines) {
						if (protoOn) {
							for (const wrappedCall of wrapTextWithAnsi(callLine, avail)) {
								outRows.push(`${rail}${pal.dim(wrappedCall)}`);
							}
						} else {
							outRows.push(`${rail}${pal.dim(truncateToWidth(callLine, avail, "…"))}`);
						}
					}
				}
				if (lines.length > 0) {
					const fullText = lines.join("\n");
					const renderedOut = renderOutput(fullText, pal.theme, isError, rail);
					if (renderedOut) outRows.push(...renderedOut.render(usableWidth));
				} else if (!isError && nestedCallLines.length === 0) {
					outRows.push(`${rail}${pal.dim("(no output)")}`);
				}
				return outRows;
			}

			return [...(renderOutput(output, pal.theme, isError, rail)?.render(width) ?? [])];
		},
		theme,
	);
}
