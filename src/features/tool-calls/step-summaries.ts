import { homedir } from "node:os";
import { basename, isAbsolute, relative } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { normalizeLineEndings, type RowStatus } from "./core.ts";
import type { ToolArgs } from "./types.ts";

export const AGY_TOOL_SUMMARIES_ENTRY_TYPE = "pi-agy-tool-summaries";

interface CachedSummaryIndex {
	scannedLength: number;
	byCallId: Map<string, string>;
}

const sessionSummaryCache = new WeakMap<readonly unknown[], CachedSummaryIndex>();
const liveSummaryOverrides = new Map<string, string>();
const MAX_LIVE_OVERRIDES = 1000;

export function cleanStepSummaryText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

export function rememberLiveToolSummary(toolCallId: string, summary: string | undefined): void {
	const cleaned = cleanStepSummaryText(summary);
	if (!toolCallId || !cleaned) return;
	liveSummaryOverrides.set(toolCallId, cleaned);
	if (liveSummaryOverrides.size > MAX_LIVE_OVERRIDES) {
		const oldest = liveSummaryOverrides.keys().next().value;
		if (oldest !== undefined) liveSummaryOverrides.delete(oldest);
	}
}

export function extractInlineToolSummary(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const rec = args as Record<string, unknown>;
	const direct =
		cleanStepSummaryText(rec.toolSummary) ??
		cleanStepSummaryText(rec.toolAction) ??
		cleanStepSummaryText(rec.summary);
	if (direct) return direct;
	if (rec.input && typeof rec.input === "object" && !Array.isArray(rec.input)) {
		const nested = rec.input as Record<string, unknown>;
		return cleanStepSummaryText(nested.toolSummary) ?? cleanStepSummaryText(nested.toolAction);
	}
	return undefined;
}

function scanEntriesIntoMap(
	entries: readonly unknown[],
	startIndex: number,
	target: Map<string, string>,
): void {
	for (let i = startIndex; i < entries.length; i++) {
		const raw = entries[i];
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== AGY_TOOL_SUMMARIES_ENTRY_TYPE) continue;
		if (!entry.data || typeof entry.data !== "object") continue;
		const summaries = (entry.data as { summaries?: unknown }).summaries;
		if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)) continue;
		for (const [callId, value] of Object.entries(summaries as Record<string, unknown>)) {
			const cleaned = cleanStepSummaryText(value);
			if (callId && cleaned) {
				target.set(callId, cleaned);
			}
		}
	}
}

/**
 * Resolves a human-readable 2-6 word step summary for `toolCallId` from inline tool
 * arguments or persisted/live `pi-agy-tool-summaries` session entries in O(1) amortized time.
 */
export function resolveExternalToolSummary(
	toolCallId: string | undefined,
	args: unknown,
	sessionEntries?: readonly unknown[],
): string | undefined {
	const inline = extractInlineToolSummary(args);
	if (inline) {
		if (toolCallId) rememberLiveToolSummary(toolCallId, inline);
		return inline;
	}
	if (!toolCallId) return undefined;
	const live = liveSummaryOverrides.get(toolCallId);
	if (live) return live;
	if (!sessionEntries || sessionEntries.length === 0) return undefined;

	let cached = sessionSummaryCache.get(sessionEntries);
	if (!cached || cached.scannedLength > sessionEntries.length) {
		cached = { scannedLength: 0, byCallId: new Map() };
		sessionSummaryCache.set(sessionEntries, cached);
	}
	if (cached.scannedLength < sessionEntries.length) {
		scanEntriesIntoMap(sessionEntries, cached.scannedLength, cached.byCallId);
		cached.scannedLength = sessionEntries.length;
	}
	return cached.byCallId.get(toolCallId);
}

/**
 * Formats an absolute path cleanly relative to `cwd` (or `~` when under home directory).
 */
export function formatWorkspacePath(rawPath: string, cwd?: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) return "";
	const activeCwd = cwd || process.cwd();
	if (isAbsolute(trimmed)) {
		const rel = relative(activeCwd, trimmed);
		if (rel === "") return ".";
		if (!rel.startsWith("..") && !isAbsolute(rel)) {
			return rel.replaceAll("\\", "/");
		}
		const home = homedir();
		if (home && (trimmed === home || trimmed.startsWith(`${home}/`))) {
			return `~${trimmed.slice(home.length)}`;
		}
	}
	return trimmed;
}

