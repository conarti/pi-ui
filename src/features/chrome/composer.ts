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
import {
	fgRgb,
	getThemeSurfacePalette,
	isLightTheme,
	renderPill,
	themeFgRgb,
	type HitBox,
	type RgbTuple,
} from "../../shared/ansi.ts";
import { matchesLayoutChord } from "../../shared/keyboard-layout.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { getSessionWorkflow, MODE_META } from "../../shared/session-workflow.ts";
import { runAppAction, setAppActionRunner, setRequestRender } from "../../shared/ui-action-bridge.ts";
import { cycleSessionMode, setSessionMode } from "../plan-studio/index.ts";
import { showPlanStudio } from "../plan-studio/studio-overlay.ts";
import {
	getPrototypeTurnElapsedLabel,
	isPrototypeActive,
	renderPrototypeBorderWorkingStatus,
} from "../transcript/prototype-state.ts";
import { bindComposerWorkingIndicator, buildWaveIndicator } from "./working-indicator.ts";

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

export const COMPOSER_PLACEHOLDER = "Спроси или опиши задачу…";

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

interface EditorInternals {
	lastWidth?: number;
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction: unknown;
	scrollOffset: number;
	renderedVisibleLineCount: number;
	isInPaste?: boolean;
	pasteBuffer?: string;
	undoStack?: { length: number; clear?: () => void };
	setCursorCol(col: number): void;
	isEditorEmpty(): boolean;
	insertTextAtCursor(text: string): void;
	buildVisualLineMap?(width: number): Array<{ logicalLine: number; startCol: number; length: number }>;
	findCurrentVisualLine?(visualLines: Array<{ logicalLine: number; startCol: number; length: number }>): number;
	moveToVisualLine?(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void;
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

export class PiUiComposerEditor extends CustomEditor {
	private deps: PiUiComposerDeps;
	private editorHovered = false;
	private hoveredBadge: string | null = null;
	private topHits: HitBox[] = [];
	private undoSnapshots: unknown[] = [];
	private pendingUndoCapture: { hasValue: boolean; value: unknown } | undefined;
	private restoringUndo = false;
	private acceptedSuggestionUndoArmed = false;

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
		readonly leadInRows: number;
		readonly leftOffset: number;
		readonly innerWidth: number;
		readonly visualLines: Array<{ logicalLine: number; startCol: number; length: number }>;
	} {
		const internal = this.internals();
		const compact = totalWidth < 9;
		const protoOn = isPrototypeActive();
		const outerPad = !compact && protoOn && totalWidth >= 40 ? 2 : 0;
		const leadInRows = !compact && protoOn ? 1 : 0;
		const leftOffset = compact ? 1 : outerPad + 4;
		const innerWidth = Math.max(1, compact ? totalWidth - 2 : totalWidth - 6 - outerPad * 2);
		const fallbackWrapWidth = Math.max(1, (compact ? Math.max(3, innerWidth) : innerWidth) - 1);
		const wrapWidth = internal.lastWidth && internal.lastWidth > 0 ? internal.lastWidth : fallbackWrapWidth;
		const visualLines =
			internal.buildVisualLineMap?.(wrapWidth) ??
			internal.state.lines.map((line, idx) => ({
				logicalLine: idx,
				startCol: 0,
				length: line.length,
			}));
		return { compact, outerPad, leadInRows, leftOffset, innerWidth, visualLines };
	}

	getTui(): TUI {
		return this.tui;
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
		const lead = isPrototypeActive() ? 1 : 0;
		return (this.internals().renderedVisibleLineCount ?? 1) + 2 + lead;
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
		const { leadInRows, leftOffset, visualLines } = this.resolveBoxLayout(totalWidth);
		const visibleRows = internal.renderedVisibleLineCount ?? Math.max(1, internal.state.lines.length);
		const boxRelY = mouseY - leadInRows;
		if (boxRelY < 1 || boxRelY > visibleRows) return undefined;

		const visualIdx = (internal.scrollOffset ?? 0) + (boxRelY - 1);
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

	resolveFrameBorderRgb(): RgbTuple {
		const st = getSessionWorkflow();
		const theme = this.deps.getTheme();
		if (isPrototypeActive()) {
			const pal = getThemeSurfacePalette(theme);
			if (st.mode === "plan") return pal.warning;
			return pal.borderSubtle;
		}
		const light = isLightTheme(theme);
		if (st.mode === "plan") return light ? [180, 83, 9] : [196, 160, 92];
		if (st.mode === "safe") return light ? [15, 118, 110] : [76, 162, 174];
		if (st.isStreaming) return light ? [37, 99, 235] : [97, 175, 239];
		if (this.editorHovered) return light ? [59, 130, 246] : [92, 138, 198];
		if (this.focused) return light ? [148, 163, 184] : [76, 91, 115];
		return light ? [203, 213, 225] : [52, 62, 80];
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
				this.insertTextWithUndoSnapshot(transformed, preCaptured);
				return;
			}
			baseEditorProto.handlePaste.call(this, pastedText);
		};

		self.pushUndoSnapshot = (): void => {
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
			const beforeDepth = internal.undoStack?.length ?? 0;
			this.restoringUndo = true;
			try {
				baseEditorProto.undo.call(this);
			} finally {
				this.restoringUndo = false;
			}
			const afterDepth = internal.undoStack?.length ?? 0;
			if (afterDepth < beforeDepth) {
				this.undoSnapshots.length = Math.min(this.undoSnapshots.length, beforeDepth);
				const snap = this.undoSnapshots.pop();
				this.undoSnapshots.length = afterDepth;
				const hooks = getComposerHooks();
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
				this.acceptedSuggestionUndoArmed = false;
				origClear();
			};
		}

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
		this.pendingUndoCapture = { hasValue: true, value: preCapturedSnapshot };
		try {
			this.internals().insertTextAtCursor(text);
		} finally {
			this.pendingUndoCapture = undefined;
		}
	}

