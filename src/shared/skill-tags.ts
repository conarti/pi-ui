import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";
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
	mixRgb,
	paintThemeSurfaceRow,
	themeBgRgb,
	themeFgRgb,
} from "./ansi.ts";
import {
	getActiveHostRuntime,
	registerTransientHoverDismisser,
	unwrapHostTui,
} from "./host-runtime.ts";
import { hasBlockingModalOverlay } from "./modal-card.ts";
import { hookMethod } from "./runtime-hooks.ts";

export interface ParsedSkillInvocation {
	readonly id: string;
	readonly name: string;
	readonly location?: string;
	readonly shortLocation?: string;
	readonly body: string;
	readonly lineCount: number;
}

export interface ExtractedSkillPrompt {
	readonly skills: readonly ParsedSkillInvocation[];
	readonly userText: string;
	readonly cleanCopyText: string;
	readonly previewText: string;
}

export interface ExtractSkillOptions {
	readonly cwd?: string;
}

const SKILL_TAG_RE = /<skill\s+([^>]+)>([\s\S]*?)<\/skill>/gi;
const ATTR_RE = /\b(name|location)="([^"]*)"/gi;

export function shortenSkillPath(filePath: string | undefined, cwd = process.cwd()): string | undefined {
	if (!filePath) return undefined;
	const trimmed = filePath.trim();
	if (!trimmed) return undefined;
	try {
		const rel = relative(cwd, trimmed).replaceAll("\\", "/");
		if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
			return rel;
		}
	} catch {
		/* Игнорируем пути на разных корнях файловой системы */
	}
	const home = homedir();
	if (home && trimmed.startsWith(home)) {
		return `~${trimmed.slice(home.length)}`;
	}
	return trimmed;
}

function cleanSkillBody(rawBody: string): string {
	return rawBody
		.replace(/^\s*References are relative to [^\n]+\n+/i, "")
		.trim();
}

export function serializeSkillBlockTag(skillBlock: {
	readonly name?: string;
	readonly location?: string;
	readonly content?: string;
}): string {
	const name = String(skillBlock.name ?? "").trim();
	const location = String(skillBlock.location ?? "").trim();
	const content = String(skillBlock.content ?? "");
	const locAttr = location ? ` location="${location}"` : "";
	return `<skill name="${name}"${locAttr}>\n${content}\n</skill>`;
}

export function extractSkillInvocations(
	rawText: string,
	options?: ExtractSkillOptions,
): ExtractedSkillPrompt {
	if (!rawText.includes("<skill")) {
		const trimmed = rawText.trim();
		return {
			skills: [],
			userText: rawText,
			cleanCopyText: trimmed,
			previewText: trimmed,
		};
	}

	const cwd = options?.cwd ?? process.cwd();
	const skills: ParsedSkillInvocation[] = [];
	let index = 0;

	const stripped = rawText.replace(SKILL_TAG_RE, (full, attrText: string, rawBody: string) => {
		let rawName = "";
		let rawLoc = "";
		ATTR_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = ATTR_RE.exec(attrText)) !== null) {
			const key = match[1]?.toLowerCase();
			if (key === "name") rawName = match[2] ?? "";
			else if (key === "location") rawLoc = match[2] ?? "";
		}
		const name = rawName.trim();
		if (!name) return full;

		const body = cleanSkillBody(rawBody ?? "");
		const lines = body ? body.split(/\r?\n/) : [];
		skills.push({
			id: `skill:${index}:${name}`,
			name,
			location: rawLoc.trim() || undefined,
			shortLocation: shortenSkillPath(rawLoc, cwd),
			body,
			lineCount: lines.length,
		});
		index += 1;
		return "";
	});

	if (skills.length === 0) {
		const trimmed = rawText.trim();
		return {
			skills: [],
			userText: rawText,
			cleanCopyText: trimmed,
			previewText: trimmed,
		};
	}

	const userText = stripped
		.replace(/^\s*\n+/, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	const slashTokens = skills.map((s) => `/skill:${s.name}`).join(" ");
	const shortTokens = skills.map((s) => `/${s.name}`).join(" ");
	const cleanCopyText = userText ? `${slashTokens} ${userText}` : slashTokens;
	const previewText = userText ? `${shortTokens} · ${userText}` : shortTokens;

	return {
		skills,
		userText,
		cleanCopyText,
		previewText,
	};
}

