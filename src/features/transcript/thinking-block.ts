import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Spacer,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type MarkdownTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	activateAnimationSurface,
	deactivateAnimationSurface,
	paintBreathingWaveGlyph,
} from "../../shared/animation-scheduler.ts";
import { fgRgb, getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";
import { t } from "../../shared/i18n.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";

const MAX_THOUGHTS_WIDTH = 120;
const STREAMING_THOUGHT_TAIL_LINES = 3;
const THINKING_BLOCK_MARKER = Symbol.for("conarti.pi-ui.thinking-block");

export function formatThinkingDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
		return undefined;
	}
	const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const rem = totalSeconds % 60;
		return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const rem = totalSeconds % 60;
	if (rem > 0) return `${hours}h ${minutes}m ${rem}s`;
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatThoughtLabel(durationMs: number | undefined): string {
	const formatted = formatThinkingDuration(durationMs);
	return formatted ? `Thought for ${formatted}` : "Thought";
}

export function isThinkingBlock(value: unknown): boolean {
	if (value instanceof ThinkingBlock) return true;
	if (typeof value !== "object" || value === null) return false;
	return (
		(value as Record<PropertyKey, unknown>)[THINKING_BLOCK_MARKER] === true ||
		value.constructor?.name === "ThinkingBlock"
	);
}

const THINKING_WAVE_SURFACE_KEY = "transcript.thinking-wave";
const THINKING_TIMINGS_KEY = Symbol.for("conarti.pi-ui.thinking-timings.v1");
const MAX_TRACKED_THINKING_RUNS = 2000;

interface ThinkingRunTiming {
	startedAt: number;
	endedAt?: number;
	signature: string;
	closedByEvent?: boolean;
}

interface SharedThinkingTimingStore {
	byRunKey: Map<string, ThinkingRunTiming>;
}

function getSharedThinkingTimingStore(): SharedThinkingTimingStore {
	const g = globalThis as Record<symbol, SharedThinkingTimingStore | undefined>;
	if (!g[THINKING_TIMINGS_KEY]) {
		g[THINKING_TIMINGS_KEY] = {
			byRunKey: new Map(),
		};
	}
	return g[THINKING_TIMINGS_KEY]!;
}

export function clearRecordedThinkingTimings(): void {
	getSharedThinkingTimingStore().byRunKey.clear();
}

function makeThinkingRunKey(message: any, runIndex: number): string | undefined {
	const ts = message?.timestamp;
	if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
	return `${ts}:${runIndex}`;
}

function rememberSharedTiming(key: string | undefined, timing: ThinkingRunTiming): void {
	if (!key) return;
	const { byRunKey } = getSharedThinkingTimingStore();
	byRunKey.set(key, timing);
	if (byRunKey.size > MAX_TRACKED_THINKING_RUNS) {
		const oldest = byRunKey.keys().next().value;
		if (oldest !== undefined) byRunKey.delete(oldest);
	}
}

function lookupSharedTiming(
	key: string | undefined,
	sig: string,
	isStreaming: boolean,
): ThinkingRunTiming | undefined {
	if (!key) return undefined;
	const existing = getSharedThinkingTimingStore().byRunKey.get(key);
	if (!existing) return undefined;
	if (isStreaming || !existing.signature || !sig) return existing;
	if (existing.signature === sig || sig.startsWith(existing.signature)) {
		return existing;
	}
	return undefined;
}

function hasContentAfterThinkingRun(contents: any[], endIdx: number): boolean {
	for (let k = endIdx; k < contents.length; k++) {
		const item = contents[k];
		if (item?.type === "text" || item?.type === "toolCall") return true;
	}
	return false;
}

