import {
	convertToPng,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	getImageDimensions,
	isKeyRelease,
	matchesKey,
	TuiAltScreen,
	type TUI,
} from "@earendil-works/pi-tui";
import { bgRgb, fgRgb, getActiveGlobalTheme, isLightTheme, type RgbTuple } from "../../shared/ansi.ts";
import {
	getComposerHooks,
	PiUiComposerEditor,
	registerComposerHooks,
	type ComposerHooks,
	type ComposerPointerInfo,
} from "../chrome/composer.ts";
import {
	getPromptPillFormatter,
	registerPromptPillFormatter,
	type PromptPillDescriptor,
	type PromptPillFormatter,
} from "../transcript/user-prompt.ts";
import {
	getActiveHostRuntime,
	installViewportScrollDismissHooks,
	resolveActiveClipboardProvider,
} from "../../shared/host-runtime.ts";
import { matchesLayoutChord } from "../../shared/keyboard-layout.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { hookMethod } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { isPrototypeActive } from "../transcript/prototype-state.ts";
import {
	extractPastedImageFilesSync,
	materializeClipboardImagePayload,
	tryReadImageFileSync,
} from "./clipboard.ts";
import { PromptChipOverlayController } from "./preview-popup.ts";
import {
	classifyTextPaste,
	findPromptChipSpans,
	getActivePromptChipRegistry,
	PROMPT_CHIPS_CUSTOM_ENTRY_TYPE,
	PromptChipRegistry,
	serializePromptChip,
	type PromptChipKind,
	type PromptChipUndoSnapshot,
	type QuotePromptChipData,
	type RegisteredPromptChip,
	type SerializedPromptChip,
} from "./registry.ts";

export * from "./registry.ts";
export * from "./clipboard.ts";
export * from "./preview-popup.ts";

