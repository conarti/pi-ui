import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Input,
	isKeyRelease,
	matchesKey,
	renderFakeCursor,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	fgRgb,
	getThemeSurfacePalette,
	paintThemeSurfaceRow,
	renderPill,
	type HitBox,
	type PillVariant,
	type RgbTuple,
	type ThemeSurfacePalette,
} from "./ansi.ts";
import { matchesLayoutChord } from "./keyboard-layout.ts";
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
	isCursorAtStart(): boolean;
	isCursorAtEnd(): boolean;
	handleInput(data: string): SingleLineInputResult;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	render(opts: {
		theme: Theme;
		focused: boolean;
		maxWidth: number;
		placeholder?: string;
	}): string;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function firstSingleLineGrapheme(text: string): string {
	for (const seg of graphemeSegmenter.segment(text)) {
		return seg.segment;
	}
	return text[0] ?? " ";
}

/**
 * Однострочный ввод поверх хостового `Input` с поддержкой навигации (`←/→`, `Home/End`, `Alt+←/→`),
 * вставки, Undo/Redo (`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`) и явного блочного курсора `CURSOR_MARKER + renderFakeCursor`.
 */
export function createSingleLineInput(initialValue = ""): SingleLineInput {
	const input = new Input({ prompt: "", placeholder: "" });
	input.setValue(initialValue);

	interface InputSnapshot {
		readonly value: string;
		readonly cursor: number;
	}

	const getCursorPos = (): number => {
		const raw = (input as unknown as { cursor?: number }).cursor;
		return typeof raw === "number" ? raw : input.getValue().length;
	};
	const setCursorPos = (pos: number): void => {
		const clamped = Math.max(0, Math.min(input.getValue().length, pos));
		(input as unknown as { cursor: number }).cursor = clamped;
	};

	const undoStack: InputSnapshot[] = [];
	const redoStack: InputSnapshot[] = [];

	const captureSnapshot = (): InputSnapshot => ({
		value: input.getValue(),
		cursor: getCursorPos(),
	});

	const restoreSnapshot = (snap: InputSnapshot): void => {
		input.setValue(snap.value);
		setCursorPos(snap.cursor);
	};

	return {
		getValue() {
			return input.getValue();
		},
		setValue(next: string) {
			input.setValue(next);
			setCursorPos(next.length);
			undoStack.length = 0;
			redoStack.length = 0;
		},
		clear() {
			input.setValue("");
			setCursorPos(0);
			undoStack.length = 0;
			redoStack.length = 0;
		},
		isCursorAtStart() {
			return getCursorPos() <= 0;
		},
		isCursorAtEnd() {
			return getCursorPos() >= input.getValue().length;
		},
		handleInput(data: string): SingleLineInputResult {
			if (!data || isKeyRelease(data)) {
				return { handled: false, changed: false };
			}
			const isPaste = data.includes("\x1b[200~");
			if (!isPaste) {
				if (
					matchesKey(data, "enter") ||
					matchesKey(data, "return") ||
					matchesKey(data, "escape") ||
					matchesKey(data, "up") ||
					matchesKey(data, "down") ||
					matchesKey(data, "tab") ||
					matchesKey(data, "shift+tab") ||
					matchesKey(data, "pageUp") ||
					matchesKey(data, "pageDown")
				) {
					return { handled: false, changed: false };
				}

				if (matchesLayoutChord(data, "ctrl+shift+z") || matchesLayoutChord(data, "ctrl+y")) {
					const next = redoStack.pop();
					if (!next) return { handled: true, changed: false };
					undoStack.push(captureSnapshot());
					const before = input.getValue();
					restoreSnapshot(next);
					return { handled: true, changed: input.getValue() !== before };
				}

				if (matchesLayoutChord(data, "ctrl+z")) {
					const prev = undoStack.pop();
					if (!prev) return { handled: true, changed: false };
					redoStack.push(captureSnapshot());
					const before = input.getValue();
					restoreSnapshot(prev);
					return { handled: true, changed: input.getValue() !== before };
				}

				if (matchesKey(data, "ctrl+u")) {
					const before = input.getValue();
					if (before.length > 0) {
						undoStack.push(captureSnapshot());
						redoStack.length = 0;
						input.setValue("");
						setCursorPos(0);
					}
					return { handled: true, changed: before.length > 0, cleared: true };
				}
			}

			const beforeSnap = captureSnapshot();
			input.handleInput(data);
			const afterValue = input.getValue();
			const afterCursor = getCursorPos();
			const changed = afterValue !== beforeSnap.value;
			if (changed) {
				undoStack.push(beforeSnap);
				if (undoStack.length > 100) undoStack.shift();
				redoStack.length = 0;
				return { handled: true, changed: true };
			}
			const cursorMoved = afterCursor !== beforeSnap.cursor;
			const isEditKey =
				isPaste ||
				matchesKey(data, "backspace") ||
				matchesKey(data, "delete") ||
				matchesKey(data, "left") ||
				matchesKey(data, "right") ||
				matchesKey(data, "home") ||
				matchesKey(data, "end") ||
				matchesKey(data, "ctrl+a") ||
				matchesKey(data, "ctrl+e") ||
				matchesKey(data, "ctrl+w") ||
				matchesKey(data, "ctrl+k") ||
				matchesKey(data, "alt+left") ||
				matchesKey(data, "alt+right") ||
				matchesKey(data, "alt+b") ||
				matchesKey(data, "alt+f");
			return { handled: cursorMoved || isEditKey, changed: false };
		},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			return input.handleMouse(event);
		},
		render(opts): string {
			const safeWidth = Math.max(2, opts.maxWidth);
			const value = input.getValue();
			if (!value) {
				const marker = opts.focused ? CURSOR_MARKER : "";
				const placeholder = opts.placeholder
					? truncateToWidth(opts.placeholder, safeWidth, "…")
					: "";
				if (!placeholder) {
					return `${marker}${renderFakeCursor(" ")}`;
				}
				const head = firstSingleLineGrapheme(placeholder);
				const rest = placeholder.slice(head.length);
				const cursor = renderFakeCursor(opts.theme.fg("dim", head));
				return `${marker}${cursor}${rest ? opts.theme.fg("dim", rest) : ""}`;
			}

			input.focused = opts.focused;
			const rendered = input.render(safeWidth)[0] ?? "";
			const palette = getThemeSurfacePalette(opts.theme);
			return fgRgb(palette.inputText, rendered);
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

						/* Переносим пилюлю на следующую строку футера при нехватке ширины */
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
			return out.map((row) => paintThemeSurfaceRow(theme, row, safeWidth, palette.popupSurfaceBg));
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