	setTextWithUndoSnapshot(text: string, preCapturedSnapshot?: unknown): void {
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

	override handleInput(data: string): void {
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
		if (!data.startsWith("\x1b[200~") && this.onExtensionShortcut?.(data)) {
			return;
		}
		if (
			!data.startsWith("\x1b[200~") &&
			!isKeyRelease(data) &&
			!this.isShowingAutocomplete() &&
			!hasBlockingModalOverlay(this.tui)
		) {
			if (isPrototypeActive() && matchesKey(data, "shift+tab")) {
				cycleSessionMode(this.deps.pi, this.deps.ctx);
				return;
			}
			const isUserCtrlZUndo =
				matchesLayoutChord(data, "ctrl+z") &&
				this.matchesKeybinding(data, "tui.editor.undo");
			if (
				(this.acceptedSuggestionUndoArmed && matchesLayoutChord(data, "ctrl+z")) ||
				isUserCtrlZUndo
			) {
				(this as unknown as { undo(): void }).undo();
				if (internal.isEditorEmpty()) {
					this.acceptedSuggestionUndoArmed = false;
				}
				hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
				this.tui.requestRender();
				return;
			}

			if (this.isDraftCompletelyEmpty()) {
				for (const featureHook of listAllComposerHooks()) {
					if (featureHook.interceptEmptyDraftInput?.(data, this)) {
						hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
						this.tui.requestRender();
						return;
					}
				}
			}
		}
		if (hooks?.interceptInput?.(data, this)) {
			return;
		}
		if (data.includes("\x1b[200~")) {
			baseEditorProto.handleInput.call(this, data);
			hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
			return;
		}
		const isAltEnter =
			matchesKey(data, "alt+enter") || matchesKey(data, "alt+return") || data === "\x1b\r" || data === "\x1b\n";
		if (isAltEnter) {
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

	private renderGrokLeadInWorkingRow(width: number, outerPad: number): string {
		const { ctx } = this.deps;
		const theme = this.deps.getTheme();
		const pal = getThemeSurfacePalette(theme);
		const anySelf = this as unknown as {
			embedWorkingStatus?: boolean;
			workingStatusIndicator?: {
				renderInBorder?: (maxWidth: number) => string;
			};
		};
		if (!anySelf.embedWorkingStatus || !anySelf.workingStatusIndicator) {
			return " ".repeat(width);
		}
		const probe = anySelf.workingStatusIndicator.renderInBorder?.(Math.max(12, width - 20)) ?? "";
		if (visibleWidth(probe) === 0) {
			return " ".repeat(width);
		}

		const stopHov = this.hoveredBadge === "stop";
		const stopLabel = stopHov
			? theme.fg("text", "[stop]")
			: themeFgRgb(theme, pal.codeMetaFg, "[stop]");
		const elapsed = getPrototypeTurnElapsedLabel();
		const rightStr = elapsed
			? `${themeFgRgb(theme, pal.codeMetaFg, elapsed)}  ${stopLabel}`
			: stopLabel;
		const rightW = visibleWidth(rightStr);
		const maxLeftW = Math.max(12, width - outerPad * 2 - rightW - 3);
		const leftStatus = renderPrototypeBorderWorkingStatus(maxLeftW, { theme });
		const leftW = visibleWidth(leftStatus);
		const gap = Math.max(1, width - outerPad * 2 - leftW - rightW);

		const stopW = 6;
		const stopX = outerPad + leftW + gap + (rightW - stopW);
		this.topHits.push({
			id: "stop",
			xStart: stopX,
			xEnd: stopX + stopW,
			y: 0,
			onClick: () => {
				ctx.abort();
				this.tui.requestRender();
			},
		});

		const line = `${" ".repeat(outerPad)}${leftStatus}${" ".repeat(gap)}${rightStr}${" ".repeat(outerPad)}`;
		return fitExactWidth(line, width);
	}

	private renderRoundedTopBorder(boxWidth: number, outerPad = 0, borderY = 0): string {
		const spanWidth = Math.max(0, boxWidth - 2);
		const bLine = (s: string) => this.paintBorder(s);
		const margin = " ".repeat(outerPad);
		if (spanWidth === 0) {
			return `${margin}${bLine("╭")}${bLine("╮")}${margin}`;
		}

		const { pi, ctx } = this.deps;
		const theme = this.deps.getTheme();
		const st = getSessionWorkflow();

		/* In Grok prototype mode, top border stays clean and quiet (status row sits above, model/mode sit on bottom border) */
		if (isPrototypeActive()) {
			const pal = getThemeSurfacePalette(theme);
			if (st.planLines.length > 0) {
				const commentCount = Object.keys(st.planComments).length;
				const label =
					commentCount > 0 ? `[Plan review (${commentCount})]` : "[Plan review]";
				const styled =
					this.hoveredBadge === "plan"
						? theme.fg("text", label)
						: themeFgRgb(theme, pal.warning, label);
				const pw = visibleWidth(label);
				if (pw + 4 <= spanWidth) {
					const fill = spanWidth - pw - 3;
					const xStart = outerPad + 1 + fill + 1;
					this.topHits.push({
						id: "plan",
						xStart,
						xEnd: xStart + pw,
						y: borderY,
						onClick: () => void showPlanStudio(pi, ctx),
					});
					return fitExactWidth(
						`${margin}${bLine("╭")}${bLine("─".repeat(fill))} ${styled} ${bLine("─")}${bLine("╮")}${margin}`,
						boxWidth + outerPad * 2,
					);
				}
			}
			const scrollOffset = this.internals().scrollOffset;
			if (scrollOffset > 0 && spanWidth >= 10) {
				const upHint = themeFgRgb(theme, pal.codeMetaFg, ` ↑ ${scrollOffset} `);
				const rem = Math.max(0, spanWidth - visibleWidth(upHint));
				const l = Math.floor(rem / 2);
				const r = rem - l;
				return fitExactWidth(
					`${margin}${bLine("╭")}${bLine("─".repeat(l))}${upHint}${bLine("─".repeat(r))}${bLine("╮")}${margin}`,
					boxWidth + outerPad * 2,
				);
			}
			return `${margin}${bLine("╭")}${bLine("─".repeat(spanWidth))}${bLine("╮")}${margin}`;
		}

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

		let curX = outerPad + visibleWidth(row);
		for (const pill of fittingPills) {
			const pw = visibleWidth(pill.str);
			this.topHits.push({
				id: pill.id,
				xStart: curX,
				xEnd: curX + pw,
				y: borderY,
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
		bottomY: number,
		hiddenBelow: number,
	): string {
		const bLine = (s: string) => this.paintBorder(s);
		const margin = " ".repeat(outerPad);
		const bottomSpan = Math.max(0, boxWidth - 2);
		const theme = this.deps.getTheme();

		if (!isPrototypeActive()) {
			const downBadge = hiddenBelow > 0 ? theme.fg("dim", ` ↓ ${hiddenBelow} `) : "";
			const downBadgeW = visibleWidth(downBadge);
			if (downBadgeW > 0 && downBadgeW + 4 <= bottomSpan) {
				const rem = bottomSpan - downBadgeW;
				const leftD = Math.floor(rem / 2);
				const rightD = rem - leftD;
				return `${margin}${bLine("╰")}${bLine("─".repeat(leftD))}${downBadge}${bLine("─".repeat(rightD))}${bLine("╯")}${margin}`;
			}
			return `${margin}${bLine("╰")}${bLine("─".repeat(bottomSpan))}${bLine("╯")}${margin}`;
		}

		/* Grok bottom-right border label: `─── Model (thinking) · always-approve ──╯` */
		const { pi, ctx } = this.deps;
		const pal = getThemeSurfacePalette(theme);
		const st = getSessionWorkflow();
		const rawModel = ctx.model?.name || ctx.model?.id || "model";
		const thinkingLevel = pi.getThinkingLevel?.() ?? "off";
		const modelPlain =
			thinkingLevel && thinkingLevel !== "off"
				? `${rawModel} (${thinkingLevel})`
				: rawModel;
		const modePlain =
			st.mode === "plan" ? "plan" : st.mode === "safe" ? "auto" : "always-approve";

		const isModelHov = this.hoveredBadge === "bottom:model";
		const isModeHov = this.hoveredBadge === "bottom:mode";
		const styledModel = isModelHov
			? theme.fg("text", modelPlain)
			: themeFgRgb(theme, pal.codeMetaFg, modelPlain);
		const styledMode = isModeHov
			? theme.fg("text", modePlain)
			: st.mode === "plan"
				? themeFgRgb(theme, pal.warning, modePlain)
				: st.mode === "safe"
					? themeFgRgb(theme, pal.accent, modePlain)
					: themeFgRgb(theme, pal.codeMetaFg, modePlain);
		const dot = themeFgRgb(theme, pal.borderSubtle, " · ");
		const metaBlock = ` ${styledModel}${dot}${styledMode} `;
		const metaW = visibleWidth(metaBlock);

		if (metaW + 5 <= bottomSpan) {
			const trailDashes = 2;
			const leadDashes = Math.max(1, bottomSpan - metaW - trailDashes);
			const modelStartX = outerPad + 1 + leadDashes + 1;
			const modelW = visibleWidth(modelPlain);
			const modeStartX = modelStartX + modelW + 3;
			const modeW = visibleWidth(modePlain);

			this.topHits.push({
				id: "bottom:model",
				xStart: modelStartX,
				xEnd: modelStartX + modelW,
				y: bottomY,
				onClick: () => {
					runAppAction("app.thinking.cycle");
					this.tui.requestRender();
				},
			});
			this.topHits.push({
				id: "bottom:mode",
				xStart: modeStartX,
				xEnd: modeStartX + modeW,
				y: bottomY,
				onClick: () => cycleSessionMode(pi, ctx),
			});

			return fitExactWidth(
				`${margin}${bLine("╰")}${bLine("─".repeat(leadDashes))}${metaBlock}${bLine("─".repeat(trailDashes))}${bLine("╯")}${margin}`,
				boxWidth + outerPad * 2,
			);
		}

		return `${margin}${bLine("╰")}${bLine("─".repeat(bottomSpan))}${bLine("╯")}${margin}`;
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

	override render(width: number): string[] {
		this.topHits = [];
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

		const { outerPad, leadInRows, innerWidth, visualLines } = this.resolveBoxLayout(width);
		const boxWidth = width - outerPad * 2;
		const margin = " ".repeat(outerPad);
		const baseLines = super.render(innerWidth);
		const internal = this.internals();
		const visibleRows = internal.renderedVisibleLineCount ?? Math.max(1, baseLines.length - 2);
		const theme = this.deps.getTheme();
		const pal = getThemeSurfacePalette(theme);
		const chevron = themeFgRgb(theme, pal.accent, "›");
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
		(this as any).__conartiHasSuggestion = Boolean(activePlaceholder);

		const out: string[] = [];
		if (leadInRows > 0) {
			out.push(this.renderGrokLeadInWorkingRow(width, outerPad));
		}
		out.push(this.renderRoundedTopBorder(boxWidth, outerPad, leadInRows));

		for (let i = 0; i < visibleRows; i++) {
			const visualIdx = internal.scrollOffset + i;
			const leftPrefix =
				visualIdx === 0 ? `${margin}${bLine("│")} ${chevron} ` : `${margin}${bLine("│")}   `;
			const rightSuffix = ` ${bLine("│")}${margin}`;

			let cell: string;
			if (isEmpty && i === 0) {
				const fallbackText = isPrototypeActive() ? "" : COMPOSER_PLACEHOLDER;
				cell = this.renderEmptyPlaceholderCell(innerWidth, activePlaceholder ?? fallbackText);
			} else {
				const rawInner = baseLines[1 + i] ?? "";
				const decorated = hooks?.decorateRenderedLine
					? hooks.decorateRenderedLine(rawInner, visualIdx, this)
					: rawInner;
				cell = fitExactWidth(decorated, innerWidth);
			}

			out.push(`${leftPrefix}${cell}${rightSuffix}`);
		}

		const hiddenBelow = isPrototypeActive()
			? Math.max(0, visualLines.length - (internal.scrollOffset + visibleRows))
			: 0;
		const bottomY = leadInRows + 1 + visibleRows;
		out.push(this.renderRoundedBottomBorder(boxWidth, outerPad, bottomY, hiddenBelow));

		for (let idx = visibleRows + 2; idx < baseLines.length; idx++) {
			out.push(`${margin}    ${fitExactWidth(baseLines[idx] ?? "", innerWidth)}  ${margin}`);
		}

		return out;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const hooks = getComposerHooks();
		const totalWidth = event.width ?? 80;
		const { compact, leadInRows, leftOffset, innerWidth, visualLines } = this.resolveBoxLayout(totalWidth);
		const internal = this.internals();
		const visibleRows = internal.renderedVisibleLineCount ?? 1;
		const autocompleteStartRow = leadInRows + visibleRows + 2;
		const inBox = event.y >= 0 && event.y < autocompleteStartRow;
		let hoverStateChanged = false;

		/* Прокрутка колесом мыши внутри многострочного черновика Composer, когда текст переполняет видимое окно */
		const evType = String(event.type);
		if (
			inBox &&
			(evType === "wheel" || evType === "mouse_wheel_up" || evType === "mouse_wheel_down") &&
			visualLines.length > visibleRows
		) {
			const maxScroll = Math.max(0, visualLines.length - visibleRows);
			const step =
				evType === "mouse_wheel_up"
					? -2
					: evType === "mouse_wheel_down"
						? 2
						: ((event as unknown as { deltaY?: number }).deltaY ?? 0) < 0
							? -2
							: 2;
			const nextScroll = Math.max(0, Math.min(maxScroll, internal.scrollOffset + step));
			if (nextScroll !== internal.scrollOffset) {
				if (internal.findCurrentVisualLine && internal.moveToVisualLine) {
					const curVL = internal.findCurrentVisualLine(visualLines);
					const clampedVL = Math.max(nextScroll, Math.min(nextScroll + visibleRows - 1, curVL));
					if (clampedVL !== curVL) {
						internal.moveToVisualLine(visualLines, curVL, clampedVL);
					}
				}
				internal.scrollOffset = nextScroll;
				hooks?.onPointerOrCursorChange?.({ hovered: this.editorHovered }, this);
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}

		if (event.type === "move") {
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
						mouseX: event.x,
						mouseY: event.y,
						screenX: event.screenX,
						screenY: event.screenY,
						width: totalWidth,
					},
					this,
				);
				const nextBadge =
					this.topHits.find(
						(h) => h.y === event.y && event.x >= h.xStart && event.x <= h.xEnd,
					)?.id ?? null;
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

		const borderHit = this.topHits.find(
			(h) => h.y === event.y && event.x >= h.xStart && event.x <= h.xEnd,
		);
		if (borderHit && event.button === "left") {
			if (event.type === "press") {
				return { handled: true, render: false };
			}
			if (event.type === "click") {
				borderHit.onClick();
				return { handled: true, focus: true, render: true };
			}
		}

		if (event.type === "click" && event.button === "left" && event.y <= leadInRows) {
			return { handled: true, focus: true };
		}

		if (
			event.y >= autocompleteStartRow &&
			event.type !== "wheel" &&
			(event.x < leftOffset || event.x >= leftOffset + innerWidth)
		) {
			if (event.type === "click") {
				return { handled: true, focus: true, ...(hoverStateChanged ? { render: true } : {}) };
			}
			return hoverStateChanged ? { handled: true, render: true } : undefined;
		}

		const translatedWidth = compact ? Math.max(3, innerWidth) : innerWidth;
		const translatedX = Math.max(0, Math.min(innerWidth, event.x - leftOffset));
		const translatedY = Math.max(0, event.y - leadInRows);
		const superResult = super.handleMouse({
			...event,
			x: translatedX,
			y: translatedY,
			width: translatedWidth,
		});
		if (event.type === "click") {
			hooks?.onPointerOrCursorChange?.(
				{
					hovered: this.editorHovered,
					mouseX: event.x,
					mouseY: event.y,
					screenX: event.screenX,
					screenY: event.screenY,
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

	ctx.ui.setEditorComponent(factory);
}
