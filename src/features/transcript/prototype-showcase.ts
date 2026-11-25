/**
 * PROTOTYPE (throwaway branch: prototype/thinking-and-tool-calls)
 * Live switcher (/proto A|B|C|demo|clear|stats|translate|off and Alt+V) plus in-memory
 * animated transcript showcase (TTFT -> streaming Thinking -> Tool Calls + native Image -> Metrics).
 */
import { deflateSync } from "node:zlib";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Image,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	activateAnimationSurface,
	deactivateAnimationSurface,
} from "../../shared/animation-scheduler.ts";
import { fgRgb, getActiveGlobalTheme, isLightTheme } from "../../shared/ansi.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { bindComposerWorkingIndicator, startComposerWorkingWave, stopComposerWorkingWave } from "../chrome/working-indicator.ts";
import { densityPalette } from "../tool-calls/density.ts";
import {
	beginWorkingTurn,
	cyclePrototypeVariant,
	getActiveVariantMeta,
	getPrototypeVariant,
	isPrototypeActive,
	isTranslateSeamPreviewEnabled,
	markWorkingPhase,
	PROTOTYPE_VARIANTS,
	setPrototypeVariant,
	setTranslateSeamPreview,
	subscribePrototypeChanges,
	type PrototypeVariant,
} from "./prototype-state.ts";
import {
	openResponseMetricsModal,
	ResponseMetricsRowComponent,
	TTFT_PULSE_MARKER,
	type ResponseMetricsData,
} from "./response-metrics.ts";
import { ThinkingBlock } from "./thinking-block.ts";

const PROTO_STATUS_KEY = "conarti-proto";
const DEMO_ANIM_SURFACE_KEY = "prototype.demo-showcase";

/* ── Генерация миниатюрного PNG с синей призмой для проверки нативного Image ── */

let cachedDemoPngBase64: string | undefined;

function crc32(buf: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i]!;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([typeBytes, Buffer.from(data)]);
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([lenBuf, body, crcBuf]);
}

