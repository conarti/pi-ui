import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { getActiveGlobalTheme } from "../../shared/ansi.ts";
import {
	getActiveHostRuntime,
	resolveActiveClipboardProvider,
	unwrapHostTui,
} from "../../shared/host-runtime.ts";
import { matchesLayoutChord, registerOptionShortcutChord } from "../../shared/keyboard-layout.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { t } from "../../shared/i18n.ts";
import { copyToClipboard } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { getActiveComposerEditor } from "../chrome/composer.ts";
import {
	getActivePromptChipRegistry,
	insertQuoteChipInComposer,
	type QuotePromptChipData,
	type RegisteredPromptChip,
} from "../prompt-chips/index.ts";
import {
	extractAssistantQuoteFromBranch,
	normalizeQuoteText,
} from "./quote-model.ts";
import { handleQuotesCommand, showQuotesManagerModal } from "./quotes-modal.ts";
import {
	installSelectionQuoteRuntimeHooks,
	QUOTE_SELECTION_POPUP_HEIGHT,
	QUOTE_SELECTION_POPUP_LABEL,
	QUOTE_SELECTION_POPUP_WIDTH,
	QuoteSelectionPopup,
	SelectionQuoteOverlayController,
} from "./selection-popup.ts";
import {
	installQuoteBlocksSuperseder,
	scrubExternalQuoteBlocksUi,
	withConartiInternalRegistration,
} from "./supersede-quote-blocks.ts";

export * from "./quote-model.ts";
export { handleQuotesCommand, showQuotesManagerModal } from "./quotes-modal.ts";
export {
	installSelectionQuoteRuntimeHooks,
	QUOTE_SELECTION_POPUP_HEIGHT,
	QUOTE_SELECTION_POPUP_LABEL,
	QUOTE_SELECTION_POPUP_WIDTH,
	QuoteSelectionPopup,
	SelectionQuoteOverlayController,
} from "./selection-popup.ts";
export {
	installQuoteBlocksSuperseder,
	isSupersededQuoteBlocksExtension,
	scrubExternalQuoteBlocksUi,
	withConartiInternalRegistration,
} from "./supersede-quote-blocks.ts";

export function insertQuoteIntoDraft(
	ctx: ExtensionContext,
	rawQuoteText: string,
	sourceLabel?: string,
): RegisteredPromptChip<QuotePromptChipData> | undefined {
	const cleaned = normalizeQuoteText(rawQuoteText);
	if (!cleaned) return undefined;

	const editor = getActiveComposerEditor();
	if (editor) {
		const tui = getActiveHostRuntime()?.tui;
		if (tui && !hasBlockingModalOverlay(tui)) {
			tui.setFocus(editor);
			editor.focused = true;
		}
		const chip = insertQuoteChipInComposer(editor, cleaned, sourceLabel);
		requestRender();
		return chip;
	}

	const registry = getActivePromptChipRegistry();
	const chip = registry.registerQuote(cleaned, sourceLabel);
	const ui = ctx.ui as ExtensionUIContext & {
		pasteToEditor?: (text: string) => void;
		getEditorText?: () => string;
	};
	if (typeof ui.pasteToEditor === "function") {
		ui.pasteToEditor(chip.token);
	} else {
		const prev = ui.getEditorText?.() ?? "";
		ctx.ui.setEditorText(prev ? `${prev} ${chip.token}` : chip.token);
	}
	requestRender();
	return chip;
}

