import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	matchesKey,
	renderFakeCursor,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	fgRgb,
	getThemeSurfacePalette,
	renderPill,
	type HitBox,
	type PillVariant,
	type RgbTuple,
	type ThemeSurfacePalette,
} from "./ansi.ts";
import { claimHover } from "./runtime-hooks.ts";

export { getThemeSurfacePalette, type PillVariant, type RgbTuple, type ThemeSurfacePalette };

type OverlayInspectableTui = TUI & {
	getTopmostVisibleOverlay?: () => unknown;
};

const BLOCKING_DIALOG_COUNT_SYMBOL = Symbol.for("conarti.pi-ui.blocking-dialog-count.v1");

function getBlockingDialogCount(): number {
	const value = (globalThis as Record<PropertyKey, unknown>)[BLOCKING_DIALOG_COUNT_SYMBOL];
	return typeof value === "number" && value > 0 ? value : 0;
}

function setBlockingDialogCount(next: number): void {
	(globalThis as Record<PropertyKey, unknown>)[BLOCKING_DIALOG_COUNT_SYMBOL] = Math.max(0, next);
}

/**
 * Registers a non-overlay blocking dialog (such as the model-driven questionnaire)
 * while it is mounted so user-invoked Modal Cards treat it as an active blocking modal.
 */
export function registerBlockingDialog(): () => void {
	setBlockingDialogCount(getBlockingDialogCount() + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		setBlockingDialogCount(getBlockingDialogCount() - 1);
	};
}

/**
 * Returns true when a capturing modal overlay or registered blocking dialog is currently visible.
 * Non-capturing overlays (such as Hover Popup previews) and hidden overlays are ignored.
 */
export function hasBlockingModalOverlay(tui: TUI): boolean {
	if (getBlockingDialogCount() > 0) return true;
	const inspectable = tui as OverlayInspectableTui;
	if (typeof inspectable.getTopmostVisibleOverlay === "function") {
		return Boolean(inspectable.getTopmostVisibleOverlay());
	}
	return false;
}

const NOOP_COMPONENT: Component = {
	invalidate() {},
	render() {
		return [];
	},
};

/**
 * Opens a centered Modal Card overlay. If another blocking Modal Card or questionnaire
 * is already visible, performs a quiet no-op and resolves to `undefined` without stacking.
 */
export async function openModalCard<T>(
	ctx: ExtensionContext,
	factory: (
		tui: TUI,
		theme: Theme,
		kb: KeybindingsManager,
		done: (result: T | undefined) => void,
	) => Component,
	overlayOptions?: OverlayOptions,
): Promise<T | undefined> {
	if (ctx.mode !== "tui") return undefined;
	let blocked = false;
	return await ctx.ui.custom<T | undefined>(
		(tui, theme, kb, done) => {
			if (hasBlockingModalOverlay(tui)) {
				blocked = true;
				done(undefined);
				return NOOP_COMPONENT;
			}
			return factory(tui, theme, kb, done);
		},
		{
			overlay: true,
			overlayOptions,
			onHandle: (handle) => {
				if (blocked) handle.hide();
			},
		},
	);
}

export interface SingleLineInputResult {
	handled: boolean;
	changed: boolean;
	cleared?: boolean;
}

