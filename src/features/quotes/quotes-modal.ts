import type {
	ExtensionContext,
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type EditorTheme,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { bgRgb, fgRgb } from "../../shared/ansi.ts";
import { t } from "../../shared/i18n.ts";
import { matchesLayoutChord } from "../../shared/keyboard-layout.ts";
import {
	createModalCard,
	getThemeSurfacePalette,
	openModalCard,
	type ModalActionPill,
} from "../../shared/modal-card.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { getActiveComposerEditor, getComposerHooks } from "../chrome/composer.ts";
import { getActivePromptChipRegistry, styleInlinePromptChip } from "../prompt-chips/index.ts";
import {
	clearAllDraftQuotes,
	editDraftQuote,
	listActiveDraftQuotes,
	parseQuoteTargetNumber,
	removeDraftQuote,
	type ActiveDraftQuoteItem,
} from "./quote-model.ts";

const MAX_LIST_VISIBLE_ROWS = 6;
const MAX_PREVIEW_LINES = 6;

export function readComposerDraftText(ctx: ExtensionContext): string {
	const editor = getActiveComposerEditor();
	if (editor) {
		return editor.getText();
	}
	const ui = ctx.ui as ExtensionUIContext & { getEditorText?: () => string };
	return ui.getEditorText?.() ?? "";
}

export function writeComposerDraftTextWithUndo(
	ctx: ExtensionContext,
	nextDraft: string,
	preCapturedUndoSnapshot: unknown,
): void {
	const editor = getActiveComposerEditor();
	if (editor) {
		const before = editor.getText();
		editor.setTextWithUndoSnapshot(nextDraft, preCapturedUndoSnapshot);
		if (before === nextDraft) {
			getComposerHooks()?.onDraftChanged?.(nextDraft, editor);
		}
		requestRender();
		return;
	}
	ctx.ui.setEditorText(nextDraft);
	requestRender();
}

function createEmbeddedEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s: string) => theme.fg("borderMuted", s),
		selectList: {
			selectedPrefix: (s: string) => theme.fg("accent", s),
			selectedText: (s: string) => theme.fg("accent", s),
			description: (s: string) => theme.fg("muted", s),
			scrollInfo: (s: string) => theme.fg("dim", s),
			noMatch: (s: string) => theme.fg("muted", s),
		},
	};
}