const EMPTY_BRACKETED_PASTE = "\x1b[200~\x1b[201~";
const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
const CHIP_DECORATION_RE =
	/(?:(\x1b_pi:c\x07)?(\x1b_pi:fc\x07))?(\[(?:🖼 Image #\d+|📋 Pasted #\d+ · \d+ (?:lines?|chars?)|❝ Quote #\d+ · \d+ lines?)\])(\x1b_pi:\/fc\x07)?/gu;

function inferChipKindFromToken(token: string): PromptChipKind {
	if (token.startsWith("[🖼")) return "image";
	if (token.startsWith("[📋")) return "paste";
	return "quote";
}

export function styleInlinePromptChip(
	token: string,
	options: { kind: PromptChipKind; theme: Theme; active?: boolean },
): string {
	const light = isLightTheme(options.theme);
	let bg: RgbTuple;
	let fg: RgbTuple;

	if (light) {
		if (options.active) {
			bg = [191, 219, 254];
			fg = [15, 23, 42];
		} else if (options.kind === "image") {
			bg = [214, 230, 252];
			fg = [29, 78, 216];
		} else if (options.kind === "paste") {
			bg = [219, 234, 250];
			fg = [30, 64, 175];
		} else {
			bg = [212, 234, 244];
			fg = [14, 116, 144];
		}
	} else if (options.active) {
		bg = [44, 68, 98];
		fg = [226, 240, 255];
	} else if (options.kind === "image") {
		bg = [34, 52, 76];
		fg = [125, 207, 255];
	} else if (options.kind === "paste") {
		bg = [33, 49, 68];
		fg = [148, 198, 242];
	} else {
		bg = [32, 50, 66];
		fg = [134, 202, 224];
	}

	return bgRgb(bg, fgRgb(fg, token));
}

export function decorateComposerLineWithChips(line: string, theme: Theme): string {
	if (!line.includes("[")) return line;
	return line.replace(
		CHIP_DECORATION_RE,
		(_full, cursorMarker: string | undefined, fakeStart: string | undefined, token: string, fakeEnd: string | undefined) => {
			const kind = inferChipKindFromToken(token);
			const isCursorOnChip = Boolean(fakeStart);
			const styled = styleInlinePromptChip(token, {
				kind,
				theme,
				active: isCursorOnChip,
			});
			if (isCursorOnChip) {
				const prefix = `${cursorMarker ?? ""}${FAKE_CURSOR_START}`;
				const suffix = fakeEnd ?? FAKE_CURSOR_END;
				return `${prefix}${styled}${suffix}`;
			}
			return `${cursorMarker ?? ""}${styled}`;
		},
	);
}

function padChipTokenForComposer(editor: PiUiComposerEditor, tokenText: string): string {
	if (!isPrototypeActive()) return tokenText;
	const before = editor.getCharBeforeCursor();
	const after = editor.getCharAfterCursor();
	const lead = before.length > 0 && !/\s/u.test(before) ? " " : "";
	const trail = after === " " ? "" : " ";
	return `${lead}${tokenText}${trail}`;
}

export function insertQuoteChipInComposer(
	editor: PiUiComposerEditor,
	quoteText: string,
	sourceLabel?: string,
): RegisteredPromptChip<QuotePromptChipData> | undefined {
	if (!quoteText.trim()) return undefined;
	const registry = getActivePromptChipRegistry();
	const preSnap = registry.captureUndoSnapshot();
	const chip = registry.registerQuote(quoteText, sourceLabel);
	editor.insertTextWithUndoSnapshot(padChipTokenForComposer(editor, chip.token), preSnap);
	requestRender();
	return chip;
}

function extractUserMessageTextContent(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: any) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n\n");
}

function isBashDraft(editor: PiUiComposerEditor): boolean {
	return editor.getText().trimStart().startsWith("!");
}

function quoteShellPathIfNeeded(filePath: string): string {
	return /\s|['"\\$`!&;()<>]/.test(filePath)
		? `'${filePath.replace(/'/g, "'\\''")}'`
		: filePath;
}

function findComponentScreenY(root: any, target: object): number | undefined {
	if (!root || typeof root !== "object") return undefined;
	if (root.component === target && typeof root.rect?.y === "number") {
		return root.rect.y;
	}
	if (Array.isArray(root.children)) {
		for (const child of root.children) {
			const found = findComponentScreenY(child, target);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function decorateComposerVisualLine(
	rawInner: string,
	visualLineIndex: number,
	editor: PiUiComposerEditor,
	registry: PromptChipRegistry,
	theme: Theme,
): string {
	const vl = editor.getVisualSlice(visualLineIndex);
	if (!vl) {
		return decorateComposerLineWithChips(rawInner, theme);
	}
	const { logicalLine } = vl;
	const vlEnd = vl.startCol + vl.length;
	if (!logicalLine || vl.length <= 0 || !logicalLine.includes("[")) {
		return rawInner;
	}

	const overlapping = findPromptChipSpans(logicalLine).filter(
		(span) => span.end > vl.startCol && span.start < vlEnd && registry.isKnownChipSpan(span),
	);
	if (overlapping.length === 0) {
		return rawInner;
	}

	let out = "";
	let rawIdx = 0;
	let logicalOffset = 0;
	let spanPtr = 0;
	let styledRun = "";
	let styledSpan: (typeof overlapping)[number] | undefined;

	const flushStyledRun = () => {
		if (!styledRun || !styledSpan) return;
		const isCursorOnChip =
			vl.cursorLine === vl.logicalLineIndex &&
			vl.cursorCol === styledSpan.start;
		out += styleInlinePromptChip(styledRun, {
			kind: styledSpan.kind,
			theme,
			active: isCursorOnChip,
		});
		styledRun = "";
	};

	while (rawIdx < rawInner.length && logicalOffset < vl.length) {
		if (rawInner.startsWith(CURSOR_MARKER, rawIdx)) {
			flushStyledRun();
			out += CURSOR_MARKER;
			rawIdx += CURSOR_MARKER.length;
			continue;
		}
		if (rawInner.startsWith(FAKE_CURSOR_START, rawIdx)) {
			flushStyledRun();
			out += FAKE_CURSOR_START;
			rawIdx += FAKE_CURSOR_START.length;
			continue;
		}
		if (rawInner.startsWith(FAKE_CURSOR_END, rawIdx)) {
			flushStyledRun();
			out += FAKE_CURSOR_END;
			rawIdx += FAKE_CURSOR_END.length;
			continue;
		}

		const absCol = vl.startCol + logicalOffset;
		while (spanPtr < overlapping.length && overlapping[spanPtr]!.end <= absCol) {
			spanPtr += 1;
		}
		const activeSpan =
			spanPtr < overlapping.length &&
			absCol >= overlapping[spanPtr]!.start &&
			absCol < overlapping[spanPtr]!.end
				? overlapping[spanPtr]
				: undefined;

		if (activeSpan !== styledSpan) {
			flushStyledRun();
			styledSpan = activeSpan;
		}

		const ch = rawInner[rawIdx]!;
		if (styledSpan) {
			styledRun += ch;
		} else {
			out += ch;
		}
		rawIdx += 1;
		logicalOffset += 1;
	}

	flushStyledRun();
	if (rawIdx < rawInner.length) {
		out += rawInner.slice(rawIdx);
	}
	return out;
}

function resolveComposerTopRow(
	tui: TUI | undefined,
	editor: PiUiComposerEditor,
	pointer?: ComposerPointerInfo,
): number {
	const fromLayout = findComponentScreenY((tui as any)?.currentLayout?.root, editor);
	if (fromLayout !== undefined) return fromLayout;
	if (pointer?.screenY !== undefined && pointer?.mouseY !== undefined) {
		return Math.max(0, pointer.screenY - pointer.mouseY);
	}
	const termRows = tui?.terminal?.rows ?? 30;
	const boxHeight = editor.getRenderedBoxHeight();
	return Math.max(0, termRows - boxHeight - 1);
}

function findHoveredComposerChip(
	editor: PiUiComposerEditor,
	registry: PromptChipRegistry,
	pointer: ComposerPointerInfo,
	tui: TUI | undefined,
): { chip: SerializedPromptChip; col: number } | undefined {
	if (!pointer.hovered || pointer.mouseX === undefined || pointer.mouseY === undefined) {
		return undefined;
	}
	const totalWidth = pointer.width ?? tui?.terminal?.columns ?? 80;
	const hit = editor.findSpanColumnAtMouse(pointer.mouseX, pointer.mouseY, totalWidth, findPromptChipSpans);
	if (!hit) return undefined;
	const entry = registry.resolveChip(hit.span.kind, hit.span.number);
	if (!entry) return undefined;
	return {
		chip: serializePromptChip(entry, hit.span.number),
		col: hit.col,
	};
}

function findCaretComposerChip(
	editor: PiUiComposerEditor,
	registry: PromptChipRegistry,
	tui: TUI | undefined,
): { chip: SerializedPromptChip; col: number } | undefined {
	const totalWidth = tui?.terminal?.columns ?? 80;
	const hit = editor.findSpanColumnAtCursor(totalWidth, findPromptChipSpans);
	if (!hit) return undefined;
	const entry = registry.resolveChip(hit.span.kind, hit.span.number);
	if (!entry) return undefined;
	return {
		chip: serializePromptChip(entry, hit.span.number),
		col: hit.col,
	};
}

export function registerPromptChipsFeature(pi: ExtensionAPI): void {
	let activeCtx: ExtensionContext | undefined;
	let lastDraftText = "";
	let syncingEditorLines = false;
	let lastEditor: PiUiComposerEditor | undefined;
	let lastPointer: ComposerPointerInfo | undefined;
	let unsubscribeInputGuard: (() => void) | undefined;

	const getTheme = () => activeCtx?.ui.theme ?? getActiveGlobalTheme();
	const overlayController = new PromptChipOverlayController(getTheme);

	const resolveEditorTui = (editor?: PiUiComposerEditor): TUI | undefined =>
		editor?.getTui() ?? getActiveHostRuntime()?.tui;

	const syncComposerPreview = (editor: PiUiComposerEditor, pointerOverride?: ComposerPointerInfo): void => {
		lastEditor = editor;
		if (pointerOverride !== undefined) {
			lastPointer = pointerOverride.hovered ? pointerOverride : undefined;
		}
		const tui = resolveEditorTui(editor);
		if (!tui || hasBlockingModalOverlay(tui)) {
			overlayController.hide();
			return;
		}

		const registry = getActivePromptChipRegistry();
		const hoveredMatch = lastPointer
			? findHoveredComposerChip(editor, registry, lastPointer, tui)
			: undefined;
		if (hoveredMatch) {
			const topRow = resolveComposerTopRow(tui, editor, lastPointer);
			overlayController.show(tui, hoveredMatch.chip, "composer-hover", {
				col: hoveredMatch.col,
				rowAbove: topRow,
			});
			return;
		}

		const caretMatch = findCaretComposerChip(editor, registry, tui);
		if (caretMatch) {
			const topRow = resolveComposerTopRow(tui, editor, lastPointer);
			overlayController.show(tui, caretMatch.chip, "composer-caret", {
				col: caretMatch.col,
				rowAbove: topRow,
			});
			return;
		}

		overlayController.hide(["composer-hover", "composer-caret"]);
	};

	const resolveCwd = () => activeCtx?.cwd ?? getActiveHostRuntime()?.ctx.cwd ?? process.cwd();

	const handleClipboardPasteAction = async (
		editor: PiUiComposerEditor,
		options: { emptyBracketedPaste: boolean },
	): Promise<void> => {
		const registry = getActivePromptChipRegistry();
		const clipboard = resolveActiveClipboardProvider();
		const cwd = resolveCwd();

		try {
			const filePaths = await clipboard.readFilePaths?.();
			if (filePaths && filePaths.length > 0) {
				if (filePaths.some((p) => /\p{Cc}/u.test(p))) {
					return;
				}
				if (isBashDraft(editor)) {
					editor.insertTextAtCursor(filePaths.map(quoteShellPathIfNeeded).join(" "));
					requestRender();
					return;
				}
				const preSnap = registry.captureUndoSnapshot();
				const tokens: string[] = [];
				for (const fp of filePaths) {
					const imgInput = tryReadImageFileSync(fp, cwd);
					if (imgInput) {
						tokens.push(registry.registerImage(imgInput).token);
					} else {
						tokens.push(fp);
					}
				}
				if (tokens.length > 0) {
					editor.insertTextWithUndoSnapshot(padChipTokenForComposer(editor, tokens.join(" ")), preSnap);
					syncComposerPreview(editor);
					requestRender();
				}
				return;
			}

			const imagePayload = await clipboard.readImage?.();
			if (imagePayload && imagePayload.bytes.length > 0) {
				const materialized = await materializeClipboardImagePayload(imagePayload);
				if (materialized) {
					const preSnap = registry.captureUndoSnapshot();
					const chip = registry.registerImage(materialized);
					editor.insertTextWithUndoSnapshot(chip.token, preSnap);
					syncComposerPreview(editor);
					requestRender();
				}
				return;
			}

			if (options.emptyBracketedPaste) {
				return;
			}

			const text = await clipboard.readText?.();
			if (text) {
				const imageFiles = !isBashDraft(editor) ? extractPastedImageFilesSync(text, cwd) : undefined;
				if (imageFiles && imageFiles.length > 0) {
					const preSnap = registry.captureUndoSnapshot();
					const tokens = imageFiles.map((img) => registry.registerImage(img).token);
					editor.insertTextWithUndoSnapshot(padChipTokenForComposer(editor, tokens.join(" ")), preSnap);
					syncComposerPreview(editor);
					requestRender();
					return;
				}
				const classified = classifyTextPaste(text);
				if (!isBashDraft(editor) && classified.shouldCreateChip) {
					const preSnap = registry.captureUndoSnapshot();
					const chip = registry.registerPaste(text);
					editor.insertTextWithUndoSnapshot(padChipTokenForComposer(editor, chip.token), preSnap);
				} else if (classified.normalizedText.length > 0) {
					editor.insertTextAtCursor(classified.normalizedText);
				}
				syncComposerPreview(editor);
				requestRender();
			}
		} catch (err) {
			activeCtx?.ui.notify(
				`Clipboard paste error: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	};

	const composerHooks: ComposerHooks = {
		interceptInput(data, editor) {
			if (isKeyRelease(data)) return false;

			if (data.startsWith(EMPTY_BRACKETED_PASTE)) {
				void handleClipboardPasteAction(editor, { emptyBracketedPaste: true });
				const tail = data.slice(EMPTY_BRACKETED_PASTE.length);
				if (tail.length > 0) {
					editor.handleInput(tail);
				}
				return true;
			}

			if (
				editor.isShowingAutocomplete() &&
				(editor.matchesKeybinding(data, "tui.select.pageUp") ||
					editor.matchesKeybinding(data, "tui.select.pageDown"))
			) {
				return false;
			}

			const isPasteKey =
				matchesLayoutChord(data, "ctrl+v") ||
				matchesLayoutChord(data, "super+v") ||
				editor.matchesKeybinding(data, "app.clipboard.pasteImage");
			if (isPasteKey) {
				void handleClipboardPasteAction(editor, { emptyBracketedPaste: false });
				return true;
			}

			return false;
		},

		transformPaste(pastedText, editor) {
			if (isBashDraft(editor)) return undefined;
			const registry = getActivePromptChipRegistry();
			const cwd = resolveCwd();

			const imageFiles = extractPastedImageFilesSync(pastedText, cwd);
			if (imageFiles && imageFiles.length > 0) {
				return imageFiles.map((img) => registry.registerImage(img).token).join(" ");
			}

			const classified = classifyTextPaste(pastedText);
			if (classified.shouldCreateChip) {
				return registry.registerPaste(pastedText).token;
			}
			/* Короткие вставки обходят Editor.handlePaste напрямую, чтобы табы >1000 колонок не рождали legacy [paste #N] */
			let inlineText = classified.normalizedText;
			if (/^[/~.]/.test(inlineText)) {
				const beforeChar = editor.getCharBeforeCursor();
				if (beforeChar && /\w/.test(beforeChar)) {
					inlineText = ` ${inlineText}`;
				}
			}
			return inlineText;
		},

		findAtomicTokenSpans(text) {
			const registry = getActivePromptChipRegistry();
			return findPromptChipSpans(text).filter((span) => registry.isKnownChipSpan(span));
		},

		decorateRenderedLine(line, visualLineIndex, editor) {
			const theme = activeCtx?.ui.theme ?? getActiveGlobalTheme();
			const registry = getActivePromptChipRegistry();
			return decorateComposerVisualLine(line, visualLineIndex, editor, registry, theme);
		},

		onDraftChanged(text, editor) {
			if (syncingEditorLines) return;
			const registry = getActivePromptChipRegistry();
			if (text === "" && lastDraftText.length > 0) {
				registry.stageDraftBeforeClear(lastDraftText);
			}
			syncingEditorLines = true;
			let updatedText: string | undefined;
			try {
				updatedText = editor.syncDraftLinesWithCursor((lines, cursorLine, cursorCol) =>
					registry.syncDraftLines(lines, cursorLine, cursorCol),
				);
			} finally {
				syncingEditorLines = false;
			}
			lastDraftText = updatedText ?? text;
			syncComposerPreview(editor);
		},

		onPointerOrCursorChange(info, editor) {
			syncComposerPreview(editor, info);
		},

		captureUndoState() {
			return getActivePromptChipRegistry().captureUndoSnapshot();
		},

		restoreUndoState(snapshot) {
			if (snapshot && typeof snapshot === "object" && "bindings" in snapshot) {
				getActivePromptChipRegistry().restoreUndoSnapshot(snapshot as PromptChipUndoSnapshot);
			}
		},
	};

	const ensureHooksInstalled = () => {
		if (!getComposerHooks()) {
			registerComposerHooks(composerHooks);
		}
		if (!getPromptPillFormatter()) {
			registerPromptPillFormatter(pillFormatter);
		}
	};

	let sentPillClickedInCurrentRelease = false;

	const toggleSentPillPreview = (chip: SerializedPromptChip, screenX: number, screenY: number): void => {
		sentPillClickedInCurrentRelease = true;
		const tui = resolveEditorTui(lastEditor);
		const expectedKey = `sent-pill:${chip.id}:${chip.token}`;
		if (overlayController.source === "sent-pill" && overlayController.chipKey === expectedKey) {
			overlayController.hide(["sent-pill"]);
			requestRender();
			return;
		}
		overlayController.show(tui, chip, "sent-pill", {
			col: Math.max(1, screenX - 2),
			rowAbove: Math.max(0, screenY - 1),
			rowBelow: screenY + 2,
		});
		requestRender();
	};

	const hydratePersistedFromSession = (ctxOverride?: ExtensionContext): void => {
		const sm = (ctxOverride ?? activeCtx ?? getActiveHostRuntime()?.ctx)?.sessionManager;
		if (!sm) return;
		const entries = sm.getEntries?.() ?? sm.getBranch?.() ?? [];
		if (entries.length > 0) {
			getActivePromptChipRegistry().restorePersistedEntries(entries);
		}
	};

	const pillFormatter: PromptPillFormatter = (rawText, context) => {
		const registry = getActivePromptChipRegistry();
		let reconstructed = registry.reconstructSubmittedPrompt(
			rawText,
			context.timestamp,
			context.messageId,
		);
		if (reconstructed.chips.length === 0) {
			hydratePersistedFromSession();
			reconstructed = registry.reconstructSubmittedPrompt(
				rawText,
				context.timestamp,
				context.messageId,
			);
		}
		if (reconstructed.chips.length === 0) {
			return rawText;
		}

		const spans = findPromptChipSpans(reconstructed.displayText);
		if (spans.length === 0) {
			return reconstructed.displayText;
		}

		const chipByKindAndNum = new Map<string, SerializedPromptChip>();
		for (const chip of reconstructed.chips) {
			chipByKindAndNum.set(`${chip.kind}:${chip.number}`, chip);
		}

		let formatted = "";
		let pos = 0;
		const pills: PromptPillDescriptor[] = [];

		for (let idx = 0; idx < spans.length; idx++) {
			const span = spans[idx]!;
			const chip = chipByKindAndNum.get(`${span.kind}:${span.number}`);
			formatted += reconstructed.displayText.slice(pos, span.start).replace(/\t/g, "  ");
			formatted += styleInlinePromptChip(span.token, {
				kind: span.kind,
				theme: context.theme,
			});
			pos = span.end;

			pills.push({
				id: `${context.surface}-${chip?.id ?? `${span.kind}-${span.number}`}-${idx}`,
				label: span.token,
				onClick: chip ? (sx, sy) => toggleSentPillPreview(chip, sx, sy) : undefined,
			});
		}
		formatted += reconstructed.displayText.slice(pos).replace(/\t/g, "  ");

		return {
			text: formatted,
			pills,
		};
	};

	const installAltScreenDismissHooks = (): void => {
		installViewportScrollDismissHooks(
			"promptChips",
			() => overlayController.source === "sent-pill",
			() => overlayController.hide(["sent-pill"]),
		);

		const altProto = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
		if (!altProto) return;

		hookMethod(altProto, "handleMouseEvent", "promptChips.outsideReleaseDismiss", (self, args, original) => {
			const raw = args[0] as { button: number; release: boolean } | undefined;
			const isButtonRelease = Boolean(raw && raw.release && (raw.button & 32) === 0);
			if (!isButtonRelease || overlayController.source !== "sent-pill") {
				return original.apply(self, args);
			}
			sentPillClickedInCurrentRelease = false;
			const res = original.apply(self, args);
			if (!sentPillClickedInCurrentRelease && overlayController.source === "sent-pill") {
				overlayController.hide(["sent-pill"]);
				self.requestRender?.();
			}
			return res;
		});
	};

	ensureHooksInstalled();

	pi.on("session_start", async (event, ctx) => {
		unsubscribeInputGuard?.();
		unsubscribeInputGuard = undefined;
		activeCtx = ctx;
		overlayController.hide();
		registerComposerHooks(composerHooks);
		registerPromptPillFormatter(pillFormatter);
		installAltScreenDismissHooks();
		const registry = getActivePromptChipRegistry();
		if (event.reason !== "reload") {
			registry.clearSession();
			lastDraftText = "";
			lastPointer = undefined;
		}
		const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch?.() ?? [];
		registry.restorePersistedEntries(entries);
		if (ctx.mode === "tui" && ctx.hasUI) {
			unsubscribeInputGuard = ctx.ui.onTerminalInput((data) => {
				if (
					!isKeyRelease(data) &&
					(data === "\x1b" || matchesKey(data, "escape")) &&
					overlayController.source === "sent-pill"
				) {
					overlayController.hide(["sent-pill"]);
					requestRender();
					return { consume: true };
				}
				queueMicrotask(() => {
					const tui = resolveEditorTui(lastEditor);
					if (tui && hasBlockingModalOverlay(tui)) {
						overlayController.hide();
					} else if (lastEditor && overlayController.source !== "sent-pill") {
						syncComposerPreview(lastEditor);
					}
				});
				return undefined;
			});
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		hydratePersistedFromSession(ctx);
	});

	pi.on("message_start", async (event: any) => {
		if (event?.message?.role === "user") {
			const text = extractUserMessageTextContent(event.message);
			if (text) {
				getActivePromptChipRegistry().bindSubmittedMessageTimestamp(text, event.message.timestamp);
			}
		}
	});

	pi.on("message_end", async (event: any) => {
		if (event?.message?.role === "user") {
			const text = extractUserMessageTextContent(event.message);
			if (text) {
				const payload = getActivePromptChipRegistry().consumePersistPayload(
					text,
					event.message.timestamp,
				);
				if (payload) {
					pi.appendEntry(PROMPT_CHIPS_CUSTOM_ENTRY_TYPE, payload);
				}
			}
		}
	});

	pi.on("input", async (event) => {
		overlayController.hide(["composer-hover", "composer-caret"]);
		const registry = getActivePromptChipRegistry();
		const spans = findPromptChipSpans(event.text);
		if (spans.length === 0) {
			return { action: "continue" };
		}

		/* BMP конвертируется в PNG через срез отправляемого черновика, т.к. submitValue уже очистил activeBindings */
		for (const chip of registry.resolveChipsForSubmit(event.text)) {
			if (chip.kind !== "image" || chip.mimeType !== "image/bmp" || !chip.base64Data) continue;
			try {
				const converted = await convertToPng(chip.base64Data, "image/bmp");
				if (converted?.data) {
					const pngBytes = Buffer.from(converted.data, "base64");
					const dims = getImageDimensions(converted.data, "image/png");
					registry.updateImageChipPayload(chip.id, {
						mimeType: "image/png",
						base64Data: converted.data,
						byteLength: pngBytes.byteLength,
						widthPx: dims?.widthPx,
						heightPx: dims?.heightPx,
					});
				}
			} catch {
				/* Если photon недоступен, оставляем исходные данные */
			}
		}

		const expanded = registry.expandDraftForSubmit(event.text, event.images);
		if (!expanded.transformed) {
			return { action: "continue" };
		}
		return {
			action: "transform",
			text: expanded.text,
			images: expanded.images,
		};
	});

	pi.on("session_shutdown", async () => {
		unsubscribeInputGuard?.();
		unsubscribeInputGuard = undefined;
		overlayController.hide();
		activeCtx = undefined;
		lastEditor = undefined;
		lastPointer = undefined;
		lastDraftText = "";
		getActivePromptChipRegistry().clearSession();
	});
}
