import { homedir } from "node:os";
import { basename, isAbsolute, relative } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { t } from "../../shared/i18n.ts";
import { normalizeLineEndings, type RowStatus } from "./core.ts";
import type { ToolArgs } from "./types.ts";

export const AGY_TOOL_SUMMARIES_ENTRY_TYPE = "pi-agy-tool-summaries";

interface CachedSummaryIndex {
	scannedCount: number;
	scannedLength: number;
	byCallId: Map<string, string>;
}

export interface SessionSummarySource {
	getSessionId?: () => string;
	getEntryCount?: () => number;
	getEntries?: () => readonly unknown[];
	getBranch?: () => readonly unknown[];
}

const managerSummaryCache = new WeakMap<object, CachedSummaryIndex>();
const arraySummaryCache = new WeakMap<readonly unknown[], CachedSummaryIndex>();
const liveSummaryOverrides = new WeakMap<object, { sessionId?: string; entries: Map<string, string> }>();

function liveEntries(source: SessionSummarySource | readonly unknown[]): Map<string, string> {
	const sessionId = (source as SessionSummarySource).getSessionId?.();
	const existing = liveSummaryOverrides.get(source);
	if (existing && existing.sessionId === sessionId) return existing.entries;
	const entries = new Map<string, string>();
	liveSummaryOverrides.set(source, { sessionId, entries });
	if (existing) managerSummaryCache.delete(source);
	return entries;
}
const MAX_LIVE_OVERRIDES = 1_000;

export function cleanStepSummaryText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

export function rememberLiveToolSummary(toolCallId: string, summary: string | undefined, source: SessionSummarySource | readonly unknown[]): void {
	const cleaned = cleanStepSummaryText(summary);
	if (!toolCallId || !cleaned) return;
	const entries = liveEntries(source);
	entries.set(toolCallId, cleaned);
	if (entries.size > MAX_LIVE_OVERRIDES) {
		const oldest = entries.keys().next().value;
		if (oldest !== undefined) entries.delete(oldest);
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
 * Разрешает краткую подпись шага для `toolCallId` из inline-полей `toolSummary`/`toolAction`
 * или инкрементального O(1) индекса записей `pi-agy-tool-summaries` в `SessionManager` / массиве.
 */
export function resolveExternalToolSummary(
	toolCallId: string | undefined,
	args: unknown,
	sessionSource?: SessionSummarySource | readonly unknown[],
): string | undefined {
	const inline = extractInlineToolSummary(args);
	if (inline) {
		if (toolCallId && sessionSource) rememberLiveToolSummary(toolCallId, inline, sessionSource);
		return inline;
	}
	if (!toolCallId || !sessionSource) return undefined;
	const live = liveEntries(sessionSource).get(toolCallId);

	if (Array.isArray(sessionSource)) {
		if (sessionSource.length === 0) return live;
		let cached = arraySummaryCache.get(sessionSource);
		if (!cached || cached.scannedLength > sessionSource.length) {
			cached = { scannedCount: 0, scannedLength: 0, byCallId: new Map() };
			arraySummaryCache.set(sessionSource, cached);
		}
		if (cached.scannedLength < sessionSource.length) {
			scanEntriesIntoMap(sessionSource, cached.scannedLength, cached.byCallId);
			cached.scannedLength = sessionSource.length;
			cached.scannedCount = sessionSource.length;
		}
		return cached.byCallId.get(toolCallId) ?? live;
	}

	/* SessionManager.getEntries() возвращает новую копию массива, поэтому кешируем по самому менеджеру
	   и сверяем getEntryCount(), не копируя записи сессии между кадрами. */
	const manager = sessionSource as SessionSummarySource;
	const count = typeof manager.getEntryCount === "function" ? manager.getEntryCount() : undefined;
	let cached = managerSummaryCache.get(manager);
	if (cached && count !== undefined && cached.scannedCount === count) {
		return cached.byCallId.get(toolCallId) ?? live;
	}

	const entries = manager.getEntries?.() ?? manager.getBranch?.();
	if (!entries || entries.length === 0) {
		if (count !== undefined) {
			managerSummaryCache.set(manager, { scannedCount: count, scannedLength: 0, byCallId: new Map() });
		}
		return live;
	}
	if (!cached || cached.scannedLength > entries.length || (count !== undefined && count < cached.scannedCount)) {
		cached = { scannedCount: 0, scannedLength: 0, byCallId: new Map() };
		managerSummaryCache.set(manager, cached);
	}
	if (cached.scannedLength < entries.length) {
		scanEntriesIntoMap(entries, cached.scannedLength, cached.byCallId);
		cached.scannedLength = entries.length;
	}
	cached.scannedCount = count ?? entries.length;
	return cached.byCallId.get(toolCallId) ?? live;
}

/**
 * Приводит абсолютный путь к относительному от `cwd` или к `~/...` под домашним каталогом.
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
 * Строит читаемую семантическую сводку для `codemode` по внутренним вызовам `tools.*`,
 * когда внешний `toolSummary` не передан, без вывода сырого JS-сниппета в заголовок.
 */
export function summarizeCodemodeIntentFallback(
	args: ToolArgs,
	status: RowStatus,
	cwd?: string,
): { verb: string; target: string } {
	const code = typeof args.code === "string" ? normalizeLineEndings(stripTerminalSequences(args.code)) : "";
	const phase = status === "error" ? "failed" : status === "running" ? "running" : "done";

	if (!code.trim()) {
		return {
			verb: t(`toolStep.batch.${phase}`),
			target: "",
		};
	}

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
			verb: t(`toolStep.read.${phase}`),
			target: fileTargets.join(", "),
		};
	}
	if (counts.size === 1 && (counts.has("edit") || counts.has("write")) && fileTargets.length > 0) {
		const tool = counts.has("edit") ? "edit" : "write";
		return {
			verb: t(`toolStep.${tool}.${phase}`),
			target: fileTargets.join(", "),
		};
	}

	const parts: string[] = [];
	const reads = counts.get("read") ?? 0;
	const edits = (counts.get("edit") ?? 0) + (counts.get("write") ?? 0);
	const cmds = (counts.get("bash") ?? 0) + (counts.get("powershell") ?? 0);
	const searches = (counts.get("grep") ?? 0) + (counts.get("find") ?? 0) + (counts.get("ls") ?? 0);

	if (edits > 0) parts.push(t(edits === 1 ? "toolStep.count.edit" : "toolStep.count.edits", { count: edits }));
	if (reads > 0) parts.push(t(reads === 1 ? "toolStep.count.read" : "toolStep.count.reads", { count: reads }));
	if (cmds > 0) parts.push(t(cmds === 1 ? "toolStep.count.command" : "toolStep.count.commands", { count: cmds }));
	if (searches > 0) parts.push(t(searches === 1 ? "toolStep.count.search" : "toolStep.count.searches", { count: searches }));

	if (parts.length > 0) {
		const fileHint = fileTargets.length > 0 ? ` (${fileTargets.slice(0, 2).join(", ")})` : "";
		return {
			verb: t(`toolStep.batch.${phase}`),
			target: `${parts.join(", ")}${fileHint}`,
		};
	}

	return {
		verb: t(`toolStep.script.${phase}`),
		target: "codemode",
	};
}

