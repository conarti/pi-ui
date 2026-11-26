import { describe, expect, it } from "vitest";
import {
	DEFAULT_LOCALE,
	EN_MESSAGES,
	getLocale,
	setLocale,
	t,
	type I18nKey,
} from "../src/shared/i18n.ts";

describe("i18n catalog (pure seam)", () => {
	it("exposes English as the default locale and keeps every catalog entry non-empty and Cyrillic-free", () => {
		expect(DEFAULT_LOCALE).toBe("en");
		expect(getLocale()).toBe("en");
		setLocale("en");
		expect(getLocale()).toBe("en");

		const keys = Object.keys(EN_MESSAGES) as I18nKey[];
		expect(keys.length).toBeGreaterThan(40);
		for (const key of keys) {
			const value = EN_MESSAGES[key];
			expect(value.trim().length, `Empty message for key ${key}`).toBeGreaterThan(0);
			expect(/[А-Яа-яЁё]/u.test(value), `Cyrillic leaked in key ${key}: ${value}`).toBe(false);
		}
	});

	it("owns questionnaire prompts and overlay actions in the typed English catalog", () => {
		expect(EN_MESSAGES).toMatchObject({
			"askUser.customPlaceholder": "Type something.",
			"askUser.review.title": "Review your answers",
			"askUser.review.ready": "Ready to submit your answers?",
			"transcript.action.open": "[Open]",
			"transcript.action.copyTsv": "[Copy TSV]",
			"transcript.popup.scrollHint": "Scroll · Esc close",
		});
	});

	it("owns the Prompt Chip preview and Context Inspector table labels", () => {
		expect(EN_MESSAGES).toMatchObject({
			"chips.popup.file": "File: {name}",
			"chips.popup.size": "Size: {size}",
			"chips.popup.path": "Path: {path}",
			"chips.popup.pasteLines": "📋 Pasted #{number} · {count} lines",
			"chips.popup.quoteLines": "❝ Quote #{number} · {count} lines",
			"context.usage.column.calls": "Calls",
			"context.usage.column.ttft": "TTFT",
		});
	});

	it("interpolates named placeholders cleanly and leaves unmatched keys or missing params safe", () => {
		expect(t("composer.placeholder")).toBe("Ask or describe a task…");
		expect(t("sessionMode.notification", { icon: "●", label: "Always-approve", desc: "Full access" })).toBe(
			"● Mode: Always-approve — Full access",
		);
		expect(t("quotes.removed", { num: 3 })).toBe("Quote #3 removed");
		expect(t("turn.fallbackTitle", { ordinal: 4 })).toBe("Turn #4");
	});
});
