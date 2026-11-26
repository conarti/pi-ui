import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	Input,
	Key,
	matchesKey,
	parseKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { blueBgRgb, fgRgb, getThemeSurfacePalette, type HitBox } from "../../shared/ansi.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { matchesLayoutChord } from "../../shared/keyboard-layout.ts";
import { hasBlockingModalOverlay, registerBlockingDialog } from "../../shared/modal-card.ts";
import { loadPiUiUserConfig } from "../../shared/pi-ui-config.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { setParkedAskUserController } from "../chrome/shortcuts-bar.ts";
import { display, editorDisplay } from "./display.ts";
import { explainer, type Explain, type Request } from "./explain.ts";
import { actionKeys, actionMatches } from "./keys.ts";
import { columns, Preview } from "./preview.ts";
import { result, type Result } from "./result.ts";
import { validate, type Params } from "./schema.ts";
import { QuestionnaireState } from "./state.ts";

export { hasBlockingModalOverlay };

const RESERVED_ROWS = 4;
const PREVIEW_ROWS = 12;
const TYPE_AHEAD_MS = 400;
const keyNames: Record<string, string> = {
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	escape: "Esc",
	enter: "Enter",
	tab: "Tab",
	space: "Space",
	pageUp: "PgUp",
	pageDown: "PgDn",
};
const keyLabel = (keys: string[]) =>
	keys[0]
		?.split("+")
		.map((part) => keyNames[part] ?? (part.length > 1 ? part[0].toUpperCase() + part.slice(1) : part))
		.join("+");
