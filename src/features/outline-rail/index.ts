import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type OverlayHandle, type OverlayOptions } from "@earendil-works/pi-tui";
import type { FullscreenShellContext } from "../../shared/fullscreen-layout.ts";
import {
	getActiveHostRuntime,
	registerTransientHoverDismisser,
} from "../../shared/host-runtime.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { t } from "../../shared/i18n.ts";
import type { IndexedTurn, TranscriptTurnIndex } from "../../shared/turn-index.ts";
import { reconstructTurnPromptText } from "../prompt-chips/registry.ts";
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
	ctx: ExtensionContext,
	shell: FullscreenShellContext,
	turnIndex: TranscriptTurnIndex,
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
		visible: () => popupVisible && !hasBlockingModalOverlay(shell.tui),
	};

	const hidePopup = (fromRender = false) => {
		if (!popupVisible && !popupHandle) return;
		popupVisible = false;
		if (popupHandle) {
			try {
				popupHandle.hide();
			} catch {
				/* Уже скрыто хостом */
			}
			popupHandle = undefined;
		}
		if (!fromRender) {
			shell.requestRender();
		}
	};

	const updatePopup = (
		hit: RailHit | undefined,
		turn: IndexedTurn | undefined,
		screenY: number,
		fromRender = false,
	) => {
		const geo = rail.geometry;
		if (!hit || !turn || !geo || hasBlockingModalOverlay(shell.tui)) {
			hidePopup(fromRender);
			return;
		}
		const termCols = shell.tui.terminal?.columns ?? 80;
		const termRows = shell.tui.terminal?.rows ?? 30;
		const viewportRows = shell.scroll.viewportHeight || termRows;
		const maxCardW = Math.max(10, termCols - RAIL_WIDTH - 4);
		const maxText = Math.max(
			6,
			Math.min(40, maxCardW - 4, Math.floor((termCols - RAIL_WIDTH - 2) * 0.55)),
		);

		const entries = ctx.sessionManager?.getEntries?.() ?? ctx.sessionManager?.getBranch?.();
		const reconstructed = reconstructTurnPromptText(turn.prompt, {
			timestamp: turn.timestamp,
			messageId: turn.id,
			entries,
		});
		const previewSource = reconstructed || turn.prompt;
		const bodyLines = wrapPreviewLines(previewSource, maxText);
		const contentW = Math.max(
			Math.min(10, maxText),
			...bodyLines.map(visibleWidth),
		);
		const cardW = Math.min(maxCardW, contentW + 4);
		const cardH = (bodyLines.length || 1) + 2;

		const maxRow = Math.max(0, Math.min(termRows - cardH, viewportRows - cardH));
		popup.time = "";
		popup.preview = previewSource;
		popupOptions.width = cardW;
		popupOptions.col = Math.max(1, termCols - RAIL_WIDTH - cardW - 1);
		popupOptions.row = Math.max(0, Math.min(screenY - Math.floor(cardH / 2), maxRow));
		popupVisible = true;
		if (!popupHandle) {
			popupHandle = shell.tui.showOverlay(popup, popupOptions);
		} else if (!fromRender) {
			shell.requestRender();
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

	const unregisterHoverDismisser = registerTransientHoverDismisser("outlineRail.preview", () =>
		hidePopup(true),
	);

	return Object.assign(rail, {
		dispose() {
			unregisterHoverDismisser();
			hidePopup();
		},
	});
}

export function registerOutlineCommands(pi: ExtensionAPI, requestRender: () => void): void {
	const toggle = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(t("outline.fullscreenOnly"), "warning");
			return;
		}
		const settings = getOutlineSettings();
		settings.enabled = !settings.enabled;
		getActiveHostRuntime()?.scroll?.invalidate?.();
		requestRender();
		ctx.ui.notify(
			t("outline.toggled", { state: settings.enabled ? t("state.shown") : t("state.hidden") }),
			"info",
		);
	};

	pi.registerShortcut("ctrl+alt+o", {
		description: t("outline.shortcut"),
		handler: async (ctx) => toggle(ctx),
	});

	pi.registerCommand("outline", {
		description: t("outline.command"),
		handler: async (_args, ctx) => toggle(ctx),
	});
}