export function relativizeCommandPaths(cmd: string, cwd?: string): string {
	const activeCwd = (cwd || process.cwd()).replace(/\/+$/u, "");
	let out = cmd;
	if (activeCwd.length > 1 && out.includes(`${activeCwd}/`)) {
		out = out.replaceAll(`${activeCwd}/`, "");
	}
	const home = homedir().replace(/\/+$/u, "");
	if (home.length > 1 && out.includes(`${home}/`)) {
		out = out.replaceAll(`${home}/`, "~/");
	}
	return out;
}

/**
 * Synthesizes a clean human-readable description of a `codemode` script when no
 * external `toolSummary` was supplied (for direct non-agy providers).
 */
export function summarizeCodemodeIntentFallback(
	args: ToolArgs,
	status: RowStatus,
	cwd?: string,
): { verb: string; target: string } {
	const code = typeof args.code === "string" ? normalizeLineEndings(stripTerminalSequences(args.code)) : "";
	const running = status === "running";
	const failed = status === "error";

	if (!code.trim()) {
		return {
			verb: failed ? "Failed batch" : running ? "Running batch" : "Ran batch",
			target: "",
		};
	}

	/* Count `tools.<name>(...)` invocations and extract up to 2 target file basenames */
	const counts = new Map<string, number>();
	for (const match of code.matchAll(/\btools\.([a-zA-Z0-9_]+)\s*\(/gu)) {
		const tool = match[1]!;
		counts.set(tool, (counts.get(tool) ?? 0) + 1);
	}
	const fileTargets: string[] = [];
	for (const match of code.matchAll(/\bpath\s*:\s*["'`]([^"'`\n]+)["'`]/gu)) {
		const p = formatWorkspacePath(match[1]!, cwd);
		const short = p.includes("/") ? basename(p) : p;
		if (short && !fileTargets.includes(short)) {
			fileTargets.push(short);
		}
		if (fileTargets.length >= 3) break;
	}

	if (counts.size === 1 && counts.has("read") && fileTargets.length > 0) {
		return {
			verb: failed ? "Failed read" : running ? "Reading" : "Read",
			target: fileTargets.join(", "),
		};
	}
	if (counts.size === 1 && (counts.has("edit") || counts.has("write")) && fileTargets.length > 0) {
		const isEdit = counts.has("edit");
		return {
			verb: failed
				? `Failed ${isEdit ? "edit" : "write"}`
				: running
					? isEdit
						? "Editing"
						: "Writing"
					: isEdit
						? "Edited"
						: "Wrote",
			target: fileTargets.join(", "),
		};
	}

	const parts: string[] = [];
	const reads = counts.get("read") ?? 0;
	const edits = (counts.get("edit") ?? 0) + (counts.get("write") ?? 0);
	const cmds = (counts.get("bash") ?? 0) + (counts.get("powershell") ?? 0);
	const searches = (counts.get("grep") ?? 0) + (counts.get("find") ?? 0) + (counts.get("ls") ?? 0);

	if (edits > 0) parts.push(`${edits} ${edits === 1 ? "edit" : "edits"}`);
	if (reads > 0) parts.push(`${reads} ${reads === 1 ? "read" : "reads"}`);
	if (cmds > 0) parts.push(`${cmds} ${cmds === 1 ? "command" : "commands"}`);
	if (searches > 0) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);

	if (parts.length > 0) {
		const fileHint = fileTargets.length > 0 ? ` (${fileTargets.slice(0, 2).join(", ")})` : "";
		return {
			verb: failed ? "Failed batch" : running ? "Running batch" : "Ran batch",
			target: `${parts.join(", ")}${fileHint}`,
		};
	}

	return {
		verb: failed ? "Failed script" : running ? "Running script" : "Ran script",
		target: "codemode",
	};
}

function cleanCommandDisplayHint(rawCmd: string, cwd?: string): string {
	const single = relativizeCommandPaths(rawCmd.replace(/\s+/gu, " ").trim(), cwd);
	if (!single) return "";
	/* Keep concise recognizable commands (`npm run check`, `git status -sb`) as a subtle secondary cue;
	   omit long multi-flag pipelines when a human step summary is already displayed. */
	if (single.length <= 40 && !single.includes("&&") && !single.includes("|")) {
		return single;
	}
	return "";
}

function cleanToolDisplayName(name: string): string {
	return name
		.replace(/^antigravity\s+/iu, "")
		.replace(/^mcp_pi-[0-9a-f]+_pi__/iu, "")
		.replace(/^mcp_[a-z0-9_-]+__/iu, "");
}

/**
 * Builds crisp, human-readable `{ verb, target }` parts for prototype Tool Call rows,
 * prioritizing `toolSummary` captions on `codemode`, `bash`, and custom/MCP tools while
 * keeping relative file paths prominent on `read` / `edit` / `write`.
 */
export function buildPrototypeStepHeaderParts(options: {
	name: string;
	args: ToolArgs;
	status: RowStatus;
	rawPath: string;
	stepSummary?: string;
	cwd?: string;
	expanded?: boolean;
	summarizeCustomArgs: (args: ToolArgs) => string;
}): { verb: string; target: string } {
	const { name, args, status, rawPath, stepSummary, cwd, expanded = false, summarizeCustomArgs } = options;
	const running = status === "running";
	const failed = status === "error";
	const relPath = formatWorkspacePath(rawPath, cwd);

	switch (name) {
		case "read": {
			const offset = typeof args.offset === "number" && args.offset > 1 ? args.offset : undefined;
			const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : undefined;
			const rangeSuffix =
				offset !== undefined && limit !== undefined
					? `:${offset}-${offset + limit - 1}`
					: offset !== undefined
						? `:${offset}+`
						: "";
			return {
				verb: failed ? "Failed read" : running ? "Reading" : "Read",
				target: `${relPath}${rangeSuffix}`,
			};
		}
		case "edit":
			return {
				verb: failed ? "Failed to edit" : running ? "Editing" : "Edited",
				target: relPath,
			};
		case "write":
			return {
				verb: failed ? "Failed to write" : running ? "Writing" : "Wrote",
				target: relPath,
			};
		case "grep": {
			if (stepSummary) {
				return {
					verb: failed ? `Failed: ${stepSummary}` : stepSummary,
					target: relPath || "",
				};
			}
			const rawGrepPat = typeof args.pattern === "string" ? args.pattern.replace(/\s+/gu, " ").trim() : "…";
			const pat = expanded ? rawGrepPat : rawGrepPat.slice(0, 48);
			return {
				verb: failed ? "Failed grep" : running ? "Searching" : "Searched",
				target: relPath ? `/${pat}/ in ${relPath}` : `/${pat}/`,
			};
		}
		case "find": {
			if (stepSummary) {
				return {
					verb: failed ? `Failed: ${stepSummary}` : stepSummary,
					target: relPath || "",
				};
			}
			const rawFindPat = typeof args.pattern === "string" ? args.pattern.replace(/\s+/gu, " ").trim() : "…";
			const pat = expanded ? rawFindPat : rawFindPat.slice(0, 48);
			return {
				verb: failed ? "Failed find" : running ? "Finding" : "Found",
				target: relPath ? `${pat} in ${relPath}` : pat,
			};
		}
		case "ls":
			return {
				verb: failed ? "Failed ls" : running ? "Listing" : "Listed",
				target: relPath || ".",
			};
		case "bash":
		case "powershell": {
			const rawCmd = typeof args.command === "string" ? normalizeLineEndings(stripTerminalSequences(args.command)) : "";
			if (stepSummary) {
				return {
					verb: failed ? `Failed: ${stepSummary}` : stepSummary,
					target: cleanCommandDisplayHint(rawCmd, cwd),
				};
			}
			const firstLine = relativizeCommandPaths(rawCmd.split("\n")[0]?.trim() ?? "", cwd);
			const clipped = firstLine.length > 84 ? `${firstLine.slice(0, 83).trimEnd()}…` : firstLine;
			return {
				verb: failed ? "Failed" : running ? "Running" : "Ran",
				target: clipped || name,
			};
		}
		case "codemode": {
			if (stepSummary) {
				return {
					verb: failed ? `Failed: ${stepSummary}` : stepSummary,
					target: "",
				};
			}
			return summarizeCodemodeIntentFallback(args, status, cwd);
		}
		default: {
			const cleanName = cleanToolDisplayName(name);
			if (stepSummary) {
				return {
					verb: failed ? `Failed: ${stepSummary}` : stepSummary,
					target: cleanName !== name ? cleanName : "",
				};
			}
			const argText = summarizeCustomArgs(args);
			return {
				verb: failed ? `Failed ${cleanName}` : running ? `Calling ${cleanName}` : cleanName,
				target: relativizeCommandPaths(argText, cwd),
			};
		}
	}
}
