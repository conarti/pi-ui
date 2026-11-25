import { ExtensionRunner, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKittyProtocolActive, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { hookMethod } from "./runtime-hooks.ts";

const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;
const MOD_SUPER = 8;
const LOCK_MASK = 64 | 128;
const SHORTCUT_MODIFIER_MASK = MOD_ALT | MOD_CTRL | MOD_SUPER;

export interface KeyboardLayoutNormalizeOptions {
	enabledOptionChords?: ReadonlySet<string> | (() => ReadonlySet<string>);
}

export interface KeyboardLayoutNormalizer {
	normalize(data: string): string;
	reset(): void;
}

const CYRILLIC_TO_QWERTY_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["й", "q"],
	["ц", "w"],
	["у", "e"],
	["к", "r"],
	["е", "t"],
	["н", "y"],
	["г", "u"],
	["ш", "i"],
	["щ", "o"],
	["з", "p"],
	["х", "["],
	["ъ", "]"],
	["ф", "a"],
	["ы", "s"],
	["в", "d"],
	["а", "f"],
	["п", "g"],
	["р", "h"],
	["о", "j"],
	["л", "k"],
	["д", "l"],
	["ж", ";"],
	["э", "'"],
	["я", "z"],
	["ч", "x"],
	["с", "c"],
	["м", "v"],
	["и", "b"],
	["т", "n"],
	["ь", "m"],
	["б", ","],
	["ю", "."],
	["ё", "`"],
];

/**
 * Таблица композиций клавиши Option в macOS (US/ABC и однозначные нерусские символы
 * русской раскладки Apple, которые не встречаются при обычном вводе текста).
 */
const MACOS_OPTION_TO_QWERTY: ReadonlyArray<readonly [string, string, boolean?]> = [
	["å", "a"],
	["∫", "b"],
	["ç", "c"],
	["∂", "d"],
	["´", "e"],
	["ƒ", "f"],
	["©", "g"],
	["˙", "h"],
	["ˆ", "i"],
	["∆", "j"],
	["˚", "k"],
	["¬", "l"],
	["µ", "m"],
	["˜", "n"],
	["ø", "o"],
	["π", "p"],
	["œ", "q"],
	["®", "r"],
	["ß", "s"],
	["†", "t"],
	["¨", "u"],
	["√", "v"],
	["∑", "w"],
	["≈", "x"],
	["¥", "y"],
	["Ω", "z"],
	["ј", "q"],
	["Ј", "q", true],
	["џ", "w"],
	["Џ", "w", true],
	["ђ", "z"],
	["Ђ", "z", true],
	["ћ", "d"],
	["Ћ", "d", true],
	["ѕ", "i"],
	["Ѕ", "i", true],
	["љ", "k"],
	["Љ", "k", true],
	["њ", "y"],
	["Њ", "y", true],
	["ѓ", "u"],
	["Ѓ", "u", true],
	["і", "b"],
	["І", "b", true],
	["ќ", "r"],
	["Ќ", "r", true],
	["ў", "o"],
	["Ў", "o", true],
	["„", "o", true],
	["‘", "p"],
	["’", "p", true],
	["Œ", "q", true],
	["Â", "m", true],
	["◊", "v", true],
	["∏", "p", true],
	["Ø", "o", true],
];

const CYRILLIC_CODEPOINT_MAP = new Map<number, { latinCodepoint: number; uppercase: boolean }>();
for (const [cyr, lat] of CYRILLIC_TO_QWERTY_PAIRS) {
	const latinCodepoint = lat.charCodeAt(0);
	CYRILLIC_CODEPOINT_MAP.set(cyr.charCodeAt(0), { latinCodepoint, uppercase: false });
	CYRILLIC_CODEPOINT_MAP.set(cyr.toUpperCase().charCodeAt(0), { latinCodepoint, uppercase: true });
}

interface OptionChordEntry {
	readonly latinCodepoint: number;
	readonly shift: boolean;
	readonly chordId: string;
}

const OPTION_CODEPOINT_MAP = new Map<number, OptionChordEntry>();
for (const [composed, lat, shift] of MACOS_OPTION_TO_QWERTY) {
	const cp = composed.codePointAt(0);
	if (cp === undefined) continue;
	const isShift = Boolean(shift);
	OPTION_CODEPOINT_MAP.set(cp, {
		latinCodepoint: lat.charCodeAt(0),
		shift: isShift,
		chordId: isShift ? `shift+alt+${lat}` : `alt+${lat}`,
	});
}