const fit = (text: string, width: number) =>
	visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…").replaceAll("\x1b[0m", "");

interface BodyRowAction {
	readonly id: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly onClick: (localX: number) => void;
}

interface TextUndoEntry {
	readonly text: string;
}

export class Questionnaire implements Component, Focusable {
	readonly state: QuestionnaireState;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (value: Result) => void;
	private editor: Editor;
	private editing = false;
	private parked = false;
	private field?: { tab: number; input: Input; undo: TextUndoEntry[]; redo: TextUndoEntry[] };
	private noteUndo: TextUndoEntry[] = [];
	private noteRedo: TextUndoEntry[] = [];
	private readonly preview = new Preview();
	private confirming = false;
	private discard = false;
	private reviewCursor = 0;
	private hasFocus = false;
	private scroll = 0;
	private followFocus = false;
	private readonly now: () => number;
	private quietUntil: number;
	private readonly explain: Explain;
	private explaining?: { tab: number; controller: AbortController; text: string };
	private explainError?: { tab: number; message: string };
	private hits: HitBox[] = [];
	private hoveredId: string | null = null;
	private readonly hoverOwner = {};
	private lastBodyWidth = 80;
	private lastWidePreview = false;
	private lastBodyLength = 0;
	private lastRoom = 1;

	constructor(
		params: Params,
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: (value: Result) => void,
		now = Date.now,
		explain: Explain = unavailable,
	) {
		this.state = new QuestionnaireState(params.questions);
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = (value) => {
			this.explaining?.controller.abort();
			setParkedAskUserController(undefined);
			done(value);
		};
		this.now = now;
		this.explain = explain;
		this.quietUntil = now() + TYPE_AHEAD_MS;
		this.editor = this.createEditor();
		setParkedAskUserController({
			isParked: () => this.parked,
			returnToQuestion: () => {
				if (!this.parked) return;
				this.parked = false;
				this.tui.requestRender();
			},
		});
	}

	get capturesViewportInput(): boolean {
		return !this.parked;
	}

	private createEditor(): Editor {
		const { tui, theme } = this;
		const editor = new Editor(tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		});
		editor.onChange = () => {
			const text = this.editor.getExpandedText();
			if (this.reviewing) this.state.globalNoteDraft = text;
			else this.state.answers[this.state.tab].noteDraft = text;
		};
		editor.onSubmit = (text) => {
			this.editing = false;
			this.editor.focused = false;
			this.resetScroll();
			this.state.saveNote(this.state.tab, text);
			this.tui.requestRender();
		};
		return editor;
	}

	get focused(): boolean {
		return this.hasFocus;
	}
	set focused(value: boolean) {
		this.hasFocus = value;
		this.editor.focused = value && this.editing;
	}
	invalidate(): void {
		this.editor.invalidate();
		this.preview.invalidate();
	}

	private get single(): boolean {
		return this.state.questions.length === 1;
	}
	private get reviewing(): boolean {
		return this.state.tab === this.state.questions.length;
	}
	private get typing(): boolean {
		const question = this.state.questions[this.state.tab];
		return (
			!!question &&
			!this.parked &&
			!this.editing &&
			!this.confirming &&
			this.state.answers[this.state.tab].cursor === question.options.length
		);
	}

	private resetScroll(): void {
		this.scroll = 0;
		this.followFocus = false;
	}

	private confirmAnswer(): void {
		if (!this.state.answered(this.state.tab)) return;
		if (this.single) this.done(result(this.state));
		else {
			this.state.advance();
			this.resetScroll();
		}
	}

	private requestCancel(): void {
		this.parked = false;
		if (!this.state.hasWork()) this.done(result(this.state, true));
		else {
			this.confirming = true;
			this.discard = false;
		}
	}

	private openNote(): void {
		this.parked = false;
		this.editor = this.createEditor();
		const initial = this.state.answers[this.state.tab]?.noteDraft ?? this.state.globalNoteDraft;
		this.editor.setText(initial);
		this.noteUndo = [];
		this.noteRedo = [];
		this.editing = true;
		this.editor.focused = this.focused;
	}

	private customField(): { tab: number; input: Input; undo: TextUndoEntry[]; redo: TextUndoEntry[] } {
		if (this.field?.tab === this.state.tab) return this.field;
		const input = new Input({
			prompt: "",
			placeholder: t("askUser.customPlaceholder"),
			placeholderStyle: (text) => this.theme.fg("muted", text),
		});
		input.setValue(this.state.answers[this.state.tab].draft);
		this.field = { tab: this.state.tab, input, undo: [], redo: [] };
		return this.field;
	}

	private customInput(): Input {
		return this.customField().input;
	}

	private syncCustomAnswer(value: string): void {
		const answer = this.state.answers[this.state.tab];
		if (this.state.questions[this.state.tab].multiSelect || answer.customActive) {
			this.state.saveCustom(this.state.tab, value);
		} else {
			answer.draft = value;
		}
	}

	private type(data: string): void {
		const field = this.customField();
		const input = field.input;
		if (matchesLayoutChord(data, "ctrl+shift+z") || matchesLayoutChord(data, "ctrl+y")) {
			const next = field.redo.pop();
			if (next) {
				field.undo.push({ text: input.getValue() });
				input.setValue(next.text);
				this.syncCustomAnswer(next.text);
			}
			return;
		}
		if (matchesLayoutChord(data, "ctrl+z")) {
			const prev = field.undo.pop();
			if (prev) {
				field.redo.push({ text: input.getValue() });
				input.setValue(prev.text);
				this.syncCustomAnswer(prev.text);
			}
			return;
		}
		const before = input.getValue();
		input.handleInput(data);
		const after = input.getValue();
		if (after !== before) {
			field.undo.push({ text: before });
			if (field.undo.length > 100) field.undo.shift();
			field.redo.length = 0;
		}
		this.syncCustomAnswer(after);
	}

	private submitCustom(): void {
		const answer = this.state.answers[this.state.tab];
		if (this.state.questions[this.state.tab].multiSelect) {
			answer.cursor++;
			this.followFocus = true;
			return;
		}
		if (!answer.draft.trim()) return;
		this.state.saveCustom(this.state.tab, answer.draft);
		this.confirmAnswer();
	}

	private startExplain(): void {
		this.parked = false;
		if (this.explaining?.tab === this.state.tab) return;
		this.stopExplain();
		const tab = this.state.tab;
		const run = { tab, controller: new AbortController(), text: "" };
		this.explaining = run;
		this.explainError = undefined;
		this.resetScroll();
		this.explain(tab, run.controller.signal, (text) => {
			run.text = text;
			this.tui.requestRender();
		})
			.then(
				(text) => {
					this.state.answers[tab].explanation = text;
				},
				(error: unknown) => {
					if (!run.controller.signal.aborted) {
						this.explainError = {
							tab,
							message: error instanceof Error ? error.message : String(error),
						};
					}
				},
			)
			.finally(() => {
				if (this.explaining === run) this.explaining = undefined;
				this.tui.requestRender();
			});
	}

	private stopExplain(): void {
		this.explaining?.controller.abort();
		this.explaining = undefined;
	}

	private previewText(): string {
		const question = this.state.questions[this.state.tab];
		return question?.options[this.state.answers[this.state.tab]?.cursor]?.preview ?? "";
	}

	/* Pi переводит фокус на опросник прямо во время набора, поэтому первые 400мс отбрасываем случайный type-ahead вне текстового ввода */
	private typedAhead(data: string, digit: number): boolean {
		if (this.typing || this.editing) return false;
		const time = this.now();
		if (time >= this.quietUntil) return false;
		this.quietUntil = time + TYPE_AHEAD_MS;
		return (
			this.keys.matches(data, "tui.select.confirm") ||
			digit >= 0 ||
			matchesKey(data, Key.space) ||
			actionMatches(this.keys, "pi-ask-user.note", data)
		);
	}

	private triggerPrimarySubmitAction(): void {
		this.parked = false;
		if (this.reviewing) {
			if (this.state.complete()) {
				this.done(result(this.state));
			} else {
				this.state.tab = this.state.answers.findIndex((_, i) => !this.state.answered(i));
				this.resetScroll();
			}
			return;
		}
		if (this.state.answered(this.state.tab)) {
			this.confirmAnswer();
		} else if (!this.single) {
			this.state.advance();
			this.resetScroll();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			if (this.lastWidePreview && event.x > this.lastBodyWidth + 1 && this.previewText()) {
				this.preview.setText(this.previewText());
				this.preview.scroll(event.wheelDelta < 0 ? -3 : 3);
				return { handled: true, render: true };
			}
			if (!this.editing && !this.confirming) {
				const maxScroll = Math.max(0, this.lastBodyLength - this.lastRoom);
				const next = Math.max(0, Math.min(maxScroll, this.scroll + event.wheelDelta));
				const changed = next !== this.scroll;
				this.scroll = next;
				this.followFocus = false;
				return { handled: true, render: changed };
			}
			return { handled: true, render: false };
		}

		const eventType: string = event.type;
		if (eventType === "mouse_wheel_up" || eventType === "mouse_wheel_down") {
			const delta = eventType === "mouse_wheel_up" ? -1 : 1;
			const count = Math.max(1, (event as { scrollDelta?: number }).scrollDelta ?? 1);
			this.scroll = Math.max(0, this.scroll + delta * count);
			this.followFocus = false;
			this.tui.requestRender();
			return { handled: true };
		}

		const hit = this.hits.find(
			(h) => h.y === event.y && event.x >= h.xStart && event.x < h.xEnd,
		);

		if (event.type === "move") {
			const nextHover = hit?.id ?? null;
			if (nextHover !== null) {
				claimHover(this.hoverOwner, () => {
					if (this.hoveredId !== null) {
						this.hoveredId = null;
						this.tui.requestRender();
					}
				});
			}
			if (nextHover !== this.hoveredId) {
				this.hoveredId = nextHover;
				return { handled: true, render: true };
			}
			return hit ? { handled: true, render: false } : undefined;
		}

		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}

		if (event.type === "click" && event.button === "left") {
			this.quietUntil = 0;
			if (this.parked) {
				this.parked = false;
			}
			if (hit) {
				hit.onClick();
				this.tui.requestRender();
				return { handled: true, render: true };
			}
			this.tui.requestRender();
			return { handled: true, render: true };
		}

		return undefined;
	}

	handleInput(data: string): void {
		const key = parseKey(data);
		const digit = key && /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
		if (this.typedAhead(data, digit)) return;

		const cancel = this.keys.matches(data, "tui.select.cancel");
		const confirm = this.keys.matches(data, "tui.select.confirm");
		const up = this.keys.matches(data, "tui.select.up");
		const down = this.keys.matches(data, "tui.select.down");

		/* Режим парковки фокуса в транскрипте: Tab возвращает в опросник, повторный Esc отменяет, ↑/↓ прокручивают ленту */
		if (this.parked) {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
				this.parked = false;
				this.tui.requestRender();
				return;
			}
			if (cancel) {
				this.requestCancel();
				this.tui.requestRender();
				return;
			}
			if (up || down) {
				const scroll = getActiveHostRuntime()?.scroll;
				if (scroll) {
					scroll.scrollTo(Math.max(0, scroll.scrollTop + (up ? -2 : 2)), {
						disableFollow: true,
					});
				}
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (
			!this.editing &&
			!this.confirming &&
			(matchesKey(data, Key.ctrl("up")) || matchesKey(data, Key.ctrl("down")))
		) {
			this.scroll = Math.max(0, this.scroll + (matchesKey(data, Key.ctrl("up")) ? -1 : 1));
			this.followFocus = false;
			this.tui.requestRender();
			return;
		}

		const arrows = !this.typing;
		const next = matchesKey(data, Key.tab) || (arrows && matchesKey(data, Key.right));
		const previous = matchesKey(data, Key.shift("tab")) || (arrows && matchesKey(data, Key.left));

		if (this.editing) {
			if (cancel) {
				this.editing = false;
				this.editor.focused = false;
			} else if (matchesLayoutChord(data, "ctrl+shift+z") || matchesLayoutChord(data, "ctrl+y")) {
				const redoEntry = this.noteRedo.pop();
				if (redoEntry) {
					this.noteUndo.push({ text: this.editor.getText() });
					this.editor.setText(redoEntry.text);
				}
			} else if (matchesLayoutChord(data, "ctrl+z")) {
				const undoEntry = this.noteUndo.pop();
				if (undoEntry) {
					this.noteRedo.push({ text: this.editor.getText() });
					this.editor.setText(undoEntry.text);
				}
			} else {
				const before = this.editor.getText();
				this.editor.handleInput(data);
				const after = this.editor.getText();
				if (after !== before) {
					this.noteUndo.push({ text: before });
					if (this.noteUndo.length > 100) this.noteUndo.shift();
					this.noteRedo.length = 0;
				}
			}
		} else if (this.confirming) {
			if (cancel) this.confirming = false;
			else if (up || down || next || previous) this.discard = !this.discard;
			else if (confirm || digit === 0 || digit === 1) {
				if (digit >= 0) this.discard = digit === 1;
				if (this.discard) this.done(result(this.state, true));
				else this.confirming = false;
			}
		} else if (cancel && this.explaining?.tab === this.state.tab) {
			this.stopExplain();
		} else if (cancel) {
			if (!this.state.hasWork()) {
				this.parked = true;
			} else {
				this.requestCancel();
			}
		} else if (!this.single && (next || previous)) {
			const count = this.state.questions.length + 1;
			this.state.tab = (this.state.tab + (next ? 1 : -1) + count) % count;
			this.resetScroll();
		} else if (this.typing && !up && !down) {
			if (confirm) this.submitCustom();
			else this.type(data);
		} else if (actionMatches(this.keys, "pi-ask-user.note", data)) {
			this.openNote();
		} else if (
			this.previewText() &&
			(actionMatches(this.keys, "pi-ask-user.previewUp", data) ||
				actionMatches(this.keys, "pi-ask-user.previewDown", data))
		) {
			this.preview.setText(this.previewText());
			this.preview.scroll(actionMatches(this.keys, "pi-ask-user.previewUp", data) ? -1 : 1);
		} else if (this.reviewing) {
			if (up || down) {
				this.reviewCursor = up ? 0 : 1;
				this.followFocus = true;
			} else if (confirm || digit === 0 || digit === 1) {
				if (digit >= 0) this.reviewCursor = digit;
				if (this.reviewCursor === 1) this.requestCancel();
				else if (this.state.complete()) this.done(result(this.state));
				else {
					this.state.tab = this.state.answers.findIndex((_, i) => !this.state.answered(i));
					this.resetScroll();
				}
			}
		} else {
			const question = this.state.questions[this.state.tab];
			const answer = this.state.answers[this.state.tab];
			const explainRow = question.options.length + (question.multiSelect ? 2 : 1);
			const chatRow = explainRow + 1;
			if (up || down) {
				answer.cursor = Math.max(0, Math.min(chatRow, answer.cursor + (up ? -1 : 1)));
				this.followFocus = true;
			} else if (digit >= 0 && digit <= question.options.length) {
				answer.cursor = digit;
				this.followFocus = true;
				if (digit < question.options.length) this.state.select(this.state.tab, digit);
				if (digit < question.options.length && !question.multiSelect) this.confirmAnswer();
			} else if (digit === question.options.length + 1 || (confirm && answer.cursor === explainRow)) {
				answer.cursor = explainRow;
				this.startExplain();
			} else if (digit === question.options.length + 2 || (confirm && answer.cursor === chatRow)) {
				this.done(result(this.state, false, true));
			} else if (
				question.multiSelect &&
				answer.cursor < question.options.length &&
				(confirm || matchesKey(data, Key.space))
			) {
				this.state.select(this.state.tab, answer.cursor);
			} else if (confirm) {
				if (!question.multiSelect) this.state.select(this.state.tab, answer.cursor);
				this.confirmAnswer();
			}
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		this.hits = [];
		if (width < 1) return [];
		const { state, theme } = this;
		const palette = getThemeSurfacePalette(theme);
		const height = Math.max(1, this.tui.terminal.rows - RESERVED_ROWS);
		const previewText = !this.editing && !this.confirming ? this.previewText() : "";
		const wide = !!previewText && width >= 100 && height >= 8;
		const hasPreview = wide || (!!previewText && height >= 20);
		const bodyWidth = wide ? Math.floor((width - 3) / 2) : width;
		this.lastBodyWidth = bodyWidth;
		this.lastWidePreview = wide;

		const body: string[] = [];
		const bodyActions: BodyRowAction[] = [];

		const add = (text: string, prefix = "", indent = visibleWidth(prefix), hoverId?: string) => {
			const isHov = hoverId !== undefined && this.hoveredId === hoverId;
			wrapTextWithAnsi(text, Math.max(1, bodyWidth - indent)).forEach((part, i) => {
				const raw = (i ? " ".repeat(indent) : prefix) + part;
				const pad = isHov ? " ".repeat(Math.max(0, bodyWidth - visibleWidth(raw))) : "";
				body.push(isHov ? blueBgRgb(theme, palette.hoveredRowBg, `${raw}${pad}`) : raw);
			});
		};

		let focusLine = 0;
		const choice = (
			index: number,
			text: string,
			focused: boolean,
			action?: { id: string; onClick: (localX: number) => void },
		) => {
			const startLine = body.length;
			if (focused) focusLine = startLine;
			const prefix = `${focused ? "❯ " : "  "}${index < 9 ? `${index + 1}. ` : "   "}`;
			add(
				focused ? theme.fg("accent", text) : text,
				focused ? theme.fg("accent", prefix) : prefix,
				visibleWidth(prefix),
				action?.id,
			);
			if (action) {
				bodyActions.push({
					id: action.id,
					startLine,
					endLine: body.length,
					onClick: action.onClick,
				});
			}
		};

		const hints: string[] = [];
		const hint = (keys: string | undefined, action: string) => {
			if (keys) hints.push(`${keys} ${action}`);
		};
		const navigate = `${keyLabel(this.keys.getKeys("tui.select.up"))}/${keyLabel(this.keys.getKeys("tui.select.down"))}`;
		const switchHint = (arrows = true) => {
			if (!this.single) hint(arrows ? "Tab/←→" : "Tab", t("askUser.hint.switch"));
		};
		const noteHint = () => hint(keyLabel(actionKeys(this.keys, "pi-ask-user.note")), t("askUser.hint.note"));
		const confirmKey = keyLabel(this.keys.getKeys("tui.select.confirm"));
		const cancelKey = keyLabel(this.keys.getKeys("tui.select.cancel"));
		let cancelHint = t("askUser.hint.cancel", { key: cancelKey });

		const actionButtons: Array<{ id: string; label: string; tone?: "accent" | "danger"; onClick: () => void }> = [];

		if (this.confirming) {
			add(theme.bold(t("askUser.confirmDiscard")));
			body.push("");
			[t("askUser.keepEditing"), t("askUser.discardAnswers")].forEach((label, i) =>
				choice(i, label, this.discard === (i === 1), {
					id: `confirm-${i}`,
					onClick: () => {
						this.discard = i === 1;
						if (this.discard) this.done(result(this.state, true));
						else this.confirming = false;
					},
				}),
			);
			hint(confirmKey, t("askUser.hint.select"));
			hint(navigate, t("askUser.hint.navigate"));
			cancelHint = t("askUser.hint.keepEditing", { key: cancelKey });
		} else if (this.editing) {
			add(theme.bold(t(this.reviewing ? "askUser.globalNoteTitle" : "askUser.questionNoteTitle")));
			body.push("");
			/* Сохраняем SGR и CURSOR_MARKER, отфильтровывая опасные управляющие последовательности */
			const editorLines = this.editor.render(width).map(editorDisplay);
			const cursor = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
			focusLine = body.length + Math.max(0, cursor);
			body.push(...editorLines);
			hints.push(t("askUser.hint.apply"), t("askUser.hint.newline"));
			cancelHint = t("askUser.hint.back", { key: cancelKey });
			actionButtons.push(
				{
					id: "btn-apply-note",
					label: `[${t("askUser.pill.apply")}]`,
					tone: "accent",
					onClick: () => {
						const text = this.editor.getExpandedText();
						this.editing = false;
						this.editor.focused = false;
						this.resetScroll();
						this.state.saveNote(this.state.tab, text);
					},
				},
				{
					id: "btn-back-note",
					label: `[${t("askUser.pill.back")}]`,
					onClick: () => {
						this.editing = false;
						this.editor.focused = false;
					},
				},
			);
		} else if (this.reviewing) {
			add(theme.bold(t("askUser.review.title")));
			body.push("");
			state.questions.forEach((question, i) => {
				const answer = state.answers[i];
				const labels = question.options
					.filter((_, index) => answer.selected.has(index))
					.map((option) => option.label);
				if (answer.customActive) labels.push(answer.custom);
				add(display(question.question), "● ");
				add(
					state.answered(i) ? display(labels.join("; ")) : theme.fg("warning", t("askUser.review.unanswered")),
					"  → ",
				);
				if (answer.notes) add(theme.fg("muted", t("askUser.notePrefix", { note: display(answer.notes) })), "    ");
			});
			if (state.globalNote) {
				body.push("");
				add(t("askUser.globalNotePrefix", { note: display(state.globalNote) }));
			}
			body.push("");
			add(
				state.complete()
					? t("askUser.review.ready")
					: theme.fg("warning", t("askUser.review.incomplete")),
			);
			body.push("");
			[t("askUser.review.submit"), t("askUser.pill.cancel")].forEach((label, i) =>
				choice(i, label, this.reviewCursor === i, {
					id: `review-${i}`,
					onClick: () => {
						this.reviewCursor = i;
						if (i === 1) this.requestCancel();
						else this.triggerPrimarySubmitAction();
					},
				}),
			);
			hint(confirmKey, t("askUser.hint.select"));
			hint(navigate, t("askUser.hint.navigate"));
			switchHint();
			noteHint();
			actionButtons.push(
				{
					id: "btn-note",
					label: `[${t("askUser.pill.note")}]`,
					onClick: () => this.openNote(),
				},
				{
					id: "btn-submit",
					label: `[${t("askUser.pill.submit")}]`,
					tone: "accent",
					onClick: () => this.triggerPrimarySubmitAction(),
				},
				{
					id: "btn-cancel",
					label: `[${t("askUser.pill.cancel")}]`,
					tone: "danger",
					onClick: () => this.requestCancel(),
				},
			);
		} else {
			const question = state.questions[state.tab];
			const answer = state.answers[state.tab];
			add(theme.bold(display(question.question)));
			body.push("");
			const explaining = this.explaining?.tab === state.tab ? this.explaining : undefined;
			const explanation = explaining ? explaining.text || t("askUser.explaining") : answer.explanation;
			if (explanation) {
				add(theme.fg("muted", display(explanation)));
				body.push("");
			}
			if (this.explainError?.tab === state.tab) {
				add(theme.fg("error", t("askUser.explanationFailed", { message: display(this.explainError.message) })));
				body.push("");
			}
			const rows = [
				...question.options.map((option, i) => ({
					label: display(option.label),
					description: option.description,
					checked: answer.selected.has(i),
				})),
				{
					label: answer.draft ? display(answer.draft) : t("askUser.customPlaceholder"),
					description: undefined,
					checked: answer.customActive,
				},
			];
			const typing = this.typing;
			rows.forEach((row, i) => {
				const box = question.multiSelect ? `[${row.checked ? "✔" : " "}] ` : "";
				const mark = !question.multiSelect && row.checked ? theme.fg("success", " ✔") : "";
				const isOther = i === question.options.length;
				const used = 2 + `${i + 1}. `.length + box.length + visibleWidth(mark);
				if (typing && i === answer.cursor) {
					const input = this.customInput();
					input.focused = this.hasFocus && !this.parked;
					row.label = editorDisplay(input.render(Math.max(1, bodyWidth - used))[0].trimEnd());
				}
				const optStart = body.length;
				choice(i, box + row.label + mark, i === answer.cursor, {
					id: `opt-${i}`,
					onClick: (localX) => {
						answer.cursor = i;
						this.followFocus = true;
						if (isOther) {
							const input = this.customInput();
							input.focused = true;
							const relX = Math.max(0, localX - used);
							input.handleMouse({
								type: "click",
								button: "left",
								x: relX,
								y: 0,
								screenX: localX,
								screenY: 0,
								width: Math.max(1, bodyWidth - used),
								height: 1,
								shift: false,
								alt: false,
								ctrl: false,
							});
							return;
						}
						this.state.select(this.state.tab, i);
						if (!question.multiSelect) this.confirmAnswer();
					},
				});
				if (row.description) {
					add(
						theme.fg("muted", display(row.description)),
						" ".repeat(2 + `${i + 1}. `.length + box.length),
					);
					const lastAction = bodyActions.at(-1);
					if (lastAction && lastAction.startLine === optStart) {
						bodyActions[bodyActions.length - 1] = {
							...lastAction,
							endLine: body.length,
						};
					}
				}
			});
			const onSubmit = question.multiSelect && answer.cursor === rows.length;
			if (question.multiSelect) {
				const subStart = body.length;
				if (onSubmit) focusLine = subStart;
				const label = theme.bold(t(this.single ? "askUser.pill.submit" : "askUser.pill.next"));
				const indent = " ".repeat(`${rows.length + 1}. `.length);
				add(
					onSubmit
						? theme.fg("accent", label)
						: state.answered(state.tab)
							? label
							: theme.fg("muted", label),
					(onSubmit ? `${theme.fg("accent", "❯")} ` : "  ") + indent,
					2 + indent.length,
					"multi-submit",
				);
				bodyActions.push({
					id: "multi-submit",
					startLine: subStart,
					endLine: body.length,
					onClick: () => this.triggerPrimarySubmitAction(),
				});
			}
			if (answer.notes) {
				body.push("");
				add(theme.fg("muted", t("askUser.notePrefix", { note: display(answer.notes) })));
			}
			body.push(theme.fg("border", "─".repeat(bodyWidth)));
			const explainRow = rows.length + (question.multiSelect ? 1 : 0);
			choice(
				question.options.length + 1,
				t(explaining ? "askUser.explaining" : "askUser.explainQuestion"),
				answer.cursor === explainRow,
				{
					id: "row-explain",
					onClick: () => {
						answer.cursor = explainRow;
						if (explaining) this.stopExplain();
						else this.startExplain();
					},
				},
			);
			choice(question.options.length + 2, t("askUser.chatAboutQuestion"), answer.cursor === explainRow + 1, {
				id: "row-chat",
				onClick: () => {
					answer.cursor = explainRow + 1;
					this.done(result(this.state, false, true));
				},
			});
			if (!question.multiSelect) hint(confirmKey, t("askUser.hint.select"));
			else if (typing) hint(confirmKey, t("askUser.hint.done"));
			else hint(`Space/${confirmKey}`, t("askUser.hint.toggle"));
			hint(navigate, t("askUser.hint.navigate"));
			switchHint(!typing);
			if (!typing) noteHint();
			if (explaining) cancelHint = t("askUser.hint.stopExplaining", { key: cancelKey });
			if (hasPreview) {
				hint(
					`${keyLabel(actionKeys(this.keys, "pi-ask-user.previewUp"))}/${keyLabel(actionKeys(this.keys, "pi-ask-user.previewDown"))}`,
					t("askUser.hint.preview"),
				);
			}
			actionButtons.push(
				{
					id: "btn-explain",
					label: explaining ? `[${t("askUser.pill.stopExplain")}]` : `[${t("askUser.pill.explain")}]`,
					onClick: () => {
						if (explaining) this.stopExplain();
						else this.startExplain();
					},
				},
				{
					id: "btn-note",
					label: `[${t("askUser.pill.note")}]`,
					onClick: () => this.openNote(),
				},
				{
					id: "btn-submit",
					label: `[${this.single ? t("askUser.pill.submit") : t("askUser.pill.next")}]`,
					tone: "accent",
					onClick: () => this.triggerPrimarySubmitAction(),
				},
				{
					id: "btn-cancel",
					label: `[${t("askUser.pill.cancel")}]`,
					tone: "danger",
					onClick: () => this.requestCancel(),
				},
			);
		}

		/* Верхняя полоса: при парковке и выключенном Shortcuts Bar показываем Tab return to question без сдвига высоты */
		const showInlineParkedHint = this.parked && !loadPiUiUserConfig().showShortcutsBar;
		const topBorder = showInlineParkedHint
			? (() => {
					const badge = ` ${t("askUser.parkedHint")} `;
					const bw = visibleWidth(badge);
					const dashCount = Math.max(0, width - bw - 2);
					return `${theme.fg("border", "──")}${fgRgb(palette.accentBright, badge)}${theme.fg("border", "─".repeat(dashCount))}`;
				})()
			: theme.fg("border", "─".repeat(width));

		const top: string[] = [topBorder];
		if (!this.single) {
			top.push(this.tabs(width, 1), "");
		}

		const renderActionRow = (rowY: number): string | undefined => {
			if (actionButtons.length === 0) return undefined;
			let curX = 0;
			let line = "";
			for (let i = 0; i < actionButtons.length; i += 1) {
				const btn = actionButtons[i]!;
				const bw = visibleWidth(btn.label);
				const isHov = this.hoveredId === btn.id;
				const styled = isHov
					? fgRgb(btn.tone === "danger" ? palette.danger : palette.accentBright, theme.bold(btn.label))
					: btn.tone === "accent"
						? fgRgb(palette.accent, btn.label)
						: btn.tone === "danger"
							? fgRgb(palette.danger, btn.label)
							: theme.fg("muted", btn.label);
				this.hits.push({
					id: btn.id,
					xStart: curX,
					xEnd: curX + bw,
					y: rowY,
					onClick: btn.onClick,
				});
				line += styled;
				curX += bw;
				if (i < actionButtons.length - 1) {
					line += "  ";
					curX += 2;
				}
			}
			return line;
		};

		const footer = (extra: string[]) =>
			wrapTextWithAnsi(theme.fg("dim", [...hints, ...extra, cancelHint].join(" · ")), width);
		const actionRowCount = actionButtons.length > 0 ? 1 : 0;
		let bottom = footer([]);
		let available = height - top.length - 1 - actionRowCount - bottom.length;
		if (body.length > available && available >= 1) {
			bottom = footer([t("askUser.hint.scroll")]);
			available = height - top.length - 1 - actionRowCount - bottom.length;
		}
		const chrome = available >= 1;
		if (!chrome) available = height;
		const room =
			hasPreview && !wide
				? Math.min(body.length, Math.max(2, Math.floor(available / 2)))
				: Math.min(body.length, available);

		if (this.confirming || this.editing || this.followFocus) {
			if (focusLine < this.scroll) this.scroll = focusLine;
			if (focusLine >= this.scroll + room) this.scroll = focusLine - room + 1;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - room)));
		this.lastBodyLength = body.length;
		this.lastRoom = Math.max(1, room);

		/* Регистрируем кликабельные области видимых строк тела с учётом scroll и top.length */
		const bodyStartY = chrome ? top.length : 0;
		for (const action of bodyActions) {
			const visStart = Math.max(action.startLine, this.scroll);
			const visEnd = Math.min(action.endLine, this.scroll + room);
			for (let lineIdx = visStart; lineIdx < visEnd; lineIdx += 1) {
				const screenY = bodyStartY + (lineIdx - this.scroll);
				this.hits.push({
					id: action.id,
					xStart: 0,
					xEnd: bodyWidth,
					y: screenY,
					onClick: () => action.onClick(0),
				});
			}
		}

		let viewport = body.slice(this.scroll, this.scroll + room);
		if (hasPreview) {
			this.preview.setText(previewText);
			const rows = wide
				? Math.min(available, Math.max(room, PREVIEW_ROWS))
				: Math.min(PREVIEW_ROWS, available - room - 1);
			const right = this.preview.render(wide ? width - bodyWidth - 3 : width, rows);
			viewport = wide
				? columns(viewport, right, bodyWidth, width)
				: [...viewport, ...(right.length ? ["", ...right] : [])];
		}

		const actionRowY = chrome ? top.length + viewport.length + 1 : -1;
		const renderedActionRow = chrome ? renderActionRow(actionRowY) : undefined;
		const lines = chrome
			? [...top, ...viewport, "", ...(renderedActionRow ? [renderedActionRow] : []), ...bottom]
			: viewport;
		return lines.slice(0, height).map((line) => truncateToWidth(line, width));
	}

	private tabs(width: number, rowY: number): string {
		const { state, theme } = this;
		const palette = getThemeSurfacePalette(theme);
		const count = state.questions.length + 1;
		const box = (i: number) => (state.answered(i) ? "☒" : "☐");
		const full = [
			...state.questions.map(
				(question, i) => `${box(i)} ${display(question.header || t("askUser.fallbackTab", { number: i + 1 })).replace(/\s+/g, " ")}`,
			),
			`✔ ${t("askUser.pill.submit")}`,
		];
		const short = [...state.questions.map((_, i) => `${box(i)} ${i + 1}`), "✔"];
		const fits = full.reduce((sum, label) => sum + visibleWidth(label) + 3, 6) <= width;
		const others = short.reduce(
			(sum, label, i) => sum + (i === state.tab ? 0 : visibleWidth(label)) + 3,
			6,
		);
		const labels = fits
			? full
			: short.map((label, i) =>
					i === state.tab ? fit(full[i], Math.max(visibleWidth(label), width - others)) : label,
				);

		let curX = 0;
		const leftArrow = this.hoveredId === "tab-prev" ? fgRgb(palette.accentBright, "←") : theme.fg("dim", "←");
		this.hits.push({
			id: "tab-prev",
			xStart: 0,
			xEnd: 2,
			y: rowY,
			onClick: () => {
				state.tab = (state.tab - 1 + count) % count;
				this.resetScroll();
			},
		});
		curX = 3;

		const cells = labels.map((label, i) => {
			const cellText = ` ${label} `;
			const cw = visibleWidth(cellText);
			const id = `tab-${i}`;
			this.hits.push({
				id,
				xStart: curX,
				xEnd: curX + cw,
				y: rowY,
				onClick: () => {
					state.tab = i;
					this.resetScroll();
				},
			});
			curX += cw + 1;
			if (i === state.tab) return theme.bg("selectedBg", theme.fg("text", cellText));
			if (this.hoveredId === id) return blueBgRgb(theme, palette.hoveredRowBg, theme.fg("text", cellText));
			return theme.fg(
				i < state.questions.length
					? state.answered(i)
						? "text"
						: "muted"
					: state.complete()
						? "success"
						: "muted",
				cellText,
			);
		});

		const rightArrowX = curX + 1;
		const rightArrow =
			this.hoveredId === "tab-next" ? fgRgb(palette.accentBright, "→") : theme.fg("dim", "→");
		this.hits.push({
			id: "tab-next",
			xStart: rightArrowX,
			xEnd: rightArrowX + 2,
			y: rowY,
			onClick: () => {
				state.tab = (state.tab + 1) % count;
				this.resetScroll();
			},
		});

		return `${leftArrow}  ${cells.join(" ")}  ${rightArrow}`;
	}
}