export async function showQuotesManagerModal(
	ctx: ExtensionContext,
	options?: { initialEditQuoteNumber?: number; initialSelectQuoteNumber?: number },
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const registry = getActivePromptChipRegistry();
	const initialItems = listActiveDraftQuotes(registry, readComposerDraftText(ctx));
	if (initialItems.length === 0) {
		ctx.ui.notify(t("quotes.noneInDraft"), "info");
		return;
	}

	await openModalCard<void>(
		ctx,
		(tui: TUI, theme: Theme, kb: KeybindingsManager, done) => {
			const card = createModalCard();
			let selectedIdx = 0;
			let scrollOffset = 0;
			let hoveredListIdx: number | null = null;
			let rowToItemIdx = new Map<number, number>();

			let mode: "inspect" | "edit" = "inspect";
			let editingQuoteNumber: number | undefined;
			let editBuffer: Editor | undefined;

			const getItems = (): ActiveDraftQuoteItem[] =>
				listActiveDraftQuotes(registry, readComposerDraftText(ctx));

			const startEditForIndex = (idx: number): boolean => {
				const items = getItems();
				const item = items[idx];
				if (!item) return false;
				selectedIdx = idx;
				editingQuoteNumber = item.number;
				const ed = new Editor(tui, createEmbeddedEditorTheme(theme), { paddingX: 0 });
				ed.focused = true;
				ed.setText(item.entry.text);
				editBuffer = ed;
				mode = "edit";
				return true;
			};

			if (options?.initialSelectQuoteNumber !== undefined) {
				const foundSelectIdx = initialItems.findIndex(
					(it) => it.number === options.initialSelectQuoteNumber,
				);
				if (foundSelectIdx !== -1) {
					selectedIdx = foundSelectIdx;
				}
			}

			if (options?.initialEditQuoteNumber !== undefined) {
				const foundIdx = initialItems.findIndex((it) => it.number === options.initialEditQuoteNumber);
				if (foundIdx !== -1) {
					startEditForIndex(foundIdx);
				}
			}

			const commitEdit = (): void => {
				if (mode !== "edit" || editingQuoteNumber === undefined || !editBuffer) return;
				const draft = readComposerDraftText(ctx);
				const preSnap = registry.captureUndoSnapshot();
				const res = editDraftQuote(registry, draft, editingQuoteNumber, editBuffer.getText());
				mode = "inspect";
				editingQuoteNumber = undefined;
				editBuffer = undefined;
				if (res.found && !(res.unchanged && res.draftText === draft)) {
					writeComposerDraftTextWithUndo(ctx, res.draftText, preSnap);
				}
				const remaining = getItems();
				if (remaining.length === 0) {
					done();
					return;
				}
				if (selectedIdx >= remaining.length) {
					selectedIdx = remaining.length - 1;
				}
			};

			const cancelEdit = (): void => {
				mode = "inspect";
				editingQuoteNumber = undefined;
				editBuffer = undefined;
			};

			const removeSelectedQuote = (): void => {
				const items = getItems();
				const item = items[selectedIdx];
				if (!item) return;
				const draft = readComposerDraftText(ctx);
				const preSnap = registry.captureUndoSnapshot();
				const res = removeDraftQuote(registry, draft, item.number);
				if (res.removed) {
					writeComposerDraftTextWithUndo(ctx, res.draftText, preSnap);
				}
				const remaining = getItems();
				if (remaining.length === 0) {
					done();
					return;
				}
				if (selectedIdx >= remaining.length) {
					selectedIdx = remaining.length - 1;
				}
			};

			const clearAllQuotes = (): void => {
				const draft = readComposerDraftText(ctx);
				const preSnap = registry.captureUndoSnapshot();
				const res = clearAllDraftQuotes(registry, draft);
				if (res.removedCount > 0) {
					writeComposerDraftTextWithUndo(ctx, res.draftText, preSnap);
				}
				done();
			};

			const comp: Component & Focusable = {
				focused: true,
				capturesViewportInput: true,
				invalidate() {},
				render(width: number): string[] {
					rowToItemIdx = new Map();
					const palette = getThemeSurfacePalette(theme);
					const innerWidth = Math.max(24, width - 4);
					const items = getItems();

					if (items.length === 0) {
						return card.render(width, theme, {
							title: fgRgb(palette.accentBright, theme.bold(t("quotes.modal.emptyTitle"))),
							onClose: () => done(),
							bodyLines: [theme.fg("muted", t("quotes.modal.emptyBody"))],
							borderVariant: "primary",
						});
					}

					if (selectedIdx >= items.length) {
						selectedIdx = Math.max(0, items.length - 1);
					}

					if (mode === "edit" && editBuffer && editingQuoteNumber !== undefined) {
						editBuffer.focused = Boolean(comp.focused);
						const editorWidth = Math.max(12, innerWidth - 2);
						const rawEditorLines = editBuffer.render(editorWidth);
						const contentLines =
							rawEditorLines.length >= 2
								? rawEditorLines.slice(1, rawEditorLines.length - 1)
								: rawEditorLines;
						const body: string[] = [
							theme.fg("muted", t("quotes.modal.editHeader", { num: editingQuoteNumber })),
							theme.fg("borderMuted", "─".repeat(innerWidth)),
							...contentLines.map((line) =>
								truncateToWidth(`${fgRgb(palette.accent, "│ ")}${line}`, innerWidth, "…"),
							),
						];

						const editPills: ModalActionPill[] = [
							{
								id: "save-edit",
								label: t("quotes.modal.save"),
								variant: "primary",
								active: true,
								onClick: () => commitEdit(),
							},
							{
								id: "cancel-edit",
								label: t("quotes.modal.cancel"),
								variant: "neutral",
								onClick: () => cancelEdit(),
							},
						];

						return card.render(width, theme, {
							title: fgRgb(
								palette.accentBright,
								theme.bold(t("quotes.modal.editTitle", { num: editingQuoteNumber })),
							),
							onClose: () => cancelEdit(),
							bodyLines: body,
							footerPills: editPills,
							borderVariant: "primary",
						});
					}

					if (selectedIdx < scrollOffset) scrollOffset = selectedIdx;
					if (selectedIdx >= scrollOffset + MAX_LIST_VISIBLE_ROWS) {
						scrollOffset = selectedIdx - MAX_LIST_VISIBLE_ROWS + 1;
					}
					scrollOffset = Math.max(
						0,
						Math.min(scrollOffset, Math.max(0, items.length - MAX_LIST_VISIBLE_ROWS)),
					);

					const body: string[] = [];
					const visibleItems = items.slice(scrollOffset, scrollOffset + MAX_LIST_VISIBLE_ROWS);
					let renderRowIdx = 1;

					for (let i = 0; i < visibleItems.length; i++) {
						const itemIdx = scrollOffset + i;
						const item = visibleItems[i]!;
						const isSelected = itemIdx === selectedIdx;
						const isHovered = itemIdx === hoveredListIdx;

						const cursorGlyph = isSelected ? fgRgb(palette.accentBright, "▸ ") : "  ";
						const pillStr = styleInlinePromptChip(item.token, {
							kind: "quote",
							theme,
							active: isSelected,
						});
						const sourceMeta = item.entry.sourceLabel
							? theme.fg("dim", ` · ${item.entry.sourceLabel}`)
							: "";
						const firstLine = (item.entry.text.split("\n")[0] ?? "").trim();
						const leftPart = `${cursorGlyph}${pillStr}${sourceMeta}`;
						const snippetBudget = Math.max(0, innerWidth - visibleWidth(leftPart) - 3);
						const snippetPart =
							snippetBudget >= 6 && firstLine
								? theme.fg("muted", `  ${truncateToWidth(firstLine, snippetBudget, "…")}`)
								: "";

						let rowText = truncateToWidth(`${leftPart}${snippetPart}`, innerWidth, "…");
						rowText += " ".repeat(Math.max(0, innerWidth - visibleWidth(rowText)));
						if (isSelected) {
							rowText = bgRgb(palette.selectedRowBg, rowText);
						} else if (isHovered) {
							rowText = bgRgb(palette.hoveredRowBg, rowText);
						}

						rowToItemIdx.set(renderRowIdx, itemIdx);
						body.push(rowText);
						renderRowIdx += 1;
					}

					body.push(theme.fg("borderMuted", "─".repeat(innerWidth)));

					const activeItem = items[selectedIdx]!;
					const rawLines = activeItem.entry.text.replace(/\t/g, "  ").split("\n");
					const wrapAvail = Math.max(8, innerWidth - 3);
					const previewLines: string[] = [];
					let sourceConsumed = 0;

					for (const srcLine of rawLines) {
						const wrapped = wrapTextWithAnsi(srcLine.length > 0 ? srcLine : " ", wrapAvail);
						if (previewLines.length + wrapped.length > MAX_PREVIEW_LINES && previewLines.length > 0) {
							break;
						}
						for (const wLine of wrapped.slice(0, MAX_PREVIEW_LINES - previewLines.length)) {
							previewLines.push(`${fgRgb(palette.accent, "│")} ${theme.fg("text", wLine)}`);
						}
						sourceConsumed += 1;
						if (previewLines.length >= MAX_PREVIEW_LINES) break;
					}

					const remainingLines = rawLines.length - sourceConsumed;
					if (remainingLines > 0) {
						previewLines.push(
							theme.fg(
								"dim",
								`  … (+${remainingLines} ${remainingLines === 1 ? "line" : "lines"})`,
							),
						);
					}
					body.push(...previewLines);

					const inspectPills: ModalActionPill[] = [
						{
							id: "edit-quote",
							label: t("quotes.modal.edit"),
							variant: "primary",
							active: true,
							onClick: () => {
								startEditForIndex(selectedIdx);
							},
						},
						{
							id: "remove-quote",
							label: t("quotes.modal.remove"),
							variant: "danger",
							onClick: () => removeSelectedQuote(),
						},
						{
							id: "clear-quotes",
							label: t("quotes.modal.clearAll"),
							variant: "warning",
							onClick: () => clearAllQuotes(),
						},
						{
							id: "close-quotes",
							label: t("quotes.modal.close"),
							variant: "neutral",
							onClick: () => done(),
						},
					];

					return card.render(width, theme, {
						title: fgRgb(palette.accentBright, theme.bold(t("quotes.modal.title"))),
						headerMeta: theme.fg("muted", `${items.length}`),
						onClose: () => done(),
						bodyLines: body,
						footerPills: inspectPills,
						borderVariant: "primary",
					});
				},
				handleInput(data: string): void {
					if (mode === "edit" && editBuffer) {
						if (
							(editBuffer as unknown as { isInPaste?: boolean }).isInPaste ||
							data.includes("\x1b[200~")
						) {
							editBuffer.handleInput(data);
							tui.requestRender();
							return;
						}
						if (data === "\x1b" || matchesKey(data, "escape")) {
							cancelEdit();
							tui.requestRender();
							return;
						}
						if (data.startsWith("\x1b\r") || data.startsWith("\x1b\n")) {
							editBuffer.insertTextAtCursor("\n");
							const tail = data.slice(2);
							if (tail.length > 0) {
								comp.handleInput?.(tail);
							}
							tui.requestRender();
							return;
						}
						const isNewlineChord =
							matchesKey(data, "alt+enter") ||
							matchesKey(data, "alt+return") ||
							matchesKey(data, "shift+enter") ||
							matchesKey(data, "shift+return");
						if (isNewlineChord) {
							editBuffer.insertTextAtCursor("\n");
							tui.requestRender();
							return;
						}
						const isCommit =
							data === "\r" ||
							data === "\n" ||
							matchesKey(data, "enter") ||
							matchesKey(data, "return") ||
							matchesLayoutChord(data, "ctrl+s");
						if (isCommit) {
							commitEdit();
							tui.requestRender();
							return;
						}
						editBuffer.handleInput(data);
						tui.requestRender();
						return;
					}

					const items = getItems();
					if (items.length === 0 || data === "\x1b" || matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel")) {
						done();
						return;
					}
					if (matchesKey(data, "up") || matchesLayoutChord(data, "ctrl+p") || kb.matches(data, "tui.select.up")) {
						selectedIdx = Math.max(0, selectedIdx - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down") || matchesLayoutChord(data, "ctrl+n") || kb.matches(data, "tui.select.down")) {
						selectedIdx = Math.min(items.length - 1, selectedIdx + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageUp") || kb.matches(data, "tui.select.pageUp")) {
						selectedIdx = Math.max(0, selectedIdx - MAX_LIST_VISIBLE_ROWS);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageDown") || kb.matches(data, "tui.select.pageDown")) {
						selectedIdx = Math.min(items.length - 1, selectedIdx + MAX_LIST_VISIBLE_ROWS);
						tui.requestRender();
						return;
					}
					const lower = data.length === 1 ? data.toLowerCase() : "";
					if (
						data === "\r" ||
						data === "\n" ||
						matchesKey(data, "enter") ||
						matchesKey(data, "return") ||
						kb.matches(data, "tui.select.confirm") ||
						lower === "e" ||
						lower === "у"
					) {
						startEditForIndex(selectedIdx);
						tui.requestRender();
						return;
					}
					if (
						lower === "d" ||
						lower === "в" ||
						lower === "r" ||
						lower === "к" ||
						matchesKey(data, "delete") ||
						matchesKey(data, "backspace")
					) {
						removeSelectedQuote();
						tui.requestRender();
						return;
					}
					if (lower === "c" || lower === "с") {
						clearAllQuotes();
						tui.requestRender();
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const items = getItems();
					if (mode === "inspect" && event.type === "wheel" && event.wheelDelta && items.length > 0) {
						const delta = event.wheelDelta < 0 ? -1 : 1;
						selectedIdx = Math.max(0, Math.min(items.length - 1, selectedIdx + delta));
						return { handled: true, render: true };
					}
					const cardOutcome = card.handleMouse(event);
					if (event.type === "move") {
						const nextHover =
							mode === "inspect" && !cardOutcome.handled ? (rowToItemIdx.get(event.y) ?? null) : null;
						const changed = nextHover !== hoveredListIdx;
						hoveredListIdx = nextHover;
						return { handled: true, render: cardOutcome.render || changed };
					}
					if (event.type === "click" && event.button === "left") {
						if (cardOutcome.triggered) {
							return { handled: true, render: true };
						}
						if (mode === "inspect") {
							const hitIdx = rowToItemIdx.get(event.y);
							if (hitIdx !== undefined && items[hitIdx]) {
								if (selectedIdx === hitIdx && (event.clickCount ?? 1) >= 2) {
									startEditForIndex(hitIdx);
								} else {
									selectedIdx = hitIdx;
								}
								return { handled: true, render: true };
							}
						}
					}
					return { handled: true, render: false };
				},
			};

			return comp;
		},
		{ width: 76, minWidth: 46, anchor: "center", margin: 2 },
	);

	const activeEditor = getActiveComposerEditor();
	if (activeEditor) {
		getComposerHooks()?.onPointerOrCursorChange?.({ hovered: false }, activeEditor);
	}
}

export async function handleQuotesCommand(rawArgs: string, ctx: ExtensionContext): Promise<void> {
	const registry = getActivePromptChipRegistry();
	const trimmed = rawArgs.trim();
	const firstSpace = trimmed.search(/\s/);
	const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();

	if (sub === "clear") {
		const draft = readComposerDraftText(ctx);
		const preSnap = registry.captureUndoSnapshot();
		const res = clearAllDraftQuotes(registry, draft);
		if (res.removedCount === 0) {
			ctx.ui.notify(t("quotes.noneInDraft"), "info");
			return;
		}
		writeComposerDraftTextWithUndo(ctx, res.draftText, preSnap);
		ctx.ui.notify(t("quotes.clearedCount", { count: res.removedCount }), "info");
		return;
	}

	if (sub === "remove" || sub === "rm" || sub === "delete") {
		const targetNum = parseQuoteTargetNumber(rest.split(/\s+/)[0]);
		if (targetNum === undefined) {
			ctx.ui.notify(t("quotes.usage.remove"), "warning");
			return;
		}
		const draft = readComposerDraftText(ctx);
		const preSnap = registry.captureUndoSnapshot();
		const res = removeDraftQuote(registry, draft, targetNum);
		if (!res.removed) {
			ctx.ui.notify(t("quotes.notFound", { num: targetNum }), "warning");
			return;
		}
		writeComposerDraftTextWithUndo(ctx, res.draftText, preSnap);
		ctx.ui.notify(t("quotes.removed", { num: targetNum }), "info");
		return;
	}

	if (sub === "edit") {
		const tokenMatch = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest);
		const targetNum = parseQuoteTargetNumber(tokenMatch?.[1]);
		if (targetNum === undefined) {
			ctx.ui.notify(t("quotes.usage.edit"), "warning");
			return;
		}
		const inlineReplacement = tokenMatch?.[2];
		if (inlineReplacement !== undefined) {
			const draft = readComposerDraftText(ctx);
			const preSnap = registry.captureUndoSnapshot();
			const res = editDraftQuote(registry, draft, targetNum, inlineReplacement);
			if (!res.found) {
				ctx.ui.notify(t("quotes.notFound", { num: targetNum }), "warning");
				return;
			}
			if (!(res.unchanged && res.draftText === draft)) {
				writeComposerDraftTextWithUndo(ctx, res.draftText, preSnap);
			}
			ctx.ui.notify(
				res.removed
					? t("quotes.removed", { num: targetNum })
					: t("quotes.updated", { num: targetNum }),
				"info",
			);
			return;
		}
		const items = listActiveDraftQuotes(registry, readComposerDraftText(ctx));
		if (!items.some((it) => it.number === targetNum)) {
			ctx.ui.notify(t("quotes.notFound", { num: targetNum }), "warning");
			return;
		}
		await showQuotesManagerModal(ctx, { initialEditQuoteNumber: targetNum });
		return;
	}

	const directQuoteNum = sub !== "" && rest === "" ? parseQuoteTargetNumber(sub) : undefined;
	if (sub !== "" && sub !== "list" && sub !== "preview" && directQuoteNum === undefined) {
		ctx.ui.notify(t("quotes.usage.quotes"), "warning");
		return;
	}

	if (ctx.mode === "tui" && ctx.hasUI && sub !== "list") {
		await showQuotesManagerModal(
			ctx,
			directQuoteNum !== undefined ? { initialSelectQuoteNumber: directQuoteNum } : undefined,
		);
		return;
	}

	const items = listActiveDraftQuotes(registry, readComposerDraftText(ctx));
	if (items.length === 0) {
		ctx.ui.notify(t("quotes.noneInDraft"), "info");
		return;
	}
	const summary = items
		.map((item) => `${item.token} · ${(item.entry.text.split("\n")[0] ?? "").trim().slice(0, 48)}`)
		.join("\n");
	ctx.ui.notify(summary, "info");
}
