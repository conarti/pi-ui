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
	createBracketedPasteTracker,
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

	it("handles mid-escape split bracketed-paste markers, batched escape sequences, Lock-masked modifyOtherKeys, Ctrl+Option compositions, and Kitty-mode legacy ESC parity", () => {
		const splitPaste = createKeyboardLayoutNormalizer();
		const chunk1 = splitPaste.normalize("\x1b[20");
		const chunk2 = splitPaste.normalize("0~µ");
		const chunk3 = splitPaste.normalize("œ\x1b[2");
		const chunk4 = splitPaste.normalize("01~");
		expect(chunk1 + chunk2 + chunk3 + chunk4).toBe("\x1b[200~µœ\x1b[201~");
		expect(matchesKey(splitPaste.normalize("µ"), "alt+m")).toBe(true);

		const byteStream = createKeyboardLayoutNormalizer();
		const fullPaste = "\x1b[200~µœ√\x1b[201~";
		let reassembled = "";
		for (const ch of fullPaste) {
			reassembled += byteStream.normalize(ch);
		}
		expect(reassembled).toBe(fullPaste);
		expect(matchesKey(byteStream.normalize("\x1bь"), "alt+m")).toBe(true);

		const batched = normalizeKeyboardLayoutInput("\x1b[1081;3u\x1b[1081;3:3u");
		expect(batched).toBe("\x1b[113;3u\x1b[113;3:3u");
		expect(normalizeKeyboardLayoutInput("интервал 5µs")).toBe("интервал 5µs");

		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;67;1100~"), "alt+m")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;131;109~"), "alt+m")).toBe(true);

		for (const seq of [
			"\x1b[960;5u",
			"\x1b[960::112;5u",
			"\x1b[960;7u",
			"\x1b[8216;5u",
			"\x1b[8216::112;5u",
			"\x1b[8216;7u",
			"\x1b[27;5;960~",
			"\x1b[27;5;8216~",
			"\x1b[27;7;8216~",
			"\x1b[16;7u",
		]) {
			expect(matchesKey(normalizeKeyboardLayoutInput(seq), "ctrl+alt+p"), `expected ${JSON.stringify(seq)} -> ctrl+alt+p`).toBe(true);
		}

		for (const seq of [
			"\x1b[248;5u",
			"\x1b[248::111;5u",
			"\x1b[248;7u",
			"\x1b[1118;5u",
			"\x1b[1118::111;5u",
			"\x1b[1118;7u",
			"\x1b[39::111;5u",
			"\x1b[39::111;7u",
			"\x1b[27;5;248~",
			"\x1b[27;5;1118~",
			"\x1b[27;7;1118~",
			"\x1b[15;7u",
		]) {
			const norm = normalizeKeyboardLayoutInput(seq);
			expect(matchesKey(norm, "ctrl+alt+o"), `expected ${JSON.stringify(seq)} -> ctrl+alt+o`).toBe(true);
			expect(matchesKey(norm, "ctrl+alt+e")).toBe(false);
		}

		expect(matchesKey(normalizeKeyboardLayoutInput("ј"), "alt+q")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("Ј"), "shift+alt+q")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[1112;3u"), "alt+q")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[27;3;1112~"), "alt+q")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[126::109;3u"), "alt+m")).toBe(true);

		for (const plainAscii of ["~", "'", "\x1b[126u", "\x1b[39u", "\x1b[126::109u", "\x1b[39::111u"]) {
			expect(normalizeKeyboardLayoutInput(plainAscii)).toBe(plainAscii);
		}
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[39;5u"), "ctrl+'")).toBe(true);

		setKittyProtocolActive(true);
		const enabled = { enabledOptionChords: new Set(["alt+m", "alt+q", "ctrl+alt+p", "ctrl+alt+o"]) };
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1bm", enabled), "alt+m")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1bь", enabled), "alt+m")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1bq", enabled), "alt+q")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1bй", enabled), "alt+q")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b\x10", enabled), "ctrl+alt+p")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b\x0f", enabled), "ctrl+alt+o")).toBe(true);
		expect(normalizeKeyboardLayoutInput("\x1bb", enabled)).toBe("\x1bb");
		expect(normalizeKeyboardLayoutInput("\x1bf", enabled)).toBe("\x1bf");
		expect(normalizeKeyboardLayoutInput("\x1b\r", enabled)).toBe("\x1b\r");

		expect(matchesLayoutChord("\x1b[1084;9u", "cmd+v")).toBe(true);
		expect(matchesLayoutChord("œ", "option+q")).toBe(true);
		expect(matchesLayoutChord("\x1b[43;5u", "ctrl++")).toBe(true);
	});

	it("prioritizes CSI-u baseLayoutKey over ambiguous Option symbols and preserves non-QWERTY Latin shortcuts", () => {
		const scoped = { enabledOptionChords: new Set(["alt+m", "alt+q"]) };
		expect(normalizeKeyboardLayoutInput("\x1b[181::118u", scoped)).toBe("\x1b[181::118u");
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[181::118u"), "alt+v")).toBe(true);
		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[181::118;3u"), "alt+v")).toBe(true);

		const ruWinCtrlOptE = normalizeKeyboardLayoutInput("\x1b[1118::101;5u");
		expect(matchesKey(ruWinCtrlOptE, "ctrl+alt+e")).toBe(true);
		expect(matchesKey(ruWinCtrlOptE, "ctrl+alt+o")).toBe(false);

		const phoneticCtrlM = normalizeKeyboardLayoutInput("\x1b[1084::109;5u");
		expect(matchesKey(phoneticCtrlM, "ctrl+m")).toBe(true);
		expect(matchesKey(phoneticCtrlM, "ctrl+alt+m")).toBe(false);

		const qwertzCtrlZ = normalizeKeyboardLayoutInput("\x1b[122::121;5u");
		expect(matchesKey(qwertzCtrlZ, "ctrl+z")).toBe(true);
		expect(matchesKey(qwertzCtrlZ, "ctrl+alt+y")).toBe(false);

		const colemakCtrlAltP = normalizeKeyboardLayoutInput("\x1b[112::114;7u");
		expect(matchesKey(colemakCtrlAltP, "ctrl+alt+p")).toBe(true);

		expect(matchesKey(normalizeKeyboardLayoutInput("\x1b[8222;5u"), "shift+ctrl+alt+o")).toBe(true);
	});

	it("tracks split-chunk and back-to-back bracketed paste boundaries and separates trailing keystrokes", () => {
		const tracker = createBracketedPasteTracker();
		expect(tracker.split("\x1b[20")).toEqual([
			{ text: "\x1b[20", inPaste: false, trailingStartPrefixLength: 4 },
		]);
		expect(tracker.isInPaste).toBe(false);

		expect(tracker.split("0~paste\x0bbody")).toEqual([
			{ text: "0~", inPaste: true, trailingStartPrefixLength: 0 },
			{ text: "paste\x0bbody", inPaste: true, trailingStartPrefixLength: 0 },
		]);
		expect(tracker.isInPaste).toBe(true);

		expect(tracker.split("\x1b[201~\x1b[200~second")).toEqual([
			{ text: "\x1b[201~", inPaste: true, trailingStartPrefixLength: 0 },
			{ text: "\x1b[200~", inPaste: true, trailingStartPrefixLength: 0 },
			{ text: "second", inPaste: true, trailingStartPrefixLength: 0 },
		]);
		expect(tracker.isInPaste).toBe(true);

		expect(tracker.split("\x1b[201~\x0b")).toEqual([
			{ text: "\x1b[201~", inPaste: true, trailingStartPrefixLength: 0 },
			{ text: "\x0b", inPaste: false, trailingStartPrefixLength: 0 },
		]);
		expect(tracker.isInPaste).toBe(false);
	});
});