const unavailable: Explain = async () => {
	throw new Error("Explanations are unavailable.");
};

export interface ExplainOptions {
	lastRequest?: () => Request | undefined;
	onUsage?: (usage: Usage) => void;
}

export async function runQuestionnaire(
	ctx: ExtensionContext,
	params: Params,
	signal?: AbortSignal,
	options: ExplainOptions = {},
): Promise<Result> {
	if (ctx.mode !== "tui") throw new Error("Questionnaires require terminal mode.");
	validate(params);
	signal?.throwIfAborted();
	let abort: (() => void) | undefined;
	let releaseBlocking: (() => void) | undefined;
	const runs: Promise<string>[] = [];
	try {
		const outcome = await ctx.ui.custom<Result | Error>((tui, theme, keys, done) => {
			if (hasBlockingModalOverlay(tui)) {
				throw new Error("Close the existing dialog before opening a questionnaire.");
			}
			releaseBlocking = registerBlockingDialog();
			let settled = false;
			const finish = (value: Result | Error) => {
				if (settled) return;
				settled = true;
				setParkedAskUserController(undefined);
				releaseBlocking?.();
				done(value);
			};
			abort = () => finish(new Error("Questionnaire aborted."));
			signal?.addEventListener("abort", abort, { once: true });
			const explain = explainer(
				ctx,
				params,
				options.lastRequest ?? (() => undefined),
				options.onUsage ?? (() => {}),
			);
			return new Questionnaire(params, tui, theme, keys, finish, Date.now, (index, own, onText) => {
				const run = explain(index, signal ? AbortSignal.any([own, signal]) : own, onText);
				runs.push(run);
				return run;
			});
		});
		if (outcome instanceof Error) throw outcome;
		if (!outcome) throw new Error("Questionnaire UI unavailable.");
		await Promise.allSettled(runs);
		return outcome;
	} finally {
		setParkedAskUserController(undefined);
		releaseBlocking?.();
		if (abort) signal?.removeEventListener("abort", abort);
	}
}
