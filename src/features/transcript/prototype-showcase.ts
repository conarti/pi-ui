/**
 * PROTOTYPE (throwaway branch: prototype/cards-markdown-sticky-rail)
 * Live switcher (/proto A|B|C|demo|clear|stats|translate|off and Alt+V) plus interactive
 * multi-turn showcase exercising Pinned Header, User Prompt + <skill> badges, two-tone
 * Markdown code blocks, Sticky Prompt, Outline Rail + Hover Popup, Thinking, and Metrics.
 */
import { deflateSync } from "node:zlib";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Image,
	Markdown,
	Spacer,
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
import { syncShortcutsBar } from "../chrome/shortcuts-bar.ts";
import { bindComposerWorkingIndicator } from "../chrome/working-indicator.ts";
import { densityPalette } from "../tool-calls/density.ts";
import {
	cyclePrototypeVariant,
	getActiveVariantMeta,
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

class DemoToolStepsMock implements Component {
	private expanded = false;
	private hovered = false;

	invalidate(): void {}

	render(width: number): string[] {
		const theme = getActiveGlobalTheme();
		const pal = densityPalette(theme);
		const rightGuard = width >= 48 ? 4 : 0;
		const fit = (s: string) => truncateToWidth(s, Math.max(1, width - rightGuard), "…");
		const glyph = pal.diamond("success", this.expanded, this.hovered);
		const summary = "Explored 4 files, 2 searches";
		const meta = ` ${pal.dim("(280ms)")}`;
		const disclosure = this.hovered ? ` ${pal.dim(this.expanded ? "⌄" : "›")}` : "";
		const out = [
			fit(`    ${glyph} ${pal.title(summary, "success", this.expanded, this.hovered)}${meta}${disclosure}`),
		];
		if (this.expanded) {
			const subGlyph = pal.diamond("success", false, false);
			const guide = pal.rail("    │");
			out.push(fit(`${guide} ${subGlyph} ${pal.title("Read", "success", false)} ${pal.target("src/features/transcript/user-prompt.ts", false)}`));
			out.push(fit(`${guide} ${subGlyph} ${pal.title("Read", "success", false)} ${pal.target("src/features/transcript/markdown-cards.ts", false)}`));
			out.push(fit(`${guide} ${subGlyph} ${pal.title("Read", "success", false)} ${pal.target("src/shared/fullscreen-layout.ts", false)}`));
		}
		out.push(
			fit(
				`    ${pal.diamond("success", false, false)} ${pal.title("Update viewport chrome & Skill Chip cards", "success", false)} ${pal.theme.fg("toolDiffAdded", "+42")} ${pal.theme.fg("toolDiffRemoved", "-9")} ${pal.dim("(410ms)")}`,
			),
		);
		return out;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			const onHeader = event.y === 0;
			claimHover(this, () => {
				if (this.hovered) {
					this.hovered = false;
					requestRender();
				}
			});
			if (this.hovered !== onHeader) {
				this.hovered = onHeader;
				return { handled: true, render: true };
			}
			return undefined;
		}
		if (event.type === "press" && event.button === "left" && event.y === 0) {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left" && event.y === 0) {
			this.expanded = !this.expanded;
			return { handled: true, render: true };
		}
		return undefined;
	}
}

class DemoInlineImageRow implements Component {
	private readonly img: Image;

	constructor() {
		const theme = getActiveGlobalTheme();
		this.img = new Image(
			getDemoPrismPngBase64(),
			"image/png",
			{
				fallbackColor: (s: string) => theme.fg("muted", s),
			},
			{ maxWidthCells: 28 },
		);
	}

	invalidate(): void {
		this.img.invalidate();
	}