export interface SingleLineInput {
	getValue(): string;
	setValue(next: string): void;
	clear(): void;
	handleInput(data: string): SingleLineInputResult;
	render(opts: {
		theme: Theme;
		focused: boolean;
		maxWidth: number;
		placeholder?: string;
	}): string;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function createSingleLineInput(initialValue = ""): SingleLineInput {
	let value = initialValue;

	return {
		getValue() {
			return value;
		},
		setValue(next: string) {
			value = next;
		},
		clear() {
			value = "";
		},
		handleInput(data: string): SingleLineInputResult {
			if (matchesKey(data, "ctrl+u")) {
				const changed = value.length > 0;
				value = "";
				return { handled: true, changed, cleared: true };
			}
			if (matchesKey(data, "backspace")) {
				if (value.length === 0) return { handled: true, changed: false };
				const segments = [...graphemeSegmenter.segment(value)];
				segments.pop();
				value = segments.map((s) => s.segment).join("");
				return { handled: true, changed: true };
			}
			if (data.length >= 1 && !data.startsWith("\x1b")) {
				// Filter out control characters (e.g. Enter, Tab, DEL)
				const clean = data.replace(/[\x00-\x1f\x7f]/g, "");
				if (clean.length > 0) {
					value += clean;
					return { handled: true, changed: true };
				}
			}
			return { handled: false, changed: false };
		},
		render(opts): string {
			const palette = getThemeSurfacePalette(opts.theme);
			const marker = opts.focused ? CURSOR_MARKER : "";
			const cursor = renderFakeCursor(" ");
			if (!value) {
				const placeholder = opts.placeholder ? opts.theme.fg("dim", opts.placeholder) : "";
				return truncateToWidth(`${marker}${cursor}${placeholder}`, Math.max(2, opts.maxWidth), "…");
			}

			const availText = Math.max(1, opts.maxWidth - 1);
			let shown = value;
			if (visibleWidth(shown) > availText) {
				const segments = [...graphemeSegmenter.segment(shown)].map((s) => s.segment);
				let tail = "";
				for (let i = segments.length - 1; i >= 0; i--) {
					const candidate = segments[i]! + tail;
					if (visibleWidth(`…${candidate}`) > availText) break;
					tail = candidate;
				}
				shown = `…${tail}`;
			}
			const styledText = fgRgb(palette.inputText, shown);
			return `${styledText}${marker}${cursor}`;
		},
	};
}

export interface ModalActionPill {
	id: string;
	label: string;
	variant?: PillVariant;
	active?: boolean;
	rgb?: RgbTuple;
	onClick: () => void;
}

export interface ModalCardRenderSpec {
	title: string;
	headerMeta?: string;
	closable?: boolean;
	onClose?: () => void;
	bodyLines: string[];
	footerText?: string;
	footerPills?: ModalActionPill[];
	borderVariant?: "primary" | "warning" | "info";
	borderRgb?: RgbTuple;
}

export interface ModalCardMouseOutcome {
	handled: boolean;
	render: boolean;
	triggered?: boolean;
}

export interface ModalCardController {
	readonly hoveredId: string | null;
	render(width: number, theme: Theme, spec: ModalCardRenderSpec): string[];
	handleMouse(event: TuiMouseEvent): ModalCardMouseOutcome;
}

function resolveBorderRgb(palette: ThemeSurfacePalette, spec: ModalCardRenderSpec): RgbTuple {
	if (spec.borderRgb) return spec.borderRgb;
	switch (spec.borderVariant) {
		case "warning":
			return palette.warning;
		case "info":
			return palette.info;
		case "primary":
		default:
			return palette.border;
	}
}

export function createModalCard(): ModalCardController {
	const hoverOwner = {};
	let hoveredId: string | null = null;
	let closeHit: HitBox | null = null;
	let pillHits: HitBox[] = [];

	return {
		get hoveredId() {
			return hoveredId;
		},
		render(width: number, theme: Theme, spec: ModalCardRenderSpec): string[] {
			const palette = getThemeSurfacePalette(theme);
			const safeWidth = Math.max(20, width);
			const innerWidth = Math.max(1, safeWidth - 4);
			const borderRgb = resolveBorderRgb(palette, spec);
			const bColor = (s: string) => fgRgb(borderRgb, s);
			const dimBorder = (s: string) => theme.fg("borderMuted", s);

			const closable = spec.closable !== false && typeof spec.onClose === "function";
			const closeGlyph = hoveredId === "top-close"
				? fgRgb(palette.danger, "✕")
				: theme.fg("muted", "✕");

			// Build top border while guaranteeing the top-right close glyph stays visible and right-aligned
			const metaPart = spec.headerMeta ? `${spec.headerMeta}  ` : "";
			const rightContent = closable ? `${metaPart}${closeGlyph}` : (spec.headerMeta ?? "");
			const rightPart = rightContent ? ` ${rightContent} ` : "";
			const rightWidth = visibleWidth(rightPart);

			// Reserve "╭─" (2) + rightPart + "╮" (1) + at least 1 border dash
			const maxLeftWidth = Math.max(2, safeWidth - 3 - rightWidth - (rightWidth > 0 ? 1 : 0));
			const leftTitle = truncateToWidth(` ${spec.title} `, maxLeftWidth, "…");
			const leftWidth = visibleWidth(leftTitle);
			const fillCount = Math.max(0, safeWidth - 3 - leftWidth - rightWidth);

			const topPrefix = `${bColor("╭─")}${leftTitle}${bColor("─".repeat(fillCount))}`;
			const top = truncateToWidth(`${topPrefix}${rightPart}${bColor("╮")}`, safeWidth, "");

			if (closable && spec.onClose) {
				const closeCol = visibleWidth(topPrefix) + 1 + visibleWidth(metaPart);
				const closeW = visibleWidth(closeGlyph);
				closeHit = {
					id: "top-close",
					xStart: Math.max(0, closeCol - 1),
					xEnd: Math.min(safeWidth - 1, closeCol + closeW + 1),
					y: 0,
					onClick: spec.onClose,
				};
			} else {
				closeHit = null;
			}

			const out: string[] = [top];
			for (const raw of spec.bodyLines) {
				const clipped = truncateToWidth(raw, innerWidth, "…");
				const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
				out.push(`${bColor("│")} ${clipped}${pad} ${bColor("│")}`);
			}

			pillHits = [];
			const hasPills = Boolean(spec.footerPills && spec.footerPills.length > 0);
			const hasFooterText = spec.footerText !== undefined;

			if (hasPills || hasFooterText) {
				out.push(`${bColor("├")}${dimBorder("─".repeat(Math.max(0, safeWidth - 2)))}${bColor("┤")}`);
				const footerStartRow = out.length;

				if (hasPills && spec.footerPills) {
					const gap = "  ";
					const gapW = 2;
					const renderedRows: string[] = [];
					let currentRowText = "";
					let currentRowWidth = 0;
					let rowIdx = 0;

					for (const pill of spec.footerPills) {
						const rendered = renderPill(pill.label, {
							hovered: hoveredId === pill.id,
							active: pill.active,
							variant: pill.variant,
							rgb: pill.rgb,
							theme,
						});
						const pillW = visibleWidth(rendered);

						// Wrap to next footer row when adding this pill would exceed innerWidth
						if (currentRowWidth > 0 && currentRowWidth + gapW + pillW > innerWidth) {
							renderedRows.push(currentRowText);
							rowIdx++;
							currentRowText = "";
							currentRowWidth = 0;
						}

						const prefixOffset = currentRowWidth > 0 ? currentRowWidth + gapW : 0;
						const clippedPill = pillW > innerWidth ? truncateToWidth(rendered, innerWidth, "…") : rendered;
						const actualW = visibleWidth(clippedPill);

						pillHits.push({
							id: pill.id,
							xStart: 2 + prefixOffset,
							xEnd: 2 + prefixOffset + actualW,
							y: footerStartRow + rowIdx,
							onClick: pill.onClick,
						});

						currentRowText = currentRowWidth > 0 ? `${currentRowText}${gap}${clippedPill}` : clippedPill;
						currentRowWidth = prefixOffset + actualW;
					}
					if (currentRowText) renderedRows.push(currentRowText);

					for (const rowText of renderedRows) {
						const clipped = truncateToWidth(rowText, innerWidth, "…");
						const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
						out.push(`${bColor("│")} ${clipped}${pad} ${bColor("│")}`);
					}
				} else if (hasFooterText && spec.footerText !== undefined) {
					const clippedFoot = truncateToWidth(spec.footerText, innerWidth, "…");
					const padFoot = " ".repeat(Math.max(0, innerWidth - visibleWidth(clippedFoot)));
					out.push(`${bColor("│")} ${clippedFoot}${padFoot} ${bColor("│")}`);
				}
			}

			out.push(`${bColor("╰")}${bColor("─".repeat(Math.max(0, safeWidth - 2)))}${bColor("╯")}`);
			return out;
		},
		handleMouse(event: TuiMouseEvent): ModalCardMouseOutcome {
			const findHit = (x: number, y: number): HitBox | undefined => {
				if (closeHit && y === closeHit.y && x >= closeHit.xStart && x < closeHit.xEnd) {
					return closeHit;
				}
				return pillHits.find((h) => h.y === y && x >= h.xStart && x < h.xEnd);
			};

			if (event.type === "move") {
				const hit = findHit(event.x, event.y);
				const nextHover = hit?.id ?? null;
				if (nextHover !== null) {
					claimHover(hoverOwner, () => {
						hoveredId = null;
					});
				}
				if (nextHover !== hoveredId) {
					hoveredId = nextHover;
					return { handled: true, render: true };
				}
				return { handled: Boolean(hit), render: false };
			}

			if (event.type === "click" && event.button === "left") {
				const hit = findHit(event.x, event.y);
				if (hit) {
					hit.onClick();
					return { handled: true, render: true, triggered: true };
				}
			}

			return { handled: false, render: false };
		},
	};
}
