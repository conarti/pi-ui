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

export function renderPill(
	text: string,
	opts: {
		hovered?: boolean;
		active?: boolean;
		rgb?: [number, number, number];
		theme: Theme;
	},
): string {
	const [r, g, b] = opts.rgb ?? [97, 175, 239];
	if (opts.hovered) {
		return bgRgb(Math.round(r * 0.34), Math.round(g * 0.34), Math.round(b * 0.38), fgRgb(235, 244, 255, ` ${text} `));
	}
	if (opts.active) {
		return bgRgb(Math.round(r * 0.2), Math.round(g * 0.22), Math.round(b * 0.26), fgRgb(r, g, b, ` ${text} `));
	}
	return bgRgb(36, 43, 56, opts.theme.fg("muted", ` ${text} `));
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