export function observeAssistantThinkingMessage(
	message: any,
	isStreaming: boolean,
	assistantEvent?: any,
): void {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
	const contents: any[] = message.content;
	let thinkingRunIndex = 0;

	for (let i = 0; i < contents.length; i++) {
		if (contents[i]?.type !== "thinking") continue;
		const startIdx = i;
		const thinkingParts: string[] = [];
		let allRedacted = true;
		let endIdx = i;
		for (; endIdx < contents.length; endIdx++) {
			const tc = contents[endIdx];
			if (tc?.type !== "thinking") break;
			if (tc.redacted !== true) allRedacted = false;
			const trimmed = String(tc.thinking ?? "").trim();
			if (trimmed) thinkingParts.push(trimmed);
		}
		i = endIdx - 1;
		const runIndex = thinkingRunIndex++;
		const joined = thinkingParts.join("\n\n");
		const sig = joined.slice(0, 160);
		const runKey = makeThinkingRunKey(message, runIndex);
		let timing = lookupSharedTiming(runKey, sig, isStreaming);

		const endedViaStreamEvent =
			(assistantEvent?.type === "thinking_end" &&
				typeof assistantEvent.contentIndex === "number" &&
				assistantEvent.contentIndex >= startIdx &&
				assistantEvent.contentIndex < endIdx &&
				assistantEvent.contentIndex === endIdx - 1) ||
			((assistantEvent?.type === "text_start" || assistantEvent?.type === "toolcall_start") &&
				typeof assistantEvent.contentIndex === "number" &&
				assistantEvent.contentIndex >= endIdx);

		if (endedViaStreamEvent && timing) {
			timing.closedByEvent = true;
			timing.endedAt ??= Date.now();
		}

		const hasSubsequentContent = hasContentAfterThinkingRun(contents, endIdx);
		const activelyThinkingNow = Boolean(
			isStreaming && !hasSubsequentContent && !endedViaStreamEvent && !timing?.closedByEvent,
		);

		if (activelyThinkingNow) {
			if (allRedacted && thinkingParts.length === 0) continue;
			if (!timing) {
				timing = { startedAt: Date.now(), signature: sig };
			} else if (sig) {
				timing.signature = sig;
			}
			rememberSharedTiming(runKey, timing);
		} else if (timing) {
			timing.endedAt ??= Date.now();
			if (sig) timing.signature = sig;
			rememberSharedTiming(runKey, timing);
		}
	}
}

export function stopThinkingWave(): void {
	deactivateAnimationSurface(THINKING_WAVE_SURFACE_KEY);
}

function waveAccentGlyph(row: number, glyph: string, lightMode: boolean): string {
	return paintBreathingWaveGlyph(row, glyph, { light: lightMode });
}

function createSoftThinkingMarkdown(text: string, themeRef: Theme, light: boolean): Markdown {
	const bodyRgb: readonly [number, number, number] = light ? [100, 116, 139] : [124, 138, 160];
	const strongRgb: readonly [number, number, number] = light ? [64, 84, 114] : [156, 174, 200];
	const bodyEsc = `\x1b[38;2;${bodyRgb[0]};${bodyRgb[1]};${bodyRgb[2]}m`;
	const strongEsc = `\x1b[38;2;${strongRgb[0]};${strongRgb[1]};${strongRgb[2]}m`;
	const bodyFg = (s: string) => fgRgb(bodyRgb, s);
	const dimFg = (s: string) => (light ? fgRgb(132, 148, 170, s) : fgRgb(92, 108, 132, s));
	/* Markdown оборачивает вложенный текст в bodyFg до вызова bold(), поэтому заменяем внутренний SGR-префикс. */
	const strongFg = (s: string) => fgRgb(strongRgb, s.replaceAll(bodyEsc, strongEsc));
	const codeFg = (s: string) => (light ? fgRgb(44, 104, 178, s) : fgRgb(128, 178, 218, s));

	const mdTheme: MarkdownTheme = {
		heading: (s: string) => strongFg(s),
		link: (s: string) => codeFg(s),
		linkUrl: (s: string) => dimFg(s),
		code: (s: string) => codeFg(s),
		codeBlock: (s: string) => codeFg(s),
		codeBlockBorder: (s: string) => dimFg(s),
		quote: (s: string) => bodyFg(s),
		quoteBorder: (s: string) => dimFg(s),
		hr: (s: string) => dimFg(s),
		listBullet: (s: string) => dimFg(s),
		bold: (s: string) => themeRef.bold(strongFg(s)),
		italic: (s: string) => themeRef.italic(s),
		underline: (s: string) => themeRef.underline(s),
		strikethrough: (s: string) => themeRef.strikethrough(s),
	};

	const md = new Markdown(text, 0, 0, mdTheme, {
		color: bodyFg,
	});
	(md as any).__conartiThinkingMarkdown = true;
	(md as any).__conartiSkipReplyCopy = true;
	return md;
}