	render(width: number): string[] {
		const theme = getActiveGlobalTheme();
		const pal = densityPalette(theme);
		const glyph = pal.diamond("success", true, false);
		const header = truncateToWidth(
			`    ${glyph} ${pal.title("Read", "success", true)} ${pal.target("assets/polaris-card.png", true)} ${pal.dim("(image/png · 180×64)")}`,
			Math.max(1, width - 4),
			"…",
		);
		const imgLines = this.img.render(Math.max(8, width - 8)).map((ln) => `      ${ln}`);
		return [header, ...imgLines];
	}
}

const DEMO_SKILL_PROMPT_1 = `<skill name="wayfinder" location="/Users/macbook/Projects/pi-ui/.agents/skills/wayfinder/SKILL.md">
References are relative to /Users/macbook/Projects/pi-ui/.agents/skills/wayfinder.

Wayfinding charts a shared map on the issue tracker and resolves decision tickets one at a time.
- Prototype tickets build 3 structurally distinct variants inside live InteractiveMode.
- Never fold losing variants or /proto switchers into main; capture on prototype/<name>.
</skill>

Align Header, User Prompt cards, <skill> badges, two-tone Markdown code blocks, Sticky Prompt, and Outline Rail across 3 live TUI variants so we can test scrolling, hover, and copy side by side:
1. Click the /wayfinder badge above to inspect SKILL.md in a Hover Popup.
2. Scroll up & down to watch Sticky Prompt pin smoothly right below the fixed Header.
3. Hover the right Outline Rail ticks to inspect opaque Turn #N · HH:MM previews.`;

const DEMO_SHORT_PROMPT_2 = `Looks clean! Also verify a 1-line untyped command fence next to a typed TypeScript block.`;

const DEMO_MARKDOWN_RESPONSE_1 = [
	"### Viewport & Two-Tone Code Comparison",
	"",
	"Run the standards and typecheck suite with a short untyped command fence:",
	"",
	"```",
	"npm run check",
	"```",
	"",
	"And compare a typed multi-line TypeScript snippet (notice zero `▎` rail characters when selecting lines with the mouse):",
	"",
	"```ts",
	"export function mountPinnedHeader(shell: FullscreenShellContext): StickyOverlayRender {",
	"  const palette = getThemeSurfacePalette(shell.theme());",
	"  return renderStickyCard(palette.userCardBg, { rightGuardCols: 4 });",
	"}",
	"```",
].join("\n");

const DEMO_MARKDOWN_RESPONSE_2 = [
	"Both short untyped snippets and typed multi-line blocks align on the **4-column right plumb line** so `Outline Rail` and the scrollbar never collide with `Copy` or timestamps.",
].join("\n");

const DEMO_THINKING_CHUNKS = [
	"**Checking Header & Sticky Prompt junction**\nMounting `SessionHeaderView` as entry `0` of `fullscreenLayoutRoot` keeps row `0` permanently pinned while `ScrollView` starts cleanly at `y = 1` (or `y = 2` in Variant C).",
	"**Checking Skill Chip & Clean Copy**\nRaw `<skill name=\"wayfinder\">...</skill>` blocks collapse into a clickable skill badge in `User Prompt`, `Sticky Prompt`, and `Outline Rail` previews while `Copy` writes `/skill:wayfinder ...` cleanly.",
	"**Checking Two-Tone Code Blocks**\nVariant A places `[Copy]` quietly below the block; Variant B skips the top header on 1-2 line untyped commands; Variant C floats a compact `ts · Copy` corner pill.",
];

class LiveDemoShowcaseContainer extends Container {
	readonly [TTFT_PULSE_MARKER] = true;
	private chunkCount = 1;
	private settled = false;
	private thinkingExpanded = false;
	private readonly startedAt = Date.now();
	private readonly hoverSlot: ThinkingInteractionSlot = { hovered: false, scrollFromBottom: 0 };
	private readonly stepsMock = new DemoToolStepsMock();
	private readonly imageRow = new DemoInlineImageRow();
	private readonly userTurn1: UserMessageComponent;
	private readonly userTurn2: UserMessageComponent;
	private readonly mdReply1: Markdown;
	private readonly mdReply2: Markdown;
	private timers: Array<ReturnType<typeof setTimeout>> = [];