export function renderStyledSkillChip(
	skillName: string,
	theme: Theme,
	options?: { active?: boolean },
): { styled: string; plainLabel: string } {
	const palette = getThemeSurfacePalette(theme);
	const light = palette.isLight;
	const plainLabel = `/${skillName}`;
	const bg = options?.active
		? mixRgb(palette.userCardBg, palette.accent, light ? 0.24 : 0.3)
		: mixRgb(palette.userCardBg, palette.accent, light ? 0.14 : 0.2);
	const fg = light
		? mixRgb([15, 23, 42], palette.accent, 0.72)
		: mixRgb([224, 236, 252], palette.accentBright, 0.45);

	return {
		plainLabel,
		styled: themeBgRgb(theme, bg, themeFgRgb(theme, fg, ` ${plainLabel} `)),
	};
}

function resolveSkillBodyText(skill: ParsedSkillInvocation): string {
	if (skill.body.trim().length > 0) return skill.body;
	if (skill.location && existsSync(skill.location)) {
		try {
			return readFileSync(skill.location, "utf8").trim();
		} catch {
			/* Если файл недоступен для чтения, показываем только путь */
		}
	}
	return "";
}

class SkillPreviewPopup implements Component {
	skill: ParsedSkillInvocation | undefined;
	scrollOffset = 0;
	onDismiss?: () => void;
	private maxScroll = 0;
	private closeHit: { xStart: number; xEnd: number } | undefined;

	constructor(private readonly getTheme: () => Theme) {}

	invalidate(): void {}

	private buildWrappedRows(textWidth: number, maxBodyRows: number): {
		rows: Array<{ text: string; muted?: boolean }>;
		maxScroll: number;
	} {
		const skill = this.skill;
		if (!skill) return { rows: [], maxScroll: 0 };

		const headerRows: Array<{ text: string; muted?: boolean }> = [];
		const displayPath = skill.shortLocation ?? skill.location;
		if (displayPath) {
			headerRows.push({ text: displayPath, muted: true });
			headerRows.push({ text: "", muted: true });
		}

		const resolvedBody = resolveSkillBodyText(skill);
		const bodyWrapped: Array<{ text: string; muted?: boolean }> = [];
		if (resolvedBody) {
			for (const rawLine of resolvedBody.replace(/\t/g, "  ").split(/\r?\n/)) {
				if (!rawLine) {
					bodyWrapped.push({ text: "" });
					continue;
				}
				const chunks = wrapTextWithAnsi(rawLine, Math.max(8, textWidth));
				for (const chunk of chunks.length > 0 ? chunks : [""]) {
					bodyWrapped.push({ text: chunk });
				}
			}
		} else {
			bodyWrapped.push({ text: "(Empty SKILL.md)", muted: true });
		}

		const allRows = [...headerRows, ...bodyWrapped];
		if (allRows.length <= maxBodyRows) {
			this.scrollOffset = 0;
			return { rows: allRows, maxScroll: 0 };
		}

		const contentBudget = Math.max(1, maxBodyRows - 1);
		const maxScroll = Math.max(0, allRows.length - contentBudget);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visibleSlice = allRows.slice(this.scrollOffset, this.scrollOffset + contentBudget);
		const remainingBelow = Math.max(0, allRows.length - (this.scrollOffset + visibleSlice.length));
		const statusParts: string[] = [];
		if (this.scrollOffset > 0) statusParts.push(`↑ ${this.scrollOffset}`);
		if (remainingBelow > 0) {
			statusParts.push(`+${remainingBelow} more ${remainingBelow === 1 ? "line" : "lines"}`);
		}
		statusParts.push("Scroll · Esc close");

		return {
			rows: [...visibleSlice, { text: statusParts.join(" · "), muted: true }],
			maxScroll,
		};
	}

