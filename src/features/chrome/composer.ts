import {
	CustomEditor,
	type AppKeybinding,
	type CustomEditorOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
	type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	matchesKey,
	renderFakeCursor,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, isLightTheme, renderPill, type HitBox, type RgbTuple } from "../../shared/ansi.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { getSessionWorkflow, MODE_META } from "../../shared/session-workflow.ts";
import { setAppActionRunner, setRequestRender } from "../../shared/ui-action-bridge.ts";
import { setSessionMode } from "../plan-studio/index.ts";
import { showPlanStudio } from "../plan-studio/studio-overlay.ts";

export const COMPOSER_PLACEHOLDER = "Спроси или опиши задачу…";

export interface ComposerHooks {
	interceptInput?(data: string, editor: PiUiComposerEditor): boolean;
	transformPaste?(pastedText: string, editor: PiUiComposerEditor): string | undefined;
	findAtomicTokenSpans?(text: string, editor: PiUiComposerEditor): ReadonlyArray<{ start: number; end: number }>;
	decorateRenderedLine?(line: string, visualLineIndex: number, editor: PiUiComposerEditor): string;
	onPointerOrCursorChange?(
		info: { hovered: boolean; mouseX?: number; mouseY?: number },
		editor: PiUiComposerEditor,
	): void;
	captureUndoState?(editor: PiUiComposerEditor): unknown;
	restoreUndoState?(snapshot: unknown, editor: PiUiComposerEditor): void;
}

const COMPOSER_HOOKS_KEY = Symbol.for("conarti.pi-ui.composer-hooks.v1");
const COMPOSER_FACTORY_ORIGIN = Symbol.for("conarti.pi-ui.composer-factory-origin.v1");

export function registerComposerHooks(hooks: ComposerHooks | undefined): void {
	(globalThis as Record<symbol, ComposerHooks | undefined>)[COMPOSER_HOOKS_KEY] = hooks;
}

export function getComposerHooks(): ComposerHooks | undefined {
	return (globalThis as Record<symbol, ComposerHooks | undefined>)[COMPOSER_HOOKS_KEY];
}

export function buildWaveIndicator(): WorkingIndicatorOptions {
	const c1 = (s: string) => fgRgb(62, 84, 118, s);
	const c2 = (s: string) => fgRgb(86, 148, 214, s);
	const c3 = (s: string) => fgRgb(125, 207, 255, s);
	const c4 = (s: string) => fgRgb(86, 212, 224, s);

	return {
		intervalMs: 95,
		frames: [
			`${c3("●")}${c2("∙")}${c1("∙")}`,
			`${c4("●")}${c3("●")}${c1("∙")}`,
			`${c2("∙")}${c4("●")}${c3("●")}`,
			`${c1("∙")}${c2("∙")}${c4("●")}`,
			`${c1("∙")}${c3("●")}${c2("∙")}`,
			`${c2("●")}${c1("∙")}${c1("∙")}`,
		],
	};
}

export interface PiUiComposerDeps {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly getTheme: () => Theme;
}

interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction: unknown;
	scrollOffset: number;
	renderedVisibleLineCount: number;
	undoStack?: { length: number };
	setCursorCol(col: number): void;
	isEditorEmpty(): boolean;
	insertTextAtCursor(text: string): void;
}

const baseEditorProto = Editor.prototype as unknown as {
	segment(text: string, mode: "grapheme" | "word"): Iterable<Intl.SegmentData>;
	moveWordBackwards(): void;
	moveWordForwards(): void;
	handlePaste(pastedText: string): void;
	pushUndoSnapshot(): void;
	undo(): void;
};

