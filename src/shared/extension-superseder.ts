import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { hookMethod } from "./runtime-hooks.ts";

export type SupersededExtensionPredicate = (ext: unknown) => boolean;

const INTERNAL_REGISTRATION_DEPTH_KEY = Symbol.for(
	"conarti.pi-ui.internal-registration-depth.v1",
);
const SUPERSEDED_EXTENSION_PREDICATES_KEY = Symbol.for(
	"conarti.pi-ui.superseded-extension-predicates.v1",
);

const INTERNAL_STACK_TOKENS = [
	"extension-superseder",
	"supersede-external",
	"supersede-quote-blocks",
] as const;

const RUNNER_METHODS_TO_GUARD = [
	"bindCore",
	"setUIContext",
	"getShortcuts",
	"getEntryRenderer",
	"getMessageRenderer",
	"hasHandlers",
	"resolveRegisteredCommands",
	"emit",
	"emitContext",
	"emitInput",
	"emitMessageEnd",
] as const;

function getRegistrationDepthSlot(): { depth: number } {
	const g = globalThis as Record<symbol, { depth: number } | undefined>;
	if (!g[INTERNAL_REGISTRATION_DEPTH_KEY]) {
		g[INTERNAL_REGISTRATION_DEPTH_KEY] = { depth: 0 };
	}
	return g[INTERNAL_REGISTRATION_DEPTH_KEY]!;
}

function getPredicatesMap(): Map<string, SupersededExtensionPredicate> {
	const g = globalThis as Record<symbol, Map<string, SupersededExtensionPredicate> | undefined>;
	if (!g[SUPERSEDED_EXTENSION_PREDICATES_KEY]) {
		g[SUPERSEDED_EXTENSION_PREDICATES_KEY] = new Map();
	}
	return g[SUPERSEDED_EXTENSION_PREDICATES_KEY]!;
}

export function withConartiInternalRegistration<T>(fn: () => T): T {
	const slot = getRegistrationDepthSlot();
	slot.depth += 1;
	try {
		return fn();
	} finally {
		slot.depth -= 1;
	}
}

export function isConartiInternalRegistrationActive(): boolean {
	return getRegistrationDepthSlot().depth > 0;
}

export function matchesExtensionSourcePath(ext: unknown, pathRegex: RegExp): boolean {
	if (!ext || typeof ext !== "object") return false;
	const rec = ext as {
		path?: unknown;
		resolvedPath?: unknown;
		sourceInfo?: { source?: unknown; path?: unknown };
	};
	const candidates = [
		rec.path,
		rec.resolvedPath,
		rec.sourceInfo?.source,
		rec.sourceInfo?.path,
	];
	return candidates.some((candidate) => typeof candidate === "string" && pathRegex.test(candidate));
}

function neutralizeRunnerExtensions(runner: unknown): void {
	if (!runner || typeof runner !== "object") return;
	const extensions = (runner as { extensions?: unknown[] }).extensions;
	if (!Array.isArray(extensions)) return;
	const predicates = [...getPredicatesMap().values()];
	if (predicates.length === 0) return;

	for (const ext of extensions) {
		if (!predicates.some((predicate) => predicate(ext))) continue;
		const rec = ext as {
			shortcuts?: Map<unknown, unknown>;
			commands?: Map<unknown, unknown>;
			handlers?: Map<unknown, unknown>;
			entryRenderers?: Map<unknown, unknown>;
			messageRenderers?: Map<unknown, unknown>;
		};
		rec.shortcuts?.clear?.();
		rec.commands?.clear?.();
		rec.handlers?.clear?.();
		rec.entryRenderers?.clear?.();
		rec.messageRenderers?.clear?.();
	}
}

function installSharedExtensionRunnerNeutralizer(): void {
	const proto = (ExtensionRunner as unknown as { prototype?: object } | undefined)?.prototype;
	if (!proto) return;

	for (const methodName of RUNNER_METHODS_TO_GUARD) {
		hookMethod(
			proto,
			methodName,
			`extensionSuperseder.neutralize.${methodName}`,
			(self, args, original) => {
				neutralizeRunnerExtensions(self);
				return original.apply(self, args);
			},
		);
	}
}

export function registerSupersededExtensionPredicate(
	id: string,
	predicate: SupersededExtensionPredicate,
): void {
	getPredicatesMap().set(id, predicate);
	installSharedExtensionRunnerNeutralizer();
}

export function captureExternalCallerSignature(): string {
	const rawStack = new Error().stack ?? "";
	const frames = rawStack
		.split("\n")
		.slice(1)
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.startsWith("at ") &&
				!INTERNAL_STACK_TOKENS.some((token) => line.includes(token)),
		);
	if (frames.length === 0) return "";
	const topWithoutLineCol = frames[0]!.replace(/:\d+:\d+(\)?)$/, "$1");
	return `${topWithoutLineCol}\n${frames.slice(1).join("\n")}`;
}
