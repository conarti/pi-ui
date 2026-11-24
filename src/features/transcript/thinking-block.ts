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
}

interface SharedThinkingTimingStore {
	bySignature: Map<string, ThinkingRunTiming>;
}

function getSharedThinkingTimingStore(): SharedThinkingTimingStore {
	const g = globalThis as Record<symbol, SharedThinkingTimingStore | undefined>;
	if (!g[THINKING_TIMINGS_KEY]) {
		g[THINKING_TIMINGS_KEY] = {
			bySignature: new Map(),
		};
	}
	return g[THINKING_TIMINGS_KEY]!;
}

export function clearRecordedThinkingTimings(): void {
	getSharedThinkingTimingStore().bySignature.clear();
}

function makeThinkingSignatureKey(
	message: any,
	runIndex: number,
	joinedThinking: string,
): string | undefined {
	const ts = message?.timestamp;
	if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
	return `${ts}:${runIndex}:${joinedThinking.slice(0, 160)}`;
}

function rememberSharedTiming(key: string | undefined, timing: ThinkingRunTiming): void {
	if (!key) return;
	const { bySignature } = getSharedThinkingTimingStore();
	bySignature.set(key, timing);
	if (bySignature.size > MAX_TRACKED_THINKING_RUNS) {
		const oldest = bySignature.keys().next().value;
		if (oldest !== undefined) bySignature.delete(oldest);
	}
}

export function observeAssistantThinkingMessage(message: any, isStreaming: boolean): void {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
	const store = getSharedThinkingTimingStore();
	const contents: any[] = message.content;
	let thinkingRunIndex = 0;

	for (let i = 0; i < contents.length; i++) {
		if (contents[i]?.type !== "thinking") continue;
		const thinkingParts: string[] = [];
		let endIdx = i;
		for (; endIdx < contents.length; endIdx++) {
			const tc = contents[endIdx];
			if (tc?.type !== "thinking") break;
			const trimmed = String(tc.thinking ?? "").trim();
			if (trimmed) thinkingParts.push(trimmed);
		}
		i = endIdx - 1;
		const runIndex = thinkingRunIndex++;
		const hasSubsequentContent = contents
			.slice(endIdx)
			.some((c) => (c?.type === "text" && String(c.text ?? "").trim()) || c?.type === "toolCall");
		const activelyThinkingNow = Boolean(isStreaming && !hasSubsequentContent);
		const joined = thinkingParts.join("\n\n");
		const exactKey = makeThinkingSignatureKey(message, runIndex, joined);
		const prefixKey =
			typeof message?.timestamp === "number" ? `${message.timestamp}:active:${runIndex}` : undefined;

		let timing =
			(exactKey ? store.bySignature.get(exactKey) : undefined) ??
			(prefixKey ? store.bySignature.get(prefixKey) : undefined);

		if (activelyThinkingNow) {
			if (!timing) {
				timing = { startedAt: Date.now() };
			}
			rememberSharedTiming(prefixKey, timing);
			if (joined) rememberSharedTiming(exactKey, timing);
		} else if (timing) {
			timing.endedAt ??= Date.now();
			if (joined) rememberSharedTiming(exactKey, timing);
			if (prefixKey) store.bySignature.delete(prefixKey);
		}
	}
}

export function startThinkingWave(): void {
	activateAnimationSurface(THINKING_WAVE_SURFACE_KEY, () => {
		requestRender();
	});
}

export function stopThinkingWave(): void {
	deactivateAnimationSurface(THINKING_WAVE_SURFACE_KEY);
}

function waveAccentGlyph(row: number, glyph: string, lightMode: boolean): string {
	return paintBreathingWaveGlyph(row, glyph, { light: lightMode });
}

