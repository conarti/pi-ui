import { InteractiveMode, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, isLightTheme, type HitBox, type RgbTuple } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { t } from "../../shared/i18n.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import { getActiveComposerEditor, type PiUiComposerEditor } from "./composer.ts";

export type QueuedItemKind = "steer" | "followUp";

export interface QueuedMessageEntry {
	readonly kind: QueuedItemKind;
	readonly index: number;
	readonly text: string;
}

interface HostInteractiveModeInternals {
	session: {
		isStreaming: boolean;
		abort(): Promise<void>;
		prompt(
			text: string,
			options?: {
				streamingBehavior?: "steer" | "followUp";
				preflightResult?: (result: string) => void;
			},
		): Promise<void>;
		steer(text: string): Promise<void>;
		followUp(text: string): Promise<void>;
		_queueSteer?(text: string): Promise<void>;
		_queueFollowUp?(text: string): Promise<void>;
		getSteeringMessages(): readonly string[];
		getFollowUpMessages(): readonly string[];
	};
	ui: {
		requestRender(): void;
	};
	pendingMessagesContainer: Container;
	pendingBashComponents?: Component[];
	getAllQueuedMessages(): { steering: string[]; followUp: string[] };
	clearAllQueues(): { steering: string[]; followUp: string[] };
	updatePendingMessagesDisplay(): void;
}

const QUEUE_STATE_KEY = Symbol.for("conarti.pi-ui.mid-turn-queue-state.v1");

interface MidTurnQueueState {
	activeMode?: HostInteractiveModeInternals;
	getTheme?: () => Theme;
	sendingNow?: boolean;
}

function getQueueState(): MidTurnQueueState {
	const g = globalThis as Record<symbol, MidTurnQueueState | undefined>;
	if (!g[QUEUE_STATE_KEY]) {
		g[QUEUE_STATE_KEY] = {};
	}
	return g[QUEUE_STATE_KEY]!;
}

async function reenqueueItems(
	mode: HostInteractiveModeInternals,
	items: { readonly steering: readonly string[]; readonly followUp: readonly string[] },
): Promise<void> {
	for (const msg of items.steering) {
		if (typeof mode.session._queueSteer === "function") {
			await mode.session._queueSteer(msg);
		} else {
			await mode.session.steer(msg);
		}
	}
	for (const msg of items.followUp) {
		if (typeof mode.session._queueFollowUp === "function") {
			await mode.session._queueFollowUp(msg);
		} else {
			await mode.session.followUp(msg);
		}
	}
}

function flattenQueues(queues: {
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
}): QueuedMessageEntry[] {
	const entries: QueuedMessageEntry[] = [];
	queues.steering.forEach((text, index) => {
		entries.push({ kind: "steer", index, text });
	});
	queues.followUp.forEach((text, index) => {
		entries.push({ kind: "followUp", index, text });
	});
	return entries;
}

function spliceQueuedItem(
	queues: { readonly steering: readonly string[]; readonly followUp: readonly string[] },
	kind: QueuedItemKind,
	index: number,
): {
	removed: string | undefined;
	remaining: { steering: string[]; followUp: string[] };
} {
	const steering = [...queues.steering];
	const followUp = [...queues.followUp];
	const target = kind === "steer" ? steering : followUp;
	const [removed] = target.splice(index, 1);
	return { removed, remaining: { steering, followUp } };
}

async function executeSendNow(
	mode: HostInteractiveModeInternals,
	text: string,
	remaining: { readonly steering: readonly string[]; readonly followUp: readonly string[] },
): Promise<void> {
	const state = getQueueState();
	if (state.sendingNow) return;
	state.sendingNow = true;
	try {
		mode.updatePendingMessagesDisplay();
		mode.ui.requestRender();
		await mode.session.abort();
		let requeued = false;
		const requeueOnce = () => {
			if (requeued) return;
			requeued = true;
			if (remaining.steering.length > 0 || remaining.followUp.length > 0) {
				void reenqueueItems(mode, remaining).then(() => {
					mode.updatePendingMessagesDisplay();
					mode.ui.requestRender();
				});
			}
		};
		void mode.session
			.prompt(text, {
				preflightResult: (outcome) => {
					if (outcome === "started") {
						requeueOnce();
					}
				},
			})
			.catch(() => {
				/* Ошибки запуска нового хода обрабатываются стандартным потоком InteractiveMode */
			});
	} finally {
		state.sendingNow = false;
	}
}

export function getActiveQueuedEntries(): QueuedMessageEntry[] {
	const mode = getQueueState().activeMode;
	if (!mode) return [];
	return flattenQueues(mode.getAllQueuedMessages());
}

export function hasQueuedMidTurnMessages(): boolean {
	return getActiveQueuedEntries().length > 0;
}