function cleanCommandDisplayHint(rawCmd: string, cwd?: string): string {
	const single = relativizeCommandPaths(rawCmd.replace(/\s+/gu, " ").trim(), cwd);
	if (!single) return "";
	if (single.length <= 40 && !single.includes("&&") && !single.includes("|")) {
		return single;
	}
	return "";
}

function cleanToolDisplayName(name: string): string {
	return name
		.replace(/^antigravity\s+/iu, "")
		.replace(/^mcp_pi-[0-9a-f]+_pi__/iu, "");
}

/**
 * Формирует `{ verb, target }` для заголовка вызова инструмента с приоритетом `toolSummary`,
 * семантическим фолбэком для `codemode` и относительными путями `cwd` / `~/...`.
 */
export function buildStepHeaderParts(options: {
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
	const phase = failed ? "failed" : running ? "running" : "done";
	const relPath = formatWorkspacePath(rawPath, cwd);
	const summaryVerb = stepSummary && (failed ? t("toolStep.failedSummary", { summary: stepSummary }) : stepSummary);

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
				verb: summaryVerb || t(`toolStep.read.${phase}`),
				target: `${relPath}${rangeSuffix}`,
			};
		}
		case "edit":
			return {
				verb: summaryVerb || t(`toolStep.edit.${phase}`),
				target: relPath,
			};
		case "write":
			return {
				verb: summaryVerb || t(`toolStep.write.${phase}`),
				target: relPath,
			};
		case "grep": {
			if (summaryVerb) {
				return {
					verb: summaryVerb,
					target: relPath || "",
				};
			}
			const rawGrepPat = typeof args.pattern === "string" ? args.pattern.replace(/\s+/gu, " ").trim() : "…";
			const pat = expanded ? rawGrepPat : rawGrepPat.slice(0, 48);
			return {
				verb: t(`toolStep.grep.${phase}`),
				target: relPath ? t("toolStep.pathFilter", { pattern: `/${pat}/`, path: relPath }) : `/${pat}/`,
			};
		}
		case "find": {
			if (summaryVerb) {
				return {
					verb: summaryVerb,
					target: relPath || "",
				};
			}
			const rawFindPat = typeof args.pattern === "string" ? args.pattern.replace(/\s+/gu, " ").trim() : "…";
			const pat = expanded ? rawFindPat : rawFindPat.slice(0, 48);
			return {
				verb: t(`toolStep.find.${phase}`),
				target: relPath ? t("toolStep.pathFilter", { pattern: pat, path: relPath }) : pat,
			};
		}
		case "ls":
			return {
				verb: summaryVerb || t(`toolStep.ls.${phase}`),
				target: relPath || ".",
			};
		case "bash":
		case "powershell": {
			const rawCmd = typeof args.command === "string" ? normalizeLineEndings(stripTerminalSequences(args.command)) : "";
			if (summaryVerb) {
				return {
					verb: summaryVerb,
					target: cleanCommandDisplayHint(rawCmd, cwd),
				};
			}
			const firstLine = relativizeCommandPaths(rawCmd.split("\n")[0]?.trim() ?? "", cwd);
			const clipped = expanded
				? firstLine
				: firstLine.length > 84
					? `${firstLine.slice(0, 83).trimEnd()}…`
					: firstLine;
			return {
				verb: t(`toolStep.command.${phase}`),
				target: clipped || name,
			};
		}
		case "codemode": {
			if (summaryVerb) {
				return {
					verb: summaryVerb,
					target: "",
				};
			}
			return summarizeCodemodeIntentFallback(args, status, cwd);
		}
		default: {
			const cleanName = cleanToolDisplayName(name);
			if (summaryVerb) {
				return {
					verb: summaryVerb,
					target: cleanName !== name ? cleanName : "",
				};
			}
			const argText = summarizeCustomArgs(args);
			return {
				verb: failed || running ? t(failed ? "toolStep.failedTool" : "toolStep.calling", { name: cleanName }) : cleanName,
				target: relativizeCommandPaths(argText, cwd),
			};
		}
	}
}