const LEGACY_READLINE_ALT_LETTERS = new Set(["b", "f", "p", "n"]);
const KITTY_CSI_U_RE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~$/;
const CSI_PREFIX_RE = /^\x1b\[[0-9;:?<>]*[@-~]/;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function isCtrlLetterControlCodepoint(codepoint: number): boolean {
	return (
		codepoint >= 0x01 &&
		codepoint <= 0x1a &&
		codepoint !== 0x08 &&
		codepoint !== 0x09 &&
		codepoint !== 0x0a &&
		codepoint !== 0x0d
	);
}

function isAsciiLetterCodepoint(codepoint: number): boolean {
	return (codepoint >= 65 && codepoint <= 90) || (codepoint >= 97 && codepoint <= 122);
}

function normalizeAsciiBaseCodepoint(codepoint: number): number | undefined {
	if (codepoint >= 65 && codepoint <= 90) {
		return codepoint + 32;
	}
	if (codepoint >= 32 && codepoint <= 126) {
		return codepoint;
	}
	return undefined;
}

function resolveEnabledChordSet(options?: KeyboardLayoutNormalizeOptions): ReadonlySet<string> | undefined {
	const source = options?.enabledOptionChords;
	if (!source) return undefined;
	return typeof source === "function" ? source() : source;
}

function isChordEnabled(chordId: string, options?: KeyboardLayoutNormalizeOptions): boolean {
	const set = resolveEnabledChordSet(options);
	return set ? set.has(chordId) : true;
}

function isChordExplicitlyEnabled(chordId: string, options?: KeyboardLayoutNormalizeOptions): boolean {
	const set = resolveEnabledChordSet(options);
	return Boolean(set?.has(chordId));
}

function normalizeNonEscapeText(text: string, options?: KeyboardLayoutNormalizeOptions): string {
	if (!text) return text;
	const cp = text.codePointAt(0);
	if (cp !== undefined && cp > 127 && text.length === (cp > 0xffff ? 2 : 1)) {
		const optEntry = OPTION_CODEPOINT_MAP.get(cp);
		if (optEntry && isChordEnabled(optEntry.chordId, options)) {
			const modValue = (MOD_ALT | (optEntry.shift ? MOD_SHIFT : 0)) + 1;
			return `\x1b[${optEntry.latinCodepoint};${modValue}u`;
		}
	}
	return text;
}

function normalizeSingleEscapeSequence(data: string, options?: KeyboardLayoutNormalizeOptions): string {
	if (!data || data.charCodeAt(0) !== 0x1b) return data;

	const secondCp = data.codePointAt(1);
	if (secondCp !== undefined && data.length === 1 + (secondCp > 0xffff ? 2 : 1)) {
		const mapped = CYRILLIC_CODEPOINT_MAP.get(secondCp);
		if (mapped) {
			const modValue = (MOD_ALT | (mapped.uppercase ? MOD_SHIFT : 0)) + 1;
			return `\x1b[${mapped.latinCodepoint};${modValue}u`;
		}
		if (secondCp > 127) {
			const optEntry = OPTION_CODEPOINT_MAP.get(secondCp);
			if (optEntry && isChordEnabled(optEntry.chordId, options)) {
				const modValue = (MOD_ALT | (optEntry.shift ? MOD_SHIFT : 0)) + 1;
				return `\x1b[${optEntry.latinCodepoint};${modValue}u`;
			}
			return data;
		}
		/* При активном Kitty-протоколе хост отключает разбор legacy ESC+<ascii> и ESC+<ctrl> */
		if (isKittyProtocolActive()) {
			if (isCtrlLetterControlCodepoint(secondCp)) {
				const latinCp = secondCp + 96;
				const chordId = `ctrl+alt+${String.fromCharCode(latinCp)}`;
				if (isChordEnabled(chordId, options)) {
					return `\x1b[${latinCp};7u`;
				}
			}
			if (secondCp >= 0x61 && secondCp <= 0x7a) {
				const ch = String.fromCharCode(secondCp);
				const chordId = `alt+${ch}`;
				const allowed = LEGACY_READLINE_ALT_LETTERS.has(ch)
					? isChordExplicitlyEnabled(chordId, options)
					: isChordEnabled(chordId, options);
				if (allowed) {
					return `\x1b[${secondCp};3u`;
				}
			}
			if (secondCp >= 0x41 && secondCp <= 0x5a && secondCp !== 0x4f && secondCp !== 0x50) {
				const lowerCp = secondCp + 32;
				const chordId = `shift+alt+${String.fromCharCode(lowerCp)}`;
				if (isChordEnabled(chordId, options)) {
					return `\x1b[${lowerCp};4u`;
				}
			}
		}
		return data;
	}

	const mokMatch = MODIFY_OTHER_KEYS_RE.exec(data);
	if (mokMatch) {
		const modValue = Number.parseInt(mokMatch[1]!, 10);
		const codepoint = Number.parseInt(mokMatch[2]!, 10);
		const rawModifier = modValue - 1;
		/* matchesPrintableModifyOtherKeys в pi-tui не сбрасывает биты CapsLock/NumLock */
		const modifier = rawModifier & ~LOCK_MASK;
		const cleanModValue = modifier + 1;

		if ((modifier & SHORTCUT_MODIFIER_MASK) !== 0) {
			if (codepoint > 127) {
				const optEntry = OPTION_CODEPOINT_MAP.get(codepoint);
				if (optEntry) {
					const nextMod = (modifier | MOD_ALT | (optEntry.shift ? MOD_SHIFT : 0)) + 1;
					return `\x1b[27;${nextMod};${optEntry.latinCodepoint}~`;
				}
				const mapped = CYRILLIC_CODEPOINT_MAP.get(codepoint);
				if (mapped) {
					return `\x1b[27;${cleanModValue};${mapped.latinCodepoint}~`;
				}
			} else if ((modifier & MOD_CTRL) !== 0 && isCtrlLetterControlCodepoint(codepoint)) {
				return `\x1b[27;${cleanModValue};${codepoint + 96}~`;
			} else if (rawModifier !== modifier) {
				return `\x1b[27;${cleanModValue};${codepoint}~`;
			}
		} else if (modifier === 0 || modifier === MOD_SHIFT) {
			const optEntry = OPTION_CODEPOINT_MAP.get(codepoint);
			if (optEntry && isChordEnabled(optEntry.chordId, options)) {
				const nextMod = (modifier | MOD_ALT | (optEntry.shift ? MOD_SHIFT : 0)) + 1;
				return `\x1b[27;${nextMod};${optEntry.latinCodepoint}~`;
			}
		}
		return data;
	}

	const csiMatch = KITTY_CSI_U_RE.exec(data);
	if (!csiMatch) {
		return data;
	}

	const codepoint = Number.parseInt(csiMatch[1]!, 10);
	const baseLayoutKey = csiMatch[3] ? Number.parseInt(csiMatch[3], 10) : undefined;
	const asciiBase = baseLayoutKey !== undefined ? normalizeAsciiBaseCodepoint(baseLayoutKey) : undefined;
	const modValue = csiMatch[4] ? Number.parseInt(csiMatch[4], 10) : 1;
	const modifier = modValue - 1;
	const eventSuffix = csiMatch[5] ? `:${csiMatch[5]}` : "";

	if ((modifier & SHORTCUT_MODIFIER_MASK) === 0) {
		const effectiveMod = modifier & ~LOCK_MASK;
		if ((effectiveMod === 0 || effectiveMod === MOD_SHIFT) && codepoint > 127) {
			const optEntry = OPTION_CODEPOINT_MAP.get(codepoint);
			if (optEntry && !CYRILLIC_CODEPOINT_MAP.has(codepoint)) {
				const targetCp =
					asciiBase !== undefined && asciiBase >= 97 && asciiBase <= 122
						? asciiBase
						: optEntry.latinCodepoint;
				const isShift = effectiveMod === MOD_SHIFT || optEntry.shift;
				const lat = String.fromCharCode(targetCp);
				const chordId = isShift ? `shift+alt+${lat}` : `alt+${lat}`;
				if (isChordEnabled(chordId, options)) {
					const nextMod = (modifier | MOD_ALT | (isShift ? MOD_SHIFT : 0)) + 1;
					return `\x1b[${targetCp};${nextMod}${eventSuffix}u`;
				}
			}
		}
		return data;
	}

	if (asciiBase !== undefined) {
		if (codepoint > 127) {
			const optEntry = !CYRILLIC_CODEPOINT_MAP.has(codepoint)
				? OPTION_CODEPOINT_MAP.get(codepoint)
				: undefined;
			if (optEntry && (modifier & MOD_ALT) === 0) {
				const nextMod = (modifier | MOD_ALT | (optEntry.shift ? MOD_SHIFT : 0)) + 1;
				return `\x1b[${asciiBase};${nextMod}${eventSuffix}u`;
			}
			return `\x1b[${asciiBase};${modValue}${eventSuffix}u`;
		}
		if (!isAsciiLetterCodepoint(codepoint) && asciiBase >= 97 && asciiBase <= 122) {
			if ((modifier & MOD_CTRL) !== 0 && (modifier & MOD_ALT) === 0 && codepoint !== asciiBase - 96) {
				const nextMod = (modifier | MOD_ALT) + 1;
				return `\x1b[${asciiBase};${nextMod}${eventSuffix}u`;
			}
			return `\x1b[${asciiBase};${modValue}${eventSuffix}u`;
		}
	}

	if (codepoint <= 127) {
		if ((modifier & MOD_CTRL) !== 0 && isCtrlLetterControlCodepoint(codepoint)) {
			return `\x1b[${codepoint + 96};${modValue}${eventSuffix}u`;
		}
		return data;
	}

	const optEntry = OPTION_CODEPOINT_MAP.get(codepoint);
	if (optEntry) {
		const nextMod = (modifier | MOD_ALT | (optEntry.shift ? MOD_SHIFT : 0)) + 1;
		return `\x1b[${optEntry.latinCodepoint};${nextMod}${eventSuffix}u`;
	}

	const mapped = CYRILLIC_CODEPOINT_MAP.get(codepoint);
	if (mapped) {
		return `\x1b[${mapped.latinCodepoint};${modValue}${eventSuffix}u`;
	}

	return data;
}

function normalizeOutsidePaste(data: string, options?: KeyboardLayoutNormalizeOptions): string {
	if (!data) return data;
	const firstEsc = data.indexOf("\x1b");
	if (firstEsc === -1) {
		return normalizeNonEscapeText(data, options);
	}
	if (firstEsc === 0 && data.indexOf("\x1b", 1) === -1) {
		const csiMatch = CSI_PREFIX_RE.exec(data);
		if (csiMatch && csiMatch[0].length < data.length) {
			return (
				normalizeSingleEscapeSequence(csiMatch[0], options) +
				normalizeNonEscapeText(data.slice(csiMatch[0].length), options)
			);
		}
		return normalizeSingleEscapeSequence(data, options);
	}

	let out = "";
	let pos = 0;
	while (pos < data.length) {
		const escIdx = data.indexOf("\x1b", pos);
		if (escIdx === -1) {
			out += normalizeNonEscapeText(data.slice(pos), options);
			break;
		}
		if (escIdx > pos) {
			out += normalizeNonEscapeText(data.slice(pos, escIdx), options);
			pos = escIdx;
		}
		const rest = data.slice(pos);
		const csiMatch = CSI_PREFIX_RE.exec(rest);
		if (csiMatch) {
			out += normalizeSingleEscapeSequence(csiMatch[0], options);
			pos += csiMatch[0].length;
			continue;
		}
		const secondCp = rest.codePointAt(1);
		if (
			secondCp !== undefined &&
			secondCp !== 0x1b &&
			secondCp !== 0x5b &&
			secondCp !== 0x5d &&
			secondCp !== 0x4f &&
			secondCp !== 0x50 &&
			secondCp !== 0x5f
		) {
			const step = 1 + (secondCp > 0xffff ? 2 : 1);
			out += normalizeSingleEscapeSequence(rest.slice(0, step), options);
			pos += step;
			continue;
		}
		const nextEsc = data.indexOf("\x1b", pos + 1);
		if (nextEsc === -1) {
			out += rest;
			break;
		}
		out += data.slice(pos, nextEsc);
		pos = nextEsc;
	}
	return out;
}

function nextMarkerPrefixLen(currentLen: number, marker: string, ch: string): number {
	if (ch === marker[currentLen]) {
		return currentLen + 1;
	}
	return ch === marker[0] ? 1 : 0;
}

export function createKeyboardLayoutNormalizer(options?: KeyboardLayoutNormalizeOptions): KeyboardLayoutNormalizer {
	let inBracketedPaste = false;
	let startMatch = 0;
	let endMatch = 0;

	return {
		normalize(data: string): string {
			if (!data) return data;
			if (!inBracketedPaste && startMatch === 0 && !data.includes("\x1b")) {
				return normalizeNonEscapeText(data, options);
			}

			let out = "";
			let segStart = 0;
			for (let i = 0; i < data.length; i++) {
				const ch = data[i]!;
				if (inBracketedPaste) {
					endMatch = nextMarkerPrefixLen(endMatch, BRACKETED_PASTE_END, ch);
					if (endMatch === BRACKETED_PASTE_END.length) {
						out += data.slice(segStart, i + 1);
						inBracketedPaste = false;
						endMatch = 0;
						segStart = i + 1;
					}
				} else {
					startMatch = nextMarkerPrefixLen(startMatch, BRACKETED_PASTE_START, ch);
					if (startMatch === BRACKETED_PASTE_START.length) {
						const markerStart = i + 1 - BRACKETED_PASTE_START.length;
						if (markerStart >= segStart) {
							if (markerStart > segStart) {
								out += normalizeOutsidePaste(data.slice(segStart, markerStart), options);
							}
							out += data.slice(markerStart, i + 1);
						} else {
							out += data.slice(segStart, i + 1);
						}
						inBracketedPaste = true;
						startMatch = 0;
						segStart = i + 1;
					}
				}
			}

			if (segStart < data.length) {
				if (inBracketedPaste) {
					out += data.slice(segStart);
				} else {
					const safeEnd = Math.max(segStart, data.length - startMatch);
					if (safeEnd > segStart) {
						out += normalizeOutsidePaste(data.slice(segStart, safeEnd), options);
					}
					if (safeEnd < data.length) {
						out += data.slice(safeEnd);
					}
				}
			}
			return out;
		},
		reset(): void {
			inBracketedPaste = false;
			startMatch = 0;
			endMatch = 0;
		},
	};
}

export function normalizeKeyboardLayoutInput(data: string, options?: KeyboardLayoutNormalizeOptions): string {
	if (!data) return data;
	if (!data.includes(BRACKETED_PASTE_START)) {
		return normalizeOutsidePaste(data, options);
	}
	return createKeyboardLayoutNormalizer(options).normalize(data);
}

const MODIFIER_ALIASES: Readonly<Record<string, "shift" | "ctrl" | "alt" | "super">> = {
	shift: "shift",
	ctrl: "ctrl",
	control: "ctrl",
	alt: "alt",
	opt: "alt",
	option: "alt",
	meta: "alt",
	super: "super",
	cmd: "super",
	command: "super",
};

const MODIFIER_PREFIXES = Object.keys(MODIFIER_ALIASES).sort((a, b) => b.length - a.length);

export function canonicalizeShortcutChord(keyId: string): string {
	let rest = keyId.trim().toLowerCase();
	if (!rest) return "";
	const modSet = new Set<"shift" | "ctrl" | "alt" | "super">();
	while (true) {
		const matchedPrefix = MODIFIER_PREFIXES.find(
			(prefix) => rest.startsWith(`${prefix}+`) && rest.length > prefix.length + 1,
		);
		if (!matchedPrefix) break;
		modSet.add(MODIFIER_ALIASES[matchedPrefix]!);
		rest = rest.slice(matchedPrefix.length + 1);
	}
	if (!rest) return "";
	const orderedMods: string[] = [];
	for (const mod of ["shift", "ctrl", "alt", "super"] as const) {
		if (modSet.has(mod)) orderedMods.push(mod);
	}
	return orderedMods.length > 0 ? `${orderedMods.join("+")}+${rest}` : rest;
}

export function matchesLayoutChord(data: string, keyId: KeyId | string): boolean {
	if (!data || data.includes(BRACKETED_PASTE_START)) return false;
	const canonical = canonicalizeShortcutChord(String(keyId));
	if (!canonical) return false;
	const normalized = normalizeKeyboardLayoutInput(data, {
		enabledOptionChords: new Set([canonical]),
	});
	if (matchesKey(normalized, canonical as KeyId)) {
		return true;
	}
	if (normalized.length === 2 && normalized.charCodeAt(0) === 0x1b) {
		const second = normalized.charCodeAt(1);
		if (second >= 0x61 && second <= 0x7a) {
			return matchesKey(`\x1b[${second};3u`, canonical as KeyId);
		}
		if (second >= 0x41 && second <= 0x5a) {
			return matchesKey(`\x1b[${second + 32};4u`, canonical as KeyId);
		}
	}
	return false;
}

const EXTRA_OPTION_CHORDS_KEY = Symbol.for("conarti.pi-ui.extra-option-chords.v1");
const RUNNER_OPTION_CHORDS_KEY = Symbol.for("conarti.pi-ui.runner-option-chords.v1");
const WRAPPED_APIS = new WeakSet<object>();

function getExtraOptionChords(): Set<string> {
	const g = globalThis as Record<symbol, Set<string> | undefined>;
	if (!g[EXTRA_OPTION_CHORDS_KEY]) {
		g[EXTRA_OPTION_CHORDS_KEY] = new Set<string>();
	}
	return g[EXTRA_OPTION_CHORDS_KEY]!;
}

function getRunnerOptionChords(): Set<string> {
	const g = globalThis as Record<symbol, Set<string> | undefined>;
	if (!g[RUNNER_OPTION_CHORDS_KEY]) {
		g[RUNNER_OPTION_CHORDS_KEY] = new Set<string>();
	}
	return g[RUNNER_OPTION_CHORDS_KEY]!;
}

/* Отслеживаем шорткаты всех загруженных расширений в ExtensionRunner, так как каждое расширение получает отдельный экземпляр ExtensionAPI */
function installRunnerShortcutObserver(): void {
	const proto = (ExtensionRunner as unknown as { prototype?: object } | undefined)?.prototype;
	if (!proto) return;

	hookMethod(proto, "getShortcuts", "keyboardLayout.observeRunnerShortcuts", (self, args, original) => {
		const map = original.apply(self, args) as Map<string, unknown> | undefined;
		const runnerChords = getRunnerOptionChords();
		runnerChords.clear();
		if (map instanceof Map) {
			for (const key of map.keys()) {
				const canonical = canonicalizeShortcutChord(String(key));
				if (canonical) {
					runnerChords.add(canonical);
				}
			}
		}
		return map;
	});
}

export function registerOptionShortcutChord(keyId: string): () => void {
	const canonical = canonicalizeShortcutChord(keyId);
	const extra = getExtraOptionChords();
	if (canonical) {
		extra.add(canonical);
	}
	return () => {
		if (canonical) {
			extra.delete(canonical);
		}
	};
}

export function installKeyboardLayoutSupport(pi: ExtensionAPI): void {
	installRunnerShortcutObserver();
	if (WRAPPED_APIS.has(pi as unknown as object)) return;
	WRAPPED_APIS.add(pi as unknown as object);

	const registeredShortcuts = new Set<string>();
	const origRegisterShortcut = pi.registerShortcut.bind(pi);
	pi.registerShortcut = ((key, options) => {
		const canonical = canonicalizeShortcutChord(String(key));
		if (canonical) {
			registeredShortcuts.add(canonical);
		}
		return origRegisterShortcut(key, options);
	}) as ExtensionAPI["registerShortcut"];

	const getEnabledChords = (): ReadonlySet<string> => {
		const extra = getExtraOptionChords();
		const runner = getRunnerOptionChords();
		if (extra.size === 0 && runner.size === 0) return registeredShortcuts;
		return new Set([...registeredShortcuts, ...extra, ...runner]);
	};

	const normalizer = createKeyboardLayoutNormalizer({
		enabledOptionChords: getEnabledChords,
	});
	let unsubscribeInput: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		normalizer.reset();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const normalized = normalizer.normalize(data);
			if (normalized !== data) {
				return { data: normalized };
			}
			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		getRunnerOptionChords().clear();
		normalizer.reset();
	});
}
