import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
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
import { getActiveHostRuntime, resolveActiveExternalOpener } from "../../shared/host-runtime.ts";
import { createClickedHoverPopup } from "../../shared/clicked-hover-popup.ts";
import { t } from "../../shared/i18n.ts";
import type { InspectableLinkTarget } from "../../shared/link-targets.ts";
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

function createLinkPopupController() {
	return createClickedHoverPopup("linkTarget.popup", (dismiss) => {
		const popup = new LinkTargetPopup(() => getActiveGlobalTheme(getActiveHostRuntime()?.theme()));
		popup.onOpen = (target) => {
			dismiss();
			const opener = resolveActiveExternalOpener();
			if (target.kind === "url") {
				void opener.openUrl(target.url);
			} else {
				void opener.openPath(target.resolvedPath, { line: target.line, column: target.column });
			}
		};
		popup.onCopy = (target) => {
			copyToClipboard(target.copyText);
			dismiss();
		};
		return popup;
	}, { x: 2, y: 1 });
}

function getLinkPopupController() {
	const g = globalThis as Record<symbol, ReturnType<typeof createLinkPopupController> | undefined>;
	return g[LINK_POPUP_SLOT_KEY] ??= createLinkPopupController();
}

export function isLinkTargetPopupVisible(): boolean {
	return getLinkPopupController().isVisible();
}

export function hideLinkTargetPopup(): void {
	getLinkPopupController().hide();
}

export function toggleLinkTargetPopup(target: InspectableLinkTarget, screenX: number, screenY: number): void {
	const key = `${target.kind}:${target.copyText}`;
	getLinkPopupController().toggle(getActiveHostRuntime()?.tui, key, screenX, screenY, (popup) => {
		popup.target = target;
		popup.hoveredAction = undefined;
		popup.scrollOffset = 0;
	});
}
