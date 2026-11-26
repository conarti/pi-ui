import { describe, expect, it } from "vitest";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import {
	getThemeSurfacePalette,
	paintThemeSurfaceRow,
	themeFgRgb,
} from "../src/shared/ansi.ts";
import {
	extractCleanSelectionText,
	type SelectedTranscriptLine,
} from "../src/shared/selection-copy.ts";
import { renderUserPromptCardLines } from "../src/features/transcript/user-prompt.ts";
import { loadPackageThemes } from "./harness/index.ts";

function makeFullLineSelection(
	fullLines: readonly string[],
	contentWidth = 60,
): SelectedTranscriptLine[] {
	return fullLines.map((fullLine) => {
		const w = visibleWidth(fullLine);
		return {
			fullLine,
			selectedAnsi: sliceByColumn(fullLine, 0, w, true),
			startCol: 0,
			endCol: w,
			contentWidth,
		};
	});
}

describe("Clean selection text extractor (pure seam over real package themes)", () => {
	it("preserves inline code backticks, unwraps soft wraps, preserves paragraph breaks and code-block newlines, and skips collapsed chrome rows", async () => {
		const { dark, light } = await loadPackageThemes();

		for (const theme of [dark, light]) {
			const palette = getThemeSurfacePalette(theme);
			const contentWidth = 56;
			const pad = "    ";
			const codeCardW = contentWidth - 8;

			const codeHeader =
				pad +
				paintThemeSurfaceRow(
					theme,
					`  ${themeFgRgb(theme, palette.codeMetaFg, "ts")}                                      ${themeFgRgb(theme, palette.codeActionMutedFg, "Copy  ")}`,
					codeCardW,
					palette.codeHeaderBg,
				);
			const codeLine1 =
				pad +
				paintThemeSurfaceRow(theme, "  const total = count + 1;", codeCardW, palette.codeBodyBg);
			const codeLine2 =
				pad +
				paintThemeSurfaceRow(theme, "    return total;", codeCardW, palette.codeBodyBg);

			const lines = [
				`${pad}✦ › Thought for 4s`,
				`${pad}✦ Inspect repo state (200ms) · bash 1 · read 6`,
				`${pad}Run ${theme.fg("mdCode", "npm run check")} after updating the config`,
				`${pad}file so every invariant stays green.`,
				"",
				`${pad}Second paragraph keeps ${theme.fg("mdCode", "copyOnSelect")} clean.`,
				"",
				codeHeader,
				codeLine1,
				codeLine2,
				"",
				`${pad}Worked for 4.2s                                10:15`,
			];

			const extracted = extractCleanSelectionText(
				makeFullLineSelection(lines, contentWidth),
				{ theme },
			);

			expect(extracted).toBe(
				[
					"Run `npm run check` after updating the config file so every invariant stays green.",
					"",
					"Second paragraph keeps `copyOnSelect` clean.",
					"",
					"const total = count + 1;",
					"  return total;",
				].join("\n"),
			);
		}
	});

	it("preserves explicit short line breaks while stripping frame borders and User Prompt chrome", async () => {
		const { dark } = await loadPackageThemes();
		const contentWidth = 80;
		const lines = [
			"    First short line A",
			"    Second short line B",
		];

		expect(
			extractCleanSelectionText(makeFullLineSelection(lines, contentWidth), { theme: dark }),
		).toBe("First short line A\nSecond short line B");

		const quotedLines = [
			"    │ Quoted prose that wraps smoothly onto the",
			"    │ next line inside a blockquote.",
		];
		expect(
			extractCleanSelectionText(makeFullLineSelection(quotedLines, 52), { theme: dark }),
		).toBe("Quoted prose that wraps smoothly onto the next line inside a blockquote.");
	});

	it("copies a wrapped User Prompt without its chevron or timestamp in either package theme", async () => {
		const { dark, light } = await loadPackageThemes();
		for (const theme of [dark, light]) {
			const text = "This is a fairly long prompt asking the agent for help with a repeated build failure.";
			const { lines } = renderUserPromptCardLines(text, 70, theme, {
				surface: "transcript",
				showCopyBadge: true,
				formattedTime: "25 Nov, 10:15",
			});
			expect(lines).toHaveLength(4);
			expect(extractCleanSelectionText(makeFullLineSelection(lines, 70), { theme })).toBe(text);
		}
	});

	it("keeps single-line selection of a chrome row intact when selected on its own", async () => {
		const { dark } = await loadPackageThemes();
		const single = makeFullLineSelection(["    ✦ › Thought for 4s"], 80);
		expect(extractCleanSelectionText(single, { theme: dark })).toBe("✦ › Thought for 4s");
	});
});
