import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	TuiAltScreen,
	visibleWidth,
	type Component,
	type Focusable,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { blueBgRgb, themeFgRgb, getThemeSurfacePalette, paintThemeSurfaceRow } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { getActiveHostRuntime, unwrapHostTui } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { createBracketedPasteTracker, matchesLayoutChord } from "../../shared/keyboard-layout.ts";
import { createSingleLineInput, hasBlockingModalOverlay } from "../../shared/modal-card.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
import { getSessionWorkflow, MODE_META, type SessionMode } from "../../shared/session-workflow.ts";
import { setSessionMode } from "../plan-approval/index.ts";
import { getActiveComposerEditor } from "./composer.ts";

export type ComposerPopoverKind = "model" | "thinking" | "mode";

export const COMPOSER_POPOVER_ORDER: readonly ComposerPopoverKind[] = [
	"model",
	"thinking",
	"mode",
];

const POPOVER_MODE_ORDER: readonly SessionMode[] = ["always-approve", "auto", "plan"];
const STANDARD_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];
const MAX_MODEL_ROWS = 8;

interface ActivePopoverController {
	kind: ComposerPopoverKind;
	handle: OverlayHandle;
	tui: TUI;
	switchKind: (next: ComposerPopoverKind, initialSearch?: string) => void;
	close: () => void;
}

const POPOVER_STATE_KEY = Symbol.for("conarti.pi-ui.composer-popover-state.v1");

function getPopoverSlot(): { active?: ActivePopoverController; clickedInside?: boolean } {
	const g = globalThis as Record<
		symbol,
		{ active?: ActivePopoverController; clickedInside?: boolean } | undefined
	>;
	if (!g[POPOVER_STATE_KEY]) {
		g[POPOVER_STATE_KEY] = {};
	}
	return g[POPOVER_STATE_KEY]!;
}

export function getActiveComposerPopoverKind(): ComposerPopoverKind | undefined {
	return getPopoverSlot().active?.kind;
}

export function closeActiveComposerPopover(): boolean {
	const slot = getPopoverSlot();
	if (!slot.active) return false;
	slot.active.close();
	return true;
}