export class PiUiComposerEditor extends CustomEditor {
	private deps: PiUiComposerDeps;
	private editorHovered = false;
	private hoveredBadge: string | null = null;
	private topHits: HitBox[] = [];
	private undoSnapshots: unknown[] = [];

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		deps: PiUiComposerDeps,
		options?: CustomEditorOptions,
	) {
		super(tui, editorTheme, keybindings, {
			...options,
			paddingX: 0,
			autocompleteMaxVisible: options?.autocompleteMaxVisible ?? 10,
			embedWorkingStatus: true,
		});
		this.deps = deps;
		this.installChipHooksOnInstance();
	}

	private internals(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	updateDeps(deps: PiUiComposerDeps): void {
		this.deps = deps;
	}

	/* InteractiveMode перезаписывает paddingX из настроек хоста сразу после фабрики */
	override getPaddingX(): number {
		return 0;
	}

	override setPaddingX(_padding: number): void {
		super.setPaddingX(0);
	}

	resolveFrameBorderRgb(): RgbTuple {
		const st = getSessionWorkflow();
		const light = isLightTheme(this.deps.getTheme());
		if (st.mode === "plan") return light ? [180, 83, 9] : [196, 160, 92];
		if (st.mode === "safe") return light ? [15, 118, 110] : [76, 162, 174];
		if (st.isStreaming) return light ? [37, 99, 235] : [97, 175, 239];
		if (this.editorHovered) return light ? [59, 130, 246] : [92, 138, 198];
		return light ? [203, 213, 225] : [58, 68, 86];
	}

	private paintBorder(text: string): string {
		return fgRgb(this.resolveFrameBorderRgb(), text);
	}

	private installChipHooksOnInstance(): void {
		const self = this as unknown as Record<string, unknown>;

		self.segment = (text: string, mode: "grapheme" | "word"): Iterable<Intl.SegmentData> => {
			const base = baseEditorProto.segment.call(this, text, mode);
			const hooks = getComposerHooks();
			const spans = hooks?.findAtomicTokenSpans?.(text, this);
			if (!spans || spans.length === 0) {
				return base;
			}
			const merged: Intl.SegmentData[] = [];
			let spanIdx = 0;
			for (const seg of base) {
				while (spanIdx < spans.length && spans[spanIdx]!.end <= seg.index) {
					spanIdx += 1;
				}
				const span = spanIdx < spans.length ? spans[spanIdx] : undefined;
				if (span && seg.index >= span.start && seg.index < span.end) {
					if (seg.index === span.start) {
						merged.push({
							segment: text.slice(span.start, span.end),
							index: span.start,
							input: text,
						});
					}
				} else {
					merged.push(seg);
				}
			}
			return merged;
		};

		self.moveWordBackwards = (): void => {
			const hooks = getComposerHooks();
			const internal = this.internals();
			const { state } = internal;
			const line = state.lines[state.cursorLine] ?? "";
			const spans = state.cursorCol > 0 ? hooks?.findAtomicTokenSpans?.(line, this) : undefined;
			if (!spans || spans.length === 0) {
				baseEditorProto.moveWordBackwards.call(this);
				return;
			}

			let nonWsCol = state.cursorCol;
			while (nonWsCol > 0 && /\s/u.test(line[nonWsCol - 1] ?? "")) {
				if (spans.some((s) => s.end === nonWsCol)) break;
				nonWsCol -= 1;
			}
			const hitSpan = spans.find((s) => s.start < nonWsCol && nonWsCol <= s.end);
			if (hitSpan) {
				internal.lastAction = null;
				internal.setCursorCol(hitSpan.start);
				return;
			}

			const prevBoundary = spans.reduce((maxEnd, s) => (s.end <= nonWsCol && s.end > maxEnd ? s.end : maxEnd), 0);
			const prevLineIdx = state.cursorLine;
			baseEditorProto.moveWordBackwards.call(this);
			if (state.cursorLine === prevLineIdx && state.cursorCol < prevBoundary) {
				internal.setCursorCol(prevBoundary);
			}
		};

		self.moveWordForwards = (): void => {
			const hooks = getComposerHooks();
			const internal = this.internals();
			const { state } = internal;
			const line = state.lines[state.cursorLine] ?? "";
			const spans = state.cursorCol < line.length ? hooks?.findAtomicTokenSpans?.(line, this) : undefined;
			if (!spans || spans.length === 0) {
				baseEditorProto.moveWordForwards.call(this);
				return;
			}

			let nonWsCol = state.cursorCol;
			while (nonWsCol < line.length && /\s/u.test(line[nonWsCol] ?? "")) {
				if (spans.some((s) => s.start === nonWsCol)) break;
				nonWsCol += 1;
			}
			const hitSpan = spans.find((s) => s.start <= nonWsCol && nonWsCol < s.end);
			if (hitSpan) {
				internal.lastAction = null;
				internal.setCursorCol(hitSpan.end);
				return;
			}

			const nextBoundary = spans.reduce(
				(minStart, s) => (s.start > nonWsCol && s.start < minStart ? s.start : minStart),
				line.length,
			);
			const prevLineIdx = state.cursorLine;
			baseEditorProto.moveWordForwards.call(this);
			if (state.cursorLine === prevLineIdx && state.cursorCol > nextBoundary) {
				internal.setCursorCol(nextBoundary);
			}
		};

		self.handlePaste = (pastedText: string): void => {
			const hooks = getComposerHooks();
			const transformed = hooks?.transformPaste?.(pastedText, this);
			if (transformed !== undefined) {
				this.internals().insertTextAtCursor(transformed);
				return;
			}
			baseEditorProto.handlePaste.call(this, pastedText);
		};

		self.pushUndoSnapshot = (): void => {
			const hooks = getComposerHooks();
			if (hooks?.captureUndoState) {
				this.undoSnapshots.push(hooks.captureUndoState(this));
			}
			baseEditorProto.pushUndoSnapshot.call(this);
		};

		self.undo = (): void => {
			const hooks = getComposerHooks();
			const internal = this.internals();
			const beforeDepth = internal.undoStack?.length;
			baseEditorProto.undo.call(this);
			const afterDepth = internal.undoStack?.length;
			if (hooks?.restoreUndoState && this.undoSnapshots.length > 0 && afterDepth !== beforeDepth) {
				const snap = this.undoSnapshots.pop();
				hooks.restoreUndoState(snap, this);
			}
		};
	}

	override handleInput(data: string): void {
		if (this.onExtensionShortcut?.(data)) {
			return;
		}
		const hooks = getComposerHooks();
		if (hooks?.interceptInput?.(data, this)) {
			return;
		}
		const isAltEnter =
			matchesKey(data, "alt+enter") || matchesKey(data, "alt+return") || data === "\x1b\r" || data === "\x1b\n";
		const savedShortcut = this.onExtensionShortcut;
		this.onExtensionShortcut = undefined;
		try {
			super.handleInput(isAltEnter ? "\n" : data);
		} finally {
			this.onExtensionShortcut = savedShortcut;
		}
		if (!isAltEnter) {
			hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
		}
	}

	private renderRoundedTopBorder(width: number): string {
		this.topHits = [];
		const spanWidth = Math.max(0, width - 2);
		const bLine = (s: string) => this.paintBorder(s);
		if (spanWidth === 0) {
			return `${bLine("╭")}${bLine("╮")}`;
		}

		const { pi, ctx } = this.deps;
		const theme = this.deps.getTheme();
		const st = getSessionWorkflow();

		const allPills: Array<{ id: string; str: string; onClick: () => void }> = [];
		if (st.mode !== "code") {
			const meta = MODE_META[st.mode];
			allPills.push({
				id: "mode",
				str: renderPill(meta.label, {
					hovered: this.hoveredBadge === "mode",
					active: true,
					variant: st.mode === "plan" ? "warning" : "secondary",
					theme,
				}),
				onClick: () => setSessionMode(pi, ctx, "code"),
			});
		}
		if (st.planLines.length > 0) {
			const commentCount = Object.keys(st.planComments).length;
			allPills.push({
				id: "plan",
				str: renderPill(commentCount > 0 ? `План (${commentCount})` : "План", {
					hovered: this.hoveredBadge === "plan",
					active: true,
					variant: "warning",
					theme,
				}),
				onClick: () => void showPlanStudio(pi, ctx),
			});
		}

		let fittingPills = allPills;
		const computePillsWidth = (list: typeof allPills) =>
			list.reduce((sum, p) => sum + visibleWidth(p.str) + 1, 0);
		while (fittingPills.length > 0 && computePillsWidth(fittingPills) + 2 > spanWidth) {
			fittingPills = fittingPills.slice(0, -1);
		}
		const pillsWidth = computePillsWidth(fittingPills);

		let leftStatus = "";
		const anySelf = this as unknown as {
			embedWorkingStatus?: boolean;
			workingStatusIndicator?: {
				renderInBorder?: (maxWidth: number) => string;
				renderSpinnerInBorder?: (maxWidth: number) => string;
			};
		};
		if (anySelf.embedWorkingStatus && anySelf.workingStatusIndicator) {
			const maxStatusW = Math.max(1, spanWidth - pillsWidth - 4);
			let statusCandidate = anySelf.workingStatusIndicator.renderInBorder?.(maxStatusW) ?? "";
			if (visibleWidth(statusCandidate) + pillsWidth + 4 > spanWidth) {
				statusCandidate = anySelf.workingStatusIndicator.renderSpinnerInBorder?.(maxStatusW) ?? "";
			}
			if (visibleWidth(statusCandidate) > 0 && visibleWidth(statusCandidate) + pillsWidth + 3 <= spanWidth) {
				leftStatus = `${bLine("─")} ${statusCandidate} `;
			}
		}

		const leftPart = leftStatus || bLine("─");
		const leftPartW = visibleWidth(leftPart);
		const scrollOffset = this.internals().scrollOffset;
		const overflowText = scrollOffset > 0 ? theme.fg("dim", ` ↑ ${scrollOffset} `) : "";
		const overflowW = visibleWidth(overflowText);
		const includeOverflow = overflowW > 0 && leftPartW + overflowW + pillsWidth + 1 <= spanWidth;

		const fillCount = Math.max(
			0,
			spanWidth - leftPartW - (includeOverflow ? overflowW : 0) - pillsWidth,
		);
		let row = `${bLine("╭")}${leftPart}`;
		if (includeOverflow) {
			const leftDashes = Math.floor(fillCount / 2);
			const rightDashes = fillCount - leftDashes;
			row += `${bLine("─".repeat(leftDashes))}${overflowText}${bLine("─".repeat(rightDashes))}`;
		} else {
			row += bLine("─".repeat(fillCount));
		}

		let curX = visibleWidth(row);
		for (const pill of fittingPills) {
			const pw = visibleWidth(pill.str);
			this.topHits.push({
				id: pill.id,
				xStart: curX,
				xEnd: curX + pw,
				y: 0,
				onClick: pill.onClick,
			});
			row += `${pill.str}${bLine("─")}`;
			curX += pw + 1;
		}

		const remaining = Math.max(0, width - 1 - visibleWidth(row));
		if (remaining > 0) {
			row += bLine("─".repeat(remaining));
		}
		const closed = `${row}${bLine("╮")}`;
		return visibleWidth(closed) <= width ? closed : sliceByColumn(closed, 0, width, true);
	}

	private renderEmptyPlaceholderCell(innerWidth: number): string {
		const theme = this.deps.getTheme();
		const marker = this.focused ? CURSOR_MARKER : "";
		const clipped = truncateToWidth(COMPOSER_PLACEHOLDER, innerWidth, "…");
		if (!clipped) {
			const cursorOnly = `${marker}${renderFakeCursor(" ")}`;
			const w = visibleWidth(cursorOnly);
			return w <= innerWidth ? cursorOnly + " ".repeat(innerWidth - w) : sliceByColumn(cursorOnly, 0, innerWidth, true);
		}
		const chars = [...clipped];
		const firstChar = chars[0]!;
		const rest = chars.slice(1).join("");
		const styled = `${marker}${renderFakeCursor(theme.fg("dim", firstChar))}${rest ? theme.fg("dim", rest) : ""}`;
		const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(styled)));
		return `${styled}${pad}`;
	}

	override render(width: number): string[] {
		this.topHits = [];
		if (width <= 0) return [""];
		const bLine = (s: string) => this.paintBorder(s);
		if (width === 1) return [bLine("│")];

		if (width === 2) {
			return [`${bLine("╭")}${bLine("╮")}`, `${bLine("│")}${bLine("│")}`, `${bLine("╰")}${bLine("╯")}`];
		}

		if (width < 8) {
			const innerW = width - 2;
			const base = super.render(innerW);
			const visCount = this.internals().renderedVisibleLineCount ?? Math.max(1, base.length - 2);
			const out: string[] = [`${bLine("╭")}${bLine("─".repeat(innerW))}${bLine("╮")}`];
			for (let i = 0; i < visCount; i++) {
				const raw = base[1 + i] ?? "";
				const w = visibleWidth(raw);
				const cell = w <= innerW ? raw + " ".repeat(innerW - w) : sliceByColumn(raw, 0, innerW, true);
				out.push(`${bLine("│")}${cell}${bLine("│")}`);
			}
			out.push(`${bLine("╰")}${bLine("─".repeat(innerW))}${bLine("╯")}`);
			return out;
		}

		const innerWidth = width - 6;
		const baseLines = super.render(innerWidth);
		const internal = this.internals();
		const visibleRows = internal.renderedVisibleLineCount ?? Math.max(1, baseLines.length - 2);
		const theme = this.deps.getTheme();
		const light = isLightTheme(theme);
		const chevron = light ? fgRgb(37, 99, 235, "›") : fgRgb(125, 207, 255, "›");
		const hooks = getComposerHooks();
		const isEmpty = internal.isEditorEmpty();

		const out: string[] = [this.renderRoundedTopBorder(width)];

		for (let i = 0; i < visibleRows; i++) {
			const visualIdx = internal.scrollOffset + i;
			const leftPrefix = visualIdx === 0 ? `${bLine("│")} ${chevron} ` : `${bLine("│")}   `;
			const rightSuffix = ` ${bLine("│")}`;

			let cell: string;
			if (isEmpty && i === 0) {
				cell = this.renderEmptyPlaceholderCell(innerWidth);
			} else {
				const rawInner = baseLines[1 + i] ?? "";
				const decorated = hooks?.decorateRenderedLine
					? hooks.decorateRenderedLine(rawInner, visualIdx, this)
					: rawInner;
				const cellW = visibleWidth(decorated);
				cell =
					cellW === innerWidth
						? decorated
						: cellW < innerWidth
							? decorated + " ".repeat(innerWidth - cellW)
							: sliceByColumn(decorated, 0, innerWidth, true);
			}

			out.push(`${leftPrefix}${cell}${rightSuffix}`);
		}

		out.push(`${bLine("╰")}${bLine("─".repeat(width - 2))}${bLine("╯")}`);

		for (let idx = visibleRows + 2; idx < baseLines.length; idx++) {
			const acLine = baseLines[idx] ?? "";
			const acW = visibleWidth(acLine);
			const paddedAc =
				acW === innerWidth
					? acLine
					: acW < innerWidth
						? acLine + " ".repeat(innerWidth - acW)
						: sliceByColumn(acLine, 0, innerWidth, true);
			out.push(`    ${paddedAc}  `);
		}

		return out;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const hooks = getComposerHooks();
		if (event.type === "move") {
			claimHover(this, () => {
				if (this.editorHovered || this.hoveredBadge) {
					this.editorHovered = false;
					this.hoveredBadge = null;
					hooks?.onPointerOrCursorChange?.({ hovered: false }, this);
					this.tui.requestRender();
				}
			});
			hooks?.onPointerOrCursorChange?.({ hovered: true, mouseX: event.x, mouseY: event.y }, this);
			const nextBadge =
				event.y === 0 ? (this.topHits.find((h) => event.x >= h.xStart && event.x < h.xEnd)?.id ?? null) : null;
			if (!this.editorHovered || nextBadge !== this.hoveredBadge) {
				this.editorHovered = true;
				this.hoveredBadge = nextBadge;
				return { handled: true, render: true };
			}
		}

		if (event.type === "click" && event.button === "left" && event.y === 0) {
			const hit = this.topHits.find((h) => event.x >= h.xStart && event.x < h.xEnd);
			if (hit) {
				hit.onClick();
				return { handled: true, focus: true, render: true };
			}
			return { handled: true, focus: true };
		}

		const translatedWidth = Math.max(1, (event.width ?? 80) - 6);
		const translatedX = Math.max(0, event.x - 4);
		return super.handleMouse({
			...event,
			x: translatedX,
			width: translatedWidth,
		});
	}
}

