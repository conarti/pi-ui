import {
	ExtensionRunner,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hookMethod } from "../../shared/runtime-hooks.ts";

const QUOTE_BLOCKS_PATH_RE = /(?:^|[/\\]|npm:)pi-quote-blocks(?:$|[/\\])|[/\\]quote-blocks\.[cm]?[jt]s$/i;
const QUOTE_BLOCKS_WIDGET_KEY = "quote-blocks";
const QUOTE_BLOCKS_STORE_SYMBOL = Symbol.for("pi.quoteBlocks.store");
const GUARDED_APIS = new WeakSet<object>();
const GUARDED_UIS = new WeakSet<object>();

let internalRegistrationDepth = 0;

export function withConartiInternalRegistration<T>(fn: () => T): T {
	internalRegistrationDepth += 1;
	try {
		return fn();
	} finally {
		internalRegistrationDepth -= 1;
	}
}

export function isSupersededQuoteBlocksExtension(ext: unknown): boolean {
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
	return candidates.some((c) => typeof c === "string" && QUOTE_BLOCKS_PATH_RE.test(c));
}

function neutralizeRunnerExtensions(runner: unknown): void {
	if (!runner || typeof runner !== "object") return;
	const extensions = (runner as { extensions?: unknown[] }).extensions;
	if (!Array.isArray(extensions)) return;
	for (const ext of extensions) {
		if (!isSupersededQuoteBlocksExtension(ext)) continue;
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

function clearExternalQuoteBlocksSharedStore(): void {
	const store = (globalThis as Record<symbol, { quotes?: Map<unknown, unknown>; nextId?: number } | undefined>)[
		QUOTE_BLOCKS_STORE_SYMBOL
	];
	if (store?.quotes instanceof Map) {
		store.quotes.clear();
		store.nextId = 1;
	}
}

function isQuoteBlocksWidgetKey(key: string): boolean {
	return key === QUOTE_BLOCKS_WIDGET_KEY || key.startsWith(`${QUOTE_BLOCKS_WIDGET_KEY}:`);
}

const EXTERNAL_QUOTE_BLOCKS_DESC_RE =
	/(?:quote blocks?|as a block|quote selected text|past assistant reply)/i;

function isExternalQuoteBlocksShortcut(key: string, description: string | undefined): boolean {
	const normKey = key.trim().toLowerCase();
	const desc = description ?? "";
	if (EXTERNAL_QUOTE_BLOCKS_DESC_RE.test(desc)) return true;
	if ((normKey === "alt+h" || normKey === "alt+e") && /quote/i.test(desc)) return true;
	return false;
}

function isExternalQuoteBlocksCommand(name: string, description: string | undefined): boolean {
	const normName = name.trim().toLowerCase();
	if (normName !== "quote" && normName !== "quotes") return false;
	return EXTERNAL_QUOTE_BLOCKS_DESC_RE.test(description ?? "");
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
		"emitInput",
		"emitMessageEnd",
	] as const;

	for (const methodName of methodsToGuard) {
		hookMethod(
			proto,
			methodName,
			`quotes.supersedeQuoteBlocks.${methodName}`,
			(self, args, original) => {
				neutralizeRunnerExtensions(self);
				return original.apply(self, args);
			},
		);
	}
}

export function scrubExternalQuoteBlocksUi(ctx: ExtensionContext): void {
	clearExternalQuoteBlocksSharedStore();
	const ui = ctx.ui as unknown as Record<string, unknown> | undefined;
	if (!ui || typeof ui !== "object") return;

	const origSetWidget = ui.setWidget as ((key: string, content: unknown, opts?: unknown) => void) | undefined;
	if (typeof origSetWidget === "function") {
		origSetWidget.call(ctx.ui, QUOTE_BLOCKS_WIDGET_KEY, undefined);
		if (!GUARDED_UIS.has(ui)) {
			GUARDED_UIS.add(ui);
			const boundOrig = origSetWidget.bind(ctx.ui);
			ui.setWidget = (key: string, content: unknown, opts?: unknown) => {
				if (content !== undefined && isQuoteBlocksWidgetKey(key)) {
					return;
				}
				boundOrig(key, content, opts);
			};
		}
	}
}

function captureCallerSignature(): string {
	const rawStack = new Error().stack ?? "";
	const frames = rawStack
		.split("\n")
		.slice(1)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("at ") && !line.includes("supersede-quote-blocks"));
	if (frames.length === 0) return "";
	const topWithoutLineCol = frames[0]!.replace(/:\d+:\d+(\)?)$/, "$1");
	return `${topWithoutLineCol}\n${frames.slice(1).join("\n")}`;
}

export function installQuoteBlocksSuperseder(pi: ExtensionAPI): void {
	installExtensionRunnerNeutralizer();
	clearExternalQuoteBlocksSharedStore();

	const apiObj = pi as unknown as Record<string, unknown>;
	if (GUARDED_APIS.has(apiObj)) return;
	GUARDED_APIS.add(apiObj);

	const origRegisterCommand = pi.registerCommand.bind(pi);
	const origRegisterShortcut = pi.registerShortcut.bind(pi);
	const origOn = pi.on.bind(pi);

	let ownsQuoteCommands = false;
	let ownsAltQ = false;
	const suppressedCallerSignatures = new Set<string>();

	const markExternalQuoteBlocksDetected = () => {
		const sig = captureCallerSignature();
		if (!sig || suppressedCallerSignatures.has(sig)) return;
		suppressedCallerSignatures.add(sig);
		queueMicrotask(() => {
			suppressedCallerSignatures.delete(sig);
		});
	};

	pi.registerCommand = ((name, options) => {
		const norm = String(name).trim().toLowerCase();
		if (internalRegistrationDepth > 0) {
			if (norm === "quote" || norm === "quotes") {
				ownsQuoteCommands = true;
			}
			return origRegisterCommand(name, options);
		}
		if (ownsQuoteCommands && isExternalQuoteBlocksCommand(norm, options?.description)) {
			markExternalQuoteBlocksDetected();
			return;
		}
		return origRegisterCommand(name, options);
	}) as ExtensionAPI["registerCommand"];

	pi.registerShortcut = ((key, options) => {
		const normKey = String(key).trim().toLowerCase();
		if (internalRegistrationDepth > 0) {
			if (normKey === "alt+q") {
				ownsAltQ = true;
			}
			return origRegisterShortcut(key, options);
		}
		if (
			(ownsAltQ && isExternalQuoteBlocksShortcut(normKey, options?.description)) ||
			isExternalQuoteBlocksShortcut(normKey, options?.description)
		) {
			markExternalQuoteBlocksDetected();
			return;
		}
		return origRegisterShortcut(key, options);
	}) as ExtensionAPI["registerShortcut"];

	pi.on = ((event: any, handler: any) => {
		if (internalRegistrationDepth === 0 && suppressedCallerSignatures.size > 0) {
			const sig = captureCallerSignature();
			if (sig && suppressedCallerSignatures.has(sig)) {
				return;
			}
		}
		return origOn(event, handler);
	}) as ExtensionAPI["on"];
}
