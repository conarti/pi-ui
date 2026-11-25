import { homedir } from "node:os";
import { relative } from "node:path";
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
	mixRgb,
	paintThemeSurfaceRow,
	themeBgRgb,
	themeFgRgb,
} from "./ansi.ts";
import {
	getActiveHostRuntime,
	installViewportScrollDismissHooks,
	registerTransientHoverDismisser,
	unwrapHostTui,
} from "./host-runtime.ts";
import { hasBlockingModalOverlay } from "./modal-card.ts";

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

const SKILL_TAG_RE = /<skill\s+name="([^"]+)"(?:\s+location="([^"]*)")?\s*>([\s\S]*?)<\/skill>/gi;

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
		/* Ignore cross-root path errors */
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

export function extractSkillInvocations(rawText: string): ExtractedSkillPrompt {
	if (!rawText.includes("<skill")) {
		return {
			skills: [],
			userText: rawText,
			cleanCopyText: rawText.trim(),
			previewText: rawText.trim(),
		};
	}

	const skills: ParsedSkillInvocation[] = [];
	let index = 0;
	const stripped = rawText.replace(
		SKILL_TAG_RE,
		(_full, rawName: string, rawLoc: string | undefined, rawBody: string) => {
			const name = rawName.trim();
			const body = cleanSkillBody(rawBody ?? "");
			const lines = body ? body.split(/\r?\n/) : [];
			skills.push({
				id: `skill:${index}:${name}`,
				name,
				location: rawLoc?.trim() || undefined,
				shortLocation: shortenSkillPath(rawLoc),
				body,
				lineCount: lines.length,
			});
			index += 1;
			return "";
		},
	);

	if (skills.length === 0) {
		return {
			skills: [],
			userText: rawText,
			cleanCopyText: rawText.trim(),
			previewText: rawText.trim(),
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
	_variant: "A" | "B" | "C" | "off",
	theme: Theme,
	options?: { active?: boolean },
): { styled: string; plainLabel: string } {
	const palette = getThemeSurfacePalette(theme);
	const light = palette.isLight;
	const plainLabel = `/${skillName}`;
	const bg = options?.active
		? mixRgb(palette.userCardBg, palette.accent, light ? 0.24 : 0.3)
		: mixRgb(palette.userCardBg, palette.accent, light ? 0.12 : 0.18);
	const fg = light
		? mixRgb([15, 23, 42], palette.accent, 0.72)
		: mixRgb([224, 236, 252], palette.accentBright, 0.45);

	return {
		plainLabel,
		styled: themeBgRgb(theme, bg, themeFgRgb(theme, fg, ` ${plainLabel} `)),
	};
}

class SkillPreviewPopup implements Component {
	skill: ParsedSkillInvocation | undefined;
	scrollOffset = 0;
	onDismiss?: () => void;

	constructor(private readonly getTheme: () => Theme) {}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const evType = String(event.type);
		if (evType === "wheel" || evType === "mouse_wheel_up" || evType === "mouse_wheel_down") {
			const step =
				evType === "mouse_wheel_up"
					? -3
					: evType === "mouse_wheel_down"
						? 3
						: ((event as unknown as { deltaY?: number }).deltaY ?? 0) < 0
							? -3
							: 3;
			this.scrollOffset = Math.max(0, this.scrollOffset + step);
			return { handled: true, render: true };
		}
		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			this.onDismiss?.();
			return { handled: true, render: true };
		}
		return undefined;
	}

	private buildRows(innerTextW: number, maxBodyRows: number): Array<{ text: string; muted?: boolean }> {
		const skill = this.skill;
		if (!skill) return [];
		const out: Array<{ text: string; muted?: boolean }> = [];
		if (skill.shortLocation) {
			out.push({
				text: `${skill.shortLocation} · ${skill.lineCount} lines`,
				muted: true,
			});
		}
		const wrapped: string[] = [];
		const rawLines = (skill.body || "Skill instructions attached to this prompt.")
			.replace(/\t/g, "  ")
			.split(/\r?\n/);
		for (const ln of rawLines) {
			if (!ln.trim()) {
				if (wrapped.length > 0 && wrapped[wrapped.length - 1] !== " ") {
					wrapped.push(" ");
				}
				continue;
			}
			for (const chunk of wrapTextWithAnsi(ln, Math.max(12, innerTextW))) {
				wrapped.push(chunk || " ");
			}
		}

		const maxScroll = Math.max(0, wrapped.length - maxBodyRows);
		const start = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const slice = wrapped.slice(start, start + maxBodyRows);
		for (const line of slice) {
			out.push({ text: line });
		}
		const below = Math.max(0, wrapped.length - (start + slice.length));
		if (start > 0 || below > 0) {
			out.push({
				text: `↑ ${start} · ↓ ${below} lines (wheel to scroll · click to close)`,
				muted: true,
			});
		}
		return out;
	}

	computeDimensions(termCols: number, termRows: number): { width: number; height: number } {
		const width = Math.max(28, Math.min(76, termCols - 6));
		const maxBodyRows = Math.max(6, Math.min(14, termRows - 10));
		const rows = this.buildRows(Math.max(12, width - 4), maxBodyRows);
		return { width, height: rows.length + 2 };
	}

	render(width: number): string[] {
		if (!this.skill) return [];
		const theme = this.getTheme();
		const palette = getThemeSurfacePalette(theme);
		const safeWidth = Math.max(16, width);
		const innerSpan = Math.max(2, safeWidth - 2);
		const textWidth = Math.max(1, safeWidth - 4);
		const termRows = getActiveHostRuntime()?.tui?.terminal?.rows ?? 30;
		const maxBodyRows = Math.max(6, Math.min(14, termRows - 10));
		const rows = this.buildRows(textWidth, maxBodyRows);

		const b = (s: string) => themeFgRgb(theme, palette.borderSubtle, s);
		const titleText = truncateToWidth(` ✦ Skill /${this.skill.name} `, Math.max(1, innerSpan - 2), "…");
		const rightDashes = Math.max(0, innerSpan - 1 - visibleWidth(titleText));

		const out: string[] = [
			paintThemeSurfaceRow(
				theme,
				`${b("╭─")}${themeFgRgb(theme, palette.accentBright, titleText)}${b("─".repeat(rightDashes))}${b("╮")}`,
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
}

function getSkillPopupState(): SkillPopupState {
	const g = globalThis as Record<symbol, SkillPopupState | undefined>;
	if (!g[SKILL_POPUP_SLOT_KEY]) {
		const state: SkillPopupState = {
			visible: false,
			hooksInstalled: false,
		};
		g[SKILL_POPUP_SLOT_KEY] = state;
		registerTransientHoverDismisser("skillChips.preview", () => hideSkillPreviewPopup());
	}
	return g[SKILL_POPUP_SLOT_KEY]!;
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
			/* Already dismissed by host */
		}
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

	const state = getSkillPopupState();
	if (!state.hooksInstalled) {
		state.hooksInstalled = true;
		installViewportScrollDismissHooks(
			"skillChips.preview",
			() => state.visible,
			() => hideSkillPreviewPopup(),
		);
	}

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
		state.popup = new SkillPreviewPopup(() => getActiveGlobalTheme(runtime?.theme()));
		state.popup.onDismiss = () => {
			hideSkillPreviewPopup();
			tui.requestRender();
		};
	}

	state.popup.skill = skill;
	state.popup.scrollOffset = 0;

	const termCols = Math.max(24, tui.terminal?.columns ?? 80);
	const termRows = Math.max(8, tui.terminal?.rows ?? 30);
	const { width, height } = state.popup.computeDimensions(termCols, termRows);

	const col = Math.max(2, Math.min(screenX - 4, Math.max(2, termCols - width - 2)));
	const aboveRow = screenY - height;
	const belowRow = screenY + 2;
	const row =
		aboveRow >= 1
			? aboveRow
			: belowRow + height <= termRows
				? belowRow
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