	constructor(private readonly ctx: ExtensionContext) {
		super();
		const mdTheme = getMarkdownTheme();
		this.userTurn1 = new UserMessageComponent(
			DEMO_SKILL_PROMPT_1,
			mdTheme,
			2,
			[],
			"demo-turn-1",
			new Date(this.startedAt - 12_000).toISOString(),
		);
		this.userTurn2 = new UserMessageComponent(
			DEMO_SHORT_PROMPT_2,
			mdTheme,
			2,
			[],
			"demo-turn-2",
			new Date(this.startedAt - 3_000).toISOString(),
		);
		this.mdReply1 = new Markdown(DEMO_MARKDOWN_RESPONSE_1, 4, 0, mdTheme);
		this.mdReply2 = new Markdown(DEMO_MARKDOWN_RESPONSE_2, 4, 0, mdTheme);

		activateAnimationSurface(DEMO_ANIM_SURFACE_KEY, () => {
			requestRender();
		});

		for (let step = 2; step <= DEMO_THINKING_CHUNKS.length; step++) {
			this.timers.push(
				setTimeout(() => {
					this.chunkCount = step;
					this.rebuild();
					requestRender();
				}, (step - 1) * 700),
			);
		}

		this.timers.push(
			setTimeout(() => {
				this.settled = true;
				deactivateAnimationSurface(DEMO_ANIM_SURFACE_KEY);
				this.rebuild();
				getActiveHostRuntime()?.scroll?.invalidate?.();
				requestRender();
			}, DEMO_THINKING_CHUNKS.length * 700 + 450),
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
		this.userTurn1.invalidate();
		this.userTurn2.invalidate();
		this.mdReply1.invalidate();
		this.mdReply2.invalidate();
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
				const tag = "◆ PROTOTYPE #34 DEMO · scroll to test Sticky Prompt + Outline Rail · /proto clear";
				const line = truncateToWidth(`    ${bannerFg(tag)}`, Math.max(1, w - 4), "…");
				return [line + " ".repeat(Math.max(0, w - visibleWidth(line)))];
			},
		});

		this.addChild(new Spacer(1));
		this.addChild(this.userTurn1);

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
				2600,
				undefined,
				this.hoverSlot,
				this.startedAt,
				"demo:0",
			),
		);

		if (!this.settled) return;

		this.addChild(new Spacer(1));
		this.addChild(this.stepsMock);
		this.addChild(new Spacer(1));
		this.addChild(this.mdReply1);

		const stepMetrics: ResponseMetricsData = {
			version: 1,
			timestamp: this.startedAt,
			firstContentAt: this.startedAt + 420,
			firstTextAt: this.startedAt + 1900,
			completedAt: this.startedAt + 3400,
			timeSinceUserMs: 3400,
			outputTokens: 312,
			reasoningTokens: 118,
			inputTokens: 14_800,
			cacheReadTokens: 12_400,
			model: "gemini-4-carbon",
			thinkingLevel: "high",
			stopReason: "stop",
		};
		this.addChild(new Spacer(1));
		this.addChild(
			new ResponseMetricsRowComponent(stepMetrics, false, theme, () => {
				void openResponseMetricsModal(this.ctx);
			}),
		);

		this.addChild(new Spacer(1));
		this.addChild(this.userTurn2);
		this.addChild(new Spacer(1));
		this.addChild(this.imageRow);
		this.addChild(new Spacer(1));
		this.addChild(this.mdReply2);

		const sampleMetrics2: ResponseMetricsData = {
			version: 1,
			timestamp: this.startedAt + 4000,
			firstContentAt: this.startedAt + 4350,
			firstTextAt: this.startedAt + 4900,
			completedAt: this.startedAt + 5600,
			timeSinceUserMs: 1600,
			outputTokens: 142,
			reasoningTokens: 44,
			inputTokens: 15_320,
			cacheReadTokens: 14_900,
			model: "gemini-4-carbon",
			thinkingLevel: "high",
			stopReason: "stop",
		};

		this.addChild(new Spacer(1));
		this.addChild(
			new ResponseMetricsRowComponent(sampleMetrics2, false, theme, () => {
				void openResponseMetricsModal(this.ctx);
			}),
		);
	}
}

