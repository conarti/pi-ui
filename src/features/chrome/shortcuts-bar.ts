import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, isLightTheme, type HitBox, type RgbTuple } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { t } from "../../shared/i18n.ts";
import { loadPiUiUserConfig } from "../../shared/pi-ui-config.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { runAppAction } from "../../shared/ui-action-bridge.ts";
import { showCommandPalette } from "../command-palette/index.ts";
import { cycleSessionMode } from "../plan-studio/index.ts";
import {
	acceptActivePromptSuggestion,
	dismissActivePromptSuggestion,
	hasActivePromptSuggestion,
} from "../prompt-suggestion/index.ts";
import { getActiveComposerEditor } from "./composer.ts";
import { openComposerPopover } from "./composer-popovers.ts";

export interface ParkedAskUserController {
	isParked(): boolean;
	returnToQuestion(): void;
}

const PARKED_ASK_USER_KEY = Symbol.for("conarti.pi-ui.parked-ask-user.v1");
const SHORTCUTS_BAR_STATE_KEY = Symbol.for("conarti.pi-ui.shortcuts-bar-state.v1");

function getParkedAskUserSlot(): { controller?: ParkedAskUserController } {
	const g = globalThis as Record<symbol, { controller?: ParkedAskUserController } | undefined>;
	if (!g[PARKED_ASK_USER_KEY]) {
		g[PARKED_ASK_USER_KEY] = {};
	}
	return g[PARKED_ASK_USER_KEY]!;
}

export function setParkedAskUserController(controller: ParkedAskUserController | undefined): void {
	getParkedAskUserSlot().controller = controller;
}

export function getParkedAskUserController(): ParkedAskUserController | undefined {
	return getParkedAskUserSlot().controller;
}

interface ShortcutsBarSlotState {
	ownsFooter: boolean;
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
}

function getBarSlotState(): ShortcutsBarSlotState {
	const g = globalThis as Record<symbol, ShortcutsBarSlotState | undefined>;
	if (!g[SHORTCUTS_BAR_STATE_KEY]) {
		g[SHORTCUTS_BAR_STATE_KEY] = { ownsFooter: false };
	}
	return g[SHORTCUTS_BAR_STATE_KEY]!;
}

interface ShortcutHintItem {
	readonly id: string;
	readonly label: string;
	readonly tone?: "default" | "warning" | "accent";
	readonly onClick: () => void;
}

function resolveContextHints(pi: ExtensionAPI, ctx: ExtensionContext): ShortcutHintItem[] {
	const editor = getActiveComposerEditor();
	const transient = editor?.getTransientHint();
	const parkedController = getParkedAskUserController();

	if (parkedController?.isParked()) {
		return [
			{
				id: "return-question",
				label: t("shortcutsBar.returnQuestion"),
				tone: "accent",
				onClick: () => parkedController.returnToQuestion(),
			},
		];
	}

	if (transient) {
		if (transient.kind === "esc-clear") {
			return [
				{
					id: "transient-clear",
					label: transient.text,
					tone: "warning",
					onClick: () => editor?.clearDraftWithUndo(),
				},
			];
		}
		return [
			{
				id: "transient-stop",
				label: transient.text,
				tone: "warning",
				onClick: () => ctx.abort(),
			},
		];
	}

	const isIdle = ctx.isIdle?.() ?? true;
	if (!isIdle) {
		const midTurn = loadPiUiUserConfig().midTurnEnter;
		return [
			{
				id: "midturn-enter",
				label: midTurn === "steer" ? t("shortcutsBar.steer") : t("shortcutsBar.queue"),
				onClick: () => editor?.triggerMidTurnAction(midTurn === "steer" ? "steer" : "queue"),
			},
			{
				id: "midturn-send-now",
				label: t("shortcutsBar.sendNow"),
				onClick: () => editor?.triggerMidTurnAction("send-now"),
			},
			{
				id: "midturn-alt",
				label: midTurn === "steer" ? t("shortcutsBar.altQueue") : t("shortcutsBar.altSteer"),
				onClick: () => editor?.triggerMidTurnAction(midTurn === "steer" ? "queue" : "steer"),
			},
			{
				id: "midturn-stop",
				label: t("shortcutsBar.stop"),
				tone: "warning",
				onClick: () => ctx.abort(),
			},
		];
	}

	const isEmpty = editor ? editor.isDraftCompletelyEmpty() : true;
	if (isEmpty && hasActivePromptSuggestion()) {
		return [
			{
				id: "sug-accept",
				label: t("shortcutsBar.accept"),
				tone: "accent",
				onClick: () => {
					if (editor) acceptActivePromptSuggestion(editor);
				},
			},
			{
				id: "sug-dismiss",
				label: t("shortcutsBar.dismiss"),
				onClick: () => dismissActivePromptSuggestion(),
			},
			{
				id: "commands",
				label: t("shortcutsBar.commands"),
				onClick: () => void showCommandPalette(pi, ctx),
			},
			{
				id: "mode",
				label: t("shortcutsBar.mode"),
				onClick: () => cycleSessionMode(pi, ctx),
			},
		];
	}

	if (!isEmpty) {
		return [
			{
				id: "send",
				label: t("shortcutsBar.send"),
				onClick: () => {
					if (editor) editor.handleInput("\r");
				},
			},
			{
				id: "newline",
				label: t("shortcutsBar.newline"),
				onClick: () => {
					if (editor) editor.handleInput("\x1b[13;2u");
				},
			},
			{
				id: "clear",
				label: t("shortcutsBar.clear"),
				onClick: () => editor?.clearDraftWithUndo(),
			},
			{
				id: "undo",
				label: t("shortcutsBar.undo"),
				onClick: () => editor?.performUndo(),
			},
			{
				id: "commands",
				label: t("shortcutsBar.commands"),
				onClick: () => void showCommandPalette(pi, ctx),
			},
		];
	}

	return [
		{
			id: "mode",
			label: t("shortcutsBar.mode"),
			onClick: () => cycleSessionMode(pi, ctx),
		},
		{
			id: "model",
			label: t("shortcutsBar.model"),
			onClick: () => openComposerPopover(pi, ctx, "model"),
		},
		{
			id: "thinking",
			label: t("shortcutsBar.thinking"),
			onClick: () => openComposerPopover(pi, ctx, "thinking"),
		},
		{
			id: "commands",
			label: t("shortcutsBar.commands"),
			onClick: () => void showCommandPalette(pi, ctx),
		},
		{
			id: "tree",
			label: t("shortcutsBar.tree"),
			onClick: () => runAppAction("app.session.tree"),
		},
	];
}

