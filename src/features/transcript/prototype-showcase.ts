/**
 * PROTOTYPE (throwaway branch: prototype/thinking-and-tool-calls)
 * Live switcher (/proto A|B|C|demo|clear|stats|translate|off and Alt+V) plus in-memory
 * animated transcript showcase (streaming Thinking page -> Tool Calls + native Image -> Metrics).
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
import { bindComposerWorkingIndicator } from "../chrome/working-indicator.ts";
import { densityPalette } from "../tool-calls/density.ts";
import {
	cyclePrototypeVariant,
	getActiveVariantMeta,
	getPrototypeVariant,
	isPrototypeActive,
	isTranslateSeamPreviewEnabled,
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
import { ThinkingBlock, type ThinkingInteractionSlot } from "./thinking-block.ts";

const LEGACY_PROTO_STATUS_KEY = "conarti-proto";
const DEMO_ANIM_SURFACE_KEY = "prototype.demo-showcase";

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

class DemoToolGroupMock implements Component {
	private expanded = false;
	private hovered = false;

	invalidate(): void {}

	render(width: number): string[] {
		const theme = getActiveGlobalTheme();
		const pal = densityPalette(theme);
		const variant = getPrototypeVariant();
		const rightGuard = width >= 48 ? 4 : 0;
		const fit = (s: string) => truncateToWidth(s, Math.max(1, width - rightGuard), "…");
		const glyph = pal.diamond("success", this.expanded, this.hovered);

		if (variant === "C") {
			const lines: string[] = [];
			const expChevron = pal.dim(this.expanded ? "▾" : "▸");
			lines.push(
				fit(
					`  ${glyph} ${pal.title("Explored: 3 files, 1 search", "success", this.expanded, this.hovered)} ${pal.dim("(340ms)")} ${expChevron}`,
				),
			);
			lines.push(
				fit(
					`  ${glyph} ${pal.title("Edited: 2 files", "success", this.expanded, this.hovered)} ${pal.theme.fg("toolDiffAdded", "+18")} ${pal.theme.fg("toolDiffRemoved", "-4")} ${pal.dim("(520ms)")} ${expChevron}`,
				),
			);
			lines.push(
				fit(
					`  ${glyph} ${pal.title("Ran: 1 cmd", "success", this.expanded, this.hovered)} ${pal.dim("(910ms)")} ${expChevron}`,
				),
			);
			if (this.expanded) {
				lines.push(fit(`  ${pal.rail("│")} ${pal.dim("Edited src/features/transcript/thinking-block.ts (+12 -3)")}`));
				lines.push(fit(`  ${pal.rail("│")} ${pal.dim("Edited src/features/tool-calls/grouping.ts (+6 -1)")}`));
				lines.push(fit(`  ${pal.rail("│")} ${pal.dim("Ran npm run typecheck (0 lines · 910ms)")}`));
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
			const guide = pal.rail("  │");
			out.push(fit(`${guide} ${subGlyph} ${pal.title("Inspect repo state and tool-summary source", "success", false)} ${pal.dim("(340ms) · bash 1 · read 3")}`));
			out.push(fit(`${guide} ${subGlyph} ${pal.title("Edited", "success", false)} ${pal.target("src/features/transcript/thinking-block.ts", false)} ${pal.dim("(+12 -3 · 280ms)")}`));
			out.push(fit(`${guide} ${subGlyph} ${pal.title("Edited", "success", false)} ${pal.target("src/features/tool-calls/grouping.ts", false)} ${pal.dim("(+6 -1 · 240ms)")}`));
			out.push(fit(`${guide} ${subGlyph} ${pal.title("Verify lint, typecheck, and unit tests", "success", false)} ${pal.target("npm run check", false)} ${pal.dim("(910ms)")}`));
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
		const glyph = pal.diamond("success", false, false);
		const rightGuard = width >= 48 ? 4 : 0;
		const header = truncateToWidth(
			`  ${glyph} ${pal.title("Read", "success", false)} ${pal.target("assets/prism-card.png", false)} ${pal.dim("(image/png · 180×64 · 14ms)")}`,
			Math.max(1, width - rightGuard),
			"…",
		);
		const imgLines = this.imageComponent.render(Math.max(12, width - 6));
		const indentedImg = imgLines.map((l, idx) => (idx === 0 && l ? `  ${l}` : l));
		return [header, ...indentedImg];
	}
}

const DEMO_THINKING_CHUNKS: readonly string[] = [
	"**Inspecting streaming Thinking readability**\nLet's check why a 3-line sliding tail feels frantic during fast token generation: every single word-wrap shifts all 3 rows upward several times per second.",
	"Instead of shifting every line on every wrap, Variant B fills a 6-line page calmly from top to bottom and only advances by 3 lines when the page fills up.",
	"Clicking the `Thinking…` header (or pressing `Ctrl+T`) right while tokens are streaming immediately unfolds the full reasoning from line 1 and keeps it open after completion.",
	"**Checking viewport alignment & Outline Rail**\nAll transcript surfaces (`User Prompt`, `Thinking`, `Tool Calls`, and `Assistant` prose) now align cleanly along column 2, while right-aligned metrics reserve 4 columns so `Outline Rail` never overlaps text.",
	"**Verifying inline Image pass-through**\nTool calls returning `{ type: \"image\" }` bypass collapsed `ToolGroupComponent` folding so `@earendil-works/pi-tui` renders the native `Image` inline right beneath `Read assets/prism-card.png`.",
];

class LiveDemoShowcaseContainer extends Container {
	readonly [TTFT_PULSE_MARKER] = true;
	private chunkCount = 1;
	private settled = false;
	private thinkingExpanded = false;
	private readonly startedAt = Date.now();
	private readonly hoverSlot: ThinkingInteractionSlot = { hovered: false, scrollFromBottom: 0 };
	private readonly groupMock = new DemoToolGroupMock();
	private readonly imageRow = new DemoInlineImageRow();
	private timers: Array<ReturnType<typeof setTimeout>> = [];

	constructor(private readonly ctx: ExtensionContext) {
		super();
		activateAnimationSurface(DEMO_ANIM_SURFACE_KEY, () => {
			requestRender();
		});

		/* Пошагово подаём куски мысли каждые 900мс, чтобы можно было кликнуть заголовок ПРЯМО ВО ВРЕМЯ СТРИМИНГА */
		for (let step = 2; step <= DEMO_THINKING_CHUNKS.length; step++) {
			this.timers.push(
				setTimeout(() => {
					this.chunkCount = step;
					this.rebuild();
					requestRender();
				}, (step - 1) * 900),
			);
		}

		this.timers.push(
			setTimeout(() => {
				this.settled = true;
				deactivateAnimationSurface(DEMO_ANIM_SURFACE_KEY);
				this.rebuild();
				requestRender();
			}, DEMO_THINKING_CHUNKS.length * 900 + 600),
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
		const meta = getActiveVariantMeta();

		this.addChild(new Spacer(1));
		this.addChild({
			invalidate() {},
			render: (w: number) => {
				const tag = `❖ PROTOTYPE DEMO (${meta?.shortLabel ?? "off"}) · click Thinking header while streaming · Alt+V switch · /proto clear`;
				const line = truncateToWidth(`  ${bannerFg(tag)}`, Math.max(1, w - 4), "…");
				return [line + " ".repeat(Math.max(0, w - visibleWidth(line)))];
			},
		});

		const activeSampleText = DEMO_THINKING_CHUNKS.slice(0, this.chunkCount).join("\n\n");

		this.addChild(new Spacer(1));
		this.addChild(
			new ThinkingBlock(
				activeSampleText,
				!this.settled,
				this.thinkingExpanded,
				() => {
					this.thinkingExpanded = !this.thinkingExpanded;
					this.rebuild();
					requestRender();
				},
				theme,
				4800,
				undefined,
				this.hoverSlot,
				this.startedAt,
				"demo:0",
			),
		);

		if (!this.settled) return;

		this.addChild(new Spacer(1));
		this.addChild(this.groupMock);
		this.addChild(new Spacer(1));
		this.addChild(this.imageRow);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				"All four surfaces rendered: expandable streaming `Thinking`, `Compact` grouped tool calls, inline native `Image`, and the clickable response metrics row below.",
				2,
				0,
			),
		);

		const sampleMetrics: ResponseMetricsData = {
			version: 1,
			timestamp: this.startedAt,
			firstContentAt: this.startedAt + 580,
			firstTextAt: this.startedAt + 3900,
			completedAt: this.startedAt + 4800,
			timeSinceUserMs: 4800,
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

export function refreshLiveTranscriptForPrototype(ctx: ExtensionContext): void {
	/* Не засоряем нижний статус-бар лишней строкой, чтобы не конфликтовать с pi-footer */
	if (ctx.mode === "tui" && ctx.hasUI) {
		ctx.ui.setStatus(LEGACY_PROTO_STATUS_KEY, undefined);
	}
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
			ctx.ui.notify("Transcript container is not ready yet.", "warning");
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
		if (ctx.mode === "tui" && ctx.hasUI) {
			ctx.ui.setStatus(LEGACY_PROTO_STATUS_KEY, undefined);
		}
		unsubscribeProto?.();
		unsubscribeProto = subscribePrototypeChanges(() => {
			if (activeCtx) {
				refreshLiveTranscriptForPrototype(activeCtx);
			}
		});
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
		description: "Prototype: cycle transcript variant (A / B / C)",
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
		description: "Control live transcript prototype: /proto [A|B|C|demo|clear|stats|translate|off]",
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
				ctx.ui.notify("Prototype disabled (restored current main rendering).", "info");
				return;
			}

			if (cmd === "demo" || cmd === "sample") {
				mountDemo(ctx);
				ctx.ui.notify(
					"Started 5s live demo at the bottom of transcript - try clicking Thinking while it streams!",
					"info",
				);
				return;
			}

			if (cmd === "clear") {
				clearDemo();
				ctx.ui.notify("Cleared demo preview from transcript.", "info");
				return;
			}

			if (cmd === "translate" || cmd === "ru") {
				const next = !isTranslateSeamPreviewEnabled();
				setTranslateSeamPreview(next);
				ctx.ui.notify(
					next
						? "Demo translation seam ON (shown on /proto demo; live translator engine is scheduled in Echelon 3)."
						: "Demo translation seam OFF.",
					"info",
				);
				return;
			}

			if (cmd === "stats" || cmd === "metrics") {
				await openResponseMetricsModal(ctx);
				return;
			}

			ctx.ui.notify(
				"Usage: /proto [A|B|C|demo|clear|stats|translate|off] (or Alt+V / click PROTO pill).",
				"info",
			);
		},
	});
}
