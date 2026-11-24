import { describe, expect, it } from "vitest";
import {
	classifyTextPaste,
	findPromptChipSpans,
	PromptChipRegistry,
} from "../src/features/prompt-chips/registry.ts";

describe("Prompt Chip pure registry & paste threshold seams", () => {
	it("classifies <=3 lines and <=300 chars as inline text while converting >=4 lines or >300 chars into paste chips and numbering draft chips monotonically until empty", () => {
		expect(classifyTextPaste("short line")).toEqual({
			shouldCreateChip: false,
			normalizedText: "short line",
			lineCount: 1,
			charCount: 10,
		});

		const exact300 = "x".repeat(300);
		expect(classifyTextPaste(exact300)).toEqual({
			shouldCreateChip: false,
			normalizedText: exact300,
			lineCount: 1,
			charCount: 300,
		});

		const threeLines = "alpha\r\nbeta\tindented\r\ngamma";
		expect(classifyTextPaste(threeLines)).toEqual({
			shouldCreateChip: false,
			normalizedText: "alpha\nbeta\tindented\ngamma",
			lineCount: 3,
			charCount: 25,
		});

		const char301 = "y".repeat(301);
		expect(classifyTextPaste(char301)).toEqual({
			shouldCreateChip: true,
			normalizedText: char301,
			lineCount: 1,
			charCount: 301,
		});

		const fourLines = "line 1\r\nline 2\r\nline 3\r\nline 4";
		expect(classifyTextPaste(fourLines)).toEqual({
			shouldCreateChip: true,
			normalizedText: "line 1\nline 2\nline 3\nline 4",
			lineCount: 4,
			charCount: 27,
		});

		const registry = new PromptChipRegistry();
		const img = registry.registerImage({
			filePath: "/tmp/pi-clipboard-1.png",
			fileName: "pi-clipboard-1.png",
			mimeType: "image/png",
			byteLength: 1024,
			base64Data: "iVBORw0KGgo=",
			widthPx: 640,
			heightPx: 480,
		});
		expect(img.token).toBe("[🖼 Image #1]");

		const pasteLines = registry.registerPaste("a\nb\nc\nd\ne");
		expect(pasteLines.token).toBe("[📋 Pasted #2 · 5 lines]");

		const pasteLongSingle = registry.registerPaste("z".repeat(305));
		expect(pasteLongSingle.token).toBe("[📋 Pasted #3 · 305 chars]");

		const quote = registry.registerQuote("first line\nsecond line");
		expect(quote.token).toBe("[❝ Quote #4 · 2 lines]");

		const draft = `${img.token} ${pasteLines.token} ${pasteLongSingle.token} ${quote.token}`;
		expect(findPromptChipSpans(draft).map((s) => ({ kind: s.kind, number: s.number, token: s.token }))).toEqual([
			{ kind: "image", number: 1, token: "[🖼 Image #1]" },
			{ kind: "paste", number: 2, token: "[📋 Pasted #2 · 5 lines]" },
			{ kind: "paste", number: 3, token: "[📋 Pasted #3 · 305 chars]" },
			{ kind: "quote", number: 4, token: "[❝ Quote #4 · 2 lines]" },
		]);

		registry.syncDraft("");
		const nextImg = registry.registerImage({
			filePath: "/tmp/pi-clipboard-2.png",
			fileName: "pi-clipboard-2.png",
			mimeType: "image/png",
			byteLength: 512,
			base64Data: "iVBORw0KGgo=",
		});
		expect(nextImg.token).toBe("[🖼 Image #1]");
	});

	it("prunes deleted chips, renumbers remaining chips contiguously with cursor adjustment across 2-digit shifts, preserves duplicate tokens until the last copy is removed, and re-links restored tokens on undo without swapping attachments", () => {
		const registry = new PromptChipRegistry();
		const created = [];
		for (let i = 1; i <= 10; i++) {
			created.push(
				registry.registerImage({
					filePath: `/tmp/shot-${i}.png`,
					fileName: `shot-${i}.png`,
					mimeType: "image/png",
					byteLength: 100 * i,
					base64Data: `data-${i}`,
				}),
			);
		}
		expect(created[0]!.token).toBe("[🖼 Image #1]");
		expect(created[9]!.token).toBe("[🖼 Image #10]");

		/* Если токен продублирован в черновике, удаление одной копии не сбрасывает привязку и не перенумеровывает остальные */
		const withDup = registry.syncDraft("[🖼 Image #1] [🖼 Image #1] [🖼 Image #2]");
		expect(withDup).toBe("[🖼 Image #1] [🖼 Image #1] [🖼 Image #2]");
		expect(registry.resolveChip("image", 1)?.id).toBe(created[0]!.entry.id);
		expect(registry.resolveChip("image", 2)?.id).toBe(created[1]!.entry.id);

		const oneCopyLeft = registry.syncDraft("[🖼 Image #1] [🖼 Image #2]");
		expect(oneCopyLeft).toBe("[🖼 Image #1] [🖼 Image #2]");

		/* Восстановим полный список #1..#10, снимем undo-слепок перед удалением #1 и проверим сдвиг #10 -> #9 и курсора */
		const fullTenRegistry = new PromptChipRegistry();
		const tenChips = Array.from({ length: 10 }, (_, idx) =>
			fullTenRegistry.registerImage({
				filePath: `/tmp/img-${idx + 1}.png`,
				fileName: `img-${idx + 1}.png`,
				mimeType: "image/png",
				byteLength: 256,
				base64Data: `b64-${idx + 1}`,
			}),
		);
		const snapBeforeDelete = fullTenRegistry.captureUndoSnapshot();

		/* Представим, что #10 стоит перед удалённым #1: "[🖼 Image #10] tail" и курсор в конце строки */
		const otherTokens = tenChips.slice(1, 9).map((c) => c.token).join(" ");
		const linesAfterDeleting1 = [otherTokens, "[🖼 Image #10] tail"];
		const cursorBeforeSync = linesAfterDeleting1[1]!.length;
		const synced = fullTenRegistry.syncDraftLines(linesAfterDeleting1, 1, cursorBeforeSync);

		expect(synced.changed).toBe(true);
		expect(synced.lines[1]).toBe("[🖼 Image #9] tail");
		expect(synced.cursorCol).toBe(cursorBeforeSync - 1);
		expect(fullTenRegistry.resolveChip("image", 1)?.id).toBe(tenChips[1]!.entry.id);
		expect(fullTenRegistry.resolveChip("image", 9)?.id).toBe(tenChips[9]!.entry.id);
		expect(fullTenRegistry.resolveChip("image", 10)).toBeUndefined();

		/* Следующий вставленный чип получает #10 */
		const eleventh = fullTenRegistry.registerPaste("1\n2\n3\n4");
		expect(eleventh.token).toBe("[📋 Pasted #10 · 4 lines]");

		/* Undo возвращает старую карту привязок: #1 снова указывает на img-1, #2 на img-2, #10 на img-10 */
		fullTenRegistry.restoreUndoSnapshot(snapBeforeDelete);
		const restoredLine = tenChips.map((c) => c.token).join(" ");
		expect(fullTenRegistry.syncDraft(restoredLine)).toBe(restoredLine);
		expect(fullTenRegistry.resolveChip("image", 1)?.id).toBe(tenChips[0]!.entry.id);
		expect(fullTenRegistry.resolveChip("image", 2)?.id).toBe(tenChips[1]!.entry.id);
		expect(fullTenRegistry.resolveChip("image", 10)?.id).toBe(tenChips[9]!.entry.id);

		/* Даже если текст чипа был вырезан и вставлен обратно без undo-слепка, кэш сессии перепривязывает его */
		fullTenRegistry.syncDraft("plain text only");
		expect(fullTenRegistry.resolveChip("image", 1)).toBeUndefined();
		const relinked = fullTenRegistry.syncDraft("plain text [🖼 Image #1]");
		expect(relinked).toBe("plain text [🖼 Image #1]");
		expect(fullTenRegistry.resolveChip("image", 1)?.id).toBe(tenChips[0]!.entry.id);
	});

	it("expands image, paste, and quote chips on submit (even after submitValue clears draft first), persists/restores steer+followUp records, and reconstructs fallback [Image #N: path] markers", () => {
		const registry = new PromptChipRegistry();
		const img = registry.registerImage({
			filePath: "/tmp/diagram.png",
			fileName: "diagram.png",
			mimeType: "image/png",
			byteLength: 2048,
			base64Data: "AAAABBBB",
			widthPx: 800,
			heightPx: 600,
		});
		const paste = registry.registerPaste("const a = 1;\n\tconst b = 2;\nconst c = 3;\nreturn a + b + c;");
		const quote = registry.registerQuote("First quoted line\nSecond quoted line");

		const rawDraft = `Inspect ${img.token} with:\n${paste.token}\nand context ${quote.token} please`;

		/* Имитируем порядок Editor.submitValue(): сначала onChange("") очищает черновик, затем вызывается input-хук */
		registry.stageDraftBeforeClear(rawDraft);
		registry.syncDraft("");

		const expanded = registry.expandDraftForSubmit(rawDraft);
		expect(expanded.transformed).toBe(true);
		expect(expanded.images).toEqual([
			{
				type: "image",
				data: "AAAABBBB",
				mimeType: "image/png",
			},
		]);
		expect(expanded.text).toBe(
			[
				"Inspect [Image #1: /tmp/diagram.png] with:",
				"const a = 1;\n\tconst b = 2;\nconst c = 3;\nreturn a + b + c;",
				"and context",
				"",
				"> First quoted line",
				"> Second quoted line",
				"",
				"please",
			].join("\n"),
		);

		/* Привязка timestamp на message_start и извлечение записи для appendEntry на message_end */
		const ts = 1713530040000;
		registry.bindSubmittedMessageTimestamp(expanded.text, ts);
		const persistPayload = registry.consumePersistPayload(expanded.text, ts);
		expect(persistPayload).toBeDefined();
		expect(persistPayload?.timestamp).toBe(ts);
		expect(persistPayload?.displayText).toBe(rawDraft);
		expect(persistPayload?.chips).toHaveLength(3);

		/* Реконструкция работает и для UserMessageComponent (expandedText), и для StickyPromptBar (+ \n\n[изображение]), и после /reload */
		const reloadedRegistry = new PromptChipRegistry();
		reloadedRegistry.restorePersistedEntries([
			{ type: "custom", customType: "conarti-prompt-chips", data: persistPayload },
		]);

		const fromTranscript = reloadedRegistry.reconstructSubmittedPrompt(expanded.text, ts);
		expect(fromTranscript.displayText).toBe(rawDraft);
		expect(fromTranscript.chips.map((c) => c.token)).toEqual([
			"[🖼 Image #1]",
			"[📋 Pasted #2 · 4 lines]",
			"[❝ Quote #3 · 2 lines]",
		]);

		const fromStickyWithImageSuffix = reloadedRegistry.reconstructSubmittedPrompt(
			`${expanded.text}\n\n[изображение]`,
			ts,
		);
		expect(fromStickyWithImageSuffix.displayText).toBe(rawDraft);

		/* Fallback для старых сессий без custom entry: [Image #1: /var/tmp/old.webp] превращается в компактную пилюлю */
		const fallback = reloadedRegistry.reconstructSubmittedPrompt(
			"Legacy [Image #1: /var/tmp/old-screen.webp] check\n\n[изображение]",
			undefined,
		);
		expect(fallback.displayText).toBe("Legacy [🖼 Image #1] check");
		expect(fallback.chips).toEqual([
			{
				id: "fallback-image-1",
				kind: "image",
				number: 1,
				token: "[🖼 Image #1]",
				filePath: "/var/tmp/old-screen.webp",
				fileName: "old-screen.webp",
				mimeType: "image/webp",
				byteLength: 0,
			},
		]);
	});

	it("handles empty inputs, image-only submissions, orphan/unknown tokens, and simultaneous steer + followUp queues cleanly", () => {
		expect(classifyTextPaste("")).toEqual({
			shouldCreateChip: false,
			normalizedText: "",
			lineCount: 0,
			charCount: 0,
		});
		expect(findPromptChipSpans("")).toEqual([]);
		expect(findPromptChipSpans("plain text without brackets")).toEqual([]);

		const registry = new PromptChipRegistry();
		/* Непривязанный токен в произвольном тексте не ломает expandDraftForSubmit */
		const untouched = registry.expandDraftForSubmit("Literal [🖼 Image #99] text");
		expect(untouched.transformed).toBe(false);
		expect(untouched.text).toBe("Literal [🖼 Image #99] text");

		/* Промпт только из одного изображения оставляет непустой маркер пути для монтирования UserMessageComponent */
		const imgOnly = registry.registerImage({
			filePath: "/tmp/solo.png",
			fileName: "solo.png",
			mimeType: "image/png",
			byteLength: 71,
			base64Data: "SOLO_B64",
		});
		const soloSubmit = registry.expandDraftForSubmit(imgOnly.token);
		expect(soloSubmit.transformed).toBe(true);
		expect(soloSubmit.text).toBe("[Image #1: /tmp/solo.png]");
		expect(soloSubmit.images).toEqual([{ type: "image", data: "SOLO_B64", mimeType: "image/png" }]);

		/* Одновременная очередь steer + followUp сохраняет независимые записи */
		const steerChip = registry.registerPaste("s1\ns2\ns3\ns4");
		const steerExpanded = registry.expandDraftForSubmit(`Steer: ${steerChip.token}`);

		const followChip = registry.registerPaste("f1\nf2\nf3\nf4\nf5");
		const followExpanded = registry.expandDraftForSubmit(`Follow: ${followChip.token}`);

		registry.bindSubmittedMessageTimestamp(steerExpanded.text, 1001);
		registry.bindSubmittedMessageTimestamp(followExpanded.text, 1002);

		const pSteer = registry.consumePersistPayload(steerExpanded.text, 1001);
		const pFollow = registry.consumePersistPayload(followExpanded.text, 1002);
		expect(pSteer?.displayText).toBe("Steer: [📋 Pasted #1 · 4 lines]");
		expect(pFollow?.displayText).toBe("Follow: [📋 Pasted #1 · 5 lines]");
		expect(registry.reconstructSubmittedPrompt(steerExpanded.text, 1001).displayText).toBe(
			"Steer: [📋 Pasted #1 · 4 lines]",
		);
		expect(registry.reconstructSubmittedPrompt(followExpanded.text, 1002).displayText).toBe(
			"Follow: [📋 Pasted #1 · 5 lines]",
		);
	});

	it("expands the latest chip after clearing a prior draft, keeps renumbered #2->#1 attachment across cut/yank or history browse, and disambiguates identical expanded prompts on /reload via messageId and ISO entry timestamps", () => {
		const registry = new PromptChipRegistry();

		/* 1. Удалённый черновик с [🖼 Image #1] не должен подменять новый [🖼 Image #1] при отправке */
		const abandonedImg = registry.registerImage({
			filePath: "/tmp/wrong-shot.png",
			fileName: "wrong-shot.png",
			mimeType: "image/png",
			byteLength: 100,
			base64Data: "WRONG_B64",
		});
		registry.stageDraftBeforeClear(abandonedImg.token);
		registry.syncDraft("");

		const freshImg = registry.registerImage({
			filePath: "/tmp/right-shot.png",
			fileName: "right-shot.png",
			mimeType: "image/png",
			byteLength: 200,
			base64Data: "RIGHT_B64",
		});
		expect(freshImg.token).toBe("[🖼 Image #1]");
		registry.stageDraftBeforeClear(freshImg.token);
		registry.syncDraft("");

		const submittedFresh = registry.expandDraftForSubmit(freshImg.token);
		expect(submittedFresh.text).toBe("[Image #1: /tmp/right-shot.png]");
		expect(submittedFresh.images).toEqual([
			{ type: "image", data: "RIGHT_B64", mimeType: "image/png" },
		]);

		/* 2. После удаления #1 перенумерованный #2 -> #1 сохраняет свою привязку при вырезании/вставке или просмотре истории */
		const yankRegistry = new PromptChipRegistry();
		yankRegistry.registerImage({
			filePath: "/tmp/deleted-first.png",
			fileName: "deleted-first.png",
			mimeType: "image/png",
			byteLength: 111,
			base64Data: "FIRST_B64",
		});
		const secondImg = yankRegistry.registerImage({
			filePath: "/tmp/kept-second.png",
			fileName: "kept-second.png",
			mimeType: "image/png",
			byteLength: 222,
			base64Data: "SECOND_B64",
		});
		expect(yankRegistry.syncDraft(secondImg.token)).toBe("[🖼 Image #1]");
		expect(yankRegistry.resolveChip("image", 1)?.id).toBe(secondImg.entry.id);

		/* Пользователь листает историю (черновик временно без чипов) и возвращается к "[🖼 Image #1]" */
		yankRegistry.syncDraft("previous plain prompt");
		yankRegistry.syncDraft("[🖼 Image #1]");
		expect(yankRegistry.resolveChip("image", 1)?.id).toBe(secondImg.entry.id);

		/* 3. Два хода с одинаковым путём файла имеют разный размер/разрешение и ISO timestamp записи SessionMessageEntry */
		const turn1Img = yankRegistry.registerImage({
			filePath: "/tmp/mockup.png",
			fileName: "mockup.png",
			mimeType: "image/png",
			byteLength: 1024,
			base64Data: "V1",
			widthPx: 320,
			heightPx: 240,
		});
		yankRegistry.syncDraft(turn1Img.token);
		const exp1 = yankRegistry.expandDraftForSubmit(`Inspect ${turn1Img.token}`);
		yankRegistry.bindSubmittedMessageTimestamp(exp1.text, 1715340300000);
		const persisted1 = yankRegistry.consumePersistPayload(exp1.text, 1715340300000)!;

		const turn2Img = yankRegistry.registerImage({
			filePath: "/tmp/mockup.png",
			fileName: "mockup.png",
			mimeType: "image/png",
			byteLength: 8192,
			base64Data: "V2",
			widthPx: 1280,
			heightPx: 720,
		});
		const exp2 = yankRegistry.expandDraftForSubmit(`Inspect ${turn2Img.token}`);
		yankRegistry.bindSubmittedMessageTimestamp(exp2.text, 1715340360000);
		const persisted2 = yankRegistry.consumePersistPayload(exp2.text, 1715340360000)!;

		const sessionFileEntries = [
			{
				type: "custom",
				id: "c1",
				parentId: null,
				timestamp: "2026-05-10T11:25:00.500Z",
				customType: "conarti-prompt-chips",
				data: persisted1,
			},
			{
				type: "message",
				id: "m1",
				parentId: "c1",
				timestamp: "2026-05-10T11:25:00.501Z",
				message: {
					role: "user",
					timestamp: 1715340300000,
					content: [{ type: "text", text: exp1.text }],
				},
			},
			{
				type: "custom",
				id: "c2",
				parentId: "m1",
				timestamp: "2026-05-10T11:26:00.500Z",
				customType: "conarti-prompt-chips",
				data: persisted2,
			},
			{
				type: "message",
				id: "m2",
				parentId: "c2",
				timestamp: "2026-05-10T11:26:00.501Z",
				message: {
					role: "user",
					timestamp: 1715340360000,
					content: [{ type: "text", text: exp2.text }],
				},
			},
		];

		const reloaded = new PromptChipRegistry();
		reloaded.restorePersistedEntries(sessionFileEntries);

		const rec1ByIso = reloaded.reconstructSubmittedPrompt(
			exp1.text,
			"2026-05-10T11:25:00.501Z",
			"m1",
		);
		const rec2ByIso = reloaded.reconstructSubmittedPrompt(
			exp2.text,
			"2026-05-10T11:26:00.501Z",
			"m2",
		);
		expect(rec1ByIso.chips[0]).toMatchObject({ byteLength: 1024, widthPx: 320, heightPx: 240 });
		expect(rec2ByIso.chips[0]).toMatchObject({ byteLength: 8192, widthPx: 1280, heightPx: 720 });

		/* Даже без messageId (только по ISO timestamp записи из renderSessionEntries) оба хода различаются */
		const rec1IsoOnly = reloaded.reconstructSubmittedPrompt(exp1.text, "2026-05-10T11:25:00.501Z");
		expect(rec1IsoOnly.chips[0]).toMatchObject({ byteLength: 1024, widthPx: 320, heightPx: 240 });
	});
});