function findComponentScreenY(root: unknown, target: object): number | undefined {
	if (!root || typeof root !== "object") return undefined;
	const node = root as { component?: unknown; rect?: { y?: number }; children?: unknown[] };
	if (node.component === target && typeof node.rect?.y === "number") {
		return node.rect.y;
	}
	if (Array.isArray(node.children)) {
		for (const child of node.children) {
			const found = findComponentScreenY(child, target);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function resolveComposerAnchorRow(tui: TUI): number {
	const editor = getActiveComposerEditor();
	if (editor) {
		const rawTui = unwrapHostTui(tui);
		const fromLayout = findComponentScreenY(
			(rawTui as unknown as { currentLayout?: { root?: unknown } }).currentLayout?.root,
			editor,
		);
		if (fromLayout !== undefined) return fromLayout;
		const termRows = tui.terminal?.rows ?? 24;
		return Math.max(1, termRows - editor.getRenderedBoxHeight() - 1);
	}
	return Math.max(1, (tui.terminal?.rows ?? 24) - 4);
}

function fuzzyMatchModel(query: string, model: Model<Api>): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const haystack = `${model.name ?? ""} ${model.id} ${model.provider}`.toLowerCase();
	if (haystack.includes(q)) return true;
	let qi = 0;
	for (let i = 0; i < haystack.length && qi < q.length; i += 1) {
		if (haystack[i] === q[qi]) qi += 1;
	}
	return qi === q.length;
}

function installOutsideClickDismissHook(): void {
	const altProto = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
	if (!altProto) return;

	hookMethod(altProto, "handleMouseEvent", "composerPopover.outsideReleaseDismiss", (self, args, original) => {
		const raw = args[0] as { button: number; release: boolean } | undefined;
		const slot = getPopoverSlot();
		const isButtonRelease = Boolean(raw && raw.release && (raw.button & 32) === 0);
		if (!isButtonRelease || !slot.active) {
			return original.apply(self, args);
		}
		slot.clickedInside = false;
		const res = original.apply(self, args);
		if (!slot.clickedInside && slot.active) {
			slot.active.close();
			self.requestRender?.();
		}
		return res;
	});
}

function listAvailableModels(ctx: ExtensionContext): Model<Api>[] {
	const avail = ctx.modelRegistry.getAvailable?.() ?? [];
	if (avail.length > 0) return [...avail];
	const all = ctx.modelRegistry.getAll?.() ?? [];
	if (all.length > 0) return [...all];
	return ctx.model ? [ctx.model] : [];
}

function listAvailableThinkingLevels(ctx: ExtensionContext): ThinkingLevel[] {
	if (ctx.model && ctx.model.reasoning === false) {
		return ["off"];
	}
	return [...STANDARD_THINKING_LEVELS];
}

export function openComposerPopover(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialKind: ComposerPopoverKind,
	options?: { readonly initialSearch?: string },
): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const slot = getPopoverSlot();
	if (slot.active) {
		if (slot.active.kind === initialKind) {
			slot.active.close();
			return;
		}
		slot.active.switchKind(initialKind, options?.initialSearch);
		return;
	}

	const tui = getActiveHostRuntime()?.tui ?? getActiveComposerEditor()?.getTui();
	if (!tui) return;
	if (hasBlockingModalOverlay(tui)) return;

	installOutsideClickDismissHook();

	let kind: ComposerPopoverKind = initialKind;
	const searchInput = createSingleLineInput(options?.initialSearch ?? "");
	const pasteTracker = createBracketedPasteTracker();
	let selectedIdx = 0;
	let scrollOffset = 0;
	let hoveredIdx: number | null = null;
	let rowToItemIdx = new Map<number, number>();
	const hoverOwner = {};
	let closed = false;
	let handle: OverlayHandle | undefined;

	const getModels = (): Model<Api>[] => {
		const all = listAvailableModels(ctx);
		const q = searchInput.getValue();
		return all.filter((m) => fuzzyMatchModel(q, m));
	};

	const syncSelectionForKind = (): void => {
		hoveredIdx = null;
		scrollOffset = 0;
		if (kind === "model") {
			const models = getModels();
			const activeIdx = models.findIndex(
				(m) => ctx.model && m.id === ctx.model.id && m.provider === ctx.model.provider,
			);
			selectedIdx = activeIdx >= 0 ? activeIdx : 0;
			if (selectedIdx >= MAX_MODEL_ROWS) {
				scrollOffset = selectedIdx - MAX_MODEL_ROWS + 1;
			}
		} else if (kind === "thinking") {
			const levels = listAvailableThinkingLevels(ctx);
			const current = pi.getThinkingLevel();
			const activeIdx = levels.indexOf(current);
			selectedIdx = activeIdx >= 0 ? activeIdx : 0;
		} else {
			const current = getSessionWorkflow().mode;
			const activeIdx = POPOVER_MODE_ORDER.indexOf(current);
			selectedIdx = activeIdx >= 0 ? activeIdx : 0;
		}
	};

	const computePopoverBox = (): { width: number; height: number; col: number; row: number } => {
		const termCols = Math.max(24, tui.terminal?.columns ?? 80);
		const termRows = Math.max(8, tui.terminal?.rows ?? 24);
		const outerPad = computeOuterCanvasMargin(termCols);
		const composerTop = resolveComposerAnchorRow(tui);

		let width: number;
		let bodyHeight: number;
		if (kind === "model") {
			width = Math.max(30, Math.min(60, termCols - outerPad * 2 - 2));
			const count = Math.max(1, Math.min(MAX_MODEL_ROWS, getModels().length));
			/* Поле поиска + разделитель + строки моделей + подсказка */
			bodyHeight = 2 + count + 1;
		} else if (kind === "thinking") {
			width = Math.max(28, Math.min(38, termCols - outerPad * 2 - 2));
			const levels = listAvailableThinkingLevels(ctx);
			bodyHeight = levels.length + (ctx.model?.reasoning === false ? 1 : 0) + 1;
		} else {
			width = Math.max(34, Math.min(58, termCols - outerPad * 2 - 2));
			bodyHeight = POPOVER_MODE_ORDER.length + 1;
		}

		const height = Math.max(4, Math.min(bodyHeight + 2, Math.max(4, termRows - 2)));
		const row = Math.max(0, Math.min(composerTop - height, termRows - height));
		const col = Math.max(outerPad, termCols - outerPad - width);
		return { width, height, col, row };
	};

	const overlayOptions: OverlayOptions = {
		nonCapturing: false,
		width: 48,
		col: 2,
		row: 1,
		visible: () => !closed,
	};

	const updateOverlayGeometry = (): void => {
		const box = computePopoverBox();
		overlayOptions.width = box.width;
		overlayOptions.col = box.col;
		overlayOptions.row = box.row;
	};

	const close = (): void => {
		if (closed) return;
		closed = true;
		if (slot.active?.handle === handle) {
			slot.active = undefined;
		}
		try {
			handle?.hide();
		} catch {
			/* Уже скрыт хостом */
		}
		const editor = getActiveComposerEditor();
		if (editor) {
			tui.setFocus(editor);
		}
		tui.requestRender();
	};

	const switchKind = (next: ComposerPopoverKind, initialSearch?: string): void => {
		kind = next;
		if (next === "model") {
			searchInput.setValue(initialSearch ?? "");
		}
		syncSelectionForKind();
		updateOverlayGeometry();
		tui.requestRender();
	};

	const stepKind = (delta: 1 | -1): void => {
		const idx = COMPOSER_POPOVER_ORDER.indexOf(kind);
		const next =
			COMPOSER_POPOVER_ORDER[
				(idx + delta + COMPOSER_POPOVER_ORDER.length) % COMPOSER_POPOVER_ORDER.length
			]!;
		switchKind(next);
	};

	const applySelection = (index: number): void => {
		if (kind === "model") {
			const models = getModels();
			const picked = models[index];
			if (!picked) return;
			close();
			void pi.setModel(picked).then(() => tui.requestRender());
			return;
		}
		if (kind === "thinking") {
			const levels = listAvailableThinkingLevels(ctx);
			const picked = levels[index];
			if (!picked) return;
			pi.setThinkingLevel(picked);
			close();
			return;
		}
		const picked = POPOVER_MODE_ORDER[index];
		if (!picked) return;
		setSessionMode(pi, ctx, picked);
		close();
	};

	syncSelectionForKind();
	updateOverlayGeometry();

	const comp: Component & Focusable = {
		focused: true,
		capturesViewportInput: true,
		invalidate() {},
		render(width: number): string[] {
			rowToItemIdx = new Map();
			const theme: Theme = ctx.ui.theme;
			const palette = getThemeSurfacePalette(theme);
			const safeWidth = Math.max(20, width);
			const innerWidth = Math.max(12, safeWidth - 4);
			const fgRgb = (rgb: Parameters<typeof themeFgRgb>[1], text: string) => themeFgRgb(theme, rgb, text);
			const bgRgb = (rgb: Parameters<typeof blueBgRgb>[1], text: string) => blueBgRgb(theme, rgb, text);
			const b = (s: string) => fgRgb(palette.border, s);

			const titleText =
				kind === "model"
					? t("composer.popover.modelTitle")
					: kind === "thinking"
						? t("composer.popover.thinkingTitle")
						: t("composer.popover.modeTitle");
			const tabBadge = theme.fg("dim", "Tab ⇄");
			const leftTitle = ` ${fgRgb(palette.accentBright, theme.bold(titleText))} `;
			const rightTitle = ` ${tabBadge} `;
			const fill = Math.max(1, safeWidth - 3 - visibleWidth(leftTitle) - visibleWidth(rightTitle));
			const topRow = `${b("╭─")}${leftTitle}${b("─".repeat(fill))}${rightTitle}${b("╮")}`;

			const body: string[] = [];

			if (kind === "model") {
				const searchIcon = fgRgb(palette.accent, "⌕ ");
				const renderedSearch = searchInput.render({
					theme,
					focused: comp.focused,
					maxWidth: Math.max(6, innerWidth - 2),
					placeholder: t("composer.popover.modelSearch"),
				});
				body.push(`${searchIcon}${renderedSearch}`);
				body.push(theme.fg("borderMuted", "─".repeat(innerWidth)));

				const models = getModels();
				if (models.length === 0) {
					body.push(theme.fg("muted", t("composer.popover.modelEmpty")));
				} else {
					selectedIdx = Math.max(0, Math.min(models.length - 1, selectedIdx));
					if (selectedIdx < scrollOffset) scrollOffset = selectedIdx;
					if (selectedIdx >= scrollOffset + MAX_MODEL_ROWS) {
						scrollOffset = selectedIdx - MAX_MODEL_ROWS + 1;
					}
					const maxScroll = Math.max(0, models.length - MAX_MODEL_ROWS);
					scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
					const visible = models.slice(scrollOffset, scrollOffset + MAX_MODEL_ROWS);
					for (let i = 0; i < visible.length; i += 1) {
						const absIdx = scrollOffset + i;
						const model = visible[i]!;
						const isActive = Boolean(
							ctx.model && model.id === ctx.model.id && model.provider === ctx.model.provider,
						);
						const isSel = absIdx === selectedIdx;
						const isHov = absIdx === hoveredIdx;
						const mark = isActive ? fgRgb(palette.success, "✓ ") : "  ";
						const prov = theme.fg("dim", ` ${model.provider}`);
						const nameAvail = Math.max(4, innerWidth - 2 - visibleWidth(prov));
						const nameLabel = truncateToWidth(model.name || model.id, nameAvail, "…");
						const styledName = isSel
							? fgRgb(palette.accentBright, theme.bold(nameLabel))
							: theme.fg("text", nameLabel);
						const gap = " ".repeat(
							Math.max(0, innerWidth - 2 - visibleWidth(nameLabel) - visibleWidth(prov)),
						);
						let row = `${mark}${styledName}${gap}${prov}`;
						if (isSel) row = bgRgb(palette.selectedRowBg, row);
						else if (isHov) row = bgRgb(palette.hoveredRowBg, row);
						rowToItemIdx.set(1 + body.length, absIdx);
						body.push(row);
					}
				}
			} else if (kind === "thinking") {
				const levels = listAvailableThinkingLevels(ctx);
				const current = pi.getThinkingLevel();
				selectedIdx = Math.max(0, Math.min(levels.length - 1, selectedIdx));
				if (ctx.model?.reasoning === false) {
					body.push(theme.fg("muted", t("composer.popover.thinkingUnsupported")));
				}
				for (let i = 0; i < levels.length; i += 1) {
					const level = levels[i]!;
					const isActive = level === current;
					const isSel = i === selectedIdx;
					const isHov = i === hoveredIdx;
					const mark = isActive ? fgRgb(palette.success, "✓ ") : "  ";
					const label = isSel
						? fgRgb(palette.accentBright, theme.bold(level))
						: theme.fg("text", level);
					const pad = " ".repeat(Math.max(0, innerWidth - 2 - visibleWidth(level)));
					let row = `${mark}${label}${pad}`;
					if (isSel) row = bgRgb(palette.selectedRowBg, row);
					else if (isHov) row = bgRgb(palette.hoveredRowBg, row);
					rowToItemIdx.set(1 + body.length, i);
					body.push(row);
				}
			} else {
				const current = getSessionWorkflow().mode;
				selectedIdx = Math.max(0, Math.min(POPOVER_MODE_ORDER.length - 1, selectedIdx));
				for (let i = 0; i < POPOVER_MODE_ORDER.length; i += 1) {
					const mode = POPOVER_MODE_ORDER[i]!;
					const meta = MODE_META[mode];
					const isActive = mode === current;
					const isSel = i === selectedIdx;
					const isHov = i === hoveredIdx;
					const mark = isActive ? fgRgb(palette.success, "✓ ") : "  ";
					const labelText = meta.label;
					const styledLabel = isSel
						? fgRgb(palette.accentBright, theme.bold(labelText))
						: fgRgb(meta.rgb, labelText);
					const descAvail = Math.max(0, innerWidth - 4 - visibleWidth(labelText));
					const desc = descAvail >= 8 ? `  ${theme.fg("dim", truncateToWidth(meta.desc, descAvail, "…"))}` : "";
					const content = `${mark}${styledLabel}${desc}`;
					const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
					let row = `${content}${pad}`;
					if (isSel) row = bgRgb(palette.selectedRowBg, row);
					else if (isHov) row = bgRgb(palette.hoveredRowBg, row);
					rowToItemIdx.set(1 + body.length, i);
					body.push(row);
				}
			}

			body.push(theme.fg("dim", truncateToWidth(t("composer.popover.navHint"), innerWidth, "…")));

			const out: string[] = [topRow];
			for (const line of body) {
				const clipped = truncateToWidth(line, innerWidth, "…");
				const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
				out.push(`${b("│")} ${clipped}${pad} ${b("│")}`);
			}
			out.push(`${b("╰")}${b("─".repeat(Math.max(0, safeWidth - 2)))}${b("╯")}`);
			return out.map((row) => paintThemeSurfaceRow(theme, row, safeWidth, palette.popupSurfaceBg, true));
		},
		handleInput(data: string): void {
			if (!data) return;
			if (pasteTracker.split(data).some((segment) => segment.inPaste || (data !== "\x1b" && segment.trailingStartPrefixLength > 0))) {
				if (kind === "model" && searchInput.handleInput(data).changed) {
					selectedIdx = 0;
					scrollOffset = 0;
					tui.requestRender();
				}
				return;
			}
			if (isKeyRelease(data)) return;

			if (matchesKey(data, "escape") || data === "\x1b") {
				close();
				return;
			}
			if (matchesLayoutChord(data, "ctrl+l")) {
				if (kind === "model") close();
				else switchKind("model");
				return;
			}
			if (matchesLayoutChord(data, "alt+t")) {
				if (kind === "thinking") close();
				else switchKind("thinking");
				return;
			}
			if (matchesLayoutChord(data, "alt+m")) {
				if (kind === "mode") close();
				else switchKind("mode");
				return;
			}
			if (matchesKey(data, "tab")) {
				stepKind(1);
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				stepKind(-1);
				return;
			}
			if (matchesKey(data, "right")) {
				if (kind !== "model" || searchInput.getValue().length === 0 || searchInput.isCursorAtEnd()) {
					stepKind(1);
					return;
				}
			}
			if (matchesKey(data, "left")) {
				if (kind !== "model" || searchInput.getValue().length === 0 || searchInput.isCursorAtStart()) {
					stepKind(-1);
					return;
				}
			}

			const count =
				kind === "model"
					? getModels().length
					: kind === "thinking"
						? listAvailableThinkingLevels(ctx).length
						: POPOVER_MODE_ORDER.length;

			if (matchesKey(data, "up")) {
				if (count > 0) {
					selectedIdx = (selectedIdx - 1 + count) % count;
					tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, "down")) {
				if (count > 0) {
					selectedIdx = (selectedIdx + 1) % count;
					tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				applySelection(selectedIdx);
				return;
			}

			if (kind === "model") {
				const res = searchInput.handleInput(data);
				if (res.handled) {
					if (res.changed) {
						selectedIdx = 0;
						scrollOffset = 0;
						updateOverlayGeometry();
					}
					tui.requestRender();
				}
			}
		},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			slot.clickedInside = true;
			const count =
				kind === "model"
					? getModels().length
					: kind === "thinking"
						? listAvailableThinkingLevels(ctx).length
						: POPOVER_MODE_ORDER.length;

			if (event.type === "wheel" && event.wheelDelta) {
				if (count > 0) {
					const delta = event.wheelDelta < 0 ? -1 : 1;
					selectedIdx = Math.max(0, Math.min(count - 1, selectedIdx + delta));
					return { handled: true, render: true };
				}
				return { handled: true, render: false };
			}
			if (event.type === "move") {
				const nextHover = rowToItemIdx.get(event.y) ?? null;
				if (nextHover !== null) {
					claimHover(hoverOwner, () => {
						hoveredIdx = null;
					});
				}
				if (nextHover !== hoveredIdx) {
					hoveredIdx = nextHover;
					return { handled: true, render: true };
				}
				return { handled: true, render: false };
			}
			if (event.type === "press" && event.button === "left") {
				return { handled: true, render: false };
			}
			if (event.type === "click" && event.button === "left") {
				const hitIdx = rowToItemIdx.get(event.y);
				if (hitIdx !== undefined) {
					applySelection(hitIdx);
					return { handled: true, render: true };
				}
				return { handled: true, render: false };
			}
			return { handled: true, render: false };
		},
	};

	handle = tui.showOverlay(comp, overlayOptions);
	slot.active = {
		kind,
		handle,
		tui,
		switchKind,
		close,
	};
	tui.requestRender();
}
