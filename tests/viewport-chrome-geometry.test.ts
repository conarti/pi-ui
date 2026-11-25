import { describe, expect, it } from "vitest";
import {
	computeOutlineGeometry,
	computeRailViewport,
	wrapPreviewLines,
} from "../src/features/outline-rail/rail-view.ts";
import {
	computeStickyPushOffset,
	computeTranscriptContentWidth,
	cropKittyLineBelowSticky,
	extractActiveBgSgrAtColumn,
	stripInlineImageSequences,
} from "../src/shared/fullscreen-layout.ts";
import { selectStickyTurn, type IndexedTurn } from "../src/shared/turn-index.ts";

function makeIndexedTurn(
	index: number,
	start: number,
	height: number,
	mounted = true,
): IndexedTurn {
	const ordinal = index + 1;
	return {
		id: `u${ordinal}`,
		index,
		ordinal,
		title: `Turn ${ordinal}`,
		prompt: `Turn ${ordinal}`,
		formattedTime: `10:0${ordinal}`,
		start,
		end: start + height,
		height,
		mounted,
	};
}

describe("Viewport chrome pure geometry and push-offset math", () => {
	it("pins Sticky Prompt in auto mode strictly once turn.start < scrollTop and pins only one active Turn", () => {
		const turns = [
			makeIndexedTurn(0, 0, 3),
			makeIndexedTurn(1, 10, 3),
			makeIndexedTurn(2, 22, 3),
		];

		expect(selectStickyTurn(turns, 0, "auto")).toBeUndefined();
		expect(selectStickyTurn(turns, 1, "auto")?.id).toBe("u1");
		expect(selectStickyTurn(turns, 9, "auto")?.id).toBe("u1");
		expect(selectStickyTurn(turns, 10, "auto")?.id).toBe("u1");
		expect(selectStickyTurn(turns, 11, "auto")?.id).toBe("u2");
		expect(selectStickyTurn(turns, 22, "auto")?.id).toBe("u2");
		expect(selectStickyTurn(turns, 23, "auto")?.id).toBe("u3");

		expect(selectStickyTurn(turns, 0, "always")?.id).toBe("u1");
	});

	it("computes row-by-row upward push displacement as the next Turn approaches within Sticky Prompt height", () => {
		expect(computeStickyPushOffset(4, 10, undefined)).toEqual({
			pushOffset: 0,
			visibleHeight: 4,
			distanceToNext: Number.POSITIVE_INFINITY,
		});

		expect(computeStickyPushOffset(4, 10, 15)).toEqual({
			pushOffset: 0,
			visibleHeight: 4,
			distanceToNext: 5,
		});

		expect(computeStickyPushOffset(4, 11, 15)).toEqual({
			pushOffset: 0,
			visibleHeight: 4,
			distanceToNext: 4,
		});

		expect(computeStickyPushOffset(4, 12, 15)).toEqual({
			pushOffset: 1,
			visibleHeight: 3,
			distanceToNext: 3,
		});

		expect(computeStickyPushOffset(4, 13, 15)).toEqual({
			pushOffset: 2,
			visibleHeight: 2,
			distanceToNext: 2,
		});

		expect(computeStickyPushOffset(4, 14, 15)).toEqual({
			pushOffset: 3,
			visibleHeight: 1,
			distanceToNext: 1,
		});

		expect(computeStickyPushOffset(4, 15, 15)).toEqual({
			pushOffset: 4,
			visibleHeight: 0,
			distanceToNext: 0,
		});
	});

	it("preserves full native ScrollView content width whether Outline Rail is visible or hidden, and extracts active background SGR at target columns", () => {
		expect(computeTranscriptContentWidth(120, true, (w) => w)).toBe(120);
		expect(computeTranscriptContentWidth(120, true, (w) => w - 1)).toBe(119);
		expect(computeTranscriptContentWidth(120, false, (w) => w)).toBe(120);
		expect(computeTranscriptContentWidth(120, false, (w) => w - 1)).toBe(119);

		const cardRow = "\x1b[48;2;27;35;50m  \x1b[38;2;220;229;242mPrompt row       \x1b[39m  \x1b[49m";
		expect(extractActiveBgSgrAtColumn(cardRow, 18)).toBe("\x1b[48;2;27;35;50m");
		expect(extractActiveBgSgrAtColumn(cardRow, 25)).toBe("");

		const paletteRow = "\x1b[48;5;236mcode card row\x1b[0m trailing";
		expect(extractActiveBgSgrAtColumn(paletteRow, 6)).toBe("\x1b[48;5;236m");
		expect(extractActiveBgSgrAtColumn(paletteRow, 16)).toBe("");

		const coloredPlainRow =
			"\x1b[38;2;224;175;104mHeading\x1b[39m \x1b[38;2;158;206;106mcode\x1b[39m \x1b[38;5;106mmuted\x1b[39m \x1b[58;2;45;102;107m\x1b[4mlink\x1b[24m\x1b[59m \x1b[38:2::36:41:47mtext\x1b[39m";
		expect(extractActiveBgSgrAtColumn(coloredPlainRow, 6)).toBe("");
		expect(extractActiveBgSgrAtColumn(coloredPlainRow, 11)).toBe("");
		expect(extractActiveBgSgrAtColumn(coloredPlainRow, 17)).toBe("");
		expect(extractActiveBgSgrAtColumn(coloredPlainRow, 22)).toBe("");
		expect(extractActiveBgSgrAtColumn(coloredPlainRow, 30)).toBe("");

		const codeBodyRow =
			"\x1b[48;2;27;32;41m\x1b[38;2;64;78;102m▎\x1b[39m \x1b[38;2;86;211;100m\"value\"\x1b[39m      \x1b[49m";
		expect(extractActiveBgSgrAtColumn(codeBodyRow, 12)).toBe("\x1b[48;2;27;32;41m");
		expect(extractActiveBgSgrAtColumn(codeBodyRow, 20)).toBe("");

		const vp = computeRailViewport(0, 40, 14, [0, 10, 20], 3);
		const normalGeo = computeOutlineGeometry(14, 3, vp, 4);
		expect(normalGeo?.upY).toBe(4);
		const pushedGeo = computeOutlineGeometry(14, 3, vp, 7);
		expect(pushedGeo?.upY).toBeGreaterThanOrEqual(7);
		expect(computeOutlineGeometry(10, 3, vp, 8)).toBeUndefined();
	});

	it("strips Kitty and iTerm2 inline image sequences while preserving surrounding text", () => {
		const kittyLine = "prefix \x1b_Ga=p,i=42,c=80,r=6\x1b\\ suffix";
		expect(stripInlineImageSequences(kittyLine)).toBe("prefix  suffix");

		const itermLine = "left \x1b[3A\x1b]1337;File=inline=1;width=40:AAAA\x07 right";
		expect(stripInlineImageSequences(itermLine)).toBe("left  right");

		const multiRowKitty = "\x1b_Ga=T,f=100,i=12,c=40,y=18,h=90,r=5;AAAA\x1b\\";
		const cropped = cropKittyLineBelowSticky(multiRowKitty, 2, 10);
		expect(cropped).toBe("\x1b_Ga=T,f=100,i=12,c=40,y=54,h=54,r=3;AAAA\x1b\\");
		expect(cropKittyLineBelowSticky(multiRowKitty, 5, 10)).toBeUndefined();
	});

	it("centers Outline Rail ticks and arrows directly inside constant viewport height and wraps multi-line preview text cleanly", () => {
		const vp = computeRailViewport(12, 48, 12, [0, 10, 24], 3, [3, 3, 3]);
		expect(vp.active).toBe(1);
		expect(vp.upTarget).toBe(1);
		expect(vp.downTarget).toBe(2);

		const geo = computeOutlineGeometry(12, 3, vp);
		expect(geo).toBeDefined();
		expect(geo!.upY).toBe(3);
		expect(geo!.ticksY).toBe(4);
		expect(geo!.downY).toBe(7);

		const wrapped = wrapPreviewLines(
			"Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
			20,
		);
		expect(wrapped.length).toBeGreaterThanOrEqual(3);
		expect(wrapped.length).toBeLessThanOrEqual(4);
		expect(wrapped[0]).toBe("Alpha beta gamma");
	});

	it("handles empty, unmounted, negative-height, and windowed 20-turn boundary inputs safely", () => {
		expect(selectStickyTurn([], 5, "auto")).toBeUndefined();
		expect(selectStickyTurn([makeIndexedTurn(0, 0, 3, false)], 10, "always")).toBeUndefined();

		expect(computeStickyPushOffset(0, 5, 6)).toEqual({
			pushOffset: 0,
			visibleHeight: 0,
			distanceToNext: 1,
		});
		expect(computeStickyPushOffset(-4, 5, 6)).toEqual({
			pushOffset: 0,
			visibleHeight: 0,
			distanceToNext: 1,
		});
		expect(computeStickyPushOffset(4, 20, 18)).toEqual({
			pushOffset: 4,
			visibleHeight: 0,
			distanceToNext: -2,
		});

		expect(computeOutlineGeometry(12, 1, { atBottom: true })).toBeUndefined();
		expect(computeOutlineGeometry(2, 5, { atBottom: true })).toBeUndefined();

		const manyVp = computeRailViewport(50, 200, 10, Array.from({ length: 20 }, (_, i) => i * 10), 20);
		const manyGeo = computeOutlineGeometry(8, 20, manyVp);
		expect(manyGeo).toBeDefined();
		expect(manyGeo!.windowEnd - manyGeo!.windowStart).toBe(6);
		expect(manyGeo!.upY).toBe(0);
		expect(manyGeo!.downY).toBe(7);

		expect(wrapPreviewLines("   \n\t  ", 20)).toEqual([]);
	});
});
