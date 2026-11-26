import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	ScrollView,
	TuiAltScreen,
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
	registerTransientHoverDismisser,
	resolveActiveExternalOpener,
	unwrapHostTui,
} from "../../shared/host-runtime.ts";
import type { InspectableLinkTarget } from "../../shared/link-targets.ts";
import { hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { copyToClipboard, hookMethod } from "../../shared/runtime-hooks.ts";

interface PopupActionHit {
	readonly kind: "open" | "copy";
	readonly xStart: number;
	readonly xEnd: number;
}

class LinkTargetPopup implements Component {
	target: InspectableLinkTarget | undefined;
	hoveredAction: "open" | "copy" | undefined;
	onOpen?: (target: InspectableLinkTarget) => void;
	onCopy?: (target: InspectableLinkTarget) => void;
	private actionRowY = -1;
	private actionHits: PopupActionHit[] = [];

	constructor(private readonly getTheme: () => Theme) {}

	invalidate(): void {}

	computeDimensions(termCols: number): { width: number; height: number } {
		const maxW = Math.max(26, Math.min(72, termCols - 6));
		const innerMax = Math.max(16, maxW - 4);
		const targetText = this.target?.displayTarget ?? "";
		const wrapped = targetText ? wrapTextWithAnsi(targetText, innerMax) : [""];
		const visibleTargetLines = wrapped.slice(0, 3);
		const contentW = Math.max(
			visibleWidth("[Open]  [Copy]"),
			...visibleTargetLines.map(visibleWidth),
		);
		const width = Math.max(24, Math.min(maxW, contentW + 4));
		return {
			width,
			height: visibleTargetLines.length + 3,
		};
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.target) return undefined;

		if (event.type === "wheel") {
			return { handled: true, render: false };
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
		const safeWidth = Math.max(22, width);
		const innerSpan = Math.max(2, safeWidth - 2);
		const textWidth = Math.max(1, safeWidth - 4);
		const b = (s: string) => themeFgRgb(theme, palette.borderSubtle, s);
		const accentFg = palette.isLight ? palette.accent : palette.accentBright;

		const wrapped = wrapTextWithAnsi(this.target.displayTarget, textWidth).slice(0, 3);
		const out: string[] = [
			paintThemeSurfaceRow(
				theme,
				`${b("╭")}${b("─".repeat(innerSpan))}${b("╮")}`,
				safeWidth,
				palette.popupSurfaceBg,
			),
		];

		for (const row of wrapped) {
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

		const openLabel = "[Open]";
		const copyLabel = "[Copy]";
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
	hooksInstalled: boolean;
	clickedInsideCurrentRelease: boolean;
}

function getLinkPopupState(): LinkPopupState {
	const g = globalThis as Record<symbol, LinkPopupState | undefined>;
	if (!g[LINK_POPUP_SLOT_KEY]) {
		const state: LinkPopupState = {
			visible: false,
			hooksInstalled: false,
			clickedInsideCurrentRelease: false,
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

function ensureLinkPopupDismissHooks(): void {
	const state = getLinkPopupState();
	if (state.hooksInstalled) return;
	state.hooksInstalled = true;

	const scrollProto = (ScrollView as unknown as { prototype?: object } | undefined)?.prototype;
	if (scrollProto) {
		for (const methodName of ["scrollTo", "scrollBy", "scrollToStart", "scrollToEnd"] as const) {
			hookMethod(
				scrollProto,
				methodName,
				`linkTarget.scrollDismiss.${methodName}`,
				(self, args, original) => {
					const prevTop = self.scrollTop;
					const result = original.apply(self, args);
					if (state.visible && self.scrollTop !== prevTop && self === getActiveHostRuntime()?.scroll) {
						hideLinkTargetPopup();
						getActiveHostRuntime()?.requestRender();
					}
					return result;
				},
			);
		}
	}

	const altProto = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
	if (altProto) {
		hookMethod(
			altProto,
			"handleMouseEvent",
			"linkTarget.outsideReleaseDismiss",
			(self, args, original) => {
				const raw = args[0] as { button: number; x: number; y: number; release: boolean } | undefined;
				const isButtonRelease = Boolean(raw && raw.release && (raw.button & 32) === 0);
				if (!isButtonRelease || !state.visible) {
					return original.apply(self, args);
				}

				const col = raw!.x - 1;
				const row = raw!.y - 1;
				const layouts = (
					self as {
						renderedOverlayLayouts?: ReadonlyArray<{
							entry: { component?: Component };
							col: number;
							row: number;
							width: number;
							height: number;
						}>;
					}
				).renderedOverlayLayouts;
				const ownLayout = layouts?.find((l) => l.entry?.component === state.popup);
				const insidePopup = Boolean(
					ownLayout &&
						col >= ownLayout.col &&
						col < ownLayout.col + ownLayout.width &&
						row >= ownLayout.row &&
						row < ownLayout.row + ownLayout.height,
				);

				state.clickedInsideCurrentRelease = insidePopup;
				const res = original.apply(self, args);
				if (!state.clickedInsideCurrentRelease && state.visible) {
					hideLinkTargetPopup();
					self.requestRender?.();
				}
				return res;
			},
		);
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

	ensureLinkPopupDismissHooks();
	const state = getLinkPopupState();
	state.clickedInsideCurrentRelease = true;

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

	const termCols = Math.max(24, tui.terminal?.columns ?? 80);
	const termRows = Math.max(8, tui.terminal?.rows ?? 30);
	const { width, height } = state.popup.computeDimensions(termCols);

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
