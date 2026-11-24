import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, isLightTheme, paintSurfaceRow } from "../../shared/ansi.ts";
import type { FullscreenShellContext } from "../../shared/fullscreen-layout.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import {
	sanitizeTurnText,
	selectStickyTurn,
	type IndexedTurn,
	type StickyDisplayMode,
	type TranscriptTurnIndex,
} from "../../shared/turn-index.ts";

export interface StickyPromptConfig {
	enabled: boolean;
	showTimestamp: boolean;
	showNavigation: boolean;
	mode: StickyDisplayMode;
}

const STICKY_CONFIG_KEY = Symbol.for("conarti.pi-ui.sticky-config.v1");

export function getStickyConfig(): StickyPromptConfig {
	const g = globalThis as Record<symbol, StickyPromptConfig | undefined>;
	if (!g[STICKY_CONFIG_KEY]) {
		g[STICKY_CONFIG_KEY] = {
			enabled: true,
			showTimestamp: true,
			showNavigation: true,
			mode: "auto",
		};
	}
	return g[STICKY_CONFIG_KEY]!;
}

export class StickyPromptBar implements Component {
	private turns: readonly IndexedTurn[] = [];
	private active: IndexedTurn | undefined;
	private navigated: { turnId: string; scrollTop: number } | undefined;
	private expanded = new Set<string>();
	private prevCol?: number;
	private nextCol?: number;
	private hoveredZone: "prev" | "next" | "body" | null = null;
	private disposed = false;
	lastRenderedHeight = 0;

	constructor(
		private readonly shell: FullscreenShellContext,
		private readonly turnIndex: TranscriptTurnIndex,
		readonly config: StickyPromptConfig,
	) {}

	invalidate(): void {
		this.shell.requestRender();
	}

	reset(): void {
		this.turns = [];
		this.active = undefined;
		this.navigated = undefined;
		this.expanded.clear();
		this.lastRenderedHeight = 0;
		this.turnIndex.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
	}

	getActivePrompt(): IndexedTurn | undefined {
		return this.active;
	}

	toggleExpanded(): void {
		if (!this.active) return;
		const key = this.active.id;
		if (this.expanded.has(key)) this.expanded.delete(key);
		else this.expanded.add(key);
		this.shell.requestRender();
	}

	private findAdjacentMountedTurn(direction: "prev" | "next"): IndexedTurn | undefined {
		if (!this.active) return undefined;
		if (direction === "prev") {
			for (let i = this.active.index - 1; i >= 0; i--) {
				if (this.turns[i]?.mounted) return this.turns[i];
			}
			return undefined;
		}
		for (let i = this.active.index + 1; i < this.turns.length; i++) {
			if (this.turns[i]?.mounted) return this.turns[i];
		}
		return undefined;
	}

	navigate(direction: "prev" | "next"): void {
		const target = this.findAdjacentMountedTurn(direction);
		if (!target) return;
		this.turnIndex.jumpToTurn(target.index, { direction });
		if (!this.shell.scroll.isFollowingEnd && this.shell.scroll.scrollTop < target.start) {
			this.navigated = { turnId: target.id, scrollTop: this.shell.scroll.scrollTop };
		} else {
			this.navigated = undefined;
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.active || event.y < 0 || event.y >= this.lastRenderedHeight - 1) return undefined;

		if (event.type === "move") {
			let nextHover: "prev" | "next" | "body" = "body";
			if (
				event.y === 0 &&
				this.prevCol !== undefined &&
				this.nextCol !== undefined &&
				event.x >= this.prevCol &&
				event.x < this.nextCol + 2
			) {
				nextHover = event.x < this.nextCol ? "prev" : "next";
			}
			claimHover(this, () => {
				if (this.hoveredZone !== null) {
					this.hoveredZone = null;
					this.shell.requestRender();
				}
			});
			if (nextHover !== this.hoveredZone) {
				this.hoveredZone = nextHover;
				return { handled: true, render: true };
			}
			return undefined;
		}

		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}

		if (event.type !== "click" || (event.button !== "left" && event.button !== "none")) {
			return undefined;
		}

