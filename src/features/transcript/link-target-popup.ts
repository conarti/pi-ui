import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	getActiveGlobalTheme,
	getThemeSurfacePalette,
	paintThemeSurfaceRow,
	themeBgRgb,
	themeFgRgb,
} from "../../shared/ansi.ts";
import {
	getActiveHostRuntime,
	installClickedHoverPopupDismissHooks,
	registerTransientHoverDismisser,
	resolveActiveExternalOpener,
	unwrapHostTui,
} from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import type { InspectableLinkTarget } from "../../shared/link-targets.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { copyToClipboard } from "../../shared/runtime-hooks.ts";

interface PopupActionHit {
	readonly kind: "open" | "copy";
	readonly xStart: number;
	readonly xEnd: number;
}

class LinkTargetPopup implements Component {
	target: InspectableLinkTarget | undefined;
	scrollOffset = 0;
	private maxScroll = 0;
	private targetRows = 3;
	hoveredAction: "open" | "copy" | undefined;
	onOpen?: (target: InspectableLinkTarget) => void;
	onCopy?: (target: InspectableLinkTarget) => void;
	private actionRowY = -1;
	private actionHits: PopupActionHit[] = [];

	constructor(private readonly getTheme: () => Theme) {}

	invalidate(): void {}

	computeDimensions(termCols: number, termRows: number): { width: number; height: number } {
		const maxWidth = Math.max(12, Math.min(72, termCols - 4));
		const target = this.target?.displayTarget ?? "";
		const actions = `${t("transcript.action.open")}  ${t("transcript.action.copy")}`;
		const width = Math.min(maxWidth, Math.max(24, visibleWidth(target) + 4, visibleWidth(actions) + 4));
		this.targetRows = Math.max(1, Math.min(8, termRows - 6));
		const wrapped = wrapTextWithAnsi(target, width - 4);
		const scrollable = wrapped.length > this.targetRows;
		return { width, height: Math.min(wrapped.length, this.targetRows) + (scrollable ? 4 : 3) };
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.target) return undefined;

		if (event.type === "wheel") {
			const next = Math.max(0, Math.min(this.maxScroll, this.scrollOffset + (event.wheelDelta ?? 0)));
			const changed = next !== this.scrollOffset;
			this.scrollOffset = next;
			return { handled: true, render: changed };
		}

		if (event.type === "move") {
			const hit =
				event.y === this.actionRowY
					? this.actionHits.find((btn) => event.x >= btn.xStart && event.x < btn.xEnd)
					: undefined;
			const next = hit?.kind;
			if (next !== this.hoveredAction) {
				this.hoveredAction = next;
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}

		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}

		if (event.type === "click" && event.button === "left") {
			if (event.y === this.actionRowY) {
				const hit = this.actionHits.find((btn) => event.x >= btn.xStart && event.x < btn.xEnd);
				if (hit?.kind === "open") {
					this.onOpen?.(this.target);
					return { handled: true, render: true };
				}
				if (hit?.kind === "copy") {
					this.onCopy?.(this.target);
					return { handled: true, render: true };
				}
			}
			return { handled: true, render: false };
		}

		return undefined;
	}

	render(width: number): string[] {
		if (!this.target) return [];
		const theme = this.getTheme();
		const palette = getThemeSurfacePalette(theme);
		const safeWidth = width;
		const innerSpan = Math.max(2, safeWidth - 2);
		const textWidth = Math.max(1, safeWidth - 4);
		const b = (s: string) => themeFgRgb(theme, palette.borderSubtle, s);
		const accentFg = palette.isLight ? palette.accent : palette.accentBright;

		const wrapped = wrapTextWithAnsi(this.target.displayTarget, textWidth);
		this.maxScroll = Math.max(0, wrapped.length - this.targetRows);
		this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
		const visibleRows = wrapped.slice(this.scrollOffset, this.scrollOffset + this.targetRows);
		if (this.maxScroll) visibleRows.push(theme.fg("muted", t("transcript.popup.scrollHint")));
		const out: string[] = [
			paintThemeSurfaceRow(
				theme,
				`${b("╭")}${b("─".repeat(innerSpan))}${b("╮")}`,
				safeWidth,
				palette.popupSurfaceBg,
			),
		];

		for (const row of visibleRows) {
			const clipped = truncateToWidth(row, textWidth, "…");
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(clipped)));
			out.push(
				paintThemeSurfaceRow(
					theme,
					`${b("│")} ${theme.fg("text", `${clipped}${pad}`)} ${b("│")}`,
					safeWidth,
					palette.popupSurfaceBg,
				),
			);
		}

		const openLabel = t("transcript.action.open");
		const copyLabel = t("transcript.action.copy");
		const paintBtn = (label: string, hovered: boolean) =>
			hovered
				? themeBgRgb(theme, palette.badgeHoverBg, themeFgRgb(theme, accentFg, label))
				: themeFgRgb(theme, accentFg, label);

		const openW = visibleWidth(openLabel);
		const copyW = visibleWidth(copyLabel);
		const openX = 2;
		const copyX = openX + openW + 2;
		this.actionRowY = out.length;
		this.actionHits = [
			{ kind: "open", xStart: openX, xEnd: openX + openW },
			{ kind: "copy", xStart: copyX, xEnd: copyX + copyW },
		];

		const actionText = `${paintBtn(openLabel, this.hoveredAction === "open")}  ${paintBtn(copyLabel, this.hoveredAction === "copy")}`;
		const actionPad = " ".repeat(Math.max(0, textWidth - visibleWidth(actionText)));
		out.push(
			paintThemeSurfaceRow(
				theme,
				`${b("│")} ${actionText}${actionPad} ${b("│")}`,
				safeWidth,
				palette.popupSurfaceBg,
			),
		);

		out.push(
			paintThemeSurfaceRow(
				theme,
				`${b("╰")}${b("─".repeat(innerSpan))}${b("╯")}`,
				safeWidth,
				palette.popupSurfaceBg,
			),
		);

		return out;
	}
}