	computeDimensions(termCols: number, termRows: number): { width: number; height: number } {
		const maxWidth = Math.max(24, Math.min(76, termCols - 6));
		const maxBodyRows = Math.max(5, Math.min(14, termRows - 8));
		const { rows } = this.buildWrappedRows(Math.max(12, maxWidth - 4), maxBodyRows);
		const contentW = Math.max(
			visibleWidth(` ✦ /${this.skill?.name ?? "skill"} [×] `),
			...rows.map((r) => visibleWidth(r.text)),
		);
		const width = Math.max(24, Math.min(maxWidth, contentW + 4));
		const finalRows = this.buildWrappedRows(Math.max(12, width - 4), maxBodyRows).rows;
		return { width, height: finalRows.length + 2 };
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			/* overscroll = "contain": колесо внутри попапа прокручивает SKILL.md, не закрывая его и не двигая ленту */
			const next = Math.max(0, Math.min(this.maxScroll, this.scrollOffset + event.wheelDelta));
			const changed = next !== this.scrollOffset;
			this.scrollOffset = next;
			return { handled: true, render: changed };
		}
		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			const hitClose =
				event.y === 0 &&
				this.closeHit !== undefined &&
				event.x >= this.closeHit.xStart &&
				event.x <= this.closeHit.xEnd;
			if (hitClose) {
				this.onDismiss?.();
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}
		return undefined;
	}

	render(width: number): string[] {
		if (!this.skill) return [];
		const theme = this.getTheme();
		const palette = getThemeSurfacePalette(theme);
		const safeWidth = Math.max(18, width);
		const innerSpan = Math.max(2, safeWidth - 2);
		const textWidth = Math.max(1, safeWidth - 4);
		const termRows = getActiveHostRuntime()?.tui?.terminal?.rows ?? 30;
		const maxBodyRows = Math.max(5, Math.min(14, termRows - 8));

		const { rows, maxScroll } = this.buildWrappedRows(textWidth, maxBodyRows);
		this.maxScroll = maxScroll;

		const b = (s: string) => themeFgRgb(theme, palette.borderSubtle, s);
		const closeLabel = " [×] ";
		const closeWidth = visibleWidth(closeLabel);
		const titleBudget = Math.max(4, innerSpan - 1 - closeWidth);
		const titleText = truncateToWidth(` ✦ /${this.skill.name} `, titleBudget, "…");
		const dashCount = Math.max(0, innerSpan - 1 - visibleWidth(titleText) - closeWidth);
		const closeCol = 2 + visibleWidth(titleText) + dashCount;
		this.closeHit = { xStart: Math.max(0, closeCol - 1), xEnd: Math.min(safeWidth - 1, closeCol + closeWidth) };

		const out: string[] = [
			paintThemeSurfaceRow(
				theme,
				`${b("╭─")}${themeFgRgb(theme, palette.accentBright, titleText)}${b("─".repeat(dashCount))}${themeFgRgb(theme, palette.codeMetaFg, closeLabel)}${b("╮")}`,
				safeWidth,
				palette.popupHeaderBg,
			),
		];

		for (const row of rows) {
			const clipped = truncateToWidth(row.text, textWidth, "…");
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(clipped)));
			const styled = row.muted
				? themeFgRgb(theme, palette.codeMetaFg, `${clipped}${pad}`)
				: theme.fg("text", `${clipped}${pad}`);
			out.push(
				paintThemeSurfaceRow(
					theme,
					`${b("│")} ${styled} ${b("│")}`,
					safeWidth,
					palette.popupSurfaceBg,
				),
			);
		}

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