export function refreshLiveTranscriptForPrototype(ctx: ExtensionContext): void {
	if (ctx.mode === "tui" && ctx.hasUI) {
		ctx.ui.setStatus(LEGACY_PROTO_STATUS_KEY, undefined);
	}
	bindComposerWorkingIndicator(ctx);

	const runtime = getActiveHostRuntime();
	const chat = runtime?.chatContainer as { children?: unknown[] } | undefined;
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
	runtime?.tui?.invalidate?.();
	runtime?.scroll?.invalidate?.();
	const slots = runtime?.viewportSlots;
	slots?.topSlot?.invalidate?.();
	slots?.rightRail?.invalidate?.();
	slots?.pinnedHeader?.invalidate?.();
	requestRender();
}

export function registerPrototypeShowcaseFeature(pi: ExtensionAPI): void {
	let activeCtx: ExtensionContext | undefined;
	let activeDemo: LiveDemoShowcaseContainer | undefined;
	let unsubscribeProto: (() => void) | undefined;

	const clearDemo = () => {
		if (!activeDemo) return;
		activeDemo.dispose();
		const runtime = getActiveHostRuntime();
		const chat = runtime?.chatContainer as { removeChild?: (c: unknown) => void } | undefined;
		chat?.removeChild?.(activeDemo);
		activeDemo = undefined;
		runtime?.scroll?.invalidate?.();
		requestRender();
	};

	const mountDemo = (ctx: ExtensionContext) => {
		clearDemo();
		const runtime = getActiveHostRuntime();
		const chat = runtime?.chatContainer as
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
		runtime?.scroll?.invalidate?.();
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
				syncShortcutsBar(pi, activeCtx);
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
		description: "Prototype: cycle card/chrome variant (A / B / C)",
		handler: async (ctx) => {
			activeCtx = ctx;
			const next = cyclePrototypeVariant();
			const meta = next !== "off" ? PROTOTYPE_VARIANTS[next] : undefined;
			if (meta) {
				ctx.ui.notify(`PROTO ${meta.shortLabel}: ${meta.summary}`, "info");
			}
		},
	});

	const subcommands = ["on", "off", "demo", "clear", "stats", "translate"] as const;

	pi.registerCommand("proto", {
		description: "Control unified prototype UI: /proto [on|off|demo|clear|stats|translate]",
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

			if (!cmd || cmd === "on" || cmd === "a" || cmd === "b" || cmd === "c" || cmd === "next") {
				const target: Exclude<PrototypeVariant, "off"> =
					cmd === "a" ? "A" : cmd === "c" ? "C" : "B";
				setPrototypeVariant(target);
				ctx.ui.notify("Unified prototype UI enabled.", "info");
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
					"Mounted multi-turn #34 showcase at bottom of transcript (Skill Chip, 2-tone Code, Sticky + Outline Rail).",
					"info",
				);
				return;
			}

			if (cmd === "clear") {
				clearDemo();
				ctx.ui.notify("Cleared demo showcase from transcript.", "info");
				return;
			}

			if (cmd === "translate" || cmd === "ru") {
				const next = !isTranslateSeamPreviewEnabled();
				setTranslateSeamPreview(next);
				ctx.ui.notify(
					next
						? "Demo translation seam ON (shown on /proto demo)."
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
				"Usage: /proto [on|off|demo|clear|stats|translate].",
				"info",
			);
		},
	});
}
