import {
	ExtensionRunner,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { hookMethod } from "../../shared/runtime-hooks.ts";
import { isConartiInternalRegistrationActive } from "../quotes/supersede-quote-blocks.ts";

const NEXT_PROMPT_PATH_RE =
	/(?:^|[/\\]|npm:)pi-next-prompt(?:$|[/\\])|[/\\]next-prompt\.[cm]?[jt]s$/i;
const NEXT_PROMPT_HANDLER_SIGNATURE_RE =
	/\[Suggestion mode\]\s*Predict what the user will type next/i;
const GUARDED_APIS = new WeakSet<object>();

function matchesNextPromptHandler(fn: unknown): boolean {
	if (typeof fn !== "function") return false;
	try {
		return NEXT_PROMPT_HANDLER_SIGNATURE_RE.test(Function.prototype.toString.call(fn));
	} catch {
		return false;
	}
}

export function isSupersededNextPromptExtension(ext: unknown): boolean {
	if (!ext || typeof ext !== "object") return false;
	const rec = ext as {
		path?: unknown;
		resolvedPath?: unknown;
		sourceInfo?: { source?: unknown; path?: unknown };
		handlers?: Map<unknown, unknown>;
	};
	const candidates = [
		rec.path,
		rec.resolvedPath,
		rec.sourceInfo?.source,
		rec.sourceInfo?.path,
	];
	if (candidates.some((c) => typeof c === "string" && NEXT_PROMPT_PATH_RE.test(c))) {
		return true;
	}
	const agentEndHandlers = rec.handlers?.get?.("agent_end");
	if (Array.isArray(agentEndHandlers) && agentEndHandlers.some(matchesNextPromptHandler)) {
		return true;
	}
	return false;
}

function neutralizeRunnerExtensions(runner: unknown): void {
	if (!runner || typeof runner !== "object") return;
	const extensions = (runner as { extensions?: unknown[] }).extensions;
	if (!Array.isArray(extensions)) return;
	for (const ext of extensions) {
		if (!isSupersededNextPromptExtension(ext)) continue;
		const rec = ext as {
			shortcuts?: Map<unknown, unknown>;
			commands?: Map<unknown, unknown>;
			handlers?: Map<unknown, unknown>;
		};
		rec.shortcuts?.clear?.();
		rec.commands?.clear?.();
		rec.handlers?.clear?.();
	}
}

function installExtensionRunnerNeutralizer(): void {
	const proto = (ExtensionRunner as unknown as { prototype?: object } | undefined)?.prototype;
	if (!proto) return;

	const methodsToGuard = [
		"bindCore",
		"setUIContext",
		"getShortcuts",
		"hasHandlers",
		"resolveRegisteredCommands",
		"emit",
		"emitContext",
		"emitInput",
		"emitMessageEnd",
	] as const;

	for (const methodName of methodsToGuard) {
		hookMethod(
			proto,
			methodName,
			`promptSuggestion.supersedeNextPrompt.${methodName}`,
			(self, args, original) => {
				neutralizeRunnerExtensions(self);
				return original.apply(self, args);
			},
		);
	}
}

function captureCallerSignature(): string {
	const rawStack = new Error().stack ?? "";
	const frames = rawStack
		.split("\n")
		.slice(1)
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.startsWith("at ") &&
				!line.includes("supersede-next-prompt") &&
				!line.includes("supersede-quote-blocks"),
		);
	if (frames.length === 0) return "";
	const topWithoutLineCol = frames[0]!.replace(/:\d+:\d+(\)?)$/, "$1");
	return `${topWithoutLineCol}\n${frames.slice(1).join("\n")}`;
}

export function installNextPromptSuperseder(pi: ExtensionAPI): void {
	installExtensionRunnerNeutralizer();

	const apiObj = pi as unknown as Record<string, unknown>;
	if (GUARDED_APIS.has(apiObj)) return;
	GUARDED_APIS.add(apiObj);

	const origOn = pi.on.bind(pi);
	const callerGates = new Map<string, { suppressed: boolean }>();

	pi.on = ((event: string, handler: (...args: unknown[]) => unknown) => {
		if (isConartiInternalRegistrationActive()) {
			return origOn(event as never, handler as never);
		}

		const stack = new Error().stack ?? "";
		if (NEXT_PROMPT_PATH_RE.test(stack)) {
			return (() => {}) as never;
		}

		const sig = captureCallerSignature();
		if (!sig) {
			if (matchesNextPromptHandler(handler)) {
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

		if (matchesNextPromptHandler(handler)) {
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