export function mountComposer(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	ctx.ui.setWorkingIndicator(buildWaveIndicator());

	const currentFactory = ctx.ui.getEditorComponent() as
		| (((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) & {
				[COMPOSER_FACTORY_ORIGIN]?: unknown;
		  })
		| undefined;
	const previousFactory =
		currentFactory && COMPOSER_FACTORY_ORIGIN in currentFactory
			? (currentFactory[COMPOSER_FACTORY_ORIGIN] as typeof currentFactory)
			: currentFactory;

	const factory = ((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
		const deps: PiUiComposerDeps = {
			pi,
			ctx,
			getTheme: () => ctx.ui.theme,
		};

		const existing = previousFactory?.(tui, editorTheme, keybindings);
		const editor =
			existing instanceof PiUiComposerEditor
				? (existing.updateDeps(deps), existing)
				: new PiUiComposerEditor(tui, editorTheme, keybindings, deps);

		setRequestRender(() => tui.requestRender());
		setAppActionRunner((actionId: string): boolean => {
			const handler = editor.actionHandlers.get(actionId as AppKeybinding);
			if (typeof handler === "function") {
				handler();
				return true;
			}
			return false;
		});

		return editor;
	}) as NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>> & {
		[COMPOSER_FACTORY_ORIGIN]?: unknown;
	};
	factory[COMPOSER_FACTORY_ORIGIN] = previousFactory;

	ctx.ui.setEditorComponent(factory);
}
