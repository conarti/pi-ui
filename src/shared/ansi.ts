import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface HitBox {
	id: string;
	xStart: number;
	xEnd: number;
	y?: number;
	onClick: () => void;
}

export type RgbTuple = readonly [number, number, number];

export type PillVariant = "primary" | "secondary" | "success" | "warning" | "danger" | "neutral";

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const GRAY_LEVELS = Array.from({ length: 24 }, (_, idx) => 8 + idx * 10);
const ANSI_16_PALETTE: readonly RgbTuple[] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

const FORBIDDEN_TURQUOISE_MIN = 165;
const FORBIDDEN_TURQUOISE_MAX = 198;
const FORBIDDEN_PURPLE_MIN = 255;
const FORBIDDEN_PURPLE_MAX = 320;
const SAFE_BLUE_ABOVE_TURQUOISE = 208;
const SAFE_BLUE_BELOW_PURPLE = 235;

function nearestChannelIndex(values: readonly number[], target: number): number {
	let best = 0;
	for (let i = 1; i < values.length; i += 1) {
		if (Math.abs(target - values[i]!) < Math.abs(target - values[best]!)) {
			best = i;
		}
	}
	return best;
}

export function rgbToAnsi256(r: number, g: number, b: number): number {
	const ri = nearestChannelIndex(CUBE_LEVELS, r);
	const gi = nearestChannelIndex(CUBE_LEVELS, g);
	const bi = nearestChannelIndex(CUBE_LEVELS, b);
	const cr = CUBE_LEVELS[ri]!;
	const cg = CUBE_LEVELS[gi]!;
	const cb = CUBE_LEVELS[bi]!;
	const lum = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
	const grayIdx = nearestChannelIndex(GRAY_LEVELS, lum);
	const gray = GRAY_LEVELS[grayIdx]!;
	const dist = (tr: number, tg: number, tb: number) =>
		(r - tr) ** 2 * 0.299 + (g - tg) ** 2 * 0.587 + (b - tb) ** 2 * 0.114;
	const spread = Math.max(r, g, b) - Math.min(r, g, b);
	return spread < 10 && dist(gray, gray, gray) < dist(cr, cg, cb)
		? 232 + grayIdx
		: 16 + 36 * ri + 6 * gi + bi;
}

function ansi256ToRgb(code: number): RgbTuple | undefined {
	if (!Number.isInteger(code) || code < 0 || code > 255) return undefined;
	if (code < 16) return ANSI_16_PALETTE[code];
	if (code >= 232) {
		const gray = GRAY_LEVELS[code - 232] ?? 128;
		return [gray, gray, gray];
	}
	const idx = code - 16;
	const ri = Math.floor(idx / 36);
	const gi = Math.floor((idx % 36) / 6);
	const bi = idx % 6;
	return [CUBE_LEVELS[ri]!, CUBE_LEVELS[gi]!, CUBE_LEVELS[bi]!];
}

/**
 * Извлекает RGB-кортеж из ANSI-последовательности цвета (`38;2`/`48;2` или `38;5`/`48;5`).
 */