export function registerQuotesFeature(pi: ExtensionAPI): void {
	installQuoteBlocksSuperseder(pi);
	registerOptionShortcutChord("alt+q");

	let activeCtx: ExtensionContext | undefined;
	let unsubscribeInput: (() => void) | undefined;

	const copySelectedAndFlash = (selectedText: string, tui: NonNullable<ReturnType<typeof getActiveHostRuntime>>["tui"]) => {
		if (!selectedText.trim()) return;
		copyToClipboard(selectedText);
		const renderer = unwrapHostTui(tui) as unknown as {
			resetTextSelection?: () => void;
			clearTextSelection?: () => void;
			flash?: (message: string, durationMs?: number) => void;
			requestRender?: () => void;
		};
		renderer.resetTextSelection?.();
		renderer.clearTextSelection?.();
		renderer.flash?.(t("quotes.selectionPopup.copied"), 1200);
		renderer.requestRender?.();
	};

	const getTheme = () => activeCtx?.ui.theme ?? getActiveGlobalTheme();
	const selectionController = new SelectionQuoteOverlayController(
		getTheme,
		(selectedText, tui) => {
			const ctx = activeCtx ?? getActiveHostRuntime()?.ctx;
			if (!ctx) return;
			const selTui = tui as unknown as {
				resetTextSelection?: () => void;
				clearTextSelection?: () => void;
				requestRender?: () => void;
			};
			selTui.resetTextSelection?.();
			selTui.clearTextSelection?.();
			insertQuoteIntoDraft(ctx, selectedText, "selection");
			const editor = getActiveComposerEditor();
			if (editor && !hasBlockingModalOverlay(tui)) {
				tui.setFocus(editor);
				editor.focused = true;
			}
			selTui.requestRender?.();
		},
		(selectedText, tui) => {
			copySelectedAndFlash(selectedText, tui);
		},
	);

	const quoteSelectionOrClipboard = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const runtime = getActiveHostRuntime();
		const tui = runtime?.tui;
		if (tui && hasBlockingModalOverlay(tui)) {
			selectionController.hide();
			return;
		}

		const selectionTui = tui as unknown as
			| {
					getActiveSelectionText?: () => string | undefined;
					resetTextSelection?: () => void;
					clearTextSelection?: () => void;
					requestRender?: () => void;
			  }
			| undefined;

		const rawSelected =
			selectionTui?.getActiveSelectionText?.() || selectionController.snapshottedText;
		const selected = typeof rawSelected === "string" ? normalizeQuoteText(rawSelected) : "";
		selectionController.hide();
		if (selected) {
			insertQuoteIntoDraft(ctx, selected, "selection");
			selectionTui?.resetTextSelection?.();
			selectionTui?.clearTextSelection?.();
			selectionTui?.requestRender?.();
			return;
		}

		const clipRaw = await resolveActiveClipboardProvider().readText?.();
		const clipText = typeof clipRaw === "string" ? normalizeQuoteText(clipRaw) : "";
		if (clipText) {
			insertQuoteIntoDraft(ctx, clipText, "clipboard");
			return;
		}

		ctx.ui.notify(t("quotes.needSelectionOrClipboard"), "warning");
	};

	const quoteAssistantReply = async (rawArgs: string, ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		selectionController.hide();
		const branch = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
		const extracted = extractAssistantQuoteFromBranch(branch, rawArgs);
		if (!extracted.ok) {
			if (extracted.reason === "empty_history") {
				ctx.ui.notify(t("quotes.emptyHistory"), "info");
			} else if (extracted.reason === "out_of_range") {
				ctx.ui.notify(
					t("quotes.outOfRange", {
						total: extracted.totalReplies,
						requested: extracted.requested ?? 1,
					}),
					"warning",
				);
			} else {
				ctx.ui.notify(t("quotes.usage.quote"), "warning");
			}
			return;
		}

		insertQuoteIntoDraft(ctx, extracted.text, extracted.sourceLabel);
	};

	withConartiInternalRegistration(() => {
		pi.registerShortcut("alt+q", {
			description: t("quotes.shortcut"),
			handler: async (ctx) => {
				await quoteSelectionOrClipboard(ctx);
			},
		});

		pi.registerCommand("quote", {
			description: t("quotes.command.quote"),
			handler: async (args, ctx) => {
				await quoteAssistantReply(args, ctx);
			},
		});

		pi.registerCommand("quotes", {
			description: t("quotes.command.quotes"),
			handler: async (args, ctx) => {
				selectionController.hide();
				await handleQuotesCommand(args, ctx);
			},
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		activeCtx = ctx;
		selectionController.hide();
		scrubExternalQuoteBlocksUi(ctx);
		installSelectionQuoteRuntimeHooks(selectionController);

		if (ctx.mode === "tui" && ctx.hasUI) {
			unsubscribeInput = ctx.ui.onTerminalInput((data) => {
				const tui = getActiveHostRuntime()?.tui;
				if (!isKeyRelease(data) && tui) {
					if (
						(data === "\x1b" || matchesKey(data, "escape")) &&
						selectionController.isShowing &&
						!hasBlockingModalOverlay(tui)
					) {
						selectionController.hide();
						requestRender();
						return { consume: true };
					}
					const isCopyChord =
						data === "\x03" ||
						data === "\x18" ||
						matchesLayoutChord(data, "cmd+c") ||
						matchesLayoutChord(data, "shift+cmd+c") ||
						matchesLayoutChord(data, "ctrl+c") ||
						matchesLayoutChord(data, "shift+ctrl+c") ||
						matchesLayoutChord(data, "ctrl+x");
					if (isCopyChord) {
						const renderer = unwrapHostTui(tui) as unknown as {
							getActiveSelectionText?: () => string | undefined;
						};
						const activeText =
							renderer.getActiveSelectionText?.() || selectionController.snapshottedText;
						if (activeText && activeText.trim().length > 0) {
							selectionController.hide();
							copySelectedAndFlash(activeText, tui);
							return { consume: true };
						}
					}
				}
				queueMicrotask(() => {
					const curTui = getActiveHostRuntime()?.tui;
					if (
						curTui &&
						hasBlockingModalOverlay(curTui) &&
						selectionController.isShowing &&
						!selectionController.isCopyOnly
					) {
						selectionController.hide();
					}
				});
				return undefined;
			});
		}
	});

	pi.on("input", async () => {
		selectionController.hide();
		return { action: "continue" };
	});

	pi.on("session_shutdown", async () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		selectionController.hide();
		activeCtx = undefined;
	});
}