export async function removeQueuedMidTurnItem(
	kind: QueuedItemKind,
	index: number,
): Promise<boolean> {
	const mode = getQueueState().activeMode;
	if (!mode) return false;
	const { removed, remaining } = spliceQueuedItem(mode.clearAllQueues(), kind, index);
	if (removed === undefined) return false;
	await reenqueueItems(mode, remaining);
	mode.updatePendingMessagesDisplay();
	mode.ui.requestRender();
	return true;
}

export async function editQueuedMidTurnItem(
	kind: QueuedItemKind,
	index: number,
	editor?: PiUiComposerEditor,
): Promise<boolean> {
	const mode = getQueueState().activeMode;
	if (!mode) return false;
	const { removed, remaining } = spliceQueuedItem(mode.clearAllQueues(), kind, index);
	if (removed === undefined) return false;
	await reenqueueItems(mode, remaining);
	const targetEditor = editor ?? getActiveComposerEditor();
	if (targetEditor) {
		const current = targetEditor.getText();
		const combined = [removed, current].filter((part) => part.trim().length > 0).join("\n\n");
		targetEditor.setText(combined);
	}
	mode.updatePendingMessagesDisplay();
	mode.ui.requestRender();
	return true;
}

export async function sendNowQueuedMidTurnItem(
	kind: QueuedItemKind,
	index: number,
): Promise<boolean> {
	const mode = getQueueState().activeMode;
	if (!mode) return false;
	const { removed, remaining } = spliceQueuedItem(mode.clearAllQueues(), kind, index);
	if (removed === undefined) return false;
	await executeSendNow(mode, removed, remaining);
	return true;
}

export async function sendNowTopQueuedMidTurnItem(): Promise<boolean> {
	const entries = getActiveQueuedEntries();
	const first = entries[0];
	if (!first) return false;
	return await sendNowQueuedMidTurnItem(first.kind, first.index);
}

export async function sendNowDraftMidTurn(
	text: string,
	editor?: PiUiComposerEditor,
): Promise<boolean> {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const mode = getQueueState().activeMode;
	if (!mode) return false;
	const targetEditor = editor ?? getActiveComposerEditor();
	targetEditor?.addToHistory?.(trimmed);
	targetEditor?.setText("");
	const remaining = mode.clearAllQueues();
	await executeSendNow(mode, trimmed, remaining);
	return true;
}

class PendingQueueStripComponent implements Component {
	private hoveredId: string | null = null;
	private hits: HitBox[] = [];
	private readonly hoverOwner = {};