export function getDemoPrismPngBase64(): string {
	if (cachedDemoPngBase64) return cachedDemoPngBase64;
	const width = 180;
	const height = 64;
	const raw = Buffer.alloc(height * (1 + width * 4));
	const cx = 36;
	const cy = height / 2;

	for (let y = 0; y < height; y++) {
		const rowOffset = y * (1 + width * 4);
		raw[rowOffset] = 0;
		for (let x = 0; x < width; x++) {
			const px = rowOffset + 1 + x * 4;
			const border = x === 0 || x === width - 1 || y === 0 || y === height - 1;
			/* Четырёхлучевая вогнутая призма ❖ слева и спокойные полосы макета справа */
			const dx = Math.abs(x - cx) / 18;
			const dy = Math.abs(y - cy) / 18;
			const starDist = Math.pow(dx, 0.65) + Math.pow(dy, 0.65);
			const bar1 = x >= 68 && x <= 156 && y >= 18 && y <= 24;
			const bar2 = x >= 68 && x <= 136 && y >= 31 && y <= 36;
			const bar3 = x >= 68 && x <= 118 && y >= 43 && y <= 47;

			let r = 20;
			let g = 27;
			let b = 40;
			if (border) {
				r = 58;
				g = 94;
				b = 148;
			} else if (starDist <= 1.0) {
				const glow = 1 - starDist;
				r = Math.round(78 + glow * 110);
				g = Math.round(148 + glow * 82);
				b = Math.round(224 + glow * 31);
			} else if (bar1) {
				r = 88;
				g = 152;
				b = 228;
			} else if (bar2) {
				r = 56;
				g = 92;
				b = 142;
			} else if (bar3) {
				r = 42;
				g = 66;
				b = 104;
			}
			raw[px] = r;
			raw[px + 1] = g;
			raw[px + 2] = b;
			raw[px + 3] = 255;
		}
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const png = Buffer.concat([
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	cachedDemoPngBase64 = png.toString("base64");
	return cachedDemoPngBase64;
}

/* ── Интерактивный живой демо-блок в ленте (не сохраняется в JSONL) ──────── */

class DemoToolGroupMock implements Component {
	private expanded = false;
	private hovered = false;

	invalidate(): void {}

	render(width: number): string[] {
		const theme = getActiveGlobalTheme();
		const pal = densityPalette(theme);
		const variant = getPrototypeVariant();
		const fit = (s: string) => truncateToWidth(s, Math.max(1, width), "…");
		const glyph = pal.diamond("success", this.expanded, this.hovered);

		if (variant === "C") {
			const lines: string[] = [];
			const expChevron = pal.dim(this.expanded ? "▾" : "▸");
			lines.push(
				fit(
					`${pal.rail(" ├ ")}${glyph} ${pal.title("Изучено: 3 ф., 1 поиск", "success", this.expanded, this.hovered)} ${pal.dim("(340ms)")} ${expChevron}`,
				),
			);
			lines.push(
				fit(
					`${pal.rail(" ├ ")}${glyph} ${pal.title("Изменено: 2 ф.", "success", this.expanded, this.hovered)} ${pal.theme.fg("toolDiffAdded", "+18")} ${pal.theme.fg("toolDiffRemoved", "-4")} ${pal.dim("(520ms)")} ${expChevron}`,
				),
			);
			lines.push(
				fit(
					`${pal.rail(" └ ")}${glyph} ${pal.title("Выполнено: 1 ком.", "success", this.expanded, this.hovered)} ${pal.dim("(910ms)")} ${expChevron}`,
				),
			);
			if (this.expanded) {
				lines.push(fit(`     ${pal.dim("· Edited src/features/transcript/thinking-block.ts (+12 -3)")}`));
				lines.push(fit(`     ${pal.dim("· Edited src/features/tool-calls/grouping.ts (+6 -1)")}`));
				lines.push(fit(`     ${pal.dim("· Ran npm run typecheck (0 lines · 910ms)")}`));
			}
			return lines;
		}

		const summary = "Edited 2 files, ran 1 command, explored 3 files";
		const diff = ` ${pal.theme.fg("toolDiffAdded", "+18")} ${pal.theme.fg("toolDiffRemoved", "-4")}`;
		const thoughtNote = variant === "A" ? "1 thought · " : "";
		const meta = ` ${pal.dim(`(${thoughtNote}1.8s)`)}`;
		const disclosure = this.hovered ? ` ${pal.dim(this.expanded ? "⌄" : "›")}` : "";
		const out = [
			fit(`  ${glyph} ${pal.title(summary, "success", this.expanded, this.hovered)}${diff}${meta}${disclosure}`),
		];
		if (this.expanded) {
			const subGlyph = pal.diamond("success", false, false);
			out.push(fit(`    ${subGlyph} ${pal.title("Explored", "success", false)} ${pal.target("3 files, 1 search", false)} ${pal.dim("(340ms)")}`));
			out.push(fit(`    ${subGlyph} ${pal.title("Edited", "success", false)} ${pal.target("src/features/transcript/thinking-block.ts", false)} ${pal.dim("(+12 -3 · 280ms)")}`));
			out.push(fit(`    ${subGlyph} ${pal.title("Edited", "success", false)} ${pal.target("src/features/tool-calls/grouping.ts", false)} ${pal.dim("(+6 -1 · 240ms)")}`));
			out.push(fit(`    ${subGlyph} ${pal.title("Ran", "success", false)} ${pal.target("npm run typecheck", false)} ${pal.dim("(910ms)")}`));
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
		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			this.expanded = !this.expanded;
			return { handled: true, render: true };
		}
		return undefined;
	}
}

class DemoInlineImageRow implements Component {
	private readonly imageComponent: Image;

	constructor() {
		const theme = getActiveGlobalTheme();
		const pal = densityPalette(theme);
		this.imageComponent = new Image(
			getDemoPrismPngBase64(),
			"image/png",
			{ fallbackColor: (s) => pal.dim(s) },
			{ maxWidthCells: 44, filename: "prism-card.png" },
			{ widthPx: 180, heightPx: 64 },
		);
	}

	invalidate(): void {
		this.imageComponent.invalidate();
	}

	render(width: number): string[] {
		const theme = getActiveGlobalTheme();
		const pal = densityPalette(theme);
		const variant = getPrototypeVariant();
		const glyph = pal.diamond("success", false, false);
		const prefix = variant === "C" ? pal.rail(" └ ") : "  ";
		const header = truncateToWidth(
			`${prefix}${glyph} ${pal.title("Read", "success", false)} ${pal.target("assets/prism-card.png", false)} ${pal.dim("(image/png · 180×64 · 14ms)")}`,
			Math.max(1, width),
			"…",
		);
		const imgLines = this.imageComponent.render(Math.max(12, width - 4));
		return [header, ...imgLines];
	}
}

class LiveDemoShowcaseContainer extends Container {
	readonly [TTFT_PULSE_MARKER] = true;
	private stage: "ttft" | "thinking" | "settled" = "ttft";
	private thinkingExpanded = false;
	private readonly startedAt = Date.now();
	private readonly hoverSlot = { hovered: false };
	private readonly groupMock = new DemoToolGroupMock();
	private readonly imageRow = new DemoInlineImageRow();
	private timers: Array<ReturnType<typeof setTimeout>> = [];

	constructor(private readonly ctx: ExtensionContext) {
		super();
		beginWorkingTurn(this.startedAt);
		startComposerWorkingWave();
		activateAnimationSurface(DEMO_ANIM_SURFACE_KEY, () => {
			requestRender();
		});

		this.timers.push(
			setTimeout(() => {
				this.stage = "thinking";
				markWorkingPhase("thinking");
				this.rebuild();
				requestRender();
			}, 1300),
		);

		this.timers.push(
			setTimeout(() => {
				this.stage = "settled";
				markWorkingPhase("idle");
				stopComposerWorkingWave(false);
				deactivateAnimationSurface(DEMO_ANIM_SURFACE_KEY);
				this.rebuild();
				requestRender();
			}, 3600),
		);

		this.rebuild();
	}

	dispose(): void {
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
		deactivateAnimationSurface(DEMO_ANIM_SURFACE_KEY);
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	rebuild(): void {
		this.clear();
		const theme = getActiveGlobalTheme(this.ctx.ui.theme);
		const light = isLightTheme(theme);
		const bannerFg = (s: string) => (light ? fgRgb(37, 99, 235, s) : fgRgb(118, 184, 248, s));
		const dimFg = (s: string) => theme.fg("dim", s);
		const meta = getActiveVariantMeta();

		this.addChild(new Spacer(1));
		this.addChild({
			invalidate() {},
			render: (w: number) => {
				const tag = ` ❖ ПРОТОТИП-ДЕМО (${meta?.shortLabel ?? "off"}) · кликай блоки / Alt+V сменить вариант / /proto clear убрать `;
				const line = truncateToWidth(`  ${bannerFg(tag)}`, Math.max(1, w), "…");
				return [line + " ".repeat(Math.max(0, w - visibleWidth(line)))];
			},
		});

		if (this.stage === "ttft") {
			this.addChild({
				invalidate() {},
				render: (w: number) => {
					const note =
						getPrototypeVariant() === "B"
							? `  ${bannerFg("✦")} ${dimFg("Фаза TTFT: смотри импульс здесь и живую фразу в верхней рамке Composer…")}`
							: `  ${dimFg("Фаза TTFT: смотри фирменную фигуру и живую фразу в верхней рамке Composer…")}`;
					return [truncateToWidth(note, Math.max(1, w), "…")];
				},
			});
			return;
		}

		const sampleThinking = [
			"Let's inspect `ThinkingBlock` in `src/features/transcript/thinking-block.ts` and check why clicking the prose body collapsed the block.",
			"We need to keep the 3-line streaming tail calm without Markdown code-fence boxes so the final answer stays the hero of the screen.",
			"Also check `ToolGroupController` in `grouping.ts` so `{ type: \"image\" }` results render inline via `Image` instead of folding away.",
		].join("\n\n");

		this.addChild(new Spacer(1));
		this.addChild(
			new ThinkingBlock(
				sampleThinking,
				this.stage === "thinking",
				this.thinkingExpanded,
				() => {
					this.thinkingExpanded = !this.thinkingExpanded;
					this.rebuild();
					requestRender();
				},
				theme,
				2300,
				undefined,
				this.hoverSlot,
				this.startedAt + 1300,
				"demo:0",
			),
		);

		if (this.stage !== "settled") return;

		this.addChild(new Spacer(1));
		this.addChild(this.groupMock);
		this.addChild(new Spacer(1));
		this.addChild(this.imageRow);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				"Готово: проверил `Thinking`, сводную строку `Tool Calls`, нативный рендер `Image` и кликабельную строку метрик ниже.",
				2,
				0,
			),
		);

		const sampleMetrics: ResponseMetricsData = {
			version: 1,
			timestamp: this.startedAt,
			firstContentAt: this.startedAt + 580,
			firstTextAt: this.startedAt + 2900,
			completedAt: this.startedAt + 3600,
			timeSinceUserMs: 3600,
			outputTokens: 486,
			reasoningTokens: 164,
			inputTokens: 19_240,
			cacheReadTokens: 16_800,
			model: "gemini-4-carbon",
			thinkingLevel: "high",
			stopReason: "stop",
		};

		this.addChild(new Spacer(1));
		this.addChild(
			new ResponseMetricsRowComponent(sampleMetrics, false, theme, () => {
				void openResponseMetricsModal(this.ctx);
			}),
		);
	}
}

/* ── Перерисовка живой сессии при переключении A / B / C / off ───────────── */

function updateProtoFooterStatus(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	if (process.env.VITEST && !isPrototypeActive()) return;
	const meta = getActiveVariantMeta();
	if (!meta) {
		if (!process.env.VITEST) {
			ctx.ui.setStatus(PROTO_STATUS_KEY, ctx.ui.theme.fg("dim", "PROTO: off | /proto A|B|C|demo"));
		}
		return;
	}
	const seamSuffix = isTranslateSeamPreviewEnabled() ? " · [RU-шов]" : "";
	const badge = ctx.ui.theme.fg(
		"accent",
		`${meta.settledGlyph} PROTO: ${meta.key} (${meta.name})${seamSuffix}`,
	);
	const hint = ctx.ui.theme.fg("dim", " | Alt+V · /proto A|B|C|demo|stats");
	ctx.ui.setStatus(PROTO_STATUS_KEY, `${badge}${hint}`);
}

export function refreshLiveTranscriptForPrototype(ctx: ExtensionContext): void {
	updateProtoFooterStatus(ctx);
	bindComposerWorkingIndicator(ctx);

	const chat = getActiveHostRuntime()?.chatContainer as { children?: unknown[] } | undefined;
	if (Array.isArray(chat?.children)) {
		for (const child of chat.children) {
			if (!child || typeof child !== "object") continue;
			if (child instanceof AssistantMessageComponent) {
				const anyMsg = child as unknown as {
					lastMessage?: unknown;
					isStreaming?: boolean;
					updateContent?: (msg: unknown, streaming?: boolean) => void;
				};
				if (anyMsg.lastMessage && typeof anyMsg.updateContent === "function") {
					anyMsg.updateContent(anyMsg.lastMessage, Boolean(anyMsg.isStreaming));
					continue;
				}
			}
			if (typeof (child as { invalidate?: () => void }).invalidate === "function") {
				(child as { invalidate: () => void }).invalidate();
			}
		}
	}
	requestRender();
}

export function registerPrototypeShowcaseFeature(pi: ExtensionAPI): void {
	let activeCtx: ExtensionContext | undefined;
	let activeDemo: LiveDemoShowcaseContainer | undefined;
	let unsubscribeProto: (() => void) | undefined;

	const clearDemo = () => {
		if (!activeDemo) return;
		activeDemo.dispose();
		const chat = getActiveHostRuntime()?.chatContainer as { removeChild?: (c: unknown) => void } | undefined;
		chat?.removeChild?.(activeDemo);
		activeDemo = undefined;
		requestRender();
	};

	const mountDemo = (ctx: ExtensionContext) => {
		clearDemo();
		const chat = getActiveHostRuntime()?.chatContainer as
			| { addChild?: (c: unknown) => void }
			| undefined;
		if (!chat || typeof chat.addChild !== "function") {
			ctx.ui.notify("Контейнер ленты ещё не готов.", "warning");
			return;
		}
		if (!isPrototypeActive()) {
			setPrototypeVariant("B");
		}
		activeDemo = new LiveDemoShowcaseContainer(ctx);
		chat.addChild(activeDemo);
		requestRender();
	};

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		unsubscribeProto?.();
		unsubscribeProto = subscribePrototypeChanges(() => {
			if (activeCtx) {
				refreshLiveTranscriptForPrototype(activeCtx);
			}
		});
		updateProtoFooterStatus(ctx);
	});

	pi.on("agent_start", () => {
		clearDemo();
	});

	pi.on("session_tree", () => {
		clearDemo();
	});

	pi.on("session_shutdown", () => {
		clearDemo();
		unsubscribeProto?.();
		unsubscribeProto = undefined;
		activeCtx = undefined;
	});

	pi.registerShortcut("alt+v", {
		description: "Прототип: переключить вариант ленты (A / B / C)",
		handler: async (ctx) => {
			activeCtx = ctx;
			const next = cyclePrototypeVariant();
			const meta = next !== "off" ? PROTOTYPE_VARIANTS[next] : undefined;
			if (meta) {
				ctx.ui.notify(`PROTO ${meta.shortLabel}: ${meta.summary}`, "info");
			}
		},
	});

	const subcommands = ["a", "b", "c", "next", "demo", "clear", "stats", "translate", "off"] as const;

	pi.registerCommand("proto", {
		description: "Управление живым прототипом ленты: /proto [A|B|C|demo|clear|stats|translate|off]",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			const matches = subcommands
				.filter((item) => item.startsWith(typed) && item !== typed)
				.map((item) => ({ value: item, label: item }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const cmd = args.trim().toLowerCase();

			if (!cmd || cmd === "next") {
				const next = cyclePrototypeVariant();
				const meta = next !== "off" ? PROTOTYPE_VARIANTS[next] : undefined;
				if (meta) {
					ctx.ui.notify(`PROTO ${meta.shortLabel} - ${meta.summary}`, "info");
				}
				return;
			}

			if (cmd === "a" || cmd === "b" || cmd === "c") {
				const upper = cmd.toUpperCase() as Exclude<PrototypeVariant, "off">;
				setPrototypeVariant(upper);
				const meta = PROTOTYPE_VARIANTS[upper];
				ctx.ui.notify(`PROTO ${meta.shortLabel} - ${meta.summary}`, "info");
				return;
			}

			if (cmd === "off") {
				clearDemo();
				setPrototypeVariant("off");
				ctx.ui.notify("Прототип отключён (возвращён текущий вид main).", "info");
				return;
			}

			if (cmd === "demo" || cmd === "sample") {
				mountDemo(ctx);
				ctx.ui.notify(
					"Запущено живое демо внизу ленты (TTFT -> Thinking -> Tool Calls + Image -> Метрики).",
					"info",
				);
				return;
			}

			if (cmd === "clear") {
				clearDemo();
				ctx.ui.notify("Демо-блок убран из ленты.", "info");
				return;
			}

			if (cmd === "translate" || cmd === "ru") {
				const next = !isTranslateSeamPreviewEnabled();
				setTranslateSeamPreview(next);
				ctx.ui.notify(
					next
						? "Включён предпросмотр шва автоперевода Thinking ([RU · авто])."
						: "Предпросмотр шва автоперевода Thinking выключен.",
					"info",
				);
				return;
			}

			if (cmd === "stats" || cmd === "metrics") {
				await openResponseMetricsModal(ctx);
				return;
			}

			ctx.ui.notify(
				"Использование: /proto [A|B|C|demo|clear|stats|translate|off] (или Alt+V / клик по пилюле PROTO).",
				"info",
			);
		},
	});
}