function createSoftThinkingMarkdown(text: string, themeRef: Theme, light: boolean): Markdown {
	const bodyFg = (s: string) => (light ? fgRgb(100, 116, 139, s) : fgRgb(124, 138, 160, s));
	const dimFg = (s: string) => (light ? fgRgb(132, 148, 170, s) : fgRgb(92, 108, 132, s));
	const strongFg = (s: string) => (light ? fgRgb(64, 84, 114, s) : fgRgb(156, 174, 200, s));
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
	private hovered = false;
	private markdownCache?: { light: boolean; md: Markdown };

	constructor(
		private readonly thinkingText: string,
		private readonly isStreamingNow: boolean,
		private readonly isExpanded: boolean,
		private readonly onToggle: () => void,
		private readonly themeRef: Theme,
		private readonly durationMs?: number,
		markdownSlot?: { light: boolean; md: Markdown },
	) {
		this.markdownCache = markdownSlot;
	}

	invalidate(): void {
		this.markdownCache?.md.invalidate();
	}

	private renderFormattedLines(contentWidth: number, light: boolean): string[] {
		if (!this.markdownCache || this.markdownCache.light !== light) {
			this.markdownCache = {
				light,
				md: createSoftThinkingMarkdown(this.thinkingText, this.themeRef, light),
			};
		} else if ((this.markdownCache.md as any).text !== this.thinkingText) {
			this.markdownCache.md.setText(this.thinkingText);
		}
		return this.markdownCache.md.render(contentWidth).map((line) => line.replace(/ +$/u, ""));
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const outerPad = width >= 48 ? 2 : 1;
		const margin = " ".repeat(outerPad);
		const cappedWidth = Math.max(8, Math.min(width - outerPad * 2, MAX_THOUGHTS_WIDTH));
		const textAvail = Math.max(4, cappedWidth - 2);
		const light = isLightTheme(getActiveGlobalTheme(this.themeRef));

		const headerMuted = (s: string) =>
			this.hovered
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

			const formattedLines = this.renderFormattedLines(textAvail, light);
			const tail = formattedLines
				.filter((l) => stripTerminalSequences(l).trim().length > 0)
				.slice(-STREAMING_THOUGHT_TAIL_LINES);
			for (let i = 0; i < tail.length; i++) {
				const spine = waveAccentGlyph(i + 1, "▎", light);
				const row = truncateToWidth(`${margin}${spine} ${tail[i]!}`, width, "…");
				out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
			}
			return out;
		}

		const label = formatThoughtLabel(this.durationMs);

		if (!this.isExpanded) {
			const collapsedSpine = this.hovered
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
		const topSpine = this.hovered
			? light
				? fgRgb(37, 99, 235, "│")
				: fgRgb(97, 175, 239, "│")
			: openSpine;
		const hdr = truncateToWidth(`${margin}${topSpine} ${headerMuted(`⌄ ${label}`)}`, width, "…");
		out.push(hdr + " ".repeat(Math.max(0, width - visibleWidth(hdr))));

		const formattedLines = this.renderFormattedLines(textAvail, light);
		for (const rowText of formattedLines) {
			const bodyLine = rowText ? `${margin}${openSpine} ${rowText}` : `${margin}${openSpine}`;
			const row = truncateToWidth(bodyLine, width, "…");
			out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
		}
		return out;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			claimHover(this, () => {
				if (this.hovered) {
					this.hovered = false;
					requestRender();
				}
			});
			if (!this.hovered) {
				this.hovered = true;
				return { handled: true, render: true };
			}
			return undefined;
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
			const chatPad = Math.max(2, self.outputPad ?? 1);

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
										} catch {
											// keep current markdown
										}
									}
									return outMd;
								},
							}),
						),
					);
					needsSpacer = true;
				} else if (part?.type === "thinking") {
					const thinkingParts: string[] = [];
					let endIdx = i;
					for (; endIdx < contents.length; endIdx++) {
						const tc = contents[endIdx];
						if (tc?.type !== "thinking") break;
						const trimmed = String(tc.thinking ?? "").trim();
						if (trimmed) thinkingParts.push(trimmed);
					}
					i = endIdx - 1;
					const runIndex = thinkingRunIndex++;
					const hasSubsequentContent = contents
						.slice(endIdx)
						.some((c) => (c?.type === "text" && String(c.text ?? "").trim()) || c?.type === "toolCall");
					const activelyThinkingNow = Boolean(isStreaming && !hasSubsequentContent);
					if (activelyThinkingNow) {
						hasActiveThinkingRun = true;
					}

					const compTimings: Map<number, ThinkingRunTiming> =
						(self.__conartiThinkingTimings ??= new Map());
					const joinedThinking = thinkingParts.join("\n\n");
					const exactKey = makeThinkingSignatureKey(message, runIndex, joinedThinking);
					const prefixKey =
						typeof message?.timestamp === "number"
							? `${message.timestamp}:active:${runIndex}`
							: undefined;
					const sharedStore = getSharedThinkingTimingStore();

					let runTiming =
						compTimings.get(runIndex) ??
						(exactKey ? sharedStore.bySignature.get(exactKey) : undefined) ??
						(prefixKey ? sharedStore.bySignature.get(prefixKey) : undefined);

					if (activelyThinkingNow) {
						if (!runTiming) {
							runTiming = { startedAt: Date.now() };
						}
						compTimings.set(runIndex, runTiming);
						rememberSharedTiming(prefixKey, runTiming);
						if (joinedThinking) rememberSharedTiming(exactKey, runTiming);
					} else if (runTiming) {
						runTiming.endedAt ??= Date.now();
						compTimings.set(runIndex, runTiming);
						if (joinedThinking) rememberSharedTiming(exactKey, runTiming);
						if (prefixKey) sharedStore.bySignature.delete(prefixKey);
					}

					if (thinkingParts.length === 0) continue;

					const durationMs =
						runTiming && runTiming.endedAt !== undefined
							? Math.max(0, runTiming.endedAt - runTiming.startedAt)
							: undefined;

					const override: boolean | undefined = self.thinkingVisibilityOverrides?.get?.(runIndex);
					const isExpanded = override !== undefined ? !override : false;

					if (self.hideThinkingBlock && override === undefined && !activelyThinkingNow) {
						if (!String(self.hiddenThinkingLabel ?? "Thinking...").trim()) continue;
					}

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
					new Text(themeRef.fg("error", "Ответ обрезан по лимиту токенов."), chatPad, 0),
				);
			} else if (!hasToolCalls) {
				if (message?.stopReason === "aborted") {
					const abortMsg =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Остановлено";
					self.contentContainer.addChild(new Spacer(1));
					self.contentContainer.addChild(new Text(themeRef.fg("muted", `⏹ ${abortMsg}`), chatPad, 0));
				} else if (message?.stopReason === "error") {
					const errMsg = message.errorMessage || "Unknown error";
					self.contentContainer.addChild(new Spacer(1));
					self.contentContainer.addChild(new Text(themeRef.fg("error", `Ошибка: ${errMsg}`), chatPad, 0));
				}
			}
		},
		["pi.grok-ui.hook.chat.assistantUpdate"],
	);
}
