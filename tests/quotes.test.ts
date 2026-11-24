import { describe, expect, it } from "vitest";
import { PromptChipRegistry } from "../src/features/prompt-chips/registry.ts";
import {
	clearAllDraftQuotes,
	computeSelectionQuotePopupAnchor,
	editDraftQuote,
	extractAssistantQuoteFromBranch,
	listActiveDraftQuotes,
	normalizeQuoteText,
	parseQuoteTargetNumber,
	removeDraftQuote,
} from "../src/features/quotes/quote-model.ts";

describe("Quotes pure domain & geometry seams", () => {
	it("normalizes quote text, extracts nth-last assistant replies from branch history, and formats blank-line-padded Markdown blockquotes cleanly", () => {
		expect(normalizeQuoteText("   \n\t  \r\n ")).toBe("");
		expect(normalizeQuoteText("\n\n  const x = 1;\r\n\r\n  return x;  \n\n")).toBe(
			"  const x = 1;\n\n  return x;  ",
		);

		const branch = [
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: "First question" },
			},
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal reasoning 1" },
						{ type: "text", text: "First assistant answer" },
					],
				},
			},
			{
				type: "message",
				id: "a-tools-only",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				},
			},
			{
				type: "message",
				id: "a2",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal reasoning 2" },
						{ type: "text", text: "Second answer part A" },
						{ type: "text", text: "Second answer part B" },
					],
				},
			},
		];

		expect(extractAssistantQuoteFromBranch([], "")).toEqual({
			ok: false,
			reason: "empty_history",
			totalReplies: 0,
		});

		expect(extractAssistantQuoteFromBranch(branch, "")).toEqual({
			ok: true,
			text: "Second answer part A\n\nSecond answer part B",
			nthFromEnd: 1,
			sourceLabel: "reply -1",
			totalReplies: 2,
		});

		expect(extractAssistantQuoteFromBranch(branch, "last")).toEqual({
			ok: true,
			text: "Second answer part A\n\nSecond answer part B",
			nthFromEnd: 1,
			sourceLabel: "reply -1",
			totalReplies: 2,
		});

		expect(extractAssistantQuoteFromBranch(branch, "2")).toEqual({
			ok: true,
			text: "First assistant answer",
			nthFromEnd: 2,
			sourceLabel: "reply -2",
			totalReplies: 2,
		});

		expect(extractAssistantQuoteFromBranch(branch, "3")).toEqual({
			ok: false,
			reason: "out_of_range",
			totalReplies: 2,
			requested: 3,
		});

		expect(extractAssistantQuoteFromBranch(branch, "0")).toEqual({
			ok: false,
			reason: "invalid_arg",
			totalReplies: 2,
		});

		expect(extractAssistantQuoteFromBranch(branch, "abc")).toEqual({
			ok: false,
			reason: "invalid_arg",
			totalReplies: 2,
		});

		const registry = new PromptChipRegistry();
		const q1 = registry.registerQuote("\nLine alpha\n\nLine omega\n", "selection");
		expect(q1.token).toBe("[❝ Quote #1 · 3 lines]");

		const q2 = registry.registerQuote("Second quote single line", "reply -1");
		expect(q2.token).toBe("[❝ Quote #2 · 1 line]");

		const expanded = registry.expandDraftForSubmit(
			`Header:\n   ${q1.token} ${q2.token}\n   Footer`,
		);
		expect(expanded.transformed).toBe(true);
		expect(expanded.text).toBe(
			[
				"Header:",
				"",
				"> Line alpha",
				">",
				"> Line omega",
				"",
				"> Second quote single line",
				"",
				"   Footer",
			].join("\n"),
		);
	});

	it("inspects, edits, removes, and clears active draft quotes without corrupting undo or non-quote chips, and clamps selection popup anchors within viewport chrome", () => {
		expect(parseQuoteTargetNumber("2")).toBe(2);
		expect(parseQuoteTargetNumber("q3")).toBe(3);
		expect(parseQuoteTargetNumber("Q1")).toBe(1);
		expect(parseQuoteTargetNumber("#4")).toBe(4);
		expect(parseQuoteTargetNumber("0")).toBeUndefined();
		expect(parseQuoteTargetNumber("bad")).toBeUndefined();

		const registry = new PromptChipRegistry();
		const img = registry.registerImage({
			filePath: "/tmp/screen.png",
			fileName: "screen.png",
			mimeType: "image/png",
			byteLength: 512,
			base64Data: "IMG_B64",
		});
		const q1 = registry.registerQuote("old line 1\nold line 2", "selection");
		const paste = registry.registerPaste("p1\np2\np3\np4");
		const q2 = registry.registerQuote("second quote", "reply -1");

		let draft = `Compare ${img.token} with ${q1.token} and ${paste.token} plus ${q2.token} end`;

		const active = listActiveDraftQuotes(registry, draft);
		expect(active.map((q) => ({ number: q.number, token: q.token, text: q.entry.text, sourceLabel: q.entry.sourceLabel }))).toEqual([
			{
				number: 2,
				token: "[❝ Quote #2 · 2 lines]",
				text: "old line 1\nold line 2",
				sourceLabel: "selection",
			},
			{
				number: 4,
				token: "[❝ Quote #4 · 1 line]",
				text: "second quote",
				sourceLabel: "reply -1",
			},
		]);

		const undoSnapBeforeEdit = registry.captureUndoSnapshot();
		const draftBeforeEdit = draft;

		const edited = editDraftQuote(registry, draft, 2, "updated A\nupdated B\nupdated C\nupdated D");
		expect(edited.found).toBe(true);
		expect(edited.removed).toBe(false);
		draft = edited.draftText;
		expect(draft).toBe(
			"Compare [🖼 Image #1] with [❝ Quote #2 · 4 lines] and [📋 Pasted #3 · 4 lines] plus [❝ Quote #4 · 1 line] end",
		);
		expect(registry.resolveChip("quote", 2)).toMatchObject({
			kind: "quote",
			text: "updated A\nupdated B\nupdated C\nupdated D",
			lineCount: 4,
			sourceLabel: "selection",
		});

		/* Undo после редактирования цитаты восстанавливает прежний текст цитаты в реестре */
		registry.restoreUndoSnapshot(undoSnapBeforeEdit);
		expect(registry.syncDraft(draftBeforeEdit)).toBe(draftBeforeEdit);
		expect(registry.resolveChip("quote", 2)).toMatchObject({
			kind: "quote",
			text: "old line 1\nold line 2",
			lineCount: 2,
		});

		/* Повторно применим правку, затем очистим цитату #2 пустой строкой -> она удалится, а чипы #3,#4 перенумеруются в #2,#3 */
		draft = editDraftQuote(registry, draftBeforeEdit, 2, "single edited line").draftText;
		expect(draft).toBe(
			"Compare [🖼 Image #1] with [❝ Quote #2 · 1 line] and [📋 Pasted #3 · 4 lines] plus [❝ Quote #4 · 1 line] end",
		);

		const emptied = editDraftQuote(registry, draft, 2, "   \n  ");
		expect(emptied.found).toBe(true);
		expect(emptied.removed).toBe(true);
		draft = emptied.draftText;
		expect(draft).toBe(
			"Compare [🖼 Image #1] with and [📋 Pasted #2 · 4 lines] plus [❝ Quote #3 · 1 line] end",
		);

		/* Добавим ещё одну цитату и проверим removeDraftQuote + clearAllDraftQuotes */
		const qExtra = registry.registerQuote("extra line 1\nextra line 2");
		draft = `${draft} ${qExtra.token}`;
		expect(listActiveDraftQuotes(registry, draft).map((q) => q.number)).toEqual([3, 4]);

		const afterRemoveOne = removeDraftQuote(registry, draft, 3);
		expect(afterRemoveOne.removed).toBe(true);
		expect(afterRemoveOne.draftText).toBe(
			"Compare [🖼 Image #1] with and [📋 Pasted #2 · 4 lines] plus end [❝ Quote #3 · 2 lines]",
		);

		const afterClearAll = clearAllDraftQuotes(registry, afterRemoveOne.draftText);
		expect(afterClearAll.removedCount).toBe(1);
		expect(afterClearAll.draftText).toBe(
			"Compare [🖼 Image #1] with and [📋 Pasted #2 · 4 lines] plus end",
		);
		expect(listActiveDraftQuotes(registry, afterClearAll.draftText)).toEqual([]);

		/* Геометрия позиционирования ╭ ❝ Цитировать ╮ около конца выделения */
		const downMid = computeSelectionQuotePopupAnchor({
			popupWidth: 16,
			popupHeight: 1,
			focusCol: 24,
			focusRow: 8,
			anchorRow: 5,
			anchorCol: 10,
			viewportTop: 0,
			viewportBottom: 22,
			stickyBottom: 3,
			termCols: 100,
			rightReservedCols: 3,
		});
		expect(downMid).toEqual({ col: 16, row: 9 });

		const upNearSticky = computeSelectionQuotePopupAnchor({
			popupWidth: 16,
			popupHeight: 1,
			focusCol: 94,
			focusRow: 3,
			anchorRow: 7,
			anchorCol: 20,
			viewportTop: 0,
			viewportBottom: 22,
			stickyBottom: 3,
			termCols: 100,
			rightReservedCols: 3,
		});
		expect(upNearSticky.row).toBe(4);
		expect(upNearSticky.col + 16).toBeLessThanOrEqual(97);

		const atBottomEdge = computeSelectionQuotePopupAnchor({
			popupWidth: 16,
			popupHeight: 1,
			focusCol: 2,
			focusRow: 21,
			anchorRow: 19,
			anchorCol: 2,
			viewportTop: 0,
			viewportBottom: 22,
			stickyBottom: 0,
			termCols: 80,
			rightReservedCols: 1,
		});
		expect(atBottomEdge).toEqual({ col: 1, row: 20 });
	});

	it("handles unsynced draft token numbers, no-op quote edits, and tab-indented quote reconstruction after card tab expansion", () => {
		const registry = new PromptChipRegistry();
		const q1 = registry.registerQuote("first quote");
		const q2 = registry.registerQuote("second line A\nsecond line B");

		/* Если токен #1 удалён из строки до syncDraft, операции над цитатой #1 должны работать по синхронизированному тексту */
		const unsyncedAfterDeletingFirst = `Prefix ${q2.token} suffix`;
		const listed = listActiveDraftQuotes(registry, unsyncedAfterDeletingFirst);
		expect(listed.map((q) => ({ number: q.number, token: q.token }))).toEqual([
			{ number: 1, token: "[❝ Quote #1 · 2 lines]" },
		]);

		const editedUnsynced = editDraftQuote(
			registry,
			unsyncedAfterDeletingFirst,
			1,
			"replaced line 1\nreplaced line 2",
		);
		expect(editedUnsynced).toMatchObject({
			found: true,
			removed: false,
			draftText: "Prefix [❝ Quote #1 · 2 lines] suffix",
		});
		expect(registry.resolveChip("quote", 1)).toMatchObject({
			text: "replaced line 1\nreplaced line 2",
		});

		/* Сохранение без изменений не пересоздаёт чип в реестре */
		const idBeforeNoop = registry.resolveChip("quote", 1)?.id;
		const noopEdit = editDraftQuote(
			registry,
			editedUnsynced.draftText,
			1,
			"replaced line 1\nreplaced line 2",
		);
		expect(noopEdit.unchanged).toBe(true);
		expect(registry.resolveChip("quote", 1)?.id).toBe(idBeforeNoop);

		/* Удаление из несинхронизированного черновика действительно убирает токен */
		const q3 = registry.registerQuote("third quote");
		const unsyncedForRemove = `Keep ${q3.token}`;
		const removed = removeDraftQuote(registry, unsyncedForRemove, 1);
		expect(removed).toEqual({ removed: true, draftText: "Keep" });

		const q4 = registry.registerQuote("fourth quote");
		const cleared = clearAllDraftQuotes(registry, `Start ${q4.token} end`);
		expect(cleared).toEqual({ removedCount: 1, draftText: "Start end" });

		/* Реконструкция отправленной карточки, когда renderUserPromptCardLines заменил табы на два пробела */
		const tabQuote = registry.registerQuote("\tif err != nil {\n\t\treturn err\n\t}", "selection");
		const submitDraft = `Inspect:\n${tabQuote.token}`;
		const expanded = registry.expandDraftForSubmit(submitDraft);
		expect(expanded.transformed).toBe(true);
		expect(expanded.text).toContain("> \tif err != nil {");

		const cardSanitizedText = expanded.text.replace(/\t/g, "  ");
		registry.bindSubmittedMessageTimestamp(cardSanitizedText, 1715900999000);
		const reconstructed = registry.reconstructSubmittedPrompt(
			cardSanitizedText,
			1715900999000,
		);
		expect(reconstructed.displayText).toBe(submitDraft);
		expect(reconstructed.chips).toHaveLength(1);
		expect(reconstructed.chips[0]).toMatchObject({
			kind: "quote",
			number: 1,
			token: "[❝ Quote #1 · 3 lines]",
		});
	});
});