	constructor(
		private readonly entries: readonly QueuedMessageEntry[],
		private readonly getTheme: () => Theme | undefined,
		private readonly onRequestRender: () => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		this.hits = [];
		const theme = this.getTheme();
		if (!theme || this.entries.length === 0 || width < 12) return [];

		const light = isLightTheme(theme);
		const outerPad = computeOuterCanvasMargin(width);
		const innerLeft = outerPad + 2;
		const contentWidth = Math.max(8, width - outerPad * 2 - 4);
		const marginLeft = " ".repeat(innerLeft);
		const marginRight = " ".repeat(outerPad + 2);

		const accentRgb: RgbTuple = light ? [29, 78, 216] : [125, 207, 255];
		const badgeSteerRgb: RgbTuple = light ? [2, 132, 199] : [100, 178, 240];
		const badgeQueueRgb: RgbTuple = light ? [71, 85, 105] : [148, 163, 184];
		const dangerRgb: RgbTuple = light ? [185, 28, 28] : [248, 113, 113];

		const rows: string[] = [""];

		for (let rowIdx = 0; rowIdx < this.entries.length; rowIdx += 1) {
			const entry = this.entries[rowIdx]!;
			const screenRowY = rowIdx + 1;

			const sendId = `send:${entry.kind}:${entry.index}`;
			const editId = `edit:${entry.kind}:${entry.index}`;
			const delId = `del:${entry.kind}:${entry.index}`;

			const sendRaw = `[${t("composer.queue.sendNow")}]`;
			const editRaw = `[${t("composer.queue.edit")}]`;
			const delRaw = `[${t("composer.queue.remove")}]`;

			const sendStyled =
				this.hoveredId === sendId
					? fgRgb(accentRgb, theme.bold(sendRaw))
					: fgRgb(accentRgb, sendRaw);
			const editStyled =
				this.hoveredId === editId
					? fgRgb(accentRgb, editRaw)
					: theme.fg("muted", editRaw);
			const delStyled =
				this.hoveredId === delId
					? fgRgb(dangerRgb, delRaw)
					: theme.fg("dim", delRaw);

			const actionsStr = `${sendStyled} ${editStyled} ${delStyled}`;
			const actionsW = visibleWidth(actionsStr);

			const badgeText =
				entry.kind === "steer"
					? t("composer.queue.steerBadge")
					: t("composer.queue.followUpBadge");
			const badgeStyled = fgRgb(
				entry.kind === "steer" ? badgeSteerRgb : badgeQueueRgb,
				`${badgeText}:`,
			);
			const singleLineMsg = entry.text.replace(/\s+/g, " ").trim();
			const prefixW = visibleWidth(badgeStyled) + 1;
			const msgAvail = Math.max(4, contentWidth - prefixW - actionsW - 2);
			const clippedMsg = truncateToWidth(singleLineMsg, msgAvail, "…");
			const leftPart = `${badgeStyled} ${theme.fg("text", clippedMsg)}`;
			const leftW = visibleWidth(leftPart);
			const gap = " ".repeat(Math.max(1, contentWidth - leftW - actionsW));

			let curX = innerLeft + leftW + gap.length;
			const sendW = visibleWidth(sendStyled);
			this.hits.push({
				id: sendId,
				xStart: curX,
				xEnd: curX + sendW,
				y: screenRowY,
				onClick: () => {
					void sendNowQueuedMidTurnItem(entry.kind, entry.index);
				},
			});
			curX += sendW + 1;

			const editW = visibleWidth(editStyled);
			this.hits.push({
				id: editId,
				xStart: curX,
				xEnd: curX + editW,
				y: screenRowY,
				onClick: () => {
					void editQueuedMidTurnItem(entry.kind, entry.index);
				},
			});
			curX += editW + 1;

			const delW = visibleWidth(delStyled);
			this.hits.push({
				id: delId,
				xStart: curX,
				xEnd: curX + delW,
				y: screenRowY,
				onClick: () => {
					void removeQueuedMidTurnItem(entry.kind, entry.index);
				},
			});

			rows.push(`${marginLeft}${leftPart}${gap}${actionsStr}${marginRight}`);
		}

		return rows;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const hit = this.hits.find(
			(h) => h.y === event.y && event.x >= h.xStart && event.x < h.xEnd,
		);
		if (event.type === "move") {
			const nextId = hit?.id ?? null;
			if (nextId !== null) {
				claimHover(this.hoverOwner, () => {
					if (this.hoveredId !== null) {
						this.hoveredId = null;
						this.onRequestRender();
					}
				});
			}
			if (nextId !== this.hoveredId) {
				this.hoveredId = nextId;
				return { handled: true, render: true };
			}
			return hit ? { handled: true, render: false } : undefined;
		}
		if (event.type === "press" && event.button === "left" && hit) {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left" && hit) {
			hit.onClick();
			return { handled: true, render: true };
		}
		return undefined;
	}
}

/**
 * Устанавливает перехват отображения очереди отложенных сообщений над Composer,
 * заменяя статичные строки хоста на кликабельную панель `[Send now] [Edit · Alt+↑] [×]`.
 */
export function installMidTurnQueueUi(getTheme: () => Theme): void {
	const state = getQueueState();
	state.getTheme = getTheme;

	const modeProto = (InteractiveMode as unknown as { prototype?: object } | undefined)?.prototype;
	if (!modeProto) return;

	const captureMode = (self: unknown) => {
		state.activeMode = self as HostInteractiveModeInternals;
	};

	hookMethod(modeProto, "init", "midTurnQueue.captureMode", (self, args, original) => {
		captureMode(self);
		return original.apply(self, args);
	});

	hookMethod(
		modeProto,
		"setCustomEditorComponent",
		"midTurnQueue.captureOnEditorMount",
		(self, args, original) => {
			captureMode(self);
			return original.apply(self, args);
		},
	);

	hookMethod(
		modeProto,
		"updatePendingMessagesDisplay",
		"midTurnQueue.renderStrip",
		(self, _args, _original) => {
			const mode = self as HostInteractiveModeInternals;
			captureMode(mode);
			mode.pendingMessagesContainer.clear();
			for (const component of mode.pendingBashComponents ?? []) {
				mode.pendingMessagesContainer.addChild(component);
			}
			const entries = flattenQueues(mode.getAllQueuedMessages());
			if (entries.length > 0) {
				mode.pendingMessagesContainer.addChild(
					new PendingQueueStripComponent(
						entries,
						() => getQueueState().getTheme?.(),
						() => mode.ui.requestRender(),
					),
				);
			}
		},
	);
}

export function bindActiveInteractiveModeFromSessionStart(getTheme: () => Theme): void {
	const state = getQueueState();
	state.getTheme = getTheme;
}

export function resetMidTurnQueueUi(): void {
	const state = getQueueState();
	state.activeMode = undefined;
	state.sendingNow = false;
}
