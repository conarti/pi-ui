import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	captureExternalCallerSignature,
	isConartiInternalRegistrationActive,
	matchesExtensionSourcePath,
	registerSupersededExtensionPredicate,
} from "../../shared/extension-superseder.ts";

const EXTERNAL_SUGGESTION_PACKAGE_RE =
	/(?:^npm:|[/\\]node_modules[/\\])pi-next-prompt(?:$|[/\\]|@)/i;
const INLINE_SUGGESTION_PROMPT_RE =
	/\[Suggestion mode\]\s*Predict what the user will type next/i;
const GUARDED_APIS = new WeakSet<object>();
const EXTENSION_MATCH_CACHE = new WeakMap<object, boolean>();

function matchesExternalSuggestionSource(source: string): boolean {
	if (INLINE_SUGGESTION_PROMPT_RE.test(source)) {
		return true;
	}
	/* Внешний пакет объявляет const PROMPT на уровне модуля, а jiti разворачивает импорты и optional chaining */
	if (
		/\bstreamSimple\b/.test(source) &&
		/\bconvertToLlm\b/.test(source) &&
		/\blastRequest\b/.test(source) &&
		/\btext\s*:\s*PROMPT\b/.test(source)
	) {
		return true;
	}
	if (/\bsetEditorComponent\b/.test(source) && /\.match\(\s*\/ \{3,\}\$\/\s*\)/.test(source)) {
		return true;
	}
	return false;
}

function matchesExternalSuggestionHandler(fn: unknown): boolean {
	if (typeof fn !== "function") return false;
	try {
		return matchesExternalSuggestionSource(Function.prototype.toString.call(fn));
	} catch {
		return false;
	}
}

function resolveCandidateFilePath(ext: {
	path?: unknown;
	resolvedPath?: unknown;
	sourceInfo?: { path?: unknown };
}): string | undefined {
	for (const candidate of [ext.resolvedPath, ext.sourceInfo?.path, ext.path]) {
		if (
			typeof candidate === "string" &&
			candidate.length > 0 &&
			!candidate.startsWith("<") &&
			existsSync(candidate)
		) {
			return candidate;
		}
	}
	return undefined;
}

export function isSupersededExternalSuggestionExtension(ext: unknown): boolean {
	if (!ext || typeof ext !== "object") return false;
	const cached = EXTENSION_MATCH_CACHE.get(ext);
	if (cached !== undefined) return cached;

	if (matchesExtensionSourcePath(ext, EXTERNAL_SUGGESTION_PACKAGE_RE)) {
		EXTENSION_MATCH_CACHE.set(ext, true);
		return true;
	}

	const rec = ext as {
		path?: unknown;
		resolvedPath?: unknown;
		sourceInfo?: { path?: unknown };
		commands?: Map<unknown, unknown>;
		tools?: Map<unknown, unknown>;
		handlers?: Map<unknown, unknown>;
	};

	for (const eventName of ["agent_end", "session_start"] as const) {
		const list = rec.handlers?.get?.(eventName);
		if (Array.isArray(list) && list.some(matchesExternalSuggestionHandler)) {
			EXTENSION_MATCH_CACHE.set(ext, true);
			return true;
		}
	}

	/* createExtensionAPI оборачивает обработчики в (...args) => handler(...args), поэтому для переименованных файлов без своих команд и тулов проверяем исходник модуля один раз */
	if (
		(rec.commands?.size ?? 0) === 0 &&
		(rec.tools?.size ?? 0) === 0 &&
		rec.handlers?.has?.("agent_end") &&
		rec.handlers?.has?.("session_start")
	) {
		const filePath = resolveCandidateFilePath(rec);
		if (filePath) {
			try {
				const matched = matchesExternalSuggestionSource(readFileSync(filePath, "utf8"));
				EXTENSION_MATCH_CACHE.set(ext, matched);
				return matched;
			} catch {
				/* Недоступный файл расширения пропускается без падения сессии */
			}
		}
	}

	EXTENSION_MATCH_CACHE.set(ext, false);
	return false;
}

export function installExternalSuggestionSuperseder(pi: ExtensionAPI): void {
	registerSupersededExtensionPredicate(
		"promptSuggestion.external",
		isSupersededExternalSuggestionExtension,
	);

	const apiObj = pi as unknown as Record<string, unknown>;
	if (GUARDED_APIS.has(apiObj)) return;
	GUARDED_APIS.add(apiObj);

	const origOn = pi.on.bind(pi);
	const callerGates = new Map<string, { suppressed: boolean }>();

	pi.on = ((event: string, handler: (...args: unknown[]) => unknown) => {
		if (isConartiInternalRegistrationActive()) {
			return origOn(event as never, handler as never);
		}

		const sig = captureExternalCallerSignature();
		if (!sig) {
			if (matchesExternalSuggestionHandler(handler)) {
				return (() => {}) as never;
			}
			return origOn(event as never, handler as never);
		}

		let gate = callerGates.get(sig);
		if (!gate) {
			gate = { suppressed: false };
			callerGates.set(sig, gate);
			queueMicrotask(() => {
				callerGates.delete(sig);
			});
		}

		if (matchesExternalSuggestionHandler(handler)) {
			gate.suppressed = true;
			return (() => {}) as never;
		}
		if (gate.suppressed) {
			return (() => {}) as never;
		}

		const activeGate = gate;
		return origOn(
			event as never,
			((...args: unknown[]) => {
				if (activeGate.suppressed) return undefined;
				return handler(...args);
			}) as never,
		);
	}) as ExtensionAPI["on"];
}
