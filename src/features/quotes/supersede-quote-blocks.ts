import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	captureExternalCallerSignature,
	isConartiInternalRegistrationActive,
	matchesExtensionSourcePath,
	registerSupersededExtensionPredicate,
	withConartiInternalRegistration,
} from "../../shared/extension-superseder.ts";

export { isConartiInternalRegistrationActive, withConartiInternalRegistration };

const QUOTE_BLOCKS_PATH_RE =
	/(?:^|[/\\]|npm:)pi-quote-blocks(?:$|[/\\])|[/\\]quote-blocks\.[cm]?[jt]s$/i;
const QUOTE_BLOCKS_WIDGET_KEY = "quote-blocks";
const QUOTE_BLOCKS_STORE_SYMBOL = Symbol.for("pi.quoteBlocks.store");
const GUARDED_APIS = new WeakSet<object>();
const GUARDED_UIS = new WeakSet<object>();

export function isSupersededQuoteBlocksExtension(ext: unknown): boolean {
	return matchesExtensionSourcePath(ext, QUOTE_BLOCKS_PATH_RE);
}

function clearExternalQuoteBlocksSharedStore(): void {
	const store = (
		globalThis as Record<
			symbol,
			{ quotes?: Map<unknown, unknown>; nextId?: number } | undefined
		>
	)[QUOTE_BLOCKS_STORE_SYMBOL];
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

export function scrubExternalQuoteBlocksUi(ctx: ExtensionContext): void {
	clearExternalQuoteBlocksSharedStore();
	const ui = ctx.ui as unknown as Record<string, unknown> | undefined;
	if (!ui || typeof ui !== "object") return;

	const origSetWidget = ui.setWidget as
		| ((key: string, content: unknown, opts?: unknown) => void)
		| undefined;
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

export function installQuoteBlocksSuperseder(pi: ExtensionAPI): void {
	registerSupersededExtensionPredicate("quotes.quoteBlocks", isSupersededQuoteBlocksExtension);
	clearExternalQuoteBlocksSharedStore();

	const apiObj = pi as unknown as Record<string, unknown>;
	if (GUARDED_APIS.has(apiObj)) return;
	GUARDED_APIS.add(apiObj);

	const origRegisterCommand = pi.registerCommand.bind(pi);
	const origRegisterShortcut = pi.registerShortcut.bind(pi);
	const origOn = pi.on.bind(pi);

	let ownsQuoteCommands = false;
	const suppressedCallerSignatures = new Set<string>();

	const markExternalQuoteBlocksDetected = () => {
		const sig = captureExternalCallerSignature();
		if (!sig || suppressedCallerSignatures.has(sig)) return;
		suppressedCallerSignatures.add(sig);
		queueMicrotask(() => {
			suppressedCallerSignatures.delete(sig);
		});
	};

	pi.registerCommand = ((name, options) => {
		const norm = String(name).trim().toLowerCase();
		if (isConartiInternalRegistrationActive()) {
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
		if (isConartiInternalRegistrationActive()) {
			return origRegisterShortcut(key, options);
		}
		if (isExternalQuoteBlocksShortcut(normKey, options?.description)) {
			markExternalQuoteBlocksDetected();
			return;
		}
		return origRegisterShortcut(key, options);
	}) as ExtensionAPI["registerShortcut"];

	pi.on = ((event: any, handler: any) => {
		if (!isConartiInternalRegistrationActive() && suppressedCallerSignatures.size > 0) {
			const sig = captureExternalCallerSignature();
			if (sig && suppressedCallerSignatures.has(sig)) {
				return;
			}
		}
		return origOn(event, handler);
	}) as ExtensionAPI["on"];
}