export class ThinkingBlock implements Component {
	readonly [THINKING_BLOCK_MARKER] = true;
	private readonly hoverSlot: { hovered: boolean };
	private markdownCache?: { light: boolean; md: Markdown };

	constructor(
		private readonly thinkingText: string,
		private readonly isStreamingNow: boolean,
		private readonly isExpanded: boolean,
		private readonly onToggle: () => void,
		private readonly themeRef: Theme,
		private readonly durationMs?: number,
		markdownSlot?: { light: boolean; md: Markdown },
		hoverSlot?: { hovered: boolean },
	) {
		this.markdownCache = markdownSlot;
		this.hoverSlot = hoverSlot ?? { hovered: false };
	}

	invalidate(): void {
		this.markdownCache?.md.invalidate();
	}

	private renderFormattedLines(contentWidth: number, light: boolean, activeTheme: Theme): string[] {
		if (!this.markdownCache || this.markdownCache.light !== light) {
			this.markdownCache = {
				light,
				md: createSoftThinkingMarkdown(this.thinkingText, activeTheme, light),
			};
		} else if ((this.markdownCache.md as any).text !== this.thinkingText) {
			this.markdownCache.md.setText(this.thinkingText);
		}
		return this.markdownCache.md.render(contentWidth).map((line) => line.replace(/ +$/u, ""));
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const outerPad = width >= 40 ? 4 : 2;
		const margin = " ".repeat(outerPad);
		const cappedWidth = Math.max(8, Math.min(width - outerPad * 2, MAX_THOUGHTS_WIDTH));
		const textAvail = Math.max(4, cappedWidth - 2);
		const activeTheme = getActiveGlobalTheme(this.themeRef);
		const light = isLightTheme(activeTheme);
		const isHovered = this.hoverSlot.hovered;

		const headerMuted = (s: string) =>
			isHovered
				? light
					? fgRgb(37, 99, 235, s)
					: fgRgb(145, 195, 248, s)
				: light
					? fgRgb(100, 116, 139, s)
					: fgRgb(118, 132, 154, s);

		const out: string[] = [];

		if (this.isStreamingNow) {
			const hdrSpine = waveAccentGlyph(0, "┃", light);
			const hdrRow = truncateToWidth(`${margin}${hdrSpine} ${headerMuted("Thinking…")}`, width, "…");
			out.push(hdrRow + " ".repeat(Math.max(0, width - visibleWidth(hdrRow))));

			const formattedLines = this.renderFormattedLines(textAvail, light, activeTheme);
			const nonEmptyLines = formattedLines.filter((l) => stripTerminalSequences(l).trim().length > 0);
			const contentLines = nonEmptyLines.filter(
				(l) => !/^(?:`{3,}|~{3,})[^\s`~]*$/u.test(stripTerminalSequences(l).trim()),
			);
			const tail = (contentLines.length > 0 ? contentLines : nonEmptyLines).slice(
				-STREAMING_THOUGHT_TAIL_LINES,
			);
			for (let i = 0; i < tail.length; i++) {
				const spine = waveAccentGlyph(i + 1, "▎", light);
				const row = truncateToWidth(`${margin}${spine} ${tail[i]!}`, width, "…");
				out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
			}
			return out;
		}

		const label = formatThoughtLabel(this.durationMs);

		if (!this.isExpanded) {
			const collapsedSpine = isHovered
				? light
					? fgRgb(37, 99, 235, "❙")
					: fgRgb(97, 175, 239, "❙")
				: light
					? fgRgb(148, 163, 184, "❙")
					: fgRgb(78, 92, 114, "❙");
			const line = truncateToWidth(
				`${margin}${collapsedSpine} ${headerMuted(`› ${label}`)}`,
				width,
				"…",
			);
			return [line + " ".repeat(Math.max(0, width - visibleWidth(line)))];
		}

		const openSpine = light ? fgRgb(148, 163, 184, "│") : fgRgb(76, 92, 118, "│");
		const topSpine = isHovered
			? light
				? fgRgb(37, 99, 235, "│")
				: fgRgb(97, 175, 239, "│")
			: openSpine;
		const hdr = truncateToWidth(`${margin}${topSpine} ${headerMuted(`⌄ ${label}`)}`, width, "…");
		out.push(hdr + " ".repeat(Math.max(0, width - visibleWidth(hdr))));

		const formattedLines = this.renderFormattedLines(textAvail, light, activeTheme);
		for (const rowText of formattedLines) {
			const bodyLine = rowText ? `${margin}${openSpine} ${rowText}` : `${margin}${openSpine}`;
			const row = truncateToWidth(bodyLine, width, "…");
			out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
		}
		return out;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			claimHover(this.hoverSlot, () => {
				if (this.hoverSlot.hovered) {
					this.hoverSlot.hovered = false;
					requestRender();
				}
			});
			if (!this.hoverSlot.hovered) {
				this.hoverSlot.hovered = true;
				return { handled: true, render: true };
			}
			return undefined;
		}
		/* Перехватываем press на строке заголовка, чтобы быстрый повторный клик (<500мс) не запускал выделение слова в TuiAltScreen */
		if (event.type === "press" && event.button === "left" && (!this.isExpanded || event.y === 0)) {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			this.onToggle();
			return { handled: true, render: true };
		}
		return undefined;
	}
}