class ShortcutsBarComponent implements Component {
	private hoveredId: string | null = null;
	private hits: HitBox[] = [];
	private readonly hoverOwner = {};

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly getTheme: () => Theme,
		private readonly requestRender: () => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		this.hits = [];
		const config = loadPiUiUserConfig();
		/* При showShortcutsBar = false занимаем строго 0 строк под Composer */
		if (!config.showShortcutsBar || width < 8) {
			return [];
		}

		const theme = this.getTheme();
		const light = isLightTheme(theme);
		const outerPad = computeOuterCanvasMargin(width);
		const leftCol = outerPad + 2;
		const contentWidth = Math.max(4, width - outerPad * 2 - 4);
		const items = resolveContextHints(this.pi, this.ctx);

		const accentRgb: RgbTuple = light ? [29, 78, 216] : [125, 207, 255];
		const warnRgb: RgbTuple = light ? [180, 83, 9] : [229, 192, 123];
		const sep = theme.fg("dim", "  ·  ");
		const sepW = 5;

		let curX = leftCol;
		let line = " ".repeat(leftCol);
		let used = 0;

		for (let i = 0; i < items.length; i += 1) {
			const item = items[i]!;
			const needSep = used > 0 ? sepW : 0;
			const itemW = visibleWidth(item.label);
			if (used + needSep + itemW > contentWidth) {
				if (used === 0) {
					const clipped = truncateToWidth(item.label, contentWidth, "…");
					const cw = visibleWidth(clipped);
					const styled =
						this.hoveredId === item.id
							? fgRgb(accentRgb, clipped)
							: item.tone === "warning"
								? fgRgb(warnRgb, clipped)
								: item.tone === "accent"
									? fgRgb(accentRgb, clipped)
									: theme.fg("dim", clipped);
					this.hits.push({
						id: item.id,
						xStart: curX,
						xEnd: curX + cw,
						y: 0,
						onClick: item.onClick,
					});
					line += styled;
					used += cw;
				}
				break;
			}
			if (needSep > 0) {
				line += sep;
				curX += sepW;
				used += sepW;
			}
			const styled =
				this.hoveredId === item.id
					? fgRgb(accentRgb, item.label)
					: item.tone === "warning"
						? fgRgb(warnRgb, item.label)
						: item.tone === "accent"
							? fgRgb(accentRgb, item.label)
							: theme.fg("dim", item.label);
			this.hits.push({
				id: item.id,
				xStart: curX,
				xEnd: curX + itemW,
				y: 0,
				onClick: item.onClick,
			});
			line += styled;
			curX += itemW;
			used += itemW;
		}

		const trailing = " ".repeat(Math.max(0, width - visibleWidth(line)));
		return [`${line}${trailing}`];
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
						this.requestRender();
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
			hit.onClick();
			return { handled: true, render: true };
		}
		return undefined;
	}
}

export function mountShortcutsBar(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const state = getBarSlotState();
	state.pi = pi;
	state.ctx = ctx;

	/* Всегда регистрируем фабрику через Slot Arbitration, чтобы она кэшировалась для мгновенного live-переключения */
	state.ownsFooter = true;
	ctx.ui.setFooter((tui, _theme) => {
		return new ShortcutsBarComponent(
			pi,
			ctx,
			() => ctx.ui.theme,
			() => tui.requestRender(),
		);
	});
}

export function disposeShortcutsBar(): void {
	const state = getBarSlotState();
	state.ownsFooter = false;
	state.pi = undefined;
	state.ctx = undefined;
}