const SKILL_POPUP_SLOT_KEY = Symbol.for("conarti.pi-ui.skill-preview-popup.v1");

interface SkillPopupState {
	popup?: SkillPreviewPopup;
	handle?: OverlayHandle;
	options?: OverlayOptions;
	visible: boolean;
	activeKey?: string;
	activeTui?: TUI;
	activeRenderer?: object;
	hooksInstalled: boolean;
	clickedInsideCurrentRelease: boolean;
}

function getSkillPopupState(): SkillPopupState {
	const g = globalThis as Record<symbol, SkillPopupState | undefined>;
	if (!g[SKILL_POPUP_SLOT_KEY]) {
		const state: SkillPopupState = {
			visible: false,
			hooksInstalled: false,
			clickedInsideCurrentRelease: false,
		};
		g[SKILL_POPUP_SLOT_KEY] = state;
		registerTransientHoverDismisser("skillChips.preview", () => hideSkillPreviewPopup());
	}
	return g[SKILL_POPUP_SLOT_KEY]!;
}

export function isSkillPreviewPopupVisible(): boolean {
	const state = getSkillPopupState();
	return state.visible && Boolean(state.handle);
}

export function hideSkillPreviewPopup(): void {
	const state = getSkillPopupState();
	if (!state.visible && !state.handle) return;
	state.visible = false;
	state.activeKey = undefined;
	state.activeRenderer = undefined;
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

function ensureSkillPopupDismissHooks(): void {
	const state = getSkillPopupState();
	if (state.hooksInstalled) return;
	state.hooksInstalled = true;

	const scrollProto = (ScrollView as unknown as { prototype?: object } | undefined)?.prototype;
	if (scrollProto) {
		for (const methodName of ["scrollTo", "scrollBy", "scrollToStart", "scrollToEnd"] as const) {
			hookMethod(
				scrollProto,
				methodName,
				`skillChips.scrollDismiss.${methodName}`,
				(self, args, original) => {
					const prevTop = self.scrollTop;
					const result = original.apply(self, args);
					if (state.visible && self.scrollTop !== prevTop && self === getActiveHostRuntime()?.scroll) {
						hideSkillPreviewPopup();
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
			"skillChips.outsideReleaseDismiss",
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
					hideSkillPreviewPopup();
					self.requestRender?.();
				}
				return res;
			},
		);
	}
}

export function toggleSkillPreviewPopup(
	skill: ParsedSkillInvocation,
	screenX: number,
	screenY: number,
): void {
	const runtime = getActiveHostRuntime();
	const tui = runtime?.tui;
	if (!tui || hasBlockingModalOverlay(tui)) {
		hideSkillPreviewPopup();
		return;
	}

	ensureSkillPopupDismissHooks();
	const state = getSkillPopupState();
	state.clickedInsideCurrentRelease = true;

	const key = `${skill.id}:${skill.location ?? ""}`;
	if (state.visible && state.activeKey === key) {
		hideSkillPreviewPopup();
		tui.requestRender();
		return;
	}

	const renderer = unwrapHostTui(tui);
	if (state.activeRenderer && state.activeRenderer !== renderer) {
		hideSkillPreviewPopup();
	}
	state.activeTui = tui;
	state.activeRenderer = renderer;

	if (!state.popup) {
		state.popup = new SkillPreviewPopup(() => getActiveGlobalTheme(getActiveHostRuntime()?.theme()));
		state.popup.onDismiss = () => {
			hideSkillPreviewPopup();
			getActiveHostRuntime()?.requestRender();
		};
	}

	state.popup.skill = skill;
	state.popup.scrollOffset = 0;

	const termCols = Math.max(24, tui.terminal?.columns ?? 80);
	const termRows = Math.max(8, tui.terminal?.rows ?? 30);
	const { width, height } = state.popup.computeDimensions(termCols, termRows);

	const col = Math.max(2, Math.min(screenX - 4, Math.max(2, termCols - width - 2)));
	const belowRow = screenY + 2;
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