		if (
			event.y === 0 &&
			this.prevCol !== undefined &&
			this.nextCol !== undefined &&
			event.x >= this.prevCol &&
			event.x < this.nextCol + 2
		) {
			this.navigate(event.x < this.nextCol ? "prev" : "next");
		} else {
			this.toggleExpanded();
		}
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		this.active = undefined;
		this.prevCol = undefined;
		this.nextCol = undefined;
		if (this.disposed || !this.config.enabled || width < 20) {
			this.lastRenderedHeight = 0;
			return [];
		}

		const { scroll } = this.shell;
		if (!scroll.children[0]) {
			this.lastRenderedHeight = 0;
			return [];
		}

		this.turns = this.turnIndex.getTurns(width);

		const mountedIds = new Set<string>(this.turns.filter((t) => t.mounted).map((t) => t.id));
		for (const key of this.expanded) {
			if (!mountedIds.has(key)) this.expanded.delete(key);
		}

		if (
			this.navigated &&
			(scroll.isFollowingEnd || scroll.scrollTop !== this.navigated.scrollTop || !mountedIds.has(this.navigated.turnId))
		) {
			this.navigated = undefined;
		}

		this.active = this.navigated
			? this.turns.find((t) => t.id === this.navigated?.turnId)
			: selectStickyTurn(this.turns, scroll.scrollTop, scroll.isFollowingEnd, this.config.mode);

		if (!this.active) {
			this.lastRenderedHeight = 0;
			return [];
		}

		const hasPrev = Boolean(this.findAdjacentMountedTurn("prev"));
		const hasNext = Boolean(this.findAdjacentMountedTurn("next"));

		const lines = this.renderStyledSticky(width, this.shell.theme(), {
			text: this.active.prompt,
			index: this.active.ordinal,
			total: this.turns.length,
			time: this.config.showTimestamp ? this.active.formattedTime : "",
			navigation: this.config.showNavigation,
			hasPrev,
			hasNext,
			expanded: this.expanded.has(this.active.id),
		});

		this.lastRenderedHeight = lines.length;
		return lines;
	}

	private renderStyledSticky(
		width: number,
		theme: Theme,
		opts: {
			text: string;
			index: number;
			total: number;
			time: string;
			navigation: boolean;
			hasPrev: boolean;
			hasNext: boolean;
			expanded: boolean;
		},
	): string[] {
		const light = isLightTheme(theme);
		const bg: [number, number, number] = light
			? this.hoveredZone
				? [225, 236, 252]
				: [234, 242, 253]
			: this.hoveredZone
				? [44, 53, 68]
				: [37, 44, 57];

		const spine = light ? fgRgb(37, 99, 235, "┃") : fgRgb(97, 175, 239, "┃");
		const chevron = light ? fgRgb(37, 99, 235, "› ") : fgRgb(125, 207, 255, "› ");
		const bodyColor = (s: string) => (light ? fgRgb(30, 41, 59, s) : fgRgb(220, 229, 242, s));
		const dimColor = (s: string) => (light ? fgRgb(100, 116, 139, s) : fgRgb(124, 138, 160, s));

		const navRaw = opts.navigation && width >= 24 ? "↑ ↓  " : "";
		const stepBadge = `#${opts.index}/${opts.total}`;
		const metaPlain = [opts.time, stepBadge].filter(Boolean).join(" · ");
		const showMeta = metaPlain && width >= visibleWidth(metaPlain) + visibleWidth(navRaw) + 20;
		const rightWidth = (showMeta ? visibleWidth(metaPlain) + 2 : 0) + visibleWidth(navRaw);

		if (navRaw) {
			this.prevCol = width - visibleWidth(navRaw);
			this.nextCol = this.prevCol + 2;
		}

		const prefix0 = `  ${spine} ${chevron}`;
		const prefixN = `  ${spine}   `;
		const textAvail0 = Math.max(6, width - visibleWidth(prefix0) - rightWidth - 2);
		const textAvailN = Math.max(6, width - visibleWidth(prefixN) - 2);

		const raw = sanitizeTurnText(opts.text).replace(/\t/g, "  ");
		let rows: string[];
		if (opts.expanded) {
			rows = raw.split("\n").flatMap((line, li) => wrapTextWithAnsi(line, li === 0 ? textAvail0 : textAvailN));
		} else {
			rows = [raw.replace(/\s+/g, " ").trim()];
		}

		const clipped = rows.slice(0, 8);
		if (rows.length > clipped.length) {
			clipped.push(`… (+${rows.length - clipped.length} стр.)`);
		}

		const out: string[] = [];
		for (let i = 0; i < clipped.length; i++) {
			const pfx = i === 0 ? prefix0 : prefixN;
			const cleanText = stripTerminalSequences(
				truncateToWidth(clipped[i] ?? "", i === 0 ? textAvail0 : textAvailN, "…"),
			);

			let rightStyled = "";
			if (i === 0) {
				if (showMeta) {
					rightStyled += dimColor(`${metaPlain}  `);
				}
				if (navRaw) {
					const upGlyph =
						!opts.hasPrev
							? dimColor("↑")
							: this.hoveredZone === "prev"
								? fgRgb(125, 207, 255, "↑")
								: bodyColor("↑");
					const downGlyph =
						!opts.hasNext
							? dimColor("↓")
							: this.hoveredZone === "next"
								? fgRgb(125, 207, 255, "↓")
								: bodyColor("↓");
					rightStyled += `${upGlyph} ${downGlyph}  `;
				}
			}

			const gap = " ".repeat(
				Math.max(0, width - visibleWidth(pfx) - visibleWidth(cleanText) - visibleWidth(rightStyled)),
			);
			out.push(paintSurfaceRow(`${pfx}${bodyColor(cleanText)}${gap}${rightStyled}`, width, bg[0], bg[1], bg[2]));
		}

		const sepColor = light ? fgRgb(203, 213, 225, "─".repeat(width)) : fgRgb(48, 57, 72, "─".repeat(width));
		out.push(sepColor);
		return out;
	}
}

