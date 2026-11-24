import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Spacer,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import { getStore } from "../../shared/session-store.ts";

const MAX_THOUGHTS_WIDTH = 120;
const STREAMING_THOUGHT_TAIL_LINES = 4;

interface WaveClock {
	phase: number;
	timer?: ReturnType<typeof setInterval>;
}

const WAVE_CLOCK_KEY = Symbol.for("conarti.pi-ui.wave-clock.v1");

function getWaveClock(): WaveClock {
	const g = globalThis as Record<symbol, WaveClock | undefined>;
	if (!g[WAVE_CLOCK_KEY]) {
		g[WAVE_CLOCK_KEY] = { phase: 0 };
	}
	return g[WAVE_CLOCK_KEY]!;
}

export function startThinkingWave(): void {
	const clock = getWaveClock();
	if (clock.timer) return;
	clock.timer = setInterval(() => {
		const st = getStore();
		if (!st.isStreaming) {
			stopThinkingWave();
			return;
		}
		clock.phase = (clock.phase + 1) % 64;
		st.requestRender?.();
	}, 65);
	clock.timer.unref?.();
}

export function stopThinkingWave(): void {
	const clock = getWaveClock();
	if (clock.timer) {
		clearInterval(clock.timer);
		clock.timer = undefined;
	}
}

function waveAccentGlyph(row: number, glyph: string, lightMode: boolean): string {
	const clock = getWaveClock();
	const angle = ((row - clock.phase * 0.85) / 12) * Math.PI * 2;
	const t = (Math.cos(angle) + 1) * 0.5;
	if (lightMode) {
		const r = Math.round(148 + (37 - 148) * t);
		const g = Math.round(163 + (99 - 163) * t);
		const b = Math.round(184 + (235 - 184) * t);
		return fgRgb(r, g, b, glyph);
	}
	const r = Math.round(64 + (125 - 64) * t);
	const g = Math.round(82 + (207 - 82) * t);
	const b = Math.round(112 + (255 - 112) * t);
	return fgRgb(r, g, b, glyph);
}

export class ThinkingBlock implements Component {
	private hovered = false;

	constructor(
		private readonly thinkingText: string,
		private readonly isStreamingNow: boolean,
		private readonly isExpanded: boolean,
		private readonly onToggle: () => void,
		private readonly themeRef: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const outerPad = width >= 48 ? 2 : 1;
		const margin = " ".repeat(outerPad);
		const cappedWidth = Math.max(16, Math.min(width - outerPad * 2, MAX_THOUGHTS_WIDTH));
		const textAvail = Math.max(10, cappedWidth - 4);
		const light = isLightTheme(this.themeRef);

		const cleanSource = this.thinkingText
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((l) => l.replace(/^\s*#{1,6}\s+/, "").trimEnd());

		const allWrapped: string[] = [];
		for (const rawLine of cleanSource) {
			if (!rawLine.trim()) {
				if (allWrapped.length > 0 && allWrapped[allWrapped.length - 1] !== "") {
					allWrapped.push("");
				}
				continue;
			}
			for (const w of wrapTextWithAnsi(rawLine, textAvail)) {
				allWrapped.push(stripTerminalSequences(w));
			}
		}

		const nonEmptyCount = allWrapped.filter((l) => l.trim().length > 0).length;
		const dimBody = (s: string) => (light ? fgRgb(100, 116, 139, s) : fgRgb(120, 133, 154, s));
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
			startThinkingWave();
			const hdrSpine = waveAccentGlyph(0, "┃", light);
			const hdrRow = `${margin}${hdrSpine} ${headerMuted("Thinking…")}`;
			out.push(hdrRow + " ".repeat(Math.max(0, width - visibleWidth(hdrRow))));

			const tail = allWrapped.filter((l) => l.trim().length > 0).slice(-STREAMING_THOUGHT_TAIL_LINES);
			for (let i = 0; i < tail.length; i++) {
				const spine = waveAccentGlyph(i + 1, "▎", light);
				const row = truncateToWidth(`${margin}${spine} ${dimBody(tail[i]!)}`, width, "…");
				out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
			}
			return out;
		}

		if (!this.isExpanded) {
			const collapsedSpine = this.hovered
				? fgRgb(97, 175, 239, "❙")
				: light
					? fgRgb(148, 163, 184, "❙")
					: fgRgb(78, 92, 114, "❙");
			const firstSnippet = allWrapped.find((l) => l.trim().length > 0) ?? "";
			const snippetBudget = Math.max(0, cappedWidth - 24);
			const snippet =
				firstSnippet && snippetBudget > 16
					? ` ${this.themeRef.fg("dim", `— ${truncateToWidth(firstSnippet.replace(/[*_`]/g, ""), snippetBudget, "…")}`)}`
					: "";
			const countHint = nonEmptyCount > 0 ? this.themeRef.fg("dim", ` (${nonEmptyCount})`) : "";
			const line = truncateToWidth(
				`${margin}${collapsedSpine} ${headerMuted("› Thought")}${countHint}${snippet}`,
				width,
				"…",
			);
			return [line + " ".repeat(Math.max(0, width - visibleWidth(line)))];
		}

		const openSpine = light ? fgRgb(148, 163, 184, "│") : fgRgb(76, 92, 118, "│");
		const topSpine = light ? fgRgb(59, 130, 246, "┃") : fgRgb(97, 175, 239, "┃");
		const hdr = `${margin}${topSpine} ${headerMuted("⌄ Thought")}${this.themeRef.fg("dim", "  · клик свернуть")}`;
		out.push(hdr + " ".repeat(Math.max(0, width - visibleWidth(hdr))));

		for (const rowText of allWrapped) {
			const row = truncateToWidth(`${margin}${openSpine} ${dimBody(rowText)}`, width, "…");
			out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
		}
		return out;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const requestRender = () => getStore().requestRender?.();
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
					if (thinkingParts.length === 0) continue;

					const runIndex = thinkingRunIndex++;
					const hasSubsequentContent = contents
						.slice(endIdx)
						.some((c) => (c?.type === "text" && String(c.text ?? "").trim()) || c?.type === "toolCall");
					const activelyThinkingNow = Boolean(isStreaming && !hasSubsequentContent);

					const override: boolean | undefined = self.thinkingVisibilityOverrides?.get?.(runIndex);
					const isExpanded = override !== undefined ? !override : false;

					if (self.hideThinkingBlock && override === undefined && !activelyThinkingNow) {
						if (!String(self.hiddenThinkingLabel ?? "Thinking...").trim()) continue;
					}

					const joinedThinking = thinkingParts.join("\n\n");
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
						),
					);
					needsSpacer = true;
				}
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
