import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";
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
	CLOSE_BUTTON_LABEL,
	getActiveGlobalTheme,
	getThemeSurfacePalette,
	mixRgb,
	paintThemeSurfaceRow,
	renderCloseButton,
	themeBgRgb,
	themeFgRgb,
} from "./ansi.ts";
import { createClickedHoverPopup } from "./clicked-hover-popup.ts";
import { getActiveHostRuntime } from "./host-runtime.ts";
import { t } from "./i18n.ts";
import { claimHover } from "./runtime-hooks.ts";

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

const LEADING_SKILL_TAG_RE = /^\s*<skill\s+([^>]+)>([\s\S]*?)<\/skill>/i;
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
	let remaining = rawText;

	for (let tag = LEADING_SKILL_TAG_RE.exec(remaining); tag; tag = LEADING_SKILL_TAG_RE.exec(remaining)) {
		const [full, attrText = "", rawBody = ""] = tag;
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
		if (!name) break;

		const body = cleanSkillBody(rawBody);
		const lines = body ? body.split(/\r?\n/) : [];
		skills.push({
			id: `skill:${skills.length}:${name}`,
			name,
			location: rawLoc.trim() || undefined,
			shortLocation: shortenSkillPath(rawLoc, cwd),
			body,
			lineCount: lines.length,
		});
		remaining = remaining.slice(full.length);
	}

	if (skills.length === 0) {
		const trimmed = rawText.trim();
		return {
			skills: [],
			userText: rawText,
			cleanCopyText: trimmed,
			previewText: trimmed,
		};
	}

	const userText = remaining.trim();

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
	private closeHovered = false;
	private readonly hoverOwner = {};

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
			bodyWrapped.push({ text: t("transcript.skill.empty"), muted: true });
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
			statusParts.push(t(remainingBelow === 1 ? "transcript.popup.moreLine" : "transcript.popup.moreLines", { count: remainingBelow }));
		}
		statusParts.push(t("transcript.popup.scrollHint"));

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
			visibleWidth(` ✦ /${this.skill?.name ?? "skill"} ${CLOSE_BUTTON_LABEL} `),
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
		const hitClose =
			event.y === 0 &&
			this.closeHit !== undefined &&
			event.x >= this.closeHit.xStart &&
			event.x < this.closeHit.xEnd;
		if (event.type === "move") {
			if (hitClose) {
				claimHover(this.hoverOwner, () => {
					this.closeHovered = false;
				});
			}
			const changed = hitClose !== this.closeHovered;
			this.closeHovered = hitClose;
			return { handled: true, render: changed };
		}
		if (event.type === "press" && event.button === "left") {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
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
		const closeStyled = ` ${renderCloseButton(theme, this.closeHovered)} `;
		const closeWidth = visibleWidth(closeStyled);
		const titleBudget = Math.max(4, innerSpan - 1 - closeWidth);
		const titleText = truncateToWidth(` ✦ /${this.skill.name} `, titleBudget, "…");
		const dashCount = Math.max(0, innerSpan - 1 - visibleWidth(titleText) - closeWidth);
		const closeCol = 2 + visibleWidth(titleText) + dashCount + 1;
		this.closeHit = {
			xStart: Math.max(0, closeCol),
			xEnd: Math.min(safeWidth - 1, closeCol + visibleWidth(CLOSE_BUTTON_LABEL)),
		};

		const out: string[] = [
			paintThemeSurfaceRow(
				theme,
				`${b("╭─")}${themeFgRgb(theme, palette.accentBright, titleText)}${b("─".repeat(dashCount))}${closeStyled}${b("╮")}`,
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

function createSkillPopupController() {
	return createClickedHoverPopup("skillChips.preview", (dismiss) => {
		const popup = new SkillPreviewPopup(() => getActiveGlobalTheme(getActiveHostRuntime()?.theme()));
		popup.onDismiss = dismiss;
		return popup;
	}, { x: 4, y: 2 });
}

function getSkillPopupController() {
	const g = globalThis as Record<symbol, ReturnType<typeof createSkillPopupController> | undefined>;
	return g[SKILL_POPUP_SLOT_KEY] ??= createSkillPopupController();
}

export function isSkillPreviewPopupVisible(): boolean {
	return getSkillPopupController().isVisible();
}

export function hideSkillPreviewPopup(): void {
	getSkillPopupController().hide();
}

export function toggleSkillPreviewPopup(skill: ParsedSkillInvocation, screenX: number, screenY: number): void {
	const key = `${skill.id}:${skill.location ?? ""}`;
	getSkillPopupController().toggle(getActiveHostRuntime()?.tui, key, screenX, screenY, (popup) => {
		popup.skill = skill;
		popup.scrollOffset = 0;
	});
}
