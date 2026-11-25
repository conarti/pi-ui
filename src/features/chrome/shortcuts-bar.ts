import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { getThemeSurfacePalette, themeFgRgb, type HitBox } from "../../shared/ansi.ts";
import {
	matchesExtensionSourcePath,
	registerSupersededExtensionPredicate,
} from "../../shared/extension-superseder.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { getSessionWorkflow } from "../../shared/session-workflow.ts";
import { requestRender, runAppAction } from "../../shared/ui-action-bridge.ts";
import { showCommandPalette } from "../command-palette/index.ts";
import { cycleSessionMode } from "../plan-studio/index.ts";
import { isPrototypeActive } from "../transcript/prototype-state.ts";
import { getActiveComposerEditor } from "./composer.ts";

const PI_FOOTER_PATH_RE = /(?:^|[\\/])pi-footer(?:[\\/]|$)/i;

export function registerPiFooterSuperseder(): void {
	registerSupersededExtensionPredicate("chrome.pi-footer", (ext) =>
		isPrototypeActive() && matchesExtensionSourcePath(ext, PI_FOOTER_PATH_RE),
	);
}

interface ShortcutItem {
	readonly id: string;
	readonly key: string;
	readonly action: string;
	readonly onClick: () => void;
}

const mountedFooterContexts = new WeakSet<object>();

export function syncShortcutsBar(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	if (!isPrototypeActive()) {
		if (mountedFooterContexts.has(ctx)) {
			mountedFooterContexts.delete(ctx);
			ctx.ui.setFooter(undefined);
		}
		return;
	}
	if (mountedFooterContexts.has(ctx)) return;
	mountedFooterContexts.add(ctx);

	ctx.ui.setFooter((tui, theme) => {
		let hoveredId: string | null = null;
		let hits: HitBox[] = [];
		const hoverOwner = {};

		return {
			invalidate() {},
			dispose() {
				hoveredId = null;
				hits = [];
			},
			render(width: number): string[] {
				hits = [];
				if (!isPrototypeActive() || width < 24) return [];

				const palette = getThemeSurfacePalette(theme);
				const wf = getSessionWorkflow();
				const editor = getActiveComposerEditor();
				const rawText = editor?.getText?.() ?? "";
				const hasDraftText = rawText.trim().length > 0;
				const hasSuggestion =
					!hasDraftText &&
					Boolean(editor && editor.isDraftCompletelyEmpty() && (editor as any).__conartiHasSuggestion);

				const items: ShortcutItem[] = [];

				if (hasSuggestion && editor) {
					items.push({
						id: "accept-suggestion",
						key: "Tab",
						action: "accept suggestion",
						onClick: () => {
							editor.handleInput("\t");
							tui.requestRender();
						},
					});
				}

				if (wf.isStreaming) {
					if (hasDraftText && editor) {
						items.push({
							id: "queue",
							key: "Enter",
							action: "queue",
							onClick: () => {
								editor.handleInput("\r");
								tui.requestRender();
							},
						});
					}
					items.push({
						id: "mode",
						key: "Shift+Tab",
						action: "mode",
						onClick: () => cycleSessionMode(pi, ctx),
					});
					items.push({
						id: "cancel",
						key: "Ctrl+c",
						action: "cancel",
						onClick: () => {
							ctx.abort();
							tui.requestRender();
						},
					});
				} else if (hasDraftText && editor) {
					items.push({
						id: "send",
						key: "Enter",
						action: "send",
						onClick: () => {
							editor.handleInput("\r");
							tui.requestRender();
						},
					});
					items.push({
						id: "newline",
						key: "Shift+Enter",
						action: "newline",
						onClick: () => {
							editor.handleInput("\x1b\r");
							tui.requestRender();
						},
					});
					items.push({
						id: "mode",
						key: "Shift+Tab",
						action: "mode",
						onClick: () => cycleSessionMode(pi, ctx),
					});
				} else {
					items.push({
						id: "mode",
						key: "Shift+Tab",
						action: "mode",
						onClick: () => cycleSessionMode(pi, ctx),
					});
					items.push({
						id: "thinking",
						key: "Ctrl+t",
						action: "thoughts",
						onClick: () => {
							runAppAction("app.thinking.toggle");
							tui.requestRender();
						},
					});
				}

				items.push({
					id: "shortcuts",
					key: "Ctrl+k",
					action: "shortcuts",
					onClick: () => void showCommandPalette(pi, ctx),
				});

				const sep = "   ";
				const sepW = sep.length;
				const leftPad = width >= 40 ? 2 : 1;
				let cursorX = leftPad;
				const renderedParts: string[] = [];

				for (let i = 0; i < items.length; i++) {
					const item = items[i]!;
					const plainW = visibleWidth(item.key) + 1 + visibleWidth(item.action);
					if (i > 0 && cursorX + sepW + plainW > width - 2) {
						break;
					}
					if (i > 0) cursorX += sepW;

					const isHov = hoveredId === item.id;
					const styledKey = isHov
						? theme.bold(themeFgRgb(theme, palette.accentBright, item.key))
						: theme.bold(theme.fg("text", item.key));
					const styledAction = isHov
						? theme.fg("text", `:${item.action}`)
						: themeFgRgb(theme, palette.codeMetaFg, `:${item.action}`);

					hits.push({
						id: item.id,
						xStart: cursorX,
						xEnd: cursorX + plainW - 1,
						y: 0,
						onClick: item.onClick,
					});
					renderedParts.push(`${styledKey}${styledAction}`);
					cursorX += plainW;
				}

				const line = `${" ".repeat(leftPad)}${renderedParts.join(sep)}`;
				const clipped = truncateToWidth(line, width, "…");
				return [clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)))];
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				const matched =
					event.y === 0
						? hits.find((h) => event.x >= h.xStart && event.x <= h.xEnd)
						: undefined;

				if (event.type === "move") {
					const nextId = matched?.id ?? null;
					if (nextId) {
						claimHover(hoverOwner, () => {
							if (hoveredId !== null) {
								hoveredId = null;
								requestRender();
							}
						});
					}
					if (nextId !== hoveredId) {
						hoveredId = nextId;
						return { handled: true, render: true };
					}
					return undefined;
				}

				if (event.button === "left" && matched) {
					if (event.type === "press") return { handled: true, render: false };
					if (event.type === "click") {
						matched.onClick();
						return { handled: true, render: true };
					}
				}
				return undefined;
			},
		};
	});
}
