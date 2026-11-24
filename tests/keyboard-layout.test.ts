import {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	createKeyboardLayoutNormalizer,
	matchesLayoutChord,
	normalizeKeyboardLayoutInput,
} from "../src/shared/keyboard-layout.ts";

const initialKittyProtocol = isKittyProtocolActive();

describe("keyboard-layout normalizer", () => {
	afterEach(() => {
		setKittyProtocolActive(initialKittyProtocol);
	});

	it("normalizes modified Cyrillic Kitty CSI-u sequences with and without baseLayoutKey while preserving event types", () => {
		const altM = normalizeKeyboardLayoutInput("\x1b[1100;3u");
		expect(matchesKey(altM, "alt+m")).toBe(true);
		expect(parseKey(altM)).toBe("alt+m");

		const ctrlAltP = normalizeKeyboardLayoutInput("\x1b[1079;7u");
		expect(matchesKey(ctrlAltP, "ctrl+alt+p")).toBe(true);
		expect(parseKey(ctrlAltP)).toBe("ctrl+alt+p");

		const ctrlAltO = normalizeKeyboardLayoutInput("\x1b[1097;7u");
		expect(matchesKey(ctrlAltO, "ctrl+alt+o")).toBe(true);
		expect(parseKey(ctrlAltO)).toBe("ctrl+alt+o");

		const superV = normalizeKeyboardLayoutInput("\x1b[1084;9u");
		expect(matchesKey(superV, "super+v")).toBe(true);
		expect(parseKey(superV)).toBe("super+v");

		const altQ = normalizeKeyboardLayoutInput("\x1b[1081;3u");
		expect(matchesKey(altQ, "alt+q")).toBe(true);
		expect(parseKey(altQ)).toBe("alt+q");

		const shiftAltM = normalizeKeyboardLayoutInput("\x1b[1068;4u");
		expect(matchesKey(shiftAltM, "shift+alt+m")).toBe(true);
		expect(parseKey(shiftAltM)).toBe("shift+alt+m");

		const repeatAltQ = normalizeKeyboardLayoutInput("\x1b[1081;3:2u");
		expect(matchesKey(repeatAltQ, "alt+q")).toBe(true);
		expect(isKeyRepeat(repeatAltQ)).toBe(true);
		expect(isKeyRelease(repeatAltQ)).toBe(false);

		const releaseAltQ = normalizeKeyboardLayoutInput("\x1b[1081;3:3u");
		expect(matchesKey(releaseAltQ, "alt+q")).toBe(true);
		expect(isKeyRelease(releaseAltQ)).toBe(true);

		/* Если терминал передал явный :baseLayoutKey (например фонетическая раскладка), он приоритетнее ЙЦУКЕН */
		const phoneticAltM = normalizeKeyboardLayoutInput("\x1b[1084::109;3u");
		expect(matchesKey(phoneticAltM, "alt+m")).toBe(true);
		expect(parseKey(phoneticAltM)).toBe("alt+m");
	});

	it("normalizes modifyOtherKeys and legacy ESC-prefixed Cyrillic sequences across legacy and Kitty protocol states", () => {
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;3;1100~"), "alt+m")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;7;1079~"), "ctrl+alt+p")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;7;1097~"), "ctrl+alt+o")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;9;1084~"), "super+v")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;5;1083~"), "ctrl+k")).toBe(true);

		for (const kittyActive of [false, true]) {
			setKittyProtocolActive(kittyActive);

			const escAltM = normalizeKeyboardLayoutInput("\x1bь");
			expect(matchesKey(escAltM, "alt+m")).toBe(true);
			expect(parseKey(escAltM)).toBe("alt+m");

			const escAltQ = normalizeKeyboardLayoutInput("\x1bй");
			expect(matchesKey(escAltQ, "alt+q")).toBe(true);
			expect(parseKey(escAltQ)).toBe("alt+q");

			const escAltP = normalizeKeyboardLayoutInput("\x1bз");
			expect(matchesKey(escAltP, "alt+p")).toBe(true);
			expect(parseKey(escAltP)).toBe("alt+p");

			const escShiftAltM = normalizeKeyboardLayoutInput("\x1bЬ");
			expect(matchesKey(escShiftAltM, "shift+alt+m")).toBe(true);
			expect(parseKey(escShiftAltM)).toBe("shift+alt+m");
		}
	});

	it("normalizes macOS Option-composed characters and provides reusable chord matching for Alt+<letter> and Super+<letter>", () => {
		expect(matchesKey(normalizeKeyboardLayoutInput("œ"), "alt+q")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("µ"), "alt+m")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("√"), "alt+v")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("ј"), "alt+q")).toBe(true);

		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[339u"), "alt+q")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[181u"), "alt+m")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[8730u"), "alt+v")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;1;181~"), "alt+m")).toBe(true);

		const releaseOptionM = normalizeKeyboardLayoutInput("\x1b[181;1:3u");
		expect(matchesKey(releaseOptionM, "alt+m")).toBe(true);
		expect(isKeyRelease(releaseOptionM)).toBe(true);

		for (const kittyActive of [false, true]) {
			setKittyProtocolActive(kittyActive);
			for (const seq of [
				"\x1bq",
				"\x1bй",
				"\x1b[113;3u",
				"\x1b[1081;3u",
				"\x1b[1081::113;3u",
				"\x1b[27;3;1081~",
				"œ",
				"ј",
				"\x1b[339u",
			]) {
				expect(matchesLayoutChord(seq, "alt+q"), `expected ${JSON.stringify(seq)} to match alt+q`).toBe(true);
				expect(matchesLayoutChord(seq, "alt+m")).toBe(false);
			}
		}

		for (const seq of ["\x1b[118;9u", "\x1b[1084;9u", "\x1b[1084::118;9u", "\x1b[27;9;118~", "\x1b[27;9;1084~"]) {
			expect(matchesLayoutChord(seq, "super+v"), `expected ${JSON.stringify(seq)} to match super+v`).toBe(true);
			expect(matchesLayoutChord(seq, "super+c")).toBe(false);
		}
	});

	it("preserves plain printable text, boundary inputs, unbound Option symbols, and single/multi-chunk bracketed pastes untouched", () => {
		for (const plain of [
			"",
			"п",
			"П",
			"ё",
			"Ё",
			"привет мир",
			"🚀",
			"m",
			"q",
			"hello",
			"\x1b[1087u",
			"\x1b[1087:1055;2u",
			"\x1b[1087;65u",
			"\x1b[999999999;3u",
			"\x1b[<35;10;5M",
		]) {
			expect(normalizeKeyboardLayoutInput(plain)).toBe(plain);
		}
		expect(decodeKittyPrintable(normalizeKeyboardLayoutInput("\x1b[1087u"))).toBe("п");
		expect(decodeKittyPrintable(normalizeKeyboardLayoutInput("\x1b[1087:1055;2u"))).toBe("П");

		const scoped = { enabledOptionChords: new Set(["alt+m", "alt+q"]) };
		expect(matchesKey(normalizeKeyboardLayoutInput("µ", scoped), "alt+m")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("œ", scoped), "alt+q")).toBe(true);
		expect(normalizeKeyboardLayoutInput("π", scoped)).toBe("π");
		expect(normalizeKeyboardLayoutInput("©", scoped)).toBe("©");
		expect(normalizeKeyboardLayoutInput("\x1b[960u", scoped)).toBe("\x1b[960u");

		const pasted = "\x1b[200~µ\x1b[201~";
		expect(normalizeKeyboardLayoutInput(pasted)).toBe(pasted);
		expect(matchesLayoutChord(pasted, "alt+m")).toBe(false);

		const streamNormalizer = createKeyboardLayoutNormalizer();
		expect(streamNormalizer.normalize("\x1b[200~µ")).toBe("\x1b[200~µ");
		expect(streamNormalizer.normalize("œ")).toBe("œ");
		expect(streamNormalizer.normalize("√")).toBe("√");
		expect(streamNormalizer.normalize(" конец\x1b[201~\x1bь")).toBe(" конец\x1b[201~\x1b[109;3u");
		expect(matchesKey(streamNormalizer.normalize("µ"), "alt+m")).toBe(true);
	});
});