export function registerStickyPromptCommands(
	pi: ExtensionAPI,
	getBar: () => StickyPromptBar | undefined,
): void {
	const usage = "/sticky [toggle | prev | next | expand | nav | time | auto | always | status]";

	pi.registerCommand("sticky", {
		description: `Закреплённый сверху активный промпт: ${usage}`,
		handler: async (args, ctx) => {
			const bar = getBar();
			if (!bar) {
				ctx.ui.notify("Sticky prompt доступен в fullscreen TUI", "info");
				return;
			}
			const cfg = bar.config;
			const sub = args.trim().toLowerCase();
			switch (sub) {
				case "":
				case "toggle":
					cfg.enabled = !cfg.enabled;
					ctx.ui.notify(`Sticky prompt: ${cfg.enabled ? "включён" : "выключен"}`, "info");
					break;
				case "prev":
				case "up":
					bar.navigate("prev");
					return;
				case "next":
				case "down":
					bar.navigate("next");
					return;
				case "expand":
				case "open":
					bar.toggleExpanded();
					return;
				case "nav":
				case "buttons":
					cfg.showNavigation = !cfg.showNavigation;
					break;
				case "time":
				case "timestamp":
					cfg.showTimestamp = !cfg.showTimestamp;
					break;
				case "auto":
				case "always":
					cfg.mode = sub;
					ctx.ui.notify(`Sticky режим: ${cfg.mode}`, "info");
					break;
				case "status":
					ctx.ui.notify(
						`Sticky: ${cfg.enabled ? "on" : "off"} | mode=${cfg.mode} | nav=${cfg.showNavigation} | time=${cfg.showTimestamp}`,
						"info",
					);
					return;
				default:
					ctx.ui.notify(`Использование: ${usage}`, "info");
					return;
			}
			ctx.ui.theme;
			bar.invalidate();
		},
	});
}

export function bindStickyExpandKey(
	ctx: ExtensionContext,
	shell: FullscreenShellContext,
	bar: StickyPromptBar,
): () => void {
	return ctx.ui.onTerminalInput((data) => {
		if (
			!isKeyRelease(data) &&
			!isKeyRepeat(data) &&
			bar.config.enabled &&
			bar.getActivePrompt() &&
			shell.keybindings.matches(data, "app.tools.expand")
		) {
			bar.toggleExpanded();
		}
		return undefined;
	});
}
