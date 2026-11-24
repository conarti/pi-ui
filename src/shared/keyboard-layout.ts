import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

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
	["џ", "w"],
	["ђ", "z"],
	["ћ", "d"],
	["ѕ", "i"],
	["љ", "k"],
	["њ", "y"],
	["ѓ", "u"],
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

const KITTY_CSI_U_RE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~$/;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function normalizeAsciiBaseCodepoint(codepoint: number): number | undefined {
	if (codepoint >= 65 && codepoint <= 90) {
		return codepoint + 32;
	}
	if (codepoint >= 32 && codepoint <= 126) {
		return codepoint;
	}
	return undefined;
}

function isOptionChordEnabled(entry: OptionChordEntry, options?: KeyboardLayoutNormalizeOptions): boolean {
	const source = options?.enabledOptionChords;
	if (!source) return true;
	const set = typeof source === "function" ? source() : source;
	return set.has(entry.chordId);
}

function normalizeSingleSequence(data: string, options?: KeyboardLayoutNormalizeOptions): string {
	if (!data) return data;

	if (data.charCodeAt(0) !== 0x1b) {
		const cp = data.codePointAt(0);
		if (cp !== undefined && cp > 127 && data.length === (cp > 0xffff ? 2 : 1)) {
			const optEntry = OPTION_CODEPOINT_MAP.get(cp);
			if (optEntry && isOptionChordEnabled(optEntry, options)) {
				const modValue = (MOD_ALT | (optEntry.shift ? MOD_SHIFT : 0)) + 1;
				return `\x1b[${optEntry.latinCodepoint};${modValue}u`;
			}
		}
		return data;
	}

	if (data.length === 2) {
		const mapped = CYRILLIC_CODEPOINT_MAP.get(data.charCodeAt(1));
		if (mapped) {
			const modValue = (MOD_ALT | (mapped.uppercase ? MOD_SHIFT : 0)) + 1;
			return `\x1b[${mapped.latinCodepoint};${modValue}u`;
		}
		return data;
	}

	const mokMatch = MODIFY_OTHER_KEYS_RE.exec(data);
	if (mokMatch) {
		const modValue = Number.parseInt(mokMatch[1]!, 10);
		const codepoint = Number.parseInt(mokMatch[2]!, 10);
		const modifier = modValue - 1;
		if ((modifier & SHORTCUT_MODIFIER_MASK) !== 0 && codepoint > 127) {
			const mapped = CYRILLIC_CODEPOINT_MAP.get(codepoint);
			if (mapped) {
				return `\x1b[27;${modValue};${mapped.latinCodepoint}~`;
			}
		} else if ((modifier & ~LOCK_MASK) === 0 || (modifier & ~LOCK_MASK) === MOD_SHIFT) {
			const optEntry = OPTION_CODEPOINT_MAP.get(codepoint);
			if (optEntry && isOptionChordEnabled(optEntry, options)) {
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
	const modValue = csiMatch[4] ? Number.parseInt(csiMatch[4], 10) : 1;
	const modifier = modValue - 1;
	const eventSuffix = csiMatch[5] ? `:${csiMatch[5]}` : "";

	if ((modifier & SHORTCUT_MODIFIER_MASK) === 0) {
		const effectiveMod = modifier & ~LOCK_MASK;
		if ((effectiveMod === 0 || effectiveMod === MOD_SHIFT) && codepoint > 127) {
			const optEntry = OPTION_CODEPOINT_MAP.get(codepoint);
			if (optEntry && isOptionChordEnabled(optEntry, options)) {
				const nextMod = (modifier | MOD_ALT | (optEntry.shift ? MOD_SHIFT : 0)) + 1;
				return `\x1b[${optEntry.latinCodepoint};${nextMod}${eventSuffix}u`;
			}
		}
		return data;
	}

	if (codepoint <= 127) {
		return data;
	}

	if (baseLayoutKey !== undefined) {
		const asciiBase = normalizeAsciiBaseCodepoint(baseLayoutKey);
		if (asciiBase !== undefined) {
			return `\x1b[${asciiBase};${modValue}${eventSuffix}u`;
		}
	}

	const mapped = CYRILLIC_CODEPOINT_MAP.get(codepoint);
	if (mapped) {
		return `\x1b[${mapped.latinCodepoint};${modValue}${eventSuffix}u`;
	}

	return data;
}

export function createKeyboardLayoutNormalizer(options?: KeyboardLayoutNormalizeOptions): KeyboardLayoutNormalizer {
	let inBracketedPaste = false;

	return {
		normalize(data: string): string {
			if (!data) return data;
			if (!inBracketedPaste && !data.includes(BRACKETED_PASTE_START)) {
				return normalizeSingleSequence(data, options);
			}

			let out = "";
			let cursor = 0;
			while (cursor < data.length) {
				if (inBracketedPaste) {
					const endIdx = data.indexOf(BRACKETED_PASTE_END, cursor);
					if (endIdx === -1) {
						out += data.slice(cursor);
						break;
					}
					const afterEnd = endIdx + BRACKETED_PASTE_END.length;
					out += data.slice(cursor, afterEnd);
					inBracketedPaste = false;
					cursor = afterEnd;
				} else {
					const startIdx = data.indexOf(BRACKETED_PASTE_START, cursor);
					if (startIdx === -1) {
						out += normalizeSingleSequence(data.slice(cursor), options);
						break;
					}
					if (startIdx > cursor) {
						out += normalizeSingleSequence(data.slice(cursor, startIdx), options);
					}
					out += BRACKETED_PASTE_START;
					inBracketedPaste = true;
					cursor = startIdx + BRACKETED_PASTE_START.length;
				}
			}
			return out;
		},
		reset(): void {
			inBracketedPaste = false;
		},
	};
}

export function normalizeKeyboardLayoutInput(data: string, options?: KeyboardLayoutNormalizeOptions): string {
	if (!data) return data;
	if (!data.includes(BRACKETED_PASTE_START)) {
		return normalizeSingleSequence(data, options);
	}
	return createKeyboardLayoutNormalizer(options).normalize(data);
}

export function canonicalizeShortcutChord(keyId: string): string {
	const parts = keyId
		.trim()
		.toLowerCase()
		.split("+")
		.filter(Boolean);
	if (parts.length === 0) return "";
	const key = parts[parts.length - 1]!;
	const modSet = new Set(parts.slice(0, -1));
	const orderedMods: string[] = [];
	for (const mod of ["shift", "ctrl", "alt", "super"]) {
		if (modSet.has(mod)) orderedMods.push(mod);
	}
	return orderedMods.length > 0 ? `${orderedMods.join("+")}+${key}` : key;
}

export function matchesLayoutChord(data: string, keyId: KeyId | string): boolean {
	if (!data || data.includes("\x1b[200~")) return false;
	const canonical = canonicalizeShortcutChord(String(keyId));
	const normalized = normalizeKeyboardLayoutInput(data, {
		enabledOptionChords: new Set([canonical]),
	});
	if (matchesKey(normalized, keyId as KeyId)) {
		return true;
	}
	/* Legacy ESC+<ascii> в терминалах с активным Kitty-протоколом (например через tmux) */
	if (normalized.length === 2 && normalized.charCodeAt(0) === 0x1b) {
		const second = normalized.charCodeAt(1);
		if (second >= 0x61 && second <= 0x7a) {
			return matchesKey(`\x1b[${second};3u`, keyId as KeyId);
		}
		if (second >= 0x41 && second <= 0x5a) {
			return matchesKey(`\x1b[${second + 32};4u`, keyId as KeyId);
		}
	}
	return false;
}

const EXTRA_OPTION_CHORDS_KEY = Symbol.for("conarti.pi-ui.extra-option-chords.v1");
const WRAPPED_APIS = new WeakSet<object>();

function getExtraOptionChords(): Set<string> {
	const g = globalThis as Record<symbol, Set<string> | undefined>;
	if (!g[EXTRA_OPTION_CHORDS_KEY]) {
		g[EXTRA_OPTION_CHORDS_KEY] = new Set<string>();
	}
	return g[EXTRA_OPTION_CHORDS_KEY]!;
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
		if (extra.size === 0) return registeredShortcuts;
		return new Set([...registeredShortcuts, ...extra]);
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
		normalizer.reset();
	});
}
