import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { InteractiveMode, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getImageDimensions,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, isLightTheme, type HitBox, type RgbTuple } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { getActiveHostRuntime, getFocusedHostComponent } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import { extensionForImageMime } from "../prompt-chips/clipboard.ts";
import { getActivePromptChipRegistry, IMAGE_MARKER_RE } from "../prompt-chips/registry.ts";
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
		agent: unknown;
		abort(): Promise<void>;
		prompt(
			text: string,
			options?: {
				images?: ImageContent[];
				streamingBehavior?: "steer" | "followUp";
				preflightResult?: (result: string) => void;
			},
		): Promise<void>;
		steer(text: string, images?: ImageContent[]): Promise<void>;
		followUp(text: string, images?: ImageContent[]): Promise<void>;
		_queueSteer?(text: string, images?: ImageContent[]): Promise<void>;
		_queueFollowUp?(text: string, images?: ImageContent[]): Promise<void>;
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

interface QueuedPayload {
	readonly text: string;
	readonly images?: ImageContent[];
}

type Queues = { steering: QueuedPayload[]; followUp: QueuedPayload[] };

function snapshotQueues(mode: HostInteractiveModeInternals): Queues | undefined {
	const { session } = mode;
	/* Публичный peek показывает только следующую пачку; сверяем полный снимок агента с текстовой очередью сессии до её очистки. */
	const agent = session.agent as {
		steeringQueue?: { messages?: readonly AgentMessage[] };
		followUpQueue?: { messages?: readonly AgentMessage[] };
	};
	const capture = (all: readonly string[], queued: readonly string[], messages?: readonly AgentMessage[]) => {
		if (queued.length === 0) return all.map((text): QueuedPayload => ({ text }));
		if (messages?.length !== queued.length) return undefined;
		const result: QueuedPayload[] = [];
		for (let i = 0; i < queued.length; i++) {
			const message = messages[i];
			const text = queued[i]!;
			if (message?.role !== "user" || typeof message.content === "string") return undefined;
			const [first, ...rest] = message.content;
			if (first?.type !== "text" || first.text !== text) return undefined;
			const images = rest.filter((part): part is ImageContent => part.type === "image");
			result.push({ text, images: images.length ? images : undefined });
		}
		return [...result, ...all.slice(queued.length).map((text) => ({ text }))];
	};
	const all = mode.getAllQueuedMessages();
	const steering = capture(all.steering, session.getSteeringMessages(), agent.steeringQueue?.messages);
	const followUp = capture(all.followUp, session.getFollowUpMessages(), agent.followUpQueue?.messages);
	return steering && followUp ? { steering, followUp } : undefined;
}

async function reenqueueItems(mode: HostInteractiveModeInternals, items: Queues): Promise<void> {
	const { session } = mode;
	const steer = session._queueSteer ?? session.steer;
	const followUp = session._queueFollowUp ?? session.followUp;
	await Promise.all([
		...items.steering.map(({ text, images }) => steer.call(session, text, images)),
		...items.followUp.map(({ text, images }) => followUp.call(session, text, images)),
	]);
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

function takeQueuedItem(mode: HostInteractiveModeInternals, kind: QueuedItemKind, index: number) {
	const remaining = snapshotQueues(mode);
	const target = kind === "steer" ? remaining?.steering : remaining?.followUp;
	if (!remaining || !target?.[index]) return undefined;
	const [removed] = target.splice(index, 1);
	mode.clearAllQueues();
	return { removed: removed!, remaining };
}

async function executeSendNow(
	mode: HostInteractiveModeInternals,
	item: QueuedPayload,
	remaining: Queues,
): Promise<void> {
	const state = getQueueState();
	if (state.sendingNow) return;
	state.sendingNow = true;
	let restoration: Promise<void> | undefined;
	const restoreQueues = () => restoration ??= reenqueueItems(mode, remaining)
		.catch((error: unknown) => {
			if (state.activeMode !== mode) return;
			getActiveHostRuntime()?.ctx.ui.notify(t("composer.queue.restoreFailed", {
				error: error instanceof Error ? error.message : String(error),
			}), "error");
		})
		.finally(() => {
			state.sendingNow = false;
			mode.updatePendingMessagesDisplay();
			mode.ui.requestRender();
		});
	try {
		mode.updatePendingMessagesDisplay();
		mode.ui.requestRender();
		await mode.session.abort();
		/* Восстанавливаем очередь до завершения нового хода, даже если ввод обработало расширение. */
		void mode.session.prompt(item.text, {
			images: item.images,
			preflightResult: () => { void restoreQueues(); },
		}).then(restoreQueues, restoreQueues);
	} catch {
		await restoreQueues();
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
	const item = takeQueuedItem(mode, kind, index);
	if (!item) return false;
	await reenqueueItems(mode, item.remaining);
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
	const runtime = getActiveHostRuntime();
	if (!mode || !runtime) return false;
	const targetEditor = editor ?? getActiveComposerEditor();
	const composer = getFocusedHostComponent(runtime.tui) === targetEditor ? targetEditor : undefined;
	const ui = runtime.ctx.ui;
	const current = ui.getEditorText();
	const item = takeQueuedItem(mode, kind, index);
	if (!item) return false;

	const registry = getActivePromptChipRegistry();
	const before = registry.captureUndoSnapshot();
	const images = item.removed.images ?? [];
	const register = (image: ImageContent, path = "") => {
		const dims = getImageDimensions(image.data, image.mimeType);
		return registry.registerImage({
			fileName: basename(path) || `image.${extensionForImageMime(image.mimeType)}`,
			filePath: path,
			mimeType: image.mimeType,
			byteLength: Buffer.byteLength(image.data, "base64"),
			base64Data: image.data,
			widthPx: dims?.widthPx,
			heightPx: dims?.heightPx,
		}).token;
	};
	let nextImage = 0;
	const restored = [...item.removed.text.matchAll(IMAGE_MARKER_RE)].length === images.length
		? item.removed.text.replace(IMAGE_MARKER_RE, (marker, _number: string, path: string | undefined) => {
			const image = images[nextImage++];
			return image ? register(image, path) : marker;
		})
		: item.removed.text;
	const draft = [restored, ...images.slice(nextImage).map((image) => register(image))].filter(Boolean).join(" ");
	const combined = [draft, current].filter((part) => part.trim().length > 0).join("\n\n");
	if (composer) composer.setTextWithUndoSnapshot(combined, before);
	else ui.setEditorText(combined);
	await reenqueueItems(mode, item.remaining);
	mode.updatePendingMessagesDisplay();
	mode.ui.requestRender();
	return true;
}

export async function sendNowQueuedMidTurnItem(
	kind: QueuedItemKind,
	index: number,
): Promise<boolean> {
	const mode = getQueueState().activeMode;
	if (!mode || getQueueState().sendingNow) return false;
	const item = takeQueuedItem(mode, kind, index);
	if (!item) return false;
	await executeSendNow(mode, item.removed, item.remaining);
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
	if (!mode || getQueueState().sendingNow) return false;
	const remaining = snapshotQueues(mode);
	if (!remaining) return false;
	const targetEditor = editor ?? getActiveComposerEditor();
	targetEditor?.addToHistory?.(trimmed);
	targetEditor?.setText("");
	mode.clearAllQueues();
	await executeSendNow(mode, { text: trimmed }, remaining);
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