export function installAssistantTranscriptBlocks(): void {
	const proto = AssistantMessageComponent.prototype as any;

	hookMethod(
		proto,
		"updateContent",
		"transcript.assistantUpdate",
		(self, args) => {
			const [message, isStreamingArg] = args as [any, boolean | undefined];
			const isStreaming = isStreamingArg ?? self.isStreaming ?? false;
			self.lastMessage = message;
			self.isStreaming = isStreaming;

			self.contentContainer.clear();
			const previousSlots: Array<{ kind: string; markdown: Markdown }> = self.markdownSlots ?? [];
			self.markdownSlots = [];
			const chatPad = 4;

			const markdownBlock = (kind: string, text: string, create: () => Markdown) => {
				const slot = previousSlots[self.markdownSlots.length];
				const markdown = slot?.kind === kind ? slot.markdown : create();
				markdown.setText(text);
				self.markdownSlots.push({ kind, markdown });
				return markdown;
			};

			let needsSpacer = true;
			const addVisibleChild = (child: Component) => {
				if (needsSpacer) {
					self.contentContainer.addChild(new Spacer(1));
					needsSpacer = false;
				}
				self.contentContainer.addChild(child);
			};

			const themeRef = getActiveGlobalTheme(self?.theme);
			const contents: any[] = Array.isArray(message?.content) ? message.content : [];
			let thinkingRunIndex = 0;
			let hasActiveThinkingRun = false;

			for (let i = 0; i < contents.length; i++) {
				const part = contents[i];
				if (part?.type === "text" && String(part.text ?? "").trim()) {
					const text = String(part.text).trim();
					const transformers: Array<(md: string, ctx: any) => unknown> = Array.isArray(self.markdownTransformers)
						? self.markdownTransformers
						: [];
					addVisibleChild(
						markdownBlock("text", text, () =>
							new Markdown(text, chatPad, 0, self.markdownTheme, undefined, {
								transform: (markdown: string, availableWidth: number) => {
									let outMd = markdown;
									const txCtx = {
										messageType: "assistant",
										isStreaming: Boolean(self.isStreaming),
										availableWidth,
										messageId: self.messageId,
										timestamp: self.timestamp,
									};
									for (const fn of transformers) {
										try {
											const next = fn(outMd, txCtx);
											if (typeof next === "string") outMd = next;
										} catch {}
									}
									return outMd;
								},
							}),
						),
					);
					needsSpacer = true;
				} else if (part?.type === "thinking") {
					const thinkingParts: string[] = [];
					let allRedacted = true;
					let endIdx = i;
					for (; endIdx < contents.length; endIdx++) {
						const tc = contents[endIdx];
						if (tc?.type !== "thinking") break;
						if (tc.redacted !== true) allRedacted = false;
						const trimmed = String(tc.thinking ?? "").trim();
						if (trimmed) thinkingParts.push(trimmed);
					}
					i = endIdx - 1;
					const runIndex = thinkingRunIndex++;
					const hasSubsequentContent = hasContentAfterThinkingRun(contents, endIdx);

					const compTimings: Map<number, ThinkingRunTiming> =
						(self.__conartiThinkingTimings ??= new Map());
					const joinedThinking = thinkingParts.join("\n\n");
					const sig = joinedThinking.slice(0, 160);
					const runKey = makeThinkingRunKey(message, runIndex);

					let runTiming =
						compTimings.get(runIndex) ?? lookupSharedTiming(runKey, sig, Boolean(isStreaming));

					const activelyThinkingNow = Boolean(
						isStreaming && !hasSubsequentContent && !runTiming?.closedByEvent,
					);

					if (activelyThinkingNow) {
						if (allRedacted && thinkingParts.length === 0) continue;
						if (!runTiming) {
							runTiming = { startedAt: Date.now(), signature: sig };
						} else if (sig) {
							runTiming.signature = sig;
						}
						compTimings.set(runIndex, runTiming);
						rememberSharedTiming(runKey, runTiming);
					} else if (runTiming) {
						runTiming.endedAt ??= Date.now();
						if (sig) runTiming.signature = sig;
						compTimings.set(runIndex, runTiming);
						rememberSharedTiming(runKey, runTiming);
					}

					const override: boolean | undefined = self.thinkingVisibilityOverrides?.get?.(runIndex);
					const isExpanded = override !== undefined ? !override : false;

					if (thinkingParts.length === 0) {
						if (!activelyThinkingNow || allRedacted || (self.hideThinkingBlock && override === undefined)) {
							continue;
						}
					}

					if (self.hideThinkingBlock && override === undefined && !activelyThinkingNow) {
						if (!String(self.hiddenThinkingLabel ?? "Thinking...").trim()) continue;
					}

					if (activelyThinkingNow) {
						hasActiveThinkingRun = true;
					}

					const durationMs =
						runTiming && runTiming.endedAt !== undefined
							? Math.max(0, runTiming.endedAt - runTiming.startedAt)
							: undefined;

					const mdSlots: Map<number, { light: boolean; md: Markdown }> =
						(self.__conartiThinkingMdSlots ??= new Map());
					const lightNow = isLightTheme(themeRef);
					let mdSlot = mdSlots.get(runIndex);
					if (!mdSlot || mdSlot.light !== lightNow) {
						mdSlot = {
							light: lightNow,
							md: createSoftThinkingMarkdown(joinedThinking, themeRef, lightNow),
						};
						mdSlots.set(runIndex, mdSlot);
					} else {
						mdSlot.md.setText(joinedThinking);
					}
					const hoverSlots: Map<number, { hovered: boolean }> =
						(self.__conartiThinkingHoverSlots ??= new Map());
					let hoverSlot = hoverSlots.get(runIndex);
					if (!hoverSlot) {
						hoverSlot = { hovered: false };
						hoverSlots.set(runIndex, hoverSlot);
					}
					addVisibleChild(
						new ThinkingBlock(
							joinedThinking,
							activelyThinkingNow,
							isExpanded,
							() => {
								self.thinkingVisibilityOverrides.set(runIndex, isExpanded);
								if (self.lastMessage) {
									self.updateContent(self.lastMessage, self.isStreaming);
								}
							},
							themeRef,
							durationMs,
							mdSlot,
							hoverSlot,
						),
					);
					needsSpacer = true;
				}
			}

			if (hasActiveThinkingRun) {
				activateAnimationSurface(self, () => {
					requestRender();
				});
			} else {
				deactivateAnimationSurface(self);
			}

			const hasToolCalls = contents.some((c) => c?.type === "toolCall");
			self.hasToolCalls = hasToolCalls;
			if (message?.stopReason === "length") {
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(themeRef.fg("error", t("transcript.truncated")), chatPad, 0),
				);
			} else if (!hasToolCalls) {
				if (message?.stopReason === "aborted") {
					const abortMsg =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: t("transcript.stopped");
					self.contentContainer.addChild(new Spacer(1));
					self.contentContainer.addChild(new Text(themeRef.fg("muted", `⏹ ${abortMsg}`), chatPad, 0));
				} else if (message?.stopReason === "error") {
					const errMsg = message.errorMessage || "Unknown error";
					self.contentContainer.addChild(new Spacer(1));
					self.contentContainer.addChild(
						new Text(themeRef.fg("error", t("transcript.error", { message: errMsg })), chatPad, 0),
					);
				}
			}
		},
		["pi.grok-ui.hook.chat.assistantUpdate"],
	);
}
