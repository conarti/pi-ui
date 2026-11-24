import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ThemeJson {
	name?: string;
	appearance?: "dark" | "light";
	vars?: Record<string, string>;
	colors?: Record<string, string>;
}

function parseHexRgb(hex: string): [number, number, number] | undefined {
	const cleaned = hex.trim().replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return undefined;
	return [
		Number.parseInt(cleaned.slice(0, 2), 16),
		Number.parseInt(cleaned.slice(2, 4), 16),
		Number.parseInt(cleaned.slice(4, 6), 16),
	];
}

function resolveTokenHex(token: string, json: ThemeJson): string | undefined {
	const raw = json.colors?.[token];
	if (!raw) return undefined;
	if (raw.startsWith("#")) return raw;
	return json.vars?.[raw];
}

export function createThemeFromFile(themeFilePath: string): Theme {
	const json = JSON.parse(readFileSync(themeFilePath, "utf8")) as ThemeJson;
	const name = json.name ?? "fake-theme";
	const appearance = json.appearance ?? (name.toLowerCase().includes("light") ? "light" : "dark");

	const getFgAnsi = (token: ThemeColor | string): string => {
		const hex = resolveTokenHex(String(token), json);
		const rgb = hex ? parseHexRgb(hex) : undefined;
		if (!rgb) return "\x1b[39m";
		return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	};

	const getBgAnsi = (token: ThemeColor | string): string => {
		const hex = resolveTokenHex(String(token), json);
		const rgb = hex ? parseHexRgb(hex) : undefined;
		if (!rgb) return "\x1b[49m";
		return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	};

	const theme = {
		name,
		appearance,
		fg: (token: ThemeColor, text: string) => `${getFgAnsi(token)}${text}\x1b[39m`,
		bg: (token: ThemeColor, text: string) => `${getBgAnsi(token)}${text}\x1b[49m`,
		getFgAnsi,
		getBgAnsi,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
		dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
		inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
	};

	return theme as unknown as Theme;
}

export function createDarkTheme(): Theme {
	return createThemeFromFile(join(REPO_ROOT, "themes", "midnight-cobalt.json"));
}

export function createLightTheme(): Theme {
	return createThemeFromFile(join(REPO_ROOT, "themes", "one-blue-light.json"));
}
