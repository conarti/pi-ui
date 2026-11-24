import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type OverlayHandle, type OverlayOptions } from "@earendil-works/pi-tui";
import type { FullscreenShellContext } from "../../shared/fullscreen-layout.ts";
import type { IndexedTurn, TranscriptTurnIndex } from "../../shared/turn-index.ts";
import {
	OutlinePreviewPopup,
	OutlineRailComponent,
	RAIL_WIDTH,
	wrapPreviewLines,
	type RailHit,
} from "./rail-view.ts";

interface OutlineSettings {
	enabled: boolean;
}

const OUTLINE_SETTINGS_KEY = Symbol.for("conarti.pi-ui.outline-settings.v1");

export function getOutlineSettings(): OutlineSettings {
	const g = globalThis as Record<symbol, OutlineSettings | undefined>;
	if (!g[OUTLINE_SETTINGS_KEY]) {
		g[OUTLINE_SETTINGS_KEY] = { enabled: true };
	}
	return g[OUTLINE_SETTINGS_KEY]!;
}

export function createOutlineRailSlot(
	_ctx: ExtensionContext,
	shell: FullscreenShellContext,
	turnIndex: TranscriptTurnIndex,
	getTopOffset: () => number,
): OutlineRailComponent & { dispose(): void } {
	const settings = getOutlineSettings();
	const popup = new OutlinePreviewPopup(shell.theme);
	let popupVisible = false;
	let popupHandle: OverlayHandle | undefined;

	const popupOptions: OverlayOptions = {
		nonCapturing: true,
		width: 24,
		row: 0,
		col: 0,
		visible: () => popupVisible && !(shell.tui as any).getTopmostVisibleOverlay?.(),
	};

	const hidePopup = () => {
		if (!popupVisible && !popupHandle) return;
		popupVisible = false;
		if (popupHandle) {
			try {
				popupHandle.hide();
			} catch {
				// already hidden
			}
			popupHandle = undefined;
		}
		shell.requestRender();
	};

	const updatePopup = (hit: RailHit | undefined, turn: IndexedTurn | undefined, screenY: number) => {
		const geo = rail.geometry;
		if (!hit || !turn || !geo) {
			hidePopup();
			return;
		}
		const allTurns = turnIndex.getTurns();
		const total = allTurns.length;
		const termCols = shell.tui.terminal?.columns ?? 80;
		const termRows = shell.tui.terminal?.rows ?? 30;
		const maxText = Math.max(16, Math.min(36, Math.floor((termCols - RAIL_WIDTH) * 0.48)));

		const prefix = hit.kind === "up" ? "↑ " : hit.kind === "down" ? "↓ " : "";
		const meta = `${prefix}Реплика ${turn.ordinal} из ${total}`;
		const above = geo.windowStart;
		const below = Math.max(0, total - geo.windowEnd);
		const note = [above ? `выше скрыто: ${above}` : "", below ? `ниже скрыто: ${below}` : ""]
			.filter(Boolean)
			.join(" · ");

		const bodyLines = wrapPreviewLines(turn.title, maxText);
		const metaLines = wrapPreviewLines(meta, maxText);
		const noteLines = note ? wrapPreviewLines(note, maxText) : [];
		const contentW = Math.max(
			12,
			...bodyLines.map(visibleWidth),
			...metaLines.map(visibleWidth),
			...noteLines.map(visibleWidth),
		);
		const cardW = Math.min(Math.max(16, termCols - RAIL_WIDTH - 4), contentW + 4);
		const cardH = (bodyLines.length || 1) + metaLines.length + noteLines.length + 2;

		const minRow = getTopOffset();
		const maxRow = Math.max(minRow, termRows - cardH - 3);
		popup.meta = meta;
		popup.note = note;
		popup.preview = turn.title;
		popupOptions.width = cardW;
		popupOptions.col = Math.max(1, termCols - RAIL_WIDTH - cardW - 2);
		popupOptions.row = Math.max(minRow, Math.min(screenY - Math.floor(cardH / 2), maxRow));
		popupVisible = true;
		if (!popupHandle) {
			popupHandle = shell.tui.showOverlay(popup, popupOptions);
		}
	};

	const rail = new OutlineRailComponent(
		shell.tui,
		shell.scroll,
		shell.theme,
		turnIndex,
		() => settings.enabled,
		updatePopup,
		(_turn, turnIdx, direction) => {
			hidePopup();
			turnIndex.jumpToTurn(turnIdx, { direction });
		},
	);

	return Object.assign(rail, {
		dispose() {
			hidePopup();
		},
	});
}

export function registerOutlineCommands(pi: ExtensionAPI, requestRender: () => void): void {
	const toggle = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Навигация по репликам доступна в fullscreen TUI", "warning");
			return;
		}
		const settings = getOutlineSettings();
		settings.enabled = !settings.enabled;
		requestRender();
		ctx.ui.notify(
			`Панель навигации справа: ${settings.enabled ? "показана" : "скрыта"}`,
			"info",
		);
	};

	pi.registerShortcut("ctrl+alt+o", {
		description: "Показать / скрыть правую панель навигации по репликам",
		handler: async (ctx) => toggle(ctx),
	});

	pi.registerCommand("outline", {
		description: "Показать / скрыть правую панель навигации по репликам (Ctrl+Alt+O)",
		handler: async (_args, ctx) => toggle(ctx),
	});
}
