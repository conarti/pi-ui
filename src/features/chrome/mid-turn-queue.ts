import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { InteractiveMode, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getImageDimensions,
	isFocusable,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { CLOSE_BUTTON_LABEL, fgRgb, isLightTheme, renderCloseButton, type HitBox, type RgbTuple } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { getActiveHostRuntime, getFocusedHostComponent } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import {
	extractSkillInvocations,
	renderStyledSkillChip,
	toggleSkillPreviewPopup,
} from "../../shared/skill-tags.ts";
import { isSlotOwnedByPiUi } from "../../shared/slot-arbitration.ts";
import { extensionForImageMime } from "../prompt-chips/clipboard.ts";
import { styleInlinePromptChip } from "../prompt-chips/index.ts";
import {
	findPromptChipSpans,
	getActivePromptChipRegistry,
	IMAGE_MARKER_RE,
} from "../prompt-chips/registry.ts";
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
	extensionWidgetsAbove?: Map<string, Component>;
	extensionWidgetsBelow?: Map<string, Component>;
	renderWidgets?(): void;
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

function restoreQueuedPayloadToDraft(item: QueuedPayload, cwd: string): string {
	const registry = getActivePromptChipRegistry();
	const images = item.images ?? [];
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

	const skillExtracted = extractSkillInvocations(item.text, { cwd });
	const slashPrefix = skillExtracted.skills.map((s) => `/skill:${s.name}`).join(" ");
	const bodySource = skillExtracted.skills.length > 0 ? skillExtracted.userText : item.text;

	let nextImage = 0;
	let restoredBody =
		[...bodySource.matchAll(IMAGE_MARKER_RE)].length === images.length
			? bodySource.replace(IMAGE_MARKER_RE, (marker, _number: string, path: string | undefined) => {
					const image = images[nextImage++];
					return image ? register(image, path) : marker;
				})
			: bodySource;

	/* Если в реестре есть сохранённые вставки/цитаты для этого сообщения, восстанавливаем их как живые чипы */
	const reconstructed = registry.reconstructSubmittedPrompt(bodySource);
	if (reconstructed.chips.some((c) => c.kind === "paste" || c.kind === "quote")) {
		let rebuilt = "";
		let pos = 0;
		const spans = findPromptChipSpans(reconstructed.displayText);
		nextImage = 0;
		for (let i = 0; i < spans.length; i += 1) {
			const span = spans[i]!;
			rebuilt += reconstructed.displayText.slice(pos, span.start);
			const chipMeta =
				reconstructed.chips.find((c) => c.kind === span.kind && c.number === span.number) ??
				reconstructed.chips[i];
			if (span.kind === "image") {
				const image = images[nextImage++];
				rebuilt += image
					? register(image, chipMeta?.kind === "image" ? chipMeta.filePath : "")
					: span.token;
			} else if (span.kind === "paste" && chipMeta?.kind === "paste" && chipMeta.previewText) {
				rebuilt += registry.registerPaste(chipMeta.previewText).token;
			} else if (span.kind === "quote" && chipMeta?.kind === "quote" && chipMeta.previewText) {
				rebuilt += registry.registerQuote(chipMeta.previewText).token;
			} else {
				rebuilt += span.token;
			}
			pos = span.end;
		}
		rebuilt += reconstructed.displayText.slice(pos);
		restoredBody = rebuilt;
	}

	const trailingImages = images.slice(nextImage).map((image) => register(image));
	return [slashPrefix, restoredBody.trim(), ...trailingImages].filter(Boolean).join(" ");
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
	const cwd = runtime.ctx.cwd ?? process.cwd();
	const draft = restoreQueuedPayloadToDraft(item.removed, cwd);
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

interface QueueHitBox extends HitBox {
	onClickAt?: (screenX: number, screenY: number) => void;
}

class PendingQueueStripComponent implements Component {
	private hoveredId: string | null = null;
	private hits: QueueHitBox[] = [];
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

		const rows: string[] = [""];

		for (let rowIdx = 0; rowIdx < this.entries.length; rowIdx += 1) {
			const entry = this.entries[rowIdx]!;
			const screenRowY = rowIdx + 1;

			const sendId = `send:${entry.kind}:${entry.index}`;
			const editId = `edit:${entry.kind}:${entry.index}`;
			const delId = `del:${entry.kind}:${entry.index}`;

			const sendRaw = `[${t("composer.queue.sendNow")}]`;
			const editRaw = `[${t("composer.queue.edit")}]`;
			const delRaw = CLOSE_BUTTON_LABEL;

			const sendStyled =
				this.hoveredId === sendId
					? fgRgb(accentRgb, theme.bold(sendRaw))
					: fgRgb(accentRgb, sendRaw);
			const editStyled =
				this.hoveredId === editId
					? fgRgb(accentRgb, editRaw)
					: theme.fg("muted", editRaw);
			const delStyled = renderCloseButton(theme, this.hoveredId === delId);

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
			const cwd = getActiveHostRuntime()?.ctx.cwd ?? process.cwd();
			const skillExtracted = extractSkillInvocations(entry.text, { cwd });
			const queueSkills = [...skillExtracted.skills];
			let rawUserBody = skillExtracted.userText;
			if (queueSkills.length === 0) {
				const slashMatch = /^((?:\s*\/skill:[^\s]+)+)(?:\s+|$)([\s\S]*)$/u.exec(rawUserBody);
				if (slashMatch) {
					const names = [...slashMatch[1]!.matchAll(/\/skill:([^\s]+)/gu)].map((m) => m[1]!);
					names.forEach((name, idx) => {
						queueSkills.push({
							id: `slash-skill:${idx}:${name}`,
							name,
							body: "",
							lineCount: 0,
						});
					});
					rawUserBody = slashMatch[2] ?? "";
				}
			}
			const reconstructed = getActivePromptChipRegistry().reconstructSubmittedPrompt(
				rawUserBody,
			);
			const prefixW = visibleWidth(badgeStyled) + 1;
			const msgAvail = Math.max(4, contentWidth - prefixW - actionsW - 2);

			let styledMsg = "";
			let localCol = 0;
			const skillHitsPending: Array<{
				id: string;
				xOffset: number;
				width: number;
				onClickAt?: (sx: number, sy: number) => void;
			}> = [];

			for (const skill of queueSkills) {
				const skillId = `skill:${entry.kind}:${entry.index}:${skill.id}`;
				const renderedSkill = renderStyledSkillChip(skill.name, theme, {
					active: this.hoveredId === skillId,
				});
				if (styledMsg) {
					styledMsg += " ";
					localCol += 1;
				}
				const sw = visibleWidth(renderedSkill.styled);
				if (skill.body || skill.location) {
					skillHitsPending.push({
						id: skillId,
						xOffset: localCol,
						width: sw,
						onClickAt: (sx, sy) => toggleSkillPreviewPopup(skill, sx, sy),
					});
				}
				styledMsg += renderedSkill.styled;
				localCol += sw;
			}

			const singleLineBody = reconstructed.displayText.replace(/\s+/gu, " ").trim();
			if (singleLineBody) {
				if (styledMsg) {
					styledMsg += " ";
					localCol += 1;
				}
				const spans = findPromptChipSpans(singleLineBody);
				let bodyPos = 0;
				for (const span of spans) {
					if (span.start > bodyPos) {
						styledMsg += theme.fg("text", singleLineBody.slice(bodyPos, span.start));
					}
					styledMsg += styleInlinePromptChip(span.token, { kind: span.kind, theme });
					bodyPos = span.end;
				}
				if (bodyPos < singleLineBody.length) {
					styledMsg += theme.fg("text", singleLineBody.slice(bodyPos));
				}
			}

			const clippedMsg = truncateToWidth(styledMsg, msgAvail, "…");
			const clippedW = visibleWidth(clippedMsg);
			const msgStartCol = innerLeft + prefixW;
			for (const sh of skillHitsPending) {
				if (sh.xOffset + sh.width <= clippedW) {
					this.hits.push({
						id: sh.id,
						xStart: msgStartCol + sh.xOffset,
						xEnd: msgStartCol + sh.xOffset + sh.width,
						y: screenRowY,
						onClick: () => {},
						onClickAt: sh.onClickAt,
					});
				}
			}
			const leftPart = `${badgeStyled} ${clippedMsg}`;
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
			if (hit.onClickAt) {
				hit.onClickAt(event.screenX, event.screenY);
			} else {
				hit.onClick();
			}
			return { handled: true, render: true };
		}
		return undefined;
	}
}

/**
 * Устанавливает перехват отображения очереди отложенных сообщений над Composer,
 * заменяя статичные строки хоста на кликабельную панель `[Send now] [Edit · Alt+↑] [×]`.
 */
const STRING_ARRAY_WIDGETS = new WeakSet<object>();

function computeWidgetSidePadding(width: number): number {
	const outerPad = computeOuterCanvasMargin(width);
	return outerPad > 0 && width >= 16 ? outerPad + 2 : outerPad;
}

function normalizeHostStringArrayWidget(component: Component): void {
	if (!(component instanceof Container)) return;
	if (
		!STRING_ARRAY_WIDGETS.has(component) &&
		!(component.children.length > 0 && component.children.every((child) => child instanceof Text))
	) {
		return;
	}
	for (const child of component.children) {
		if (child instanceof Text) {
			child.setPaddingX(0);
		}
	}
}

class InsetExtensionWidgetComponent implements Component, Focusable {
	private lastPad = 0;
	private lastInnerWidth = 0;

	constructor(private readonly inner: Component) {}

	get focused(): boolean {
		return isFocusable(this.inner) ? this.inner.focused : false;
	}

	set focused(value: boolean) {
		if (isFocusable(this.inner)) {
			this.inner.focused = value;
		}
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		const pad = computeWidgetSidePadding(width);
		const innerWidth = Math.max(1, width - pad * 2);
		this.lastPad = pad;
		this.lastInnerWidth = innerWidth;

		const rawLines = this.inner.render(innerWidth);
		if (rawLines.length === 0 || pad === 0) {
			return [...rawLines];
		}
		const margin = " ".repeat(pad);
		return rawLines.map((line) => {
			if (line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) {
				return `${margin}${line}`;
			}
			const clipped = visibleWidth(line) > innerWidth ? truncateToWidth(line, innerWidth, "…") : line;
			const rightFill = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
			return `${margin}${clipped}\x1b[0m${rightFill}${margin}`;
		});
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (typeof this.inner.handleMouse !== "function") {
			return undefined;
		}
		const pad = this.lastPad;
		const innerWidth = Math.max(1, this.lastInnerWidth || Math.max(1, event.width - pad * 2));
		if (
			event.type !== "drag" &&
			event.type !== "release" &&
			(event.x < pad || event.x >= pad + innerWidth)
		) {
			return undefined;
		}
		const res = this.inner.handleMouse({
			...event,
			x: event.x - pad,
			width: innerWidth,
		});
		if (res && typeof res === "object" && "target" in res) {
			const { target: _ignoredTarget, focusTarget: _ignoredFocus, ...plain } = res as TuiMouseEventResult & {
				target?: unknown;
				focusTarget?: unknown;
			};
			return plain;
		}
		return res;
	}
}

export function installExtensionWidgetMargins(): void {
	const modeProto = (InteractiveMode as unknown as { prototype?: object } | undefined)?.prototype;
	if (!modeProto) return;

	hookMethod(
		modeProto,
		"setExtensionWidget",
		"chrome.tagStringArrayWidget",
		(self, args, original) => {
			const result = original.apply(self, args);
			const [key, content, options] = args as [
				string,
				unknown,
				{ placement?: "aboveEditor" | "belowEditor" } | undefined,
			];
			if (Array.isArray(content)) {
				const mode = self as HostInteractiveModeInternals;
				const targetMap =
					options?.placement === "belowEditor"
						? mode.extensionWidgetsBelow
						: mode.extensionWidgetsAbove;
				const created = targetMap?.get(key);
				if (created && typeof created === "object") {
					STRING_ARRAY_WIDGETS.add(created);
				}
			}
			return result;
		},
	);

	hookMethod(
		modeProto,
		"renderWidgetContainer",
		"chrome.insetExtensionWidgets",
		(self, args, original) => {
			if (!isSlotOwnedByPiUi("editor")) {
				return original.apply(self, args);
			}
			const [container, widgets, spacerWhenEmpty, leadingSpacer] = args as [
				Container,
				Map<string, Component>,
				boolean,
				boolean,
			];
			container.clear();
			if (widgets.size === 0) {
				if (spacerWhenEmpty) {
					container.addChild(new Spacer(1));
				}
				return;
			}
			if (leadingSpacer) {
				container.addChild(new Spacer(1));
			}
			for (const component of widgets.values()) {
				normalizeHostStringArrayWidget(component);
				container.addChild(
					component instanceof InsetExtensionWidgetComponent
						? component
						: new InsetExtensionWidgetComponent(component),
				);
			}
		},
	);
}

export function installMidTurnQueueUi(getTheme: () => Theme): void {
	const state = getQueueState();
	state.getTheme = getTheme;
	installExtensionWidgetMargins();

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
		"restoreQueuedMessagesToEditor",
		"midTurnQueue.cleanRestoreQueued",
		(self, args, original) => {
			const mode = self as HostInteractiveModeInternals & {
				editor?: { getText(): string; getExpandedText?: () => string; setText(t: string): void };
			};
			const snap = snapshotQueues(mode);
			if (!snap || (snap.steering.length === 0 && snap.followUp.length === 0)) {
				return original.apply(self, args);
			}
			const options = (args[0] ?? {}) as { abort?: boolean; currentText?: string };
			mode.clearAllQueues();
			const cwd = getActiveHostRuntime()?.ctx.cwd ?? process.cwd();
			const allPayloads = [...snap.steering, ...snap.followUp];
			const restoredItems = allPayloads.map((p) => restoreQueuedPayloadToDraft(p, cwd));
			const currentText =
				options.currentText ?? mode.editor?.getExpandedText?.() ?? mode.editor?.getText() ?? "";
			const combined = [...restoredItems, currentText].filter((part) => part.trim().length > 0).join("\n\n");
			mode.editor?.setText(combined);
			mode.updatePendingMessagesDisplay();
			if (options.abort) {
				void mode.session.abort();
			}
			return allPayloads.length;
		},
	);

	hookMethod(modeProto, "handleDequeue", "midTurnQueue.editTopItem", (self, args, original) => {
		if (!getActiveHostRuntime()) return original.apply(self, args);
		captureMode(self);
		const top = getActiveQueuedEntries()[0];
		if (!top) return original.apply(self, args);
		void editQueuedMidTurnItem(top.kind, top.index).catch((error: unknown) => {
			getActiveHostRuntime()?.ctx.ui.notify(t("composer.queue.restoreFailed", { error: String(error) }), "error");
		});
	});

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

	state.activeMode?.renderWidgets?.();
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