export function parseAnsiColorRgb(ansi: string | undefined): RgbTuple | undefined {
	if (!ansi) return undefined;
	const trueColor = /\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/.exec(ansi);
	if (trueColor) {
		return [
			Math.min(255, Math.max(0, Number(trueColor[1]))),
			Math.min(255, Math.max(0, Number(trueColor[2]))),
			Math.min(255, Math.max(0, Number(trueColor[3]))),
		];
	}
	const indexed = /\x1b\[(?:38|48);5;(\d+)m/.exec(ansi);
	if (indexed) {
		return ansi256ToRgb(Number(indexed[1]));
	}
	return undefined;
}

export function rgbHueDegrees(rgb: RgbTuple): {
	readonly hue: number;
	readonly saturation: number;
	readonly lightness: number;
} {
	const r = rgb[0] / 255;
	const g = rgb[1] / 255;
	const b = rgb[2] / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	const lightness = (max + min) / 2;

	if (delta === 0) {
		return { hue: 0, saturation: 0, lightness };
	}

	const saturation = delta / (1 - Math.abs(2 * lightness - 1));
	let rawHue = 0;
	if (max === r) {
		rawHue = ((g - b) / delta) % 6;
	} else if (max === g) {
		rawHue = (b - r) / delta + 2;
	} else {
		rawHue = (r - g) / delta + 4;
	}
	const hue = ((rawHue * 60) + 360) % 360;
	return { hue, saturation, lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number): RgbTuple {
	const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const hPrime = (((hue % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hPrime % 2) - 1));
	let r1 = 0;
	let g1 = 0;
	let b1 = 0;
	if (hPrime >= 0 && hPrime < 1) {
		r1 = c;
		g1 = x;
	} else if (hPrime >= 1 && hPrime < 2) {
		r1 = x;
		g1 = c;
	} else if (hPrime >= 2 && hPrime < 3) {
		g1 = c;
		b1 = x;
	} else if (hPrime >= 3 && hPrime < 4) {
		g1 = x;
		b1 = c;
	} else if (hPrime >= 4 && hPrime < 5) {
		r1 = x;
		b1 = c;
	} else {
		r1 = c;
		b1 = x;
	}
	const m = lightness - c / 2;
	return [
		Math.round(Math.min(255, Math.max(0, (r1 + m) * 255))),
		Math.round(Math.min(255, Math.max(0, (g1 + m) * 255))),
		Math.round(Math.min(255, Math.max(0, (b1 + m) * 255))),
	];
}

/**
 * Удерживает хроматические цвета вне запрещённых фиолетового (`255°-320°`)
 * и бирюзового (`165°-198°`) секторов, переводя их в чистую синюю палитру.
 */
export function clampHueOutsideForbiddenBands(rgb: RgbTuple): RgbTuple {
	const { hue, saturation, lightness } = rgbHueDegrees(rgb);
	if (saturation <= 0.04) {
		return rgb;
	}
	if (hue >= FORBIDDEN_PURPLE_MIN && hue <= FORBIDDEN_PURPLE_MAX) {
		return hslToRgb(SAFE_BLUE_BELOW_PURPLE, saturation, lightness);
	}
	if (hue >= FORBIDDEN_TURQUOISE_MIN && hue <= FORBIDDEN_TURQUOISE_MAX) {
		return hslToRgb(SAFE_BLUE_ABOVE_TURQUOISE, saturation, lightness);
	}
	return rgb;
}

export function getActiveGlobalTheme(fallback?: unknown): Theme {
	const g = (globalThis as Record<PropertyKey, unknown>)[
		Symbol.for("@earendil-works/pi-coding-agent:theme")
	];
	if (g) return g as Theme;
	return fallback as Theme;
}

export function is256ColorTheme(theme?: unknown): boolean {
	const resolved = (theme ?? getActiveGlobalTheme()) as
		| { getColorMode?: () => string }
		| undefined;
	if (typeof resolved?.getColorMode === "function") {
		return resolved.getColorMode() === "256color";
	}
	return process.env.PI_TRUE_COLOR === "0";
}

function openAnsiRgb(set: 38 | 48, r: number, g: number, b: number, theme?: unknown): string {
	const rr = Math.round(r);
	const gg = Math.round(g);
	const bb = Math.round(b);
	return is256ColorTheme(theme)
		? `\x1b[${set};5;${rgbToAnsi256(rr, gg, bb)}m`
		: `\x1b[${set};2;${rr};${gg};${bb}m`;
}

export function fgRgbPrefix(rgb: RgbTuple, theme?: unknown): string {
	return openAnsiRgb(38, rgb[0], rgb[1], rgb[2], theme);
}

export function themeFgRgb(theme: unknown, rgb: RgbTuple, text: string): string {
	return `${openAnsiRgb(38, rgb[0], rgb[1], rgb[2], theme)}${text}\x1b[39m`;
}

export function themeBgRgb(theme: unknown, rgb: RgbTuple, text: string): string {
	return `${openAnsiRgb(48, rgb[0], rgb[1], rgb[2], theme)}${text}\x1b[49m`;
}

export function fgRgb(rgb: RgbTuple, text: string): string;
export function fgRgb(r: number, g: number, b: number, text: string): string;
export function fgRgb(
	rOrRgb: number | RgbTuple,
	gOrText: number | string,
	b?: number,
	text?: string,
): string {
	if (Array.isArray(rOrRgb)) {
		const [r, g, bVal] = rOrRgb;
		return `${openAnsiRgb(38, r, g, bVal)}${gOrText as string}\x1b[39m`;
	}
	return `${openAnsiRgb(38, rOrRgb as number, gOrText as number, b!)}${text!}\x1b[39m`;
}

export function bgRgb(rgb: RgbTuple, text: string): string;
export function bgRgb(r: number, g: number, b: number, text: string): string;
export function bgRgb(
	rOrRgb: number | RgbTuple,
	gOrText: number | string,
	b?: number,
	text?: string,
): string {
	if (Array.isArray(rOrRgb)) {
		const [r, g, bVal] = rOrRgb;
		return `${openAnsiRgb(48, r, g, bVal)}${gOrText as string}\x1b[49m`;
	}
	return `${openAnsiRgb(48, rOrRgb as number, gOrText as number, b!)}${text!}\x1b[49m`;
}

export function isLightTheme(theme: unknown): boolean {
	try {
		const t = theme as
			| { name?: string; appearance?: string; getFgAnsi?: (token: string) => string }
			| undefined;
		if (t?.appearance === "light") return true;
		if (t?.appearance === "dark") return false;
		const name = String(t?.name ?? "").toLowerCase();
		if (name.includes("light") || name.includes("day")) return true;
		const probe = String(t?.getFgAnsi?.("text") ?? "");
		const rgb = parseAnsiColorRgb(probe);
		if (rgb) {
			const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
			return lum < 128;
		}
	} catch {
		/* По умолчанию используется тёмная палитра */
	}
	return false;
}

export function paintThemeSurfaceRow(
	theme: unknown,
	content: string,
	targetWidth: number,
	rgb: RgbTuple,
): string {
	const clipped = truncateToWidth(content, targetWidth, "…");
	const pad = " ".repeat(Math.max(0, targetWidth - visibleWidth(clipped)));
	const bgEsc = openAnsiRgb(48, rgb[0], rgb[1], rgb[2], theme);
	const patched = (clipped + pad)
		.replace(/\x1b\[0m/g, `\x1b[0m${bgEsc}`)
		.replace(/\x1b\[49m/g, bgEsc);
	return `${bgEsc}${patched}\x1b[49m`;
}

export function paintSurfaceRow(
	content: string,
	targetWidth: number,
	r: number,
	g: number,
	b: number,
): string {
	return paintThemeSurfaceRow(undefined, content, targetWidth, [r, g, b]);
}

export interface ThemeSurfacePalette {
	readonly isLight: boolean;
	readonly surfaceBg: RgbTuple;
	readonly popupSurfaceBg: RgbTuple;
	readonly selectedRowBg: RgbTuple;
	readonly hoveredRowBg: RgbTuple;
	readonly noteRowBg: RgbTuple;
	readonly noteEditRowBg: RgbTuple;
	readonly pillNeutralBg: RgbTuple;
	readonly pillNeutralHoverBg: RgbTuple;
	readonly border: RgbTuple;
	readonly accent: RgbTuple;
	readonly accentBright: RgbTuple;
	readonly headingSubtle: RgbTuple;
	readonly selectedText: RgbTuple;
	readonly inputText: RgbTuple;
	readonly noteText: RgbTuple;
	readonly warning: RgbTuple;
	readonly success: RgbTuple;
	readonly danger: RgbTuple;
	readonly info: RgbTuple;
	readonly freeBar: RgbTuple;
	readonly codeHeaderBg: RgbTuple;
	readonly codeHeaderActiveBg: RgbTuple;
	readonly codeBodyBg: RgbTuple;
	readonly codeRailFg: RgbTuple;
	readonly codeMetaFg: RgbTuple;
	readonly codeMetaActiveFg: RgbTuple;
	readonly codeActionMutedFg: RgbTuple;
	readonly badgeHoverBg: RgbTuple;
	readonly badgeCopiedBg: RgbTuple;
}

const DARK_SURFACE_PALETTE: ThemeSurfacePalette = {
	isLight: false,
	surfaceBg: [27, 35, 50],
	popupSurfaceBg: [31, 41, 58],
	selectedRowBg: [39, 52, 74],
	hoveredRowBg: [31, 39, 54],
	noteRowBg: [40, 39, 33],
	noteEditRowBg: [44, 42, 34],
	pillNeutralBg: [36, 43, 56],
	pillNeutralHoverBg: [48, 59, 78],
	border: [97, 175, 239],
	accent: [97, 175, 239],
	accentBright: [125, 207, 255],
	headingSubtle: [122, 162, 247],
	selectedText: [235, 244, 255],
	inputText: [220, 232, 248],
	noteText: [232, 210, 156],
	warning: [229, 192, 123],
	success: [140, 194, 101],
	danger: [224, 108, 117],
	info: [100, 178, 240],
	freeBar: [52, 62, 80],
	codeHeaderBg: [35, 42, 54],
	codeHeaderActiveBg: [42, 52, 68],
	codeBodyBg: [27, 32, 41],
	codeRailFg: [64, 78, 102],
	codeMetaFg: [127, 142, 166],
	codeMetaActiveFg: [145, 165, 194],
	codeActionMutedFg: [108, 124, 148],
	badgeHoverBg: [38, 49, 68],
	badgeCopiedBg: [32, 54, 42],
};

const LIGHT_SURFACE_PALETTE: ThemeSurfacePalette = {
	isLight: true,
	surfaceBg: [237, 243, 252],
	popupSurfaceBg: [243, 247, 253],
	selectedRowBg: [214, 230, 252],
	hoveredRowBg: [232, 240, 251],
	noteRowBg: [252, 244, 224],
	noteEditRowBg: [248, 237, 206],
	pillNeutralBg: [226, 235, 247],
	pillNeutralHoverBg: [207, 224, 246],
	border: [37, 99, 235],
	accent: [29, 78, 216],
	accentBright: [2, 132, 199],
	headingSubtle: [3, 105, 161],
	selectedText: [15, 23, 42],
	inputText: [15, 23, 42],
	noteText: [120, 53, 15],
	warning: [180, 83, 9],
	success: [21, 128, 61],
	danger: [220, 38, 38],
	info: [2, 132, 199],
	freeBar: [203, 213, 225],
	codeHeaderBg: [226, 234, 245],
	codeHeaderActiveBg: [214, 226, 242],
	codeBodyBg: [240, 245, 251],
	codeRailFg: [148, 163, 184],
	codeMetaFg: [71, 85, 105],
	codeMetaActiveFg: [51, 65, 85],
	codeActionMutedFg: [100, 116, 139],
	badgeHoverBg: [219, 231, 246],
	badgeCopiedBg: [220, 242, 228],
};

function mixRgb(base: RgbTuple, accent: RgbTuple, accentWeight: number): [number, number, number] {
	const baseWeight = 1 - accentWeight;
	return [
		Math.round(base[0] * baseWeight + accent[0] * accentWeight),
		Math.round(base[1] * baseWeight + accent[1] * accentWeight),
		Math.round(base[2] * baseWeight + accent[2] * accentWeight),
	];
}

function rgbLuminance([r, g, b]: RgbTuple): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

function readThemeBgToken(theme: unknown, token: string): RgbTuple | undefined {
	try {
		const t = theme as { getBgAnsi?: (name: string) => string } | undefined;
		if (typeof t?.getBgAnsi !== "function") return undefined;
		return parseAnsiColorRgb(t.getBgAnsi(token));
	} catch {
		return undefined;
	}
}

/**
 * Вычисляет приподнятый фон `popupSurfaceBg` для `Modal Card` и `Hover Popup`
 * из elevated-токенов темы (`userMessageBg` / `selectedBg`), никогда не опираясь на утопленные
 * `toolPendingBg` / `codeBodyBg`, и удерживая оттенок вне фиолетового и бирюзового диапазонов.
 */
export function computePopupSurfaceBg(theme: unknown): RgbTuple {
	const light = isLightTheme(theme);
	const cardBg = readThemeBgToken(theme, "userMessageBg");
	const selectedBg = readThemeBgToken(theme, "selectedBg");

	let candidate: RgbTuple;
	if (light) {
		const base = cardBg ?? selectedBg ?? LIGHT_SURFACE_PALETTE.surfaceBg;
		candidate = mixRgb(base, [255, 255, 255], 0.35);
	} else if (cardBg && selectedBg) {
		candidate =
			rgbLuminance(selectedBg) >= rgbLuminance(cardBg)
				? mixRgb(cardBg, selectedBg, 0.45)
				: mixRgb(cardBg, [255, 255, 255], 0.06);
	} else if (selectedBg) {
		candidate = selectedBg;
	} else if (cardBg) {
		candidate = mixRgb(cardBg, [255, 255, 255], 0.05);
	} else {
		candidate = DARK_SURFACE_PALETTE.popupSurfaceBg;
	}

	return clampHueOutsideForbiddenBands(candidate);
}

export function getThemeSurfacePalette(theme: unknown): ThemeSurfacePalette {
	const base = isLightTheme(theme) ? LIGHT_SURFACE_PALETTE : DARK_SURFACE_PALETTE;
	const popupSurfaceBg = computePopupSurfaceBg(theme);
	if (
		popupSurfaceBg[0] === base.popupSurfaceBg[0] &&
		popupSurfaceBg[1] === base.popupSurfaceBg[1] &&
		popupSurfaceBg[2] === base.popupSurfaceBg[2]
	) {
		return base;
	}
	return {
		...base,
		popupSurfaceBg,
	};
}

function resolvePillAccent(palette: ThemeSurfacePalette, variant?: PillVariant, rgb?: RgbTuple): RgbTuple {
	if (rgb) return rgb;
	switch (variant) {
		case "primary":
			return palette.accent;
		case "secondary":
			return palette.info;
		case "success":
			return palette.success;
		case "warning":
			return palette.warning;
		case "danger":
			return palette.danger;
		case "neutral":
		default:
			return palette.accent;
	}
}

export function renderPill(
	text: string,
	opts: {
		hovered?: boolean;
		active?: boolean;
		variant?: PillVariant;
		rgb?: RgbTuple;
		theme: Theme;
	},
): string {
	const palette = getThemeSurfacePalette(opts.theme);
	const isNeutral = opts.variant === "neutral" || (!opts.variant && !opts.rgb && !opts.active);
	const accent = resolvePillAccent(palette, opts.variant, opts.rgb);

	if (palette.isLight) {
		if (opts.hovered) {
			const bg = isNeutral ? palette.pillNeutralHoverBg : mixRgb([244, 248, 254], accent, 0.28);
			return themeBgRgb(opts.theme, bg, themeFgRgb(opts.theme, [15, 23, 42], ` ${text} `));
		}
		if (opts.active) {
			const bg = mixRgb([246, 249, 254], accent, 0.16);
			const fg = mixRgb([15, 23, 42], accent, 0.72);
			return themeBgRgb(opts.theme, bg, themeFgRgb(opts.theme, fg, ` ${text} `));
		}
		const bg = palette.pillNeutralBg;
		return themeBgRgb(opts.theme, bg, opts.theme.fg("muted", ` ${text} `));
	}

	const [r, g, b] = accent;
	if (opts.hovered) {
		const bg = isNeutral
			? palette.pillNeutralHoverBg
			: ([Math.round(r * 0.34), Math.round(g * 0.34), Math.round(b * 0.38)] as const);
		return themeBgRgb(opts.theme, bg, themeFgRgb(opts.theme, [235, 244, 255], ` ${text} `));
	}
	if (opts.active) {
		return themeBgRgb(
			opts.theme,
			[Math.round(r * 0.2), Math.round(g * 0.22), Math.round(b * 0.26)],
			themeFgRgb(opts.theme, [r, g, b], ` ${text} `),
		);
	}
	const bg = palette.pillNeutralBg;
	return themeBgRgb(opts.theme, bg, opts.theme.fg("muted", ` ${text} `));
}

export function renderCardFrame(
	title: string,
	rightHint: string,
	bodyLines: string[],
	footerLine: string | undefined,
	width: number,
	theme: Theme,
	borderRgb: [number, number, number] = [97, 175, 239],
): string[] {
	const safeWidth = Math.max(20, width);
	const innerWidth = Math.max(1, safeWidth - 4);
	const bColor = (s: string) => themeFgRgb(theme, borderRgb, s);
	const dimBorder = (s: string) => theme.fg("borderMuted", s);

	const leftTitle = ` ${title} `;
	const rightPart = rightHint ? ` ${rightHint} ` : "";
	const fillTop = Math.max(0, safeWidth - 2 - visibleWidth(leftTitle) - visibleWidth(rightPart));
	const top = truncateToWidth(
		`${bColor("╭─")}${leftTitle}${bColor("─".repeat(Math.max(0, fillTop - 1)))}${rightPart}${bColor("╮")}`,
		safeWidth,
		"",
	);

	const out: string[] = [top];
	for (const raw of bodyLines) {
		const clipped = truncateToWidth(raw, innerWidth, "…");
		const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		out.push(`${bColor("│")} ${clipped}${pad} ${bColor("│")}`);
	}

	if (footerLine !== undefined) {
		out.push(`${bColor("├")}${dimBorder("─".repeat(Math.max(0, safeWidth - 2)))}${bColor("┤")}`);
		const clippedFoot = truncateToWidth(footerLine, innerWidth, "…");
		const padFoot = " ".repeat(Math.max(0, innerWidth - visibleWidth(clippedFoot)));
		out.push(`${bColor("│")} ${clippedFoot}${padFoot} ${bColor("│")}`);
	}

	out.push(`${bColor("╰")}${bColor("─".repeat(Math.max(0, safeWidth - 2)))}${bColor("╯")}`);
	return out;
}

export function formatCompactTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}
