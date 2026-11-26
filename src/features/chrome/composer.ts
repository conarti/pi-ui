import {
	CustomEditor,
	type AppKeybinding,
	type CustomEditorOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	isKeyRelease,
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
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { t } from "../../shared/i18n.ts";
import { matchesLayoutChord } from "../../shared/keyboard-layout.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { loadPiUiUserConfig } from "../../shared/pi-ui-config.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { getSessionWorkflow, MODE_META } from "../../shared/session-workflow.ts";
import {
	isSlotOwnedByPiUi,
	PI_UI_OWNER_ID,
	registerSlotOwnershipChangeListener,
} from "../../shared/slot-arbitration.ts";
import { runAppAction, setAppActionRunner, setRequestRender } from "../../shared/ui-action-bridge.ts";
import { setSessionMode } from "../plan-approval/index.ts";
import { showPlanApproval } from "../plan-approval/approval-overlay.ts";
import {
	closeActiveComposerPopover,
	getActiveComposerPopoverKind,
	openComposerPopover,
} from "./composer-popovers.ts";
import {
	hasQueuedMidTurnMessages,
	installMidTurnQueueUi,
	sendNowDraftMidTurn,
	sendNowTopQueuedMidTurnItem,
} from "./mid-turn-queue.ts";
import {
	bindComposerWorkingIndicator,
	buildWaveIndicator,
	isComposerWorkingSuppressed,
	renderInlineWorkingStatusBorder,
} from "./working-indicator.ts";

export { buildWaveIndicator };

function fitExactWidth(text: string, targetWidth: number): string {
	if (targetWidth <= 0) return "";
	const w = visibleWidth(text);
	if (w === targetWidth) return text;
	if (w < targetWidth) return text + " ".repeat(targetWidth - w);
	const sliced = sliceByColumn(text, 0, targetWidth, true);
	const slicedW = visibleWidth(sliced);
	return slicedW < targetWidth ? sliced + " ".repeat(targetWidth - slicedW) : sliced;
}

export const COMPOSER_PLACEHOLDER = t("composer.placeholder");

/**
 * Вычисляет максимальное число видимых строк многострочного черновика Composer:
 * `clamp(4, floor(termRows * 0.35), 10)`.
 */
export function computeComposerMaxVisibleLines(termRows: number): number {
	const safeRows = Number.isFinite(termRows) ? Math.max(1, Math.floor(termRows)) : 24;
	return Math.max(4, Math.min(10, Math.floor(safeRows * 0.35)));
}

export interface ComposerPointerInfo {
	readonly hovered: boolean;
	readonly mouseX?: number;
	readonly mouseY?: number;
	readonly screenX?: number;
	readonly screenY?: number;
	readonly width?: number;
}

export interface ComposerHooks {
	interceptInput?(data: string, editor: PiUiComposerEditor): boolean;
	interceptEmptyDraftInput?(data: string, editor: PiUiComposerEditor): boolean;
	getEmptyPlaceholder?(editor: PiUiComposerEditor): string | undefined;
	onEmptyPlaceholderClick?(editor: PiUiComposerEditor): boolean;
	hasDraftAttachments?(): boolean;
	transformPaste?(pastedText: string, editor: PiUiComposerEditor): string | undefined;
	findAtomicTokenSpans?(text: string, editor: PiUiComposerEditor): ReadonlyArray<{ start: number; end: number }>;
	decorateRenderedLine?(line: string, visualLineIndex: number, editor: PiUiComposerEditor): string;
	onDraftChanged?(text: string, editor: PiUiComposerEditor): void;
	onPointerOrCursorChange?(info: ComposerPointerInfo, editor: PiUiComposerEditor): void;
	captureUndoState?(editor: PiUiComposerEditor): unknown;
	restoreUndoState?(snapshot: unknown, editor: PiUiComposerEditor): void;
}

const COMPOSER_HOOKS_KEY = Symbol.for("conarti.pi-ui.composer-hooks.v1");
const COMPOSER_FEATURE_HOOKS_KEY = Symbol.for("conarti.pi-ui.composer-feature-hooks.v1");
const ACTIVE_COMPOSER_KEY = Symbol.for("conarti.pi-ui.active-composer.v1");
const COMPOSER_FACTORY_ORIGIN = Symbol.for("conarti.pi-ui.composer-factory-origin.v1");
const UPSTREAM_EDITOR_FACTORIES = new WeakMap<object, ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>();
const composerGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function firstGrapheme(text: string): string {
	for (const segment of composerGraphemeSegmenter.segment(text)) {
		return segment.segment;
	}
	return text[0] ?? "";
}

function getFeatureComposerHooksMap(): Map<string, ComposerHooks> {
	const g = globalThis as Record<symbol, Map<string, ComposerHooks> | undefined>;
	if (!g[COMPOSER_FEATURE_HOOKS_KEY]) {
		g[COMPOSER_FEATURE_HOOKS_KEY] = new Map();
	}
	return g[COMPOSER_FEATURE_HOOKS_KEY]!;
}

export function getActiveComposerEditor(): PiUiComposerEditor | undefined {
	return (globalThis as Record<symbol, PiUiComposerEditor | undefined>)[ACTIVE_COMPOSER_KEY];
}

export function setActiveComposerEditor(editor: PiUiComposerEditor | undefined): void {
	(globalThis as Record<symbol, PiUiComposerEditor | undefined>)[ACTIVE_COMPOSER_KEY] = editor;
}

export function registerComposerHooks(hooks: ComposerHooks | undefined): void {
	(globalThis as Record<symbol, ComposerHooks | undefined>)[COMPOSER_HOOKS_KEY] = hooks;
}

export function getComposerHooks(): ComposerHooks | undefined {
	return (globalThis as Record<symbol, ComposerHooks | undefined>)[COMPOSER_HOOKS_KEY];
}

export function registerFeatureComposerHooks(
	featureId: string,
	hooks: ComposerHooks | undefined,
): void {
	const map = getFeatureComposerHooksMap();
	if (hooks) {
		map.set(featureId, hooks);
	} else {
		map.delete(featureId);
	}
}

function listAllComposerHooks(): ComposerHooks[] {
	const primary = getComposerHooks();
	const extras = [...getFeatureComposerHooksMap().values()];
	return primary ? [primary, ...extras] : extras;
}

export interface PiUiComposerDeps {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly getTheme: () => Theme;
}

interface EditorLayoutLine {
	readonly text: string;
	readonly hasCursor: boolean;
	readonly cursorPos?: number;
}

interface EditorInternals {
	lastWidth?: number;
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction: unknown;
	scrollOffset: number;
	renderedVisibleLineCount: number;
	renderedAutocompleteHeight?: number;
	autocompleteState?: unknown;
	autocompleteList?: { render(width: number): string[] };
	isInPaste?: boolean;
	pasteBuffer?: string;
	undoStack?: { length: number; clear?: () => void };
	setCursorCol(col: number): void;
	isEditorEmpty(): boolean;
	insertTextAtCursor(text: string): void;
	layoutText?(contentWidth: number): EditorLayoutLine[];
	segment?(text: string, mode: "grapheme" | "word"): Iterable<Intl.SegmentData>;
	buildVisualLineMap?(width: number): Array<{ logicalLine: number; startCol: number; length: number }>;
}

export interface ComposerVisualSlice {
	readonly logicalLineIndex: number;
	readonly logicalLine: string;
	readonly startCol: number;
	readonly length: number;
	readonly cursorLine: number;
	readonly cursorCol: number;
}

const baseEditorProto = Editor.prototype as unknown as {
	segment(text: string, mode: "grapheme" | "word"): Iterable<Intl.SegmentData>;
	moveWordBackwards(): void;
	moveWordForwards(): void;
	handleInput(data: string): void;
	handlePaste(pastedText: string): void;
	pushUndoSnapshot(): void;
	undo(): void;
};

export type ComposerTransientHintKind = "esc-clear" | "ctrl-c-stop";

export interface ComposerTransientHint {
	readonly kind: ComposerTransientHintKind;
	readonly text: string;
	readonly expiresAt: number;
}

interface ComposerRedoEntry {
	readonly lines: string[];
	readonly cursorLine: number;
	readonly cursorCol: number;
	readonly chipSnapshot: unknown;
}

export class PiUiComposerEditor extends CustomEditor {
	private deps: PiUiComposerDeps;
	private editorHovered = false;
	private hoveredBadge: string | null = null;
	private topHits: HitBox[] = [];
	private bottomHits: HitBox[] = [];
	private manualScrollActive = false;
	private totalVisualLineCount = 1;
	private undoSnapshots: unknown[] = [];
	private redoStack: ComposerRedoEntry[] = [];
	private pendingUndoCapture: { hasValue: boolean; value: unknown } | undefined;
	private restoringUndo = false;
	private applyingRedo = false;
	private acceptedSuggestionUndoArmed = false;
	private transientHint: ComposerTransientHint | undefined;
	private transientHintTimer: ReturnType<typeof setTimeout> | undefined;
	private lastEmptyEscAt = 0;
	private lastQueuedAt = 0;

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

	private resolveBoxLayout(totalWidth: number): {
		readonly compact: boolean;
		readonly outerPad: number;
		readonly boxWidth: number;
		readonly leftOffset: number;
		readonly innerWidth: number;
		readonly visualLines: Array<{ logicalLine: number; startCol: number; length: number }>;
	} {
		const internal = this.internals();
		const outerPad = computeOuterCanvasMargin(totalWidth);
		const boxWidth = Math.max(1, totalWidth - outerPad * 2);
		const compact = boxWidth < 9;
		const leftOffset = outerPad + (compact ? 1 : 4);
		const innerWidth = Math.max(1, compact ? boxWidth - 2 : boxWidth - 6);
		const fallbackWrapWidth = Math.max(1, (compact ? Math.max(3, innerWidth) : innerWidth) - 1);
		const wrapWidth = internal.lastWidth && internal.lastWidth > 0 ? internal.lastWidth : fallbackWrapWidth;
		const visualLines =
			internal.buildVisualLineMap?.(wrapWidth) ??
			internal.state.lines.map((line, idx) => ({
				logicalLine: idx,
				startCol: 0,
				length: line.length,
			}));
		return { compact, outerPad, boxWidth, leftOffset, innerWidth, visualLines };
	}

	getTui(): TUI {
		return this.tui;
	}

	getTransientHint(): ComposerTransientHint | undefined {
		if (!this.transientHint) return undefined;
		if (Date.now() > this.transientHint.expiresAt) {
			this.clearTransientHint();
			return undefined;
		}
		return this.transientHint;
	}

	private showTransientHint(kind: ComposerTransientHintKind, durationMs: number): void {
		if (this.transientHintTimer) {
			clearTimeout(this.transientHintTimer);
			this.transientHintTimer = undefined;
		}
		const text =
			kind === "esc-clear"
				? t("composer.escAgainToClear")
				: t("composer.pressCtrlCToStop");
		this.transientHint = {
			kind,
			text,
			expiresAt: Date.now() + durationMs,
		};
		this.transientHintTimer = setTimeout(() => {
			this.transientHintTimer = undefined;
			this.transientHint = undefined;
			this.tui.requestRender();
		}, durationMs);
		this.transientHintTimer.unref?.();
		this.tui.requestRender();
	}

	clearTransientHint(): void {
		if (this.transientHintTimer) {
			clearTimeout(this.transientHintTimer);
			this.transientHintTimer = undefined;
		}
		this.transientHint = undefined;
	}

	dispose(): void {
		this.clearTransientHint();
	}

	clearDraftWithUndo(): void {
		const hooks = getComposerHooks();
		const preSnap = hooks?.captureUndoState?.(this);
		this.clearTransientHint();
		this.setTextWithUndoSnapshot("", preSnap);
		hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
		this.tui.requestRender();
	}

	performUndo(): void {
		const hooks = getComposerHooks();
		this.clearTransientHint();
		(this as unknown as { undo(): void }).undo();
		if (this.internals().isEditorEmpty()) {
			this.acceptedSuggestionUndoArmed = false;
		}
		hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
		this.tui.requestRender();
	}

	performRedo(): boolean {
		const entry = this.redoStack.pop();
		if (!entry) return false;
		const internal = this.internals();
		const hooks = getComposerHooks();
		this.clearTransientHint();
		const currentChipSnap = hooks?.captureUndoState?.(this);

		this.applyingRedo = true;
		this.restoringUndo = true;
		try {
			this.pendingUndoCapture = { hasValue: true, value: currentChipSnap };
			(this as unknown as { pushUndoSnapshot(): void }).pushUndoSnapshot();
			internal.state.lines = [...entry.lines];
			internal.state.cursorLine = Math.max(
				0,
				Math.min(internal.state.lines.length - 1, entry.cursorLine),
			);
			const targetLine = internal.state.lines[internal.state.cursorLine] ?? "";
			internal.setCursorCol(Math.max(0, Math.min(targetLine.length, entry.cursorCol)));
			if (hooks?.restoreUndoState && entry.chipSnapshot !== undefined) {
				hooks.restoreUndoState(entry.chipSnapshot, this);
			}
			const nextText = this.getText();
			hooks?.onDraftChanged?.(nextText, this);
			this.onChange?.(this.getText());
		} finally {
			this.pendingUndoCapture = undefined;
			this.restoringUndo = false;
			this.applyingRedo = false;
		}
		hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
		this.tui.requestRender();
		return true;
	}

	isSessionIdle(): boolean {
		return this.deps.ctx.isIdle();
	}

	isDraftCompletelyEmpty(): boolean {
		if (!this.internals().isEditorEmpty()) return false;
		for (const hook of listAllComposerHooks()) {
			if (hook.hasDraftAttachments?.()) return false;
		}
		return true;
	}

	acceptTextWithUndoSnapshot(text: string): void {
		const hooks = getComposerHooks();
		const preSnap = hooks?.captureUndoState?.(this);
		this.setTextWithUndoSnapshot(text, preSnap);
		this.acceptedSuggestionUndoArmed = true;
		hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
		this.tui.requestRender();
	}

	getRenderedBoxHeight(): number {
		return (this.internals().renderedVisibleLineCount ?? 1) + 2;
	}

	getCharBeforeCursor(): string {
		const { state } = this.internals();
		const currentLine = state.lines[state.cursorLine] ?? "";
		return state.cursorCol > 0 ? (currentLine[state.cursorCol - 1] ?? "") : "";
	}

	getCharAfterCursor(): string {
		const { state } = this.internals();
		const currentLine = state.lines[state.cursorLine] ?? "";
		return state.cursorCol < currentLine.length ? (currentLine[state.cursorCol] ?? "") : "";
	}

	scrollDraftBy(delta: number): boolean {
		const internal = this.internals();
		const visibleRows = Math.max(1, internal.renderedVisibleLineCount ?? 1);
		const maxScroll = Math.max(0, this.totalVisualLineCount - visibleRows);
		if (maxScroll <= 0) return false;
		const prevScroll = internal.scrollOffset ?? 0;
		const nextScroll = Math.max(0, Math.min(maxScroll, prevScroll + delta));
		this.manualScrollActive = true;
		if (nextScroll === prevScroll) return false;
		internal.scrollOffset = nextScroll;
		this.tui.requestRender();
		return true;
	}

	override setText(text: string): void {
		this.manualScrollActive = false;
		super.setText(text);
	}

	getVisualSlice(visualLineIndex: number, totalWidth?: number): ComposerVisualSlice | undefined {
		const internal = this.internals();
		const width = totalWidth ?? this.tui?.terminal?.columns ?? 80;
		const { visualLines } = this.resolveBoxLayout(width);
		const vl = visualLines[visualLineIndex];
		if (!vl) return undefined;
		return {
			logicalLineIndex: vl.logicalLine,
			logicalLine: internal.state.lines[vl.logicalLine] ?? "",
			startCol: vl.startCol,
			length: vl.length,
			cursorLine: internal.state.cursorLine,
			cursorCol: internal.state.cursorCol,
		};
	}

	findSpanColumnAtMouse<TSpan extends { readonly start: number; readonly end: number }>(
		mouseX: number,
		mouseY: number,
		totalWidth: number,
		findSpans: (logicalLine: string) => ReadonlyArray<TSpan>,
	): { readonly span: TSpan; readonly col: number } | undefined {
		const internal = this.internals();
		const { leftOffset, visualLines } = this.resolveBoxLayout(totalWidth);
		const visibleRows = internal.renderedVisibleLineCount ?? Math.max(1, internal.state.lines.length);
		if (mouseY < 1 || mouseY > visibleRows) return undefined;

		const visualIdx = (internal.scrollOffset ?? 0) + (mouseY - 1);
		const vl = visualLines[visualIdx];
		if (!vl) return undefined;

		const logicalLine = internal.state.lines[vl.logicalLine] ?? "";
		const vlEnd = vl.startCol + vl.length;
		for (const span of findSpans(logicalLine)) {
			if (span.end <= vl.startCol || span.start >= vlEnd) continue;
			const sliceStart = Math.max(vl.startCol, span.start);
			const sliceEnd = Math.min(vlEnd, span.end);
			const colStart = leftOffset + visibleWidth(logicalLine.slice(vl.startCol, sliceStart));
			const colEnd = colStart + visibleWidth(logicalLine.slice(sliceStart, sliceEnd));
			if (mouseX >= colStart && mouseX < colEnd) {
				return { span, col: colStart };
			}
		}
		return undefined;
	}

	findSpanColumnAtCursor<TSpan extends { readonly start: number; readonly end: number }>(
		totalWidth: number,
		findSpans: (logicalLine: string) => ReadonlyArray<TSpan>,
	): { readonly span: TSpan; readonly col: number } | undefined {
		if (!this.focused) return undefined;
		const internal = this.internals();
		const line = internal.state.lines[internal.state.cursorLine] ?? "";
		if (!line) return undefined;
		const col = internal.state.cursorCol;
		const spans = findSpans(line);
		if (spans.length === 0) return undefined;

		const matched =
			spans.find((s) => s.start <= col && col < s.end) ??
			spans.find((s) => s.end === col);
		if (!matched) return undefined;

		const { leftOffset, visualLines } = this.resolveBoxLayout(totalWidth);
		const targetVl = visualLines.find(
			(vl) =>
				vl.logicalLine === internal.state.cursorLine &&
				matched.start >= vl.startCol &&
				matched.start < vl.startCol + Math.max(1, vl.length),
		);
		const sliceFrom = targetVl ? targetVl.startCol : 0;
		return {
			span: matched,
			col: leftOffset + visibleWidth(line.slice(sliceFrom, matched.start)),
		};
	}

	syncDraftLinesWithCursor(
		syncFn: (
			lines: string[],
			cursorLine: number,
			cursorCol: number,
		) => { lines: string[]; cursorLine: number; cursorCol: number; changed: boolean },
	): string | undefined {
		const internal = this.internals();
		const synced = syncFn(
			internal.state.lines,
			internal.state.cursorLine,
			internal.state.cursorCol,
		);
		if (!synced.changed) return undefined;
		internal.state.lines = synced.lines;
		internal.setCursorCol(synced.cursorCol);
		return synced.lines.join("\n");
	}

	updateDeps(deps: PiUiComposerDeps): void {
		this.deps = deps;
	}

	matchesKeybinding(data: string, action: string): boolean {
		const kb = (this as unknown as { keybindings?: KeybindingsManager }).keybindings;
		return Boolean(kb?.matches(data, action as AppKeybinding));
	}

	/* InteractiveMode перезаписывает paddingX из настроек хоста сразу после фабрики */
	override getPaddingX(): number {
		return 0;
	}

	override setPaddingX(_padding: number): void {
		super.setPaddingX(0);
	}

	clearPopoverHoverState(): void {
		if (this.hoveredBadge?.startsWith("popover-")) {
			this.hoveredBadge = null;
		}
	}

	resolveFrameBorderRgb(): RgbTuple {
		const st = getSessionWorkflow();
		const light = isLightTheme(this.deps.getTheme());
		if (st.mode === "plan") return light ? [180, 83, 9] : [196, 160, 92];
		if (st.mode === "auto") return light ? [2, 132, 199] : [100, 178, 240];
		if (st.isStreaming) return light ? [37, 99, 235] : [97, 175, 239];
		return light ? [148, 163, 184] : [76, 91, 115];
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
			const preCaptured = hooks?.captureUndoState ? hooks.captureUndoState(this) : undefined;
			const transformed = hooks?.transformPaste?.(pastedText, this);
			if (transformed !== undefined) {
				const spans = hooks?.findAtomicTokenSpans?.(transformed, this);
				if (spans && spans.length > 0 && spans[0]!.start === 0 && spans.at(-1)!.end === transformed.length) {
					this.insertChipTokenWithAutoSpaces(transformed, preCaptured);
				} else {
					this.insertTextWithUndoSnapshot(transformed, preCaptured);
				}
				return;
			}
			baseEditorProto.handlePaste.call(this, pastedText);
		};

		self.pushUndoSnapshot = (): void => {
			if (!this.applyingRedo) {
				this.redoStack.length = 0;
			}
			const stackDepth = this.internals().undoStack?.length ?? 0;
			this.undoSnapshots.length = stackDepth;
			const hooks = getComposerHooks();
			const snap = this.pendingUndoCapture?.hasValue
				? this.pendingUndoCapture.value
				: hooks?.captureUndoState
					? hooks.captureUndoState(this)
					: undefined;
			this.pendingUndoCapture = undefined;
			this.undoSnapshots.push(snap);
			baseEditorProto.pushUndoSnapshot.call(this);
		};

		self.undo = (): void => {
			const internal = this.internals();
			const hooks = getComposerHooks();
			const beforeDepth = internal.undoStack?.length ?? 0;
			const preUndoEntry: ComposerRedoEntry = {
				lines: [...internal.state.lines],
				cursorLine: internal.state.cursorLine,
				cursorCol: internal.state.cursorCol,
				chipSnapshot: hooks?.captureUndoState?.(this),
			};
			this.restoringUndo = true;
			try {
				baseEditorProto.undo.call(this);
			} finally {
				this.restoringUndo = false;
			}
			const afterDepth = internal.undoStack?.length ?? 0;
			if (afterDepth < beforeDepth) {
				this.redoStack.push(preUndoEntry);
				this.undoSnapshots.length = Math.min(this.undoSnapshots.length, beforeDepth);
				const snap = this.undoSnapshots.pop();
				this.undoSnapshots.length = afterDepth;
				if (hooks?.restoreUndoState && snap !== undefined) {
					hooks.restoreUndoState(snap, this);
				}
				const beforeSyncText = this.getText();
				hooks?.onDraftChanged?.(beforeSyncText, this);
				const afterSyncText = this.getText();
				if (afterSyncText !== beforeSyncText) {
					hostOnChange?.(afterSyncText);
				}
			}
			if (this.internals().isEditorEmpty()) {
				this.acceptedSuggestionUndoArmed = false;
			}
		};

		const undoStack = this.internals().undoStack;
		if (undoStack && typeof undoStack.clear === "function") {
			const origClear = undoStack.clear.bind(undoStack);
			undoStack.clear = () => {
				this.undoSnapshots.length = 0;
				this.redoStack.length = 0;
				this.acceptedSuggestionUndoArmed = false;
				origClear();
			};
		}

		let hostOnSubmit = this.onSubmit;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => (text: string) => {
				const trimmed = text.trim();
				if (trimmed === "/model") {
					this.addToHistory?.(trimmed);
					this.setText("");
					openComposerPopover(this.deps.pi, this.deps.ctx, "model");
					return;
				}
				if (trimmed === "/thinking") {
					this.addToHistory?.(trimmed);
					this.setText("");
					openComposerPopover(this.deps.pi, this.deps.ctx, "thinking");
					return;
				}
				hostOnSubmit?.(text);
			},
			set: (fn: ((text: string) => void) | undefined) => {
				hostOnSubmit = fn;
			},
		});

		let hostOnChange = this.onChange;
		Object.defineProperty(this, "onChange", {
			configurable: true,
			enumerable: true,
			get: () => (text: string) => {
				if (!this.restoringUndo) {
					getComposerHooks()?.onDraftChanged?.(text, this);
				}
				const currentText = this.getText();
				if (currentText === "") {
					this.acceptedSuggestionUndoArmed = false;
				}
				hostOnChange?.(currentText);
			},
			set: (fn: ((text: string) => void) | undefined) => {
				hostOnChange = fn;
			},
		});
	}

	insertTextWithUndoSnapshot(text: string, preCapturedSnapshot?: unknown): void {
		if (!text) return;
		this.manualScrollActive = false;
		this.pendingUndoCapture = { hasValue: true, value: preCapturedSnapshot };
		try {
			this.internals().insertTextAtCursor(text);
		} finally {
			this.pendingUndoCapture = undefined;
		}
	}

	/**
	 * Вставляет токен `Prompt Chip` с автоматическими одиночными пробелами вокруг при соседстве
	 * с непробельным текстом; для чипов изображений всегда оставляет завершающий пробел под ввод текста.
	 */
	insertChipTokenWithAutoSpaces(
		token: string,
		preCapturedSnapshot?: unknown,
		options?: { readonly trailingSpace?: boolean },
	): void {
		if (!token) return;
		const before = this.getCharBeforeCursor();
		const after = this.getCharAfterCursor();
		const alwaysTrailSpace = options?.trailingSpace ?? token.startsWith("[🖼");
		const lead = before && !/\s/u.test(before) ? " " : "";
		const trail = alwaysTrailSpace
			? !after || !/\s/u.test(after)
				? " "
				: ""
			: after && !/\s/u.test(after)
				? " "
				: "";
		this.insertTextWithUndoSnapshot(`${lead}${token}${trail}`, preCapturedSnapshot);
		if (alwaysTrailSpace) {
			if (after === " " && trail === "") {
				const internal = this.internals();
				const currentLine = internal.state.lines[internal.state.cursorLine] ?? "";
				if (internal.state.cursorCol < currentLine.length) {
					internal.setCursorCol(internal.state.cursorCol + 1);
				}
			}
		} else if (trail === " ") {
			const internal = this.internals();
			if (internal.state.cursorCol > 0) {
				internal.setCursorCol(internal.state.cursorCol - 1);
			}
		}
	}

	/**
	 * Удаляет атомарный `Prompt Chip` по `Backspace` или `Delete`, схлопывая дублирующийся пробел,
	 * если чип был окружён одиночными пробелами с обеих сторон.
	 */
	private tryDeleteAtomicChipWithSpaceCollapse(direction: "backward" | "forward"): boolean {
		const hooks = getComposerHooks();
		if (!hooks?.findAtomicTokenSpans) return false;
		const internal = this.internals();
		const { state } = internal;
		const line = state.lines[state.cursorLine] ?? "";
		const spans = hooks.findAtomicTokenSpans(line, this);
		if (spans.length === 0) return false;

		const hit =
			direction === "backward"
				? spans.find((s) => s.end === state.cursorCol)
				: spans.find((s) => s.start === state.cursorCol);
		if (!hit) return false;

		const hasLeadingSpace = hit.start > 0 && line[hit.start - 1] === " ";
		const hasTrailingSpace = hit.end < line.length && line[hit.end] === " ";
		if (!hasLeadingSpace || !hasTrailingSpace) return false;

		const preSnap = hooks.captureUndoState?.(this);
		const nextLine = `${line.slice(0, hit.start)}${line.slice(hit.end + 1)}`;
		const nextLines = [...state.lines];
		nextLines[state.cursorLine] = nextLine;
		this.pendingUndoCapture = { hasValue: true, value: preSnap };
		try {
			(this as unknown as { pushUndoSnapshot(): void }).pushUndoSnapshot();
			state.lines = nextLines;
			internal.setCursorCol(hit.start);
			this.onChange?.(this.getText());
		} finally {
			this.pendingUndoCapture = undefined;
		}
		hooks.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
		this.tui.requestRender();
		return true;
	}

	setTextWithUndoSnapshot(text: string, preCapturedSnapshot?: unknown): void {
		this.manualScrollActive = false;
		const normalizedNext =
			(this as unknown as { normalizeText?: (s: string) => string }).normalizeText?.(text) ?? text;
		/* Editor.setText пропускает pushUndoSnapshot при неизменной строке (например, правка цитаты с тем же числом строк) */
		const sameText = preCapturedSnapshot !== undefined && this.getText() === normalizedNext;
		this.pendingUndoCapture = { hasValue: true, value: preCapturedSnapshot };
		try {
			if (sameText) {
				(this as unknown as { pushUndoSnapshot(): void }).pushUndoSnapshot();
			}
			this.setText(text);
		} finally {
			this.pendingUndoCapture = undefined;
		}
	}

	triggerMidTurnAction(action: "queue" | "steer" | "send-now"): void {
		const expanded = (this.getExpandedText?.() ?? this.getText()).trim();
		if (action === "send-now") {
			if (expanded.length > 0) {
				void sendNowDraftMidTurn(expanded, this);
			} else if (hasQueuedMidTurnMessages()) {
				void sendNowTopQueuedMidTurnItem();
			}
			return;
		}
		if (expanded.length === 0) return;
		this.lastQueuedAt = Date.now();
		if (action === "queue") {
			runAppAction("app.message.followUp");
		} else {
			this.onSubmit?.(expanded);
		}
	}

	override handleInput(data: string): void {
		this.manualScrollActive = false;
		const internal = this.internals();
		const hooks = getComposerHooks();
		if (internal.isInPaste) {
			if ((internal.pasteBuffer ?? "") === "" && data.startsWith("\x1b[201~")) {
				internal.isInPaste = false;
				internal.pasteBuffer = "";
				hooks?.interceptInput?.("\x1b[200~\x1b[201~", this);
				const remaining = data.slice(6);
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
				return;
			}
			baseEditorProto.handleInput.call(this, data);
			hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
			return;
		}
		if (
			!data.startsWith("\x1b[200~") &&
			!isKeyRelease(data) &&
			!hasBlockingModalOverlay(this.tui)
		) {
			if (matchesLayoutChord(data, "alt+m") && isSlotOwnedByPiUi("shortcut:alt+m")) {
				openComposerPopover(this.deps.pi, this.deps.ctx, "mode");
				return;
			}
		}
		if (!data.startsWith("\x1b[200~") && this.onExtensionShortcut?.(data)) {
			return;
		}
		if (
			!data.startsWith("\x1b[200~") &&
			!isKeyRelease(data) &&
			!hasBlockingModalOverlay(this.tui)
		) {
			/* Даже с открытым автодополнением Ctrl+Z не должен доходить до привязки SIGTSTP хоста. */
			if (matchesLayoutChord(data, "ctrl+shift+z") || matchesLayoutChord(data, "ctrl+y")) {
				this.performRedo();
				return;
			}
			if (matchesLayoutChord(data, "ctrl+z")) {
				this.performUndo();
				return;
			}

		}
		if (
			!data.startsWith("\x1b[200~") &&
			!isKeyRelease(data) &&
			!this.isShowingAutocomplete() &&
			!hasBlockingModalOverlay(this.tui)
		) {
			/* Ctrl+C во время активного хода прерывает генерацию */
			if (
				(data === "\x03" || matchesLayoutChord(data, "ctrl+c")) &&
				!this.isSessionIdle()
			) {
				this.clearTransientHint();
				this.deps.ctx.abort();
				this.tui.requestRender();
				return;
			}

			if (this.isDraftCompletelyEmpty()) {
				for (const featureHook of listAllComposerHooks()) {
					if (featureHook.interceptEmptyDraftInput?.(data, this)) {
						this.clearTransientHint();
						this.lastEmptyEscAt = 0;
						hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
						this.tui.requestRender();
						return;
					}
				}
			}

			/* Каскадный Esc: никогда не прерывает активный ход; Esc×2 очищает черновик+чипы или открывает /tree */
			if (data === "\x1b" || matchesKey(data, "escape")) {
				if (closeActiveComposerPopover()) {
					return;
				}
				if (!this.isSessionIdle()) {
					this.showTransientHint("ctrl-c-stop", 1500);
					return;
				}
				if (!this.isDraftCompletelyEmpty()) {
					const activeHint = this.getTransientHint();
					if (activeHint?.kind === "esc-clear") {
						this.clearDraftWithUndo();
						return;
					}
					this.showTransientHint("esc-clear", 800);
					return;
				}
				this.clearTransientHint();
				const now = Date.now();
				if (now - this.lastEmptyEscAt <= 800) {
					this.lastEmptyEscAt = 0;
					runAppAction("app.session.tree");
					return;
				}
				this.lastEmptyEscAt = now;
				this.onEscape?.();
				return;
			}

			this.clearTransientHint();
			this.lastEmptyEscAt = 0;
		}
		if (hooks?.interceptInput?.(data, this)) {
			return;
		}
		if (
			!data.includes("\x1b[200~") &&
			!isKeyRelease(data) &&
			!this.isShowingAutocomplete() &&
			!hasBlockingModalOverlay(this.tui)
		) {
			if (this.matchesKeybinding(data, "tui.editor.deleteCharBackward")) {
				if (this.tryDeleteAtomicChipWithSpaceCollapse("backward")) return;
			} else if (this.matchesKeybinding(data, "tui.editor.deleteCharForward")) {
				if (this.tryDeleteAtomicChipWithSpaceCollapse("forward")) return;
			}
		}
		if (data.includes("\x1b[200~")) {
			baseEditorProto.handleInput.call(this, data);
			hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
			return;
		}
		const isCtrlEnter =
			matchesKey(data, "ctrl+enter") ||
			matchesKey(data, "ctrl+return") ||
			data === "\x1b[13;5u" ||
			data === "\x1b[27;5;13~";
		const isAltEnter =
			matchesKey(data, "alt+enter") ||
			matchesKey(data, "alt+return") ||
			data === "\x1b\r" ||
			data === "\x1b\n";
		const isShiftEnter =
			matchesKey(data, "shift+enter") ||
			matchesKey(data, "shift+return") ||
			data === "\x1b[13;2u" ||
			data === "\x1b[27;2;13~";
		const isPlainEnter =
			!isCtrlEnter &&
			!isAltEnter &&
			!isShiftEnter &&
			(data === "\r" || matchesKey(data, "enter") || matchesKey(data, "return"));

		if (!this.isShowingAutocomplete() && !hasBlockingModalOverlay(this.tui)) {
			if (!this.isSessionIdle()) {
				const expanded = (this.getExpandedText?.() ?? this.getText()).trim();
				if (isCtrlEnter) {
					if (expanded.length > 0) {
						void sendNowDraftMidTurn(expanded, this);
					} else if (hasQueuedMidTurnMessages() && Date.now() - this.lastQueuedAt >= 1000) {
						void sendNowTopQueuedMidTurnItem();
					}
					return;
				}
				if (isAltEnter) {
					if (expanded.length > 0) {
						const behavior = loadPiUiUserConfig().midTurnEnter;
						this.lastQueuedAt = Date.now();
						if (behavior === "steer") {
							runAppAction("app.message.followUp");
						} else {
							this.onSubmit?.(expanded);
						}
					}
					return;
				}
				if (isPlainEnter) {
					if (expanded.length === 0) {
						if (hasQueuedMidTurnMessages() && Date.now() - this.lastQueuedAt >= 1000) {
							void sendNowTopQueuedMidTurnItem();
						}
						return;
					}
					if (!expanded.startsWith("/")) {
						const behavior = loadPiUiUserConfig().midTurnEnter;
						this.lastQueuedAt = Date.now();
						if (behavior === "queue") {
							runAppAction("app.message.followUp");
							return;
						}
					}
				}
			} else if (isCtrlEnter) {
				const expanded = (this.getExpandedText?.() ?? this.getText()).trim();
				if (expanded.length > 0) {
					super.handleInput("\r");
					hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
					return;
				}
			} else if (isAltEnter) {
				baseEditorProto.handleInput.call(this, "\n");
				hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
				return;
			}
		} else if (isAltEnter) {
			baseEditorProto.handleInput.call(this, "\n");
			hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
			return;
		}
		const savedShortcut = this.onExtensionShortcut;
		this.onExtensionShortcut = undefined;
		try {
			super.handleInput(data);
		} finally {
			this.onExtensionShortcut = savedShortcut;
		}
		hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
	}

	private renderRoundedTopBorder(boxWidth: number, outerPad = 0): string {
		this.topHits = [];
		const spanWidth = Math.max(0, boxWidth - 2);
		const bLine = (s: string) => this.paintBorder(s);
		const margin = " ".repeat(outerPad);
		if (spanWidth === 0) {
			return `${margin}${bLine("╭")}${bLine("╮")}${margin}`;
		}

		const { pi, ctx } = this.deps;
		const theme = this.deps.getTheme();
		const st = getSessionWorkflow();

		const allPills: Array<{ id: string; str: string; onClick: () => void }> = [];
		if (st.mode !== "always-approve") {
			const meta = MODE_META[st.mode];
			allPills.push({
				id: "mode",
				str: renderPill(meta.label, {
					hovered: this.hoveredBadge === "mode",
					active: true,
					variant: st.mode === "plan" ? "warning" : "secondary",
					theme,
				}),
				onClick: () => setSessionMode(pi, ctx, "always-approve"),
			});
		}
		if (st.planLines.length > 0) {
			const commentCount = Object.keys(st.planComments).length;
			allPills.push({
				id: "plan",
				str: renderPill(
					commentCount > 0
						? t("composer.pill.planWithComments", { count: commentCount })
						: t("composer.pill.plan"),
					{
						hovered: this.hoveredBadge === "plan",
						active: true,
						variant: "warning",
						theme,
					},
				),
				onClick: () => void showPlanApproval(pi, ctx),
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
		const activeTransientHint = !loadPiUiUserConfig().showShortcutsBar
			? this.getTransientHint()
			: undefined;
		const anySelf = this as unknown as {
			embedWorkingStatus?: boolean;
			workingStatusIndicator?: {
				kind?: string;
				renderInBorder?: (maxWidth: number) => string;
				renderSpinnerInBorder?: (maxWidth: number) => string;
			};
		};
		/* Все индикаторы состояния (включая kind === "working" с 30fps волной и [stop]) рендерятся прямо на верхней рамке */
		if (activeTransientHint) {
			const hintRgb: RgbTuple = isLightTheme(theme) ? [180, 83, 9] : [229, 192, 123];
			const maxHintW = Math.max(1, spanWidth - pillsWidth - 4);
			const clippedHint = truncateToWidth(activeTransientHint.text, maxHintW, "…");
			if (visibleWidth(clippedHint) > 0 && visibleWidth(clippedHint) + pillsWidth + 3 <= spanWidth) {
				leftStatus = `${bLine("─")} ${fgRgb(hintRgb, clippedHint)} `;
			}
		} else if (
			anySelf.embedWorkingStatus &&
			anySelf.workingStatusIndicator?.kind === "working"
		) {
			const maxWorkingW = Math.max(1, spanWidth - pillsWidth - 4);
			const customText = isComposerWorkingSuppressed()
				? anySelf.workingStatusIndicator.renderInBorder?.(maxWorkingW)
				: undefined;
			const workingSegment = renderInlineWorkingStatusBorder(maxWorkingW, {
				theme,
				stopHovered: this.hoveredBadge === "working-stop",
				customText,
			});
			const segW = visibleWidth(workingSegment.text);
			if (segW > 0 && segW + pillsWidth + 3 <= spanWidth) {
				leftStatus = `${bLine("─")} ${workingSegment.text} `;
				if (workingSegment.stopOffset !== undefined && workingSegment.stopWidth !== undefined) {
					const stopXStart = outerPad + 3 + workingSegment.stopOffset;
					this.topHits.push({
						id: "working-stop",
						xStart: stopXStart,
						xEnd: stopXStart + workingSegment.stopWidth,
						y: 0,
						onClick: () => this.abortActiveTurn(),
					});
				}
			}
		} else if (
			anySelf.embedWorkingStatus &&
			anySelf.workingStatusIndicator &&
			anySelf.workingStatusIndicator.kind !== "working"
		) {
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
		const visibleRows = Math.max(1, this.internals().renderedVisibleLineCount ?? 1);
		const overflowLabel = scrollOffset > 0 ? ` ↑ ${scrollOffset} ` : "";
		const overflowText = overflowLabel
			? this.hoveredBadge === "scroll-up"
				? theme.fg("accent", overflowLabel)
				: theme.fg("dim", overflowLabel)
			: "";
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
			const upXStart = outerPad + visibleWidth(row) + leftDashes;
			this.topHits.push({
				id: "scroll-up",
				xStart: upXStart,
				xEnd: upXStart + overflowW,
				y: 0,
				onClick: () => {
					this.scrollDraftBy(-Math.max(1, visibleRows - 1));
				},
			});
			row += `${bLine("─".repeat(leftDashes))}${overflowText}${bLine("─".repeat(rightDashes))}`;
		} else {
			row += bLine("─".repeat(fillCount));
		}

		let curX = outerPad + visibleWidth(row);
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

		const remaining = Math.max(0, boxWidth - 1 - visibleWidth(row));
		if (remaining > 0) {
			row += bLine("─".repeat(remaining));
		}
		const closed = `${margin}${row}${bLine("╮")}${margin}`;
		return fitExactWidth(closed, boxWidth + outerPad * 2);
	}

	private renderRoundedBottomBorder(
		boxWidth: number,
		outerPad: number,
		hiddenBelow: number,
		bottomRowY: number,
	): string {
		this.bottomHits = [];
		const spanWidth = Math.max(0, boxWidth - 2);
		const bLine = (s: string) => this.paintBorder(s);
		const margin = " ".repeat(outerPad);
		if (spanWidth === 0) {
			return `${margin}${bLine("╰")}${bLine("╯")}${margin}`;
		}

		const { pi, ctx } = this.deps;
		const theme = this.deps.getTheme();
		const light = isLightTheme(theme);
		const activePopover = getActiveComposerPopoverKind();
		const visibleRows = Math.max(1, this.internals().renderedVisibleLineCount ?? 1);

		const downLabel = hiddenBelow > 0 ? ` ↓ ${hiddenBelow} ` : "";
		const downText = downLabel
			? this.hoveredBadge === "scroll-down"
				? theme.fg("accent", downLabel)
				: theme.fg("dim", downLabel)
			: "";
		const downW = visibleWidth(downText);

		/* Зоны нижней рамки: Model · (thinking) · mode */
		let zones: Array<{ id: string; text: string; onClick: () => void }> = [];
		if (spanWidth >= 32) {
			const wf = getSessionWorkflow();
			const modeMeta = MODE_META[wf.mode];
			const thinkingLevel = pi.getThinkingLevel?.() ?? "off";
			const rawModelLabel = ctx.model?.name || ctx.model?.id || t("composer.noModel");
			const maxModelChars = Math.max(10, Math.min(28, spanWidth - 26));
			const modelLabel = truncateToWidth(rawModelLabel, maxModelChars, "…");
			const thinkingLabel = `(${thinkingLevel})`;
			const modeLabel = modeMeta.label;

			const paintZone = (
				id: string,
				popKind: "model" | "thinking" | "mode",
				label: string,
				modeRgb?: RgbTuple,
			): string => {
				const isHighlighted =
					activePopover !== undefined ? activePopover === popKind : this.hoveredBadge === id;
				if (isHighlighted) {
					return fgRgb(light ? [29, 78, 216] : [125, 207, 255], label);
				}
				if (modeRgb) {
					return fgRgb(modeRgb, label);
				}
				return theme.fg("muted", label);
			};

			const modeRgb: RgbTuple | undefined =
				wf.mode === "plan"
					? light
						? [180, 83, 9]
						: [229, 192, 123]
					: wf.mode === "auto"
						? light
							? [2, 132, 199]
							: [100, 178, 240]
						: undefined;

			zones = [
				{
					id: "popover-model",
					text: paintZone("popover-model", "model", modelLabel),
					onClick: () => openComposerPopover(pi, ctx, "model"),
				},
				{
					id: "popover-thinking",
					text: paintZone("popover-thinking", "thinking", thinkingLabel),
					onClick: () => openComposerPopover(pi, ctx, "thinking"),
				},
				{
					id: "popover-mode",
					text: paintZone("popover-mode", "mode", modeLabel, modeRgb),
					onClick: () => openComposerPopover(pi, ctx, "mode"),
				},
			];
		}

		const sep = theme.fg("dim", " · ");
		const sepW = 3;
		const zonesContentW =
			zones.length > 0
				? zones.reduce((sum, z) => sum + visibleWidth(z.text), 0) + sepW * (zones.length - 1)
				: 0;
		const trailingDashes = 2;
		const rightBlockW = zones.length > 0 ? 1 + zonesContentW + 1 + trailingDashes : 0;
		const includeZones = zones.length > 0 && rightBlockW + 2 <= spanWidth;

		const availLeft = includeZones ? spanWidth - rightBlockW : spanWidth;
		const includeDown = downW > 0 && downW + 2 <= availLeft;

		let row = bLine("╰");
		if (includeDown) {
			const fillLeft = Math.max(0, availLeft - downW);
			const leftDashes = Math.min(2, fillLeft);
			const midDashes = fillLeft - leftDashes;
			const downXStart = outerPad + 1 + leftDashes;
			this.bottomHits.push({
				id: "scroll-down",
				xStart: downXStart,
				xEnd: downXStart + downW,
				y: bottomRowY,
				onClick: () => {
					this.scrollDraftBy(Math.max(1, visibleRows - 1));
				},
			});
			row += `${bLine("─".repeat(leftDashes))}${downText}${bLine("─".repeat(midDashes))}`;
		} else {
			row += bLine("─".repeat(availLeft));
		}

		if (includeZones) {
			row += " ";
			let curX = outerPad + visibleWidth(row);
			for (let i = 0; i < zones.length; i += 1) {
				const zone = zones[i]!;
				const zw = visibleWidth(zone.text);
				this.bottomHits.push({
					id: zone.id,
					xStart: curX,
					xEnd: curX + zw,
					y: bottomRowY,
					onClick: zone.onClick,
				});
				row += zone.text;
				curX += zw;
				if (i < zones.length - 1) {
					row += sep;
					curX += sepW;
				}
			}
			row += ` ${bLine("─".repeat(trailingDashes))}`;
		}

		const closed = `${margin}${row}${bLine("╯")}${margin}`;
		return fitExactWidth(closed, boxWidth + outerPad * 2);
	}

	private renderLayoutLineWithCursor(layoutLine: EditorLayoutLine, contentWidth: number): string {
		const internal = this.internals();
		let displayText = layoutLine.text;
		let lineVisibleWidth = visibleWidth(layoutLine.text);
		if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
			const before = displayText.slice(0, layoutLine.cursorPos);
			const after = displayText.slice(layoutLine.cursorPos);
			const marker = this.focused ? CURSOR_MARKER : "";
			if (after.length > 0) {
				const segs = internal.segment
					? [...internal.segment(after, "grapheme")]
					: [...composerGraphemeSegmenter.segment(after)];
				const head = segs[0]?.segment || "";
				const restAfter = after.slice(head.length);
				displayText = `${before}${marker}${renderFakeCursor(head)}${restAfter}`;
			} else {
				displayText = `${before}${marker}${renderFakeCursor(" ")}`;
				lineVisibleWidth += 1;
			}
		}
		const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
		return `${displayText}${padding}`;
	}

	private renderEmptyPlaceholderCell(innerWidth: number, placeholderText = COMPOSER_PLACEHOLDER): string {
		const theme = this.deps.getTheme();
		const marker = this.focused ? CURSOR_MARKER : "";
		const clipped = truncateToWidth(placeholderText, innerWidth, "…");
		if (!clipped) {
			return fitExactWidth(`${marker}${renderFakeCursor(" ")}`, innerWidth);
		}
		const head = firstGrapheme(clipped);
		const rest = clipped.slice(head.length);
		const styled = `${marker}${renderFakeCursor(theme.fg("dim", head))}${rest ? theme.fg("dim", rest) : ""}`;
		return fitExactWidth(styled, innerWidth);
	}

	private abortActiveTurn(): void {
		if (typeof this.deps.ctx.abort === "function") {
			this.deps.ctx.abort();
			return;
		}
		this.actionHandlers.get("app.interrupt")?.();
	}

	override render(width: number): string[] {
		this.topHits = [];
		this.bottomHits = [];
		if (width <= 0) return [""];
		const bLine = (s: string) => this.paintBorder(s);
		if (width === 1) return [bLine("╭"), bLine("│"), bLine("╰")];

		if (width === 2) {
			return [`${bLine("╭")}${bLine("╮")}`, `${bLine("│")}${bLine("│")}`, `${bLine("╰")}${bLine("╯")}`];
		}

		if (width < 9) {
			const innerW = width - 2;
			/* layoutWidth в Editor равен inner - 1; передаём минимум 3, чтобы wordWrapLine не зациклился на 2-колоночных глифах при maxWidth=1 */
			const base = super.render(Math.max(3, innerW));
			const visCount = this.internals().renderedVisibleLineCount ?? Math.max(1, base.length - 2);
			this.totalVisualLineCount = Math.max(this.totalVisualLineCount, visCount);
			const out: string[] = [`${bLine("╭")}${bLine("─".repeat(innerW))}${bLine("╮")}`];
			for (let i = 0; i < visCount; i++) {
				const raw = base[1 + i] ?? "";
				out.push(`${bLine("│")}${fitExactWidth(raw, innerW)}${bLine("│")}`);
			}
			out.push(`${bLine("╰")}${bLine("─".repeat(innerW))}${bLine("╯")}`);
			for (let idx = visCount + 2; idx < base.length; idx++) {
				out.push(` ${fitExactWidth(base[idx] ?? "", innerW)} `);
			}
			return out;
		}

		const outerPad = computeOuterCanvasMargin(width);
		const outerMargin = " ".repeat(outerPad);
		const boxWidth = width - outerPad * 2;
		const innerWidth = boxWidth - 6;
		const internal = this.internals();
		const maxVisibleLines = computeComposerMaxVisibleLines(this.tui?.terminal?.rows ?? 24);
		const layoutWidth = Math.max(1, innerWidth - 1);

		let visibleBodyRawLines: string[];
		let visibleRows: number;
		let hiddenBelow = 0;
		let autocompleteLines: string[] = [];

		if (typeof internal.layoutText === "function") {
			internal.lastWidth = layoutWidth;
			const layoutLines = internal.layoutText(layoutWidth);
			this.totalVisualLineCount = Math.max(1, layoutLines.length);
			let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
			if (cursorLineIndex === -1) cursorLineIndex = 0;

			if (!this.manualScrollActive) {
				if (cursorLineIndex < internal.scrollOffset) {
					internal.scrollOffset = cursorLineIndex;
				} else if (cursorLineIndex >= internal.scrollOffset + maxVisibleLines) {
					internal.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
				}
			}
			const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
			internal.scrollOffset = Math.max(0, Math.min(internal.scrollOffset, maxScrollOffset));

			const slice = layoutLines.slice(internal.scrollOffset, internal.scrollOffset + maxVisibleLines);
			visibleRows = Math.max(1, slice.length);
			internal.renderedVisibleLineCount = visibleRows;
			hiddenBelow = Math.max(0, layoutLines.length - (internal.scrollOffset + slice.length));
			visibleBodyRawLines = slice.map((ll) => this.renderLayoutLineWithCursor(ll, innerWidth));

			internal.renderedAutocompleteHeight = 0;
			if (internal.autocompleteState && internal.autocompleteList) {
				autocompleteLines = internal.autocompleteList.render(innerWidth);
				internal.renderedAutocompleteHeight = autocompleteLines.length;
			}
		} else {
			const baseLines = super.render(innerWidth);
			visibleRows = internal.renderedVisibleLineCount ?? Math.max(1, baseLines.length - 2);
			this.totalVisualLineCount = Math.max(visibleRows, internal.scrollOffset + visibleRows);
			visibleBodyRawLines = baseLines.slice(1, 1 + visibleRows);
			autocompleteLines = baseLines.slice(visibleRows + 2);
		}

		const theme = this.deps.getTheme();
		const light = isLightTheme(theme);
		const chevron = light ? fgRgb(37, 99, 235, "›") : fgRgb(125, 207, 255, "›");
		const hooks = getComposerHooks();
		const isEmpty = internal.isEditorEmpty();
		let activePlaceholder: string | undefined;
		if (this.isDraftCompletelyEmpty()) {
			for (const featureHook of listAllComposerHooks()) {
				const candidate = featureHook.getEmptyPlaceholder?.(this);
				if (candidate) {
					activePlaceholder = candidate;
					break;
				}
			}
		}

		const out: string[] = [];
		out.push(this.renderRoundedTopBorder(boxWidth, outerPad));

		for (let i = 0; i < visibleRows; i++) {
			const visualIdx = internal.scrollOffset + i;
			const leftPrefix =
				visualIdx === 0
					? `${outerMargin}${bLine("│")} ${chevron} `
					: `${outerMargin}${bLine("│")}   `;
			const rightSuffix = ` ${bLine("│")}${outerMargin}`;

			let cell: string;
			if (isEmpty && i === 0) {
				cell = this.renderEmptyPlaceholderCell(innerWidth, activePlaceholder ?? COMPOSER_PLACEHOLDER);
			} else {
				const rawInner = visibleBodyRawLines[i] ?? "";
				const decorated = hooks?.decorateRenderedLine
					? hooks.decorateRenderedLine(rawInner, visualIdx, this)
					: rawInner;
				cell = fitExactWidth(decorated, innerWidth);
			}

			out.push(`${leftPrefix}${cell}${rightSuffix}`);
		}

		out.push(this.renderRoundedBottomBorder(boxWidth, outerPad, hiddenBelow, visibleRows + 1));

		const acLeftPad = " ".repeat(outerPad + 4);
		const acRightPad = " ".repeat(outerPad + 2);
		for (const acLine of autocompleteLines) {
			out.push(`${acLeftPad}${fitExactWidth(acLine, innerWidth)}${acRightPad}`);
		}

		return out;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const hooks = getComposerHooks();
		const totalWidth = event.width ?? 80;
		const boxEvent = event;
		const { compact, leftOffset, innerWidth, visualLines } = this.resolveBoxLayout(totalWidth);
		const internal = this.internals();
		const visibleRows = internal.renderedVisibleLineCount ?? 1;
		const bottomBorderRow = visibleRows + 1;
		const autocompleteStartRow = visibleRows + 2;
		const inBox = boxEvent.y >= 0 && boxEvent.y < autocompleteStartRow;
		let hoverStateChanged = false;

		/* Локальная прокрутка переполненного черновика Composer с overscroll = "contain" */
		if (boxEvent.type === "wheel" && boxEvent.wheelDelta && inBox) {
			if (visualLines.length > visibleRows) {
				const maxScroll = Math.max(0, visualLines.length - visibleRows);
				const prevScroll = internal.scrollOffset ?? 0;
				const nextScroll = Math.max(0, Math.min(maxScroll, prevScroll + boxEvent.wheelDelta));
				const changed = nextScroll !== prevScroll;
				this.manualScrollActive = true;
				if (changed) {
					internal.scrollOffset = nextScroll;
				}
				return { handled: true, render: changed };
			}
		}

		const findBorderHit = (x: number, y: number): HitBox | undefined => {
			if (y === 0) return this.topHits.find((h) => x >= h.xStart && x < h.xEnd);
			if (y === bottomBorderRow) return this.bottomHits.find((h) => x >= h.xStart && x < h.xEnd);
			return undefined;
		};

		if (boxEvent.type === "move") {
			if (inBox) {
				claimHover(this, () => {
					if (this.editorHovered || this.hoveredBadge) {
						this.editorHovered = false;
						this.hoveredBadge = null;
						hooks?.onPointerOrCursorChange?.({ hovered: false }, this);
						this.tui.requestRender();
					}
				});
				hooks?.onPointerOrCursorChange?.(
					{
						hovered: true,
						mouseX: boxEvent.x,
						mouseY: boxEvent.y,
						screenX: boxEvent.screenX,
						screenY: boxEvent.screenY,
						width: totalWidth,
					},
					this,
				);
				const nextBadge = findBorderHit(boxEvent.x, boxEvent.y)?.id ?? null;
				if (!this.editorHovered || nextBadge !== this.hoveredBadge) {
					this.editorHovered = true;
					this.hoveredBadge = nextBadge;
					hoverStateChanged = true;
				}
			} else if (this.editorHovered || this.hoveredBadge) {
				this.editorHovered = false;
				this.hoveredBadge = null;
				hooks?.onPointerOrCursorChange?.({ hovered: false }, this);
				hoverStateChanged = true;
			}
			if (inBox) {
				return hoverStateChanged ? { handled: true, render: true } : undefined;
			}
		}

		/* Перехватываем press на пилюлях и зонах рамок, чтобы быстрый повторный клик (<500мс) не запускал выделение слова */
		if (
			boxEvent.type === "press" &&
			boxEvent.button === "left" &&
			(boxEvent.y === 0 || boxEvent.y === bottomBorderRow)
		) {
			const hit = findBorderHit(boxEvent.x, boxEvent.y);
			if (hit) {
				return { handled: true, focus: true, render: false };
			}
		}

		if (
			boxEvent.type === "click" &&
			boxEvent.button === "left" &&
			(boxEvent.y === 0 || boxEvent.y === bottomBorderRow)
		) {
			const hit = findBorderHit(boxEvent.x, boxEvent.y);
			if (hit) {
				hit.onClick();
				return { handled: true, focus: true, render: true };
			}
			return { handled: true, focus: true };
		}

		if (boxEvent.type === "click" && boxEvent.y >= 1 && boxEvent.y <= visibleRows) {
			this.manualScrollActive = false;
			if (boxEvent.button === "left" && boxEvent.y === 1 && this.isDraftCompletelyEmpty()) {
				for (const featureHook of listAllComposerHooks()) {
					if (featureHook.onEmptyPlaceholderClick?.(this)) {
						return { handled: true, focus: true, render: true };
					}
				}
			}
		}

		if (
			boxEvent.y >= autocompleteStartRow &&
			boxEvent.type !== "wheel" &&
			(boxEvent.x < leftOffset || boxEvent.x >= leftOffset + innerWidth)
		) {
			if (boxEvent.type === "click") {
				return { handled: true, focus: true, ...(hoverStateChanged ? { render: true } : {}) };
			}
			return hoverStateChanged ? { handled: true, render: true } : undefined;
		}

		const translatedWidth = compact ? Math.max(3, innerWidth) : innerWidth;
		const translatedX = Math.max(0, Math.min(innerWidth, boxEvent.x - leftOffset));
		const superResult = super.handleMouse({
			...boxEvent,
			x: translatedX,
			width: translatedWidth,
		});
		if (boxEvent.type === "click") {
			hooks?.onPointerOrCursorChange?.(
				{
					hovered: this.editorHovered,
					mouseX: boxEvent.x,
					mouseY: boxEvent.y,
					screenX: boxEvent.screenX,
					screenY: boxEvent.screenY,
					width: totalWidth,
				},
				this,
			);
		}
		if (hoverStateChanged) {
			return { ...(superResult ?? { handled: true }), handled: true, render: true };
		}
		return superResult;
	}
}

export function mountComposer(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	installMidTurnQueueUi(() => ctx.ui.theme);
	bindComposerWorkingIndicator(ctx);

	const apiKey = pi as unknown as object;
	let previousFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	if (UPSTREAM_EDITOR_FACTORIES.has(apiKey)) {
		previousFactory = UPSTREAM_EDITOR_FACTORIES.get(apiKey);
	} else {
		const currentFactory = ctx.ui.getEditorComponent() as
			| (NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>> & {
					[COMPOSER_FACTORY_ORIGIN]?: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
			  })
			| undefined;
		previousFactory =
			currentFactory && COMPOSER_FACTORY_ORIGIN in currentFactory
				? currentFactory[COMPOSER_FACTORY_ORIGIN]
				: currentFactory;
		UPSTREAM_EDITOR_FACTORIES.set(apiKey, previousFactory);
	}

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
		setActiveComposerEditor(editor);

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

	registerSlotOwnershipChangeListener("composer.editorSlot", (slotId, ownerId) => {
		if (slotId !== "editor") return;
		if (ownerId !== PI_UI_OWNER_ID) {
			getActiveComposerEditor()?.dispose();
			setActiveComposerEditor(undefined);
		}
	});

	ctx.ui.setEditorComponent(factory);
}