const LINK_POPUP_SLOT_KEY = Symbol.for("conarti.pi-ui.link-target-popup.v1");

interface LinkPopupState {
	popup?: LinkTargetPopup;
	handle?: OverlayHandle;
	options?: OverlayOptions;
	visible: boolean;
	activeKey?: string;
	activeTui?: TUI;
	activeRenderer?: object;
	markOpened?: () => void;
}

function getLinkPopupState(): LinkPopupState {
	const g = globalThis as Record<symbol, LinkPopupState | undefined>;
	if (!g[LINK_POPUP_SLOT_KEY]) {
		const state: LinkPopupState = {
			visible: false,
		};
		g[LINK_POPUP_SLOT_KEY] = state;
		registerTransientHoverDismisser("linkTarget.popup", () => hideLinkTargetPopup());
	}
	return g[LINK_POPUP_SLOT_KEY]!;
}

export function isLinkTargetPopupVisible(): boolean {
	const state = getLinkPopupState();
	return state.visible && Boolean(state.handle);
}

export function hideLinkTargetPopup(): void {
	const state = getLinkPopupState();
	if (!state.visible && !state.handle) return;
	state.visible = false;
	state.activeKey = undefined;
	state.activeRenderer = undefined;
	if (state.popup) {
		state.popup.hoveredAction = undefined;
	}
	const handle = state.handle;
	state.handle = undefined;
	if (handle) {
		try {
			handle.hide();
		} catch {
			/* Уже скрыто хостом */
		}
	}
}

export function toggleLinkTargetPopup(
	target: InspectableLinkTarget,
	screenX: number,
	screenY: number,
): void {
	const runtime = getActiveHostRuntime();
	const tui = runtime?.tui;
	if (!tui || hasBlockingModalOverlay(tui)) {
		hideLinkTargetPopup();
		return;
	}

	const state = getLinkPopupState();
	state.markOpened ??= installClickedHoverPopupDismissHooks(
		"linkTarget", () => state.visible ? state.popup : undefined, hideLinkTargetPopup,
	);

	const key = `${target.kind}:${target.copyText}`;
	if (state.visible && state.activeKey === key) {
		hideLinkTargetPopup();
		tui.requestRender();
		return;
	}

	const renderer = unwrapHostTui(tui);
	if (state.activeRenderer && state.activeRenderer !== renderer) {
		hideLinkTargetPopup();
	}
	state.activeTui = tui;
	state.activeRenderer = renderer;

	if (!state.popup) {
		state.popup = new LinkTargetPopup(() => getActiveGlobalTheme(getActiveHostRuntime()?.theme()));
		state.popup.onOpen = (item) => {
			hideLinkTargetPopup();
			getActiveHostRuntime()?.requestRender();
			const opener = resolveActiveExternalOpener();
			if (item.kind === "url") {
				void opener.openUrl(item.url);
			} else {
				void opener.openPath(item.resolvedPath, {
					line: item.line,
					column: item.column,
				});
			}
		};
		state.popup.onCopy = (item) => {
			copyToClipboard(item.copyText);
			hideLinkTargetPopup();
			getActiveHostRuntime()?.requestRender();
		};
	}

	state.popup.target = target;
	state.popup.hoveredAction = undefined;
	state.popup.scrollOffset = 0;

	const termCols = Math.max(24, tui.terminal?.columns ?? 80);
	const termRows = Math.max(8, tui.terminal?.rows ?? 30);
	const { width, height } = state.popup.computeDimensions(termCols, termRows);

	const col = Math.max(2, Math.min(screenX - 2, Math.max(2, termCols - width - 2)));
	const belowRow = screenY + 1;
	const aboveRow = screenY - height;
	const row =
		belowRow + height <= termRows
			? belowRow
			: aboveRow >= 1
				? aboveRow
				: Math.max(1, Math.min(belowRow, termRows - height));

	state.visible = true;
	state.activeKey = key;
	state.markOpened();

	if (!state.options) {
		state.options = {
			nonCapturing: true,
			width,
			col,
			row,
			visible: () =>
				state.visible && Boolean(state.activeTui) && !hasBlockingModalOverlay(state.activeTui!),
		};
	} else {
		state.options.width = width;
		state.options.col = col;
		state.options.row = row;
	}

	if (!state.handle) {
		state.handle = tui.showOverlay(state.popup, state.options);
	} else {
		tui.requestRender();
	}
}
