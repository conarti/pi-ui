import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface HitBox {
	id: string;
	xStart: number;
	xEnd: number;
	y?: number;
	onClick: () => void;
}

export function fgRgb(r: number, g: number, b: number, text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function bgRgb(r: number, g: number, b: number, text: string): string {
	return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}

export function isLightTheme(theme: unknown): boolean {
	try {
		const t = theme as { name?: string; getFgAnsi?: (token: string) => string } | undefined;
		const name = String(t?.name ?? "").toLowerCase();
		if (name.includes("light") || name.includes("day")) return true;
		const probe = String(t?.getFgAnsi?.("text") ?? "");
		const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(probe);
		if (m) {
			const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
			return lum < 128;
		}
	} catch {
		// Default to dark palette
	}
	return false;
}

export function getActiveGlobalTheme(fallback?: unknown): Theme {
	const g = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
	if (g) return g as Theme;
	return fallback as Theme;
}

export function paintSurfaceRow(content: string, targetWidth: number, r: number, g: number, b: number): string {
	const clipped = truncateToWidth(content, targetWidth, "…");
	const pad = " ".repeat(Math.max(0, targetWidth - visibleWidth(clipped)));
	const bgEsc = `\x1b[48;2;${r};${g};${b}m`;
	const patched = (clipped + pad)
		.replace(/\x1b\[0m/g, `\x1b[0m${bgEsc}`)
		.replace(/\x1b\[49m/g, bgEsc);
	return `${bgEsc}${patched}\x1b[49m`;
}

export type RgbTuple = readonly [number, number, number];

export type PillVariant = "primary" | "secondary" | "success" | "warning" | "danger" | "neutral";

export interface ThemeSurfacePalette {
	readonly isLight: boolean;
	readonly surfaceBg: RgbTuple;
	readonly selectedRowBg: RgbTuple;
	readonly hoveredRowBg: RgbTuple;
	readonly noteRowBg: RgbTuple;
	readonly noteEditRowBg: RgbTuple;
	readonly pillNeutralBg: RgbTuple;
	readonly pillNeutralHoverBg: RgbTuple;
	readonly border: RgbTuple;
	readonly accent: RgbTuple;
	readonly accentBright: RgbTuple;
	readonly selectedText: RgbTuple;
	readonly inputText: RgbTuple;
	readonly noteText: RgbTuple;
	readonly warning: RgbTuple;
	readonly success: RgbTuple;
	readonly danger: RgbTuple;
	readonly info: RgbTuple;
	readonly freeBar: RgbTuple;
}

const DARK_SURFACE_PALETTE: ThemeSurfacePalette = {
	isLight: false,
	surfaceBg: [27, 35, 50],
	selectedRowBg: [39, 52, 74],
	hoveredRowBg: [31, 39, 54],
	noteRowBg: [40, 39, 33],
	noteEditRowBg: [44, 42, 34],
	pillNeutralBg: [36, 43, 56],
	pillNeutralHoverBg: [48, 59, 78],
	border: [97, 175, 239],
	accent: [97, 175, 239],
	accentBright: [125, 207, 255],
	selectedText: [235, 244, 255],
	inputText: [220, 232, 248],
	noteText: [232, 210, 156],
	warning: [229, 192, 123],
	success: [140, 194, 101],
	danger: [224, 108, 117],
	info: [86, 182, 194],
	freeBar: [52, 62, 80],
};

const LIGHT_SURFACE_PALETTE: ThemeSurfacePalette = {
	isLight: true,
	surfaceBg: [237, 243, 252],
	selectedRowBg: [214, 230, 252],
	hoveredRowBg: [232, 240, 251],
	noteRowBg: [252, 244, 224],
	noteEditRowBg: [248, 237, 206],
	pillNeutralBg: [226, 235, 247],
	pillNeutralHoverBg: [207, 224, 246],
	border: [37, 99, 235],
	accent: [29, 78, 216],
	accentBright: [2, 132, 199],
	selectedText: [15, 23, 42],
	inputText: [15, 23, 42],
	noteText: [120, 53, 15],
	warning: [180, 83, 9],
	success: [21, 128, 61],
	danger: [220, 38, 38],
	info: [15, 118, 110],
	freeBar: [203, 213, 225],
};

export function getThemeSurfacePalette(theme: unknown): ThemeSurfacePalette {
	return isLightTheme(theme) ? LIGHT_SURFACE_PALETTE : DARK_SURFACE_PALETTE;
}

function mixRgb(base: RgbTuple, accent: RgbTuple, accentWeight: number): [number, number, number] {
	const baseWeight = 1 - accentWeight;
	return [
		Math.round(base[0] * baseWeight + accent[0] * accentWeight),
		Math.round(base[1] * baseWeight + accent[1] * accentWeight),
		Math.round(base[2] * baseWeight + accent[2] * accentWeight),
	];
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
			return bgRgb(bg[0], bg[1], bg[2], fgRgb(15, 23, 42, ` ${text} `));
		}
		if (opts.active) {
			const bg = mixRgb([246, 249, 254], accent, 0.16);
			const fg = mixRgb([15, 23, 42], accent, 0.72);
			return bgRgb(bg[0], bg[1], bg[2], fgRgb(fg[0], fg[1], fg[2], ` ${text} `));
		}
		const bg = palette.pillNeutralBg;
		return bgRgb(bg[0], bg[1], bg[2], opts.theme.fg("muted", ` ${text} `));
	}

	const [r, g, b] = accent;
	if (opts.hovered) {
		const bg = isNeutral
			? palette.pillNeutralHoverBg
			: ([Math.round(r * 0.34), Math.round(g * 0.34), Math.round(b * 0.38)] as const);
		return bgRgb(bg[0], bg[1], bg[2], fgRgb(235, 244, 255, ` ${text} `));
	}
	if (opts.active) {
		return bgRgb(Math.round(r * 0.2), Math.round(g * 0.22), Math.round(b * 0.26), fgRgb(r, g, b, ` ${text} `));
	}
	const bg = palette.pillNeutralBg;
	return bgRgb(bg[0], bg[1], bg[2], opts.theme.fg("muted", ` ${text} `));
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
	const bColor = (s: string) => fgRgb(borderRgb[0], borderRgb[1], borderRgb[2], s);
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
