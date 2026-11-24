import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	computeStickyPushOffset,
	type FullscreenShellContext,
	type StickyOverlayRender,
} from "../../shared/fullscreen-layout.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import {
	selectStickyTurn,
	type IndexedTurn,
	type StickyDisplayMode,
	type TranscriptTurnIndex,
} from "../../shared/turn-index.ts";
import {
	renderUserPromptCardLines,
	type PromptPillHitTarget,
} from "../transcript/user-prompt.ts";

export interface StickyPromptConfig {
	enabled: boolean;
	showTimestamp: boolean;
	showNavigation: boolean;
	mode: StickyDisplayMode;
}

const STICKY_CONFIG_KEY = Symbol.for("conarti.pi-ui.sticky-config.v1");
const COLLAPSED_MAX_CONTENT_LINES = 3;

export function getStickyConfig(): StickyPromptConfig {
	const g = globalThis as Record<symbol, StickyPromptConfig | undefined>;
	if (!g[STICKY_CONFIG_KEY]) {
		g[STICKY_CONFIG_KEY] = {
			enabled: true,
			showTimestamp: true,
			showNavigation: false,
			mode: "auto",
		};
	}
	return g[STICKY_CONFIG_KEY]!;
}

export class StickyPromptBar implements Component {
	private turns: readonly IndexedTurn[] = [];
	private active: IndexedTurn | undefined;
	private expanded = new Set<string>();
	private hovered = false;
	private pillHits: readonly PromptPillHitTarget[] = [];
	private disposed = false;
	lastRenderedHeight = 0;
	lastVisibleHeight = 0;
	lastPushOffset = 0;

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
		this.expanded.clear();
		this.hovered = false;
		this.pillHits = [];
		this.lastRenderedHeight = 0;
		this.lastVisibleHeight = 0;
		this.lastPushOffset = 0;
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
		const target = this.active ?? this.resolveCurrentTurn();
		if (!target) return;
		const key = target.id;
		if (this.expanded.has(key)) this.expanded.delete(key);
		else this.expanded.add(key);
		this.shell.requestRender();
	}

	private resolveCurrentTurn(): IndexedTurn | undefined {
		const turns = this.turnIndex.getTurns();
		const mounted = turns.filter((t) => t.mounted);
		if (mounted.length === 0) return undefined;
		const scrollTop = this.shell.scroll.scrollTop ?? 0;
		return mounted.findLast((t) => t.start <= scrollTop) ?? mounted[0];
	}

	private findAdjacentMountedTurn(fromTurn: IndexedTurn | undefined, direction: "prev" | "next"): IndexedTurn | undefined {
		if (!fromTurn) return undefined;
		if (direction === "prev") {
			for (let i = fromTurn.index - 1; i >= 0; i--) {
				if (this.turns[i]?.mounted) return this.turns[i];
			}
			return undefined;
		}
		for (let i = fromTurn.index + 1; i < this.turns.length; i++) {
			if (this.turns[i]?.mounted) return this.turns[i];
		}
		return undefined;
	}

	navigate(direction: "prev" | "next"): void {
		this.turns = this.turnIndex.getTurns();
		const reference = this.resolveCurrentTurn();
		const target = this.findAdjacentMountedTurn(reference, direction);
		if (!target) return;
		this.turnIndex.jumpToTurn(target.index, { direction });
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.active || event.y < 0 || event.y >= this.lastRenderedHeight) return undefined;

		if (event.type === "move") {
			claimHover(this, () => {
				if (this.hovered) {
					this.hovered = false;
					this.shell.requestRender();
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

		if (event.type !== "click" || (event.button !== "left" && event.button !== "none")) {
			return undefined;
		}

		const matchedPill = this.pillHits.find(
			(hit) => event.y === hit.y && event.x >= hit.xStart && event.x < hit.xEnd,
		);
		if (matchedPill) {
			matchedPill.onClick?.(event.screenX, event.screenY);
			return { handled: true, render: true };
		}

		this.toggleExpanded();
		return { handled: true, render: true };
	}

	renderStickyOverlay(width: number, viewportWidth?: number): StickyOverlayRender {
		const lines = this.renderInternal(width, viewportWidth);
		if (lines.length === 0 || !this.active) {
			this.lastVisibleHeight = 0;
			this.lastPushOffset = 0;
			return {
				lines: [],
				visibleLines: [],
				fullHeight: 0,
				pushOffset: 0,
			};
		}

		const nextTurn = this.findAdjacentMountedTurn(this.active, "next");
		const scrollTop = this.shell.scroll.scrollTop ?? 0;
		const push = computeStickyPushOffset(lines.length, scrollTop, nextTurn?.start);
		const visibleLines = push.pushOffset > 0 ? lines.slice(push.pushOffset) : lines;
		this.lastPushOffset = push.pushOffset;
		this.lastVisibleHeight = visibleLines.length;
		return {
			lines,
			visibleLines,
			fullHeight: lines.length,
			pushOffset: push.pushOffset,
		};
	}

	render(width: number): string[] {
		return [...this.renderStickyOverlay(width).visibleLines];
	}

	private renderInternal(cardWidth: number, viewportWidth?: number): string[] {
		this.active = undefined;
		this.pillHits = [];
		if (this.disposed || !this.config.enabled || cardWidth < 16) {
			this.lastRenderedHeight = 0;
			return [];
		}

		const { scroll } = this.shell;
		if (!scroll.children[0]) {
			this.lastRenderedHeight = 0;
			return [];
		}

		this.turns = this.turnIndex.getTurns(viewportWidth);

		const mountedIds = new Set<string>(this.turns.filter((t) => t.mounted).map((t) => t.id));
		for (const key of this.expanded) {
			if (!mountedIds.has(key)) this.expanded.delete(key);
		}

		this.active = selectStickyTurn(this.turns, scroll.scrollTop ?? 0, this.config.mode);
		if (!this.active) {
			this.lastRenderedHeight = 0;
			return [];
		}

		const isExpanded = this.expanded.has(this.active.id);
		const viewportLimit =
			scroll.viewportHeight && scroll.viewportHeight > 4
				? Math.max(COLLAPSED_MAX_CONTENT_LINES, scroll.viewportHeight - 3)
				: undefined;
		const maxContentLines = isExpanded ? viewportLimit : COLLAPSED_MAX_CONTENT_LINES;

		const rendered = renderUserPromptCardLines(
			this.active.prompt,
			cardWidth,
			this.shell.theme(),
			{
				formattedTime: this.config.showTimestamp ? this.active.formattedTime : "",
				hovered: this.hovered,
				showCopyBadge: false,
				maxContentLines,
				surface: "sticky",
				messageId: this.active.id,
				timestamp: this.active.timestamp,
			},
		);

		this.pillHits = rendered.pillHits;
		this.lastRenderedHeight = rendered.lines.length;
		return rendered.lines;
	}
}

export function registerStickyPromptCommands(
	pi: ExtensionAPI,
	getBar: () => StickyPromptBar | undefined,
): void {
	const usage = "/sticky [toggle | prev | next | expand | time | auto | always | status]";

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
						`Sticky: ${cfg.enabled ? "on" : "off"} | mode=${cfg.mode} | time=${cfg.showTimestamp}`,
						"info",
					);
					return;
				default:
					ctx.ui.notify(`Использование: ${usage}`, "info");
					return;
			}
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
