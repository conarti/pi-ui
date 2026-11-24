import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { bgRgb, fgRgb } from "../../shared/ansi.ts";
import {
	createModalCard,
	createSingleLineInput,
	getThemeSurfacePalette,
	openModalCard,
	type ModalActionPill,
} from "../../shared/modal-card.ts";
import { getStore, persistSessionStore } from "../../shared/session-store.ts";
import { approveAndExecutePlan, revisePlanWithComments, setSessionMode, updatePlanWidget } from "./index.ts";

function stylePlanLine(raw: string, theme: Theme): string {
	const palette = getThemeSurfacePalette(theme);
	const trimmed = raw.trimStart();
	const indent = raw.slice(0, raw.length - trimmed.length);
	if (/^#{1,6}\s+/.test(trimmed)) {
		const clean = trimmed.replace(/^#{1,6}\s+/, "");
		return indent + fgRgb(palette.accentBright[0], palette.accentBright[1], palette.accentBright[2], theme.bold(clean));
	}
	const stepMatch = trimmed.match(/^(\d+[.)])\s+(.*)$/);
	if (stepMatch) {
		return `${indent}${fgRgb(palette.warning[0], palette.warning[1], palette.warning[2], theme.bold(stepMatch[1]!))} ${theme.fg("text", stepMatch[2]!)}`;
	}
	if (/^[-*•]\s+/.test(trimmed)) {
		const clean = trimmed.slice(2);
		return `${indent}${fgRgb(palette.accent[0], palette.accent[1], palette.accent[2], "•")} ${theme.fg("text", clean)}`;
	}
	return raw ? theme.fg("text", raw) : "";
}

export async function showPlanStudio(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	const st = getStore();

	if (st.planLines.length === 0) {
		if (st.mode !== "plan") {
			setSessionMode(pi, ctx, "plan");
		} else {
			ctx.ui.notify("План пока пуст — отправь запрос, и после ответа откроется ревью плана", "info");
		}
		return;
	}

	const outcome = await openModalCard<"close" | "approve" | "revise">(
		ctx,
		(_tui, theme, _kb, done) => {
			const card = createModalCard();
			const commentInput = createSingleLineInput();
			let cursorIdx = 0;
			let scrollTop = 0;
			let editingLine: number | null = null;
			let hoveredRowLine: number | null = null;
			let rowToPlanLine = new Map<number, number>();

			const startCommentEdit = (lineIdx: number) => {
				cursorIdx = Math.max(0, Math.min(st.planLines.length - 1, lineIdx));
				editingLine = cursorIdx;
				commentInput.setValue(st.planComments[cursorIdx] ?? "");
			};

			const saveCommentEdit = () => {
				if (editingLine === null) return;
				const trimmed = commentInput.getValue().trim();
				if (trimmed) st.planComments[editingLine] = trimmed;
				else delete st.planComments[editingLine];
				editingLine = null;
				commentInput.clear();
				persistSessionStore(pi);
			};

			const comp: Component & Focusable = {
				focused: true,
				capturesViewportInput: true,
				invalidate() {},
				render(width: number): string[] {
					rowToPlanLine = new Map();
					const palette = getThemeSurfacePalette(theme);
					const innerWidth = Math.max(24, width - 4);
					const termRows = _tui.terminal?.rows ?? 32;
					const maxBodyRows = Math.max(10, Math.min(24, termRows - 9));

					if (cursorIdx < scrollTop) scrollTop = cursorIdx;
					if (cursorIdx >= scrollTop + maxBodyRows - 3) {
						scrollTop = Math.max(0, cursorIdx - Math.floor(maxBodyRows * 0.6));
					}

					const commentCount = Object.keys(st.planComments).length;
					const subHeader = `${theme.fg("muted", "Кликни по любой строке (или Enter / c), чтобы оставить комментарий прямо под ней")}${
						commentCount > 0
							? `  ${fgRgb(palette.warning[0], palette.warning[1], palette.warning[2], theme.bold(`· 💬 ${commentCount}`))}`
							: ""
					}`;

					const body: string[] = [
						truncateToWidth(subHeader, innerWidth, "…"),
						theme.fg("borderMuted", "─".repeat(innerWidth)),
					];
					let currentBodyRow = 3;

					for (let i = scrollTop; i < st.planLines.length && body.length < maxBodyRows; i++) {
						const raw = st.planLines[i] ?? "";
						const isSelected = i === cursorIdx;
						const isHovered = i === hoveredRowLine;
						const hasComment = Boolean(st.planComments[i]);
						const numStr = String(i + 1).padStart(3, " ");
						const marker = hasComment
							? fgRgb(palette.warning[0], palette.warning[1], palette.warning[2], "💬")
							: isSelected
								? fgRgb(palette.accent[0], palette.accent[1], palette.accent[2], "▸ ")
								: "  ";
						const numStyled = isSelected
							? fgRgb(palette.accentBright[0], palette.accentBright[1], palette.accentBright[2], theme.bold(numStr))
							: theme.fg("dim", numStr);

						const contentAvail = Math.max(8, innerWidth - 8);
						const styledContent = truncateToWidth(stylePlanLine(raw, theme), contentAvail, "…");
						let lineOut = `${marker}${numStyled} │ ${styledContent}`;
						const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(lineOut)));
						lineOut += pad;

						if (isSelected) {
							lineOut = bgRgb(palette.selectedRowBg[0], palette.selectedRowBg[1], palette.selectedRowBg[2], lineOut);
						} else if (isHovered) {
							lineOut = bgRgb(palette.hoveredRowBg[0], palette.hoveredRowBg[1], palette.hoveredRowBg[2], lineOut);
						}

						rowToPlanLine.set(currentBodyRow, i);
						body.push(lineOut);
						currentBodyRow++;

						if (editingLine === i && body.length < maxBodyRows) {
							const editPrefix = `      ${fgRgb(palette.warning[0], palette.warning[1], palette.warning[2], "↳ 💬 ")}`;
							const editHint = theme.fg("dim", "  [Enter сохр · Esc отмена]");
							const maxDraft = Math.max(6, innerWidth - visibleWidth(editPrefix) - visibleWidth(editHint));
							const renderedInput = commentInput.render({
								theme,
								focused: Boolean(comp.focused),
								maxWidth: maxDraft,
								placeholder: "Комментарий…",
							});
							const editRow = truncateToWidth(`${editPrefix}${renderedInput}${editHint}`, innerWidth, "…");
							const editPad = " ".repeat(Math.max(0, innerWidth - visibleWidth(editRow)));
							body.push(
								bgRgb(
									palette.noteEditRowBg[0],
									palette.noteEditRowBg[1],
									palette.noteEditRowBg[2],
									editRow + editPad,
								),
							);
							currentBodyRow++;
						} else if (hasComment && body.length < maxBodyRows) {
							const notePrefix = `      ${fgRgb(palette.warning[0], palette.warning[1], palette.warning[2], "↳ 💬 ")}`;
							const noteText = fgRgb(palette.noteText[0], palette.noteText[1], palette.noteText[2], st.planComments[i]!);
							const noteRow = truncateToWidth(`${notePrefix}${noteText}`, innerWidth, "…");
							const notePad = " ".repeat(Math.max(0, innerWidth - visibleWidth(noteRow)));
							rowToPlanLine.set(currentBodyRow, i);
							body.push(
								bgRgb(palette.noteRowBg[0], palette.noteRowBg[1], palette.noteRowBg[2], noteRow + notePad),
							);
							currentBodyRow++;
						}
					}

					const footerPills: ModalActionPill[] = [
						{
							id: "approve",
							label: "✓ В работу (Ctrl+↵)",
							variant: "success",
							active: true,
							onClick: () => {
								if (editingLine !== null) saveCommentEdit();
								done("approve");
							},
						},
						{
							id: "revise",
							label: commentCount > 0 ? `↻ Пересобрать (${commentCount}) (Ctrl+R)` : "↻ Пересобрать (Ctrl+R)",
							variant: "warning",
							active: commentCount > 0,
							onClick: () => {
								if (editingLine !== null) saveCommentEdit();
								done("revise");
							},
						},
					];
					if (commentCount > 0) {
						footerPills.push({
							id: "clear",
							label: "🗑 Сбросить комменты",
							variant: "neutral",
							onClick: () => {
								st.planComments = {};
								persistSessionStore(pi);
							},
						});
					}
					footerPills.push({
						id: "close",
						label: "✕ Закрыть (Esc)",
						variant: "neutral",
						onClick: () => {
							if (editingLine !== null) saveCommentEdit();
							done("close");
						},
					});

					return card.render(width, theme, {
						title: fgRgb(palette.warning[0], palette.warning[1], palette.warning[2], theme.bold("◈ Plan Studio")),
						headerMeta: theme.fg("muted", `${cursorIdx + 1}/${st.planLines.length}`),
						onClose: () => {
							if (editingLine !== null) saveCommentEdit();
							done("close");
						},
						bodyLines: body,
						footerPills,
						borderVariant: "warning",
					});
				},
				handleInput(data: string): void {
					if (editingLine !== null) {
						if (matchesKey(data, "escape")) {
							editingLine = null;
							commentInput.clear();
							return;
						}
						if (matchesKey(data, "enter") || matchesKey(data, "return")) {
							saveCommentEdit();
							return;
						}
						commentInput.handleInput(data);
						return;
					}

					if (matchesKey(data, "escape") || data === "q") {
						done("close");
						return;
					}
					if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+return") || data === "a") {
						done("approve");
						return;
					}
					if (matchesKey(data, "ctrl+r") || data === "r") {
						done("revise");
						return;
					}
					if (matchesKey(data, "up") || data === "k") {
						cursorIdx = Math.max(0, cursorIdx - 1);
						return;
					}
					if (matchesKey(data, "down") || data === "j") {
						cursorIdx = Math.min(st.planLines.length - 1, cursorIdx + 1);
						return;
					}
					if (matchesKey(data, "pageUp")) {
						cursorIdx = Math.max(0, cursorIdx - 8);
						return;
					}
					if (matchesKey(data, "pageDown")) {
						cursorIdx = Math.min(st.planLines.length - 1, cursorIdx + 8);
						return;
					}
					if (matchesKey(data, "backspace") || matchesKey(data, "delete") || data === "d") {
						if (st.planComments[cursorIdx]) {
							delete st.planComments[cursorIdx];
							persistSessionStore(pi);
						}
						return;
					}
					if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "c") {
						startCommentEdit(cursorIdx);
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.type === "wheel" && event.wheelDelta) {
						const delta = event.wheelDelta < 0 ? -2 : 2;
						scrollTop = Math.max(0, Math.min(Math.max(0, st.planLines.length - 4), scrollTop + delta));
						cursorIdx = Math.max(0, Math.min(st.planLines.length - 1, cursorIdx + (delta < 0 ? -1 : 1)));
						return { handled: true, render: true };
					}
					const cardOutcome = card.handleMouse(event);
					if (event.type === "move") {
						const lineHit = cardOutcome.handled ? null : (rowToPlanLine.get(event.y) ?? null);
						const rowChanged = lineHit !== hoveredRowLine;
						hoveredRowLine = lineHit;
						return { handled: true, render: cardOutcome.render || rowChanged };
					}
					if (event.type === "click" && event.button === "left") {
						if (cardOutcome.triggered) {
							return { handled: true, render: true };
						}
						const lineHit = rowToPlanLine.get(event.y);
						if (lineHit !== undefined) {
							if (editingLine !== null && editingLine !== lineHit) saveCommentEdit();
							startCommentEdit(lineHit);
							return { handled: true, render: true };
						}
					}
					return { handled: true, render: false };
				},
			};
			return comp;
		},
		{ width: "86%", minWidth: 52, maxHeight: "84%", anchor: "center", margin: 1 },
	);

	updatePlanWidget(pi, ctx);

	if (outcome === "approve") approveAndExecutePlan(pi, ctx);
	else if (outcome === "revise") revisePlanWithComments(pi, ctx);
}

export async function confirmSafeToolCall(
	ctx: ExtensionContext,
	toolName: string,
	summary: string,
): Promise<"allow" | "allow-turn" | "block"> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		const ok = await ctx.ui.confirm(`Auto-Safe: разрешить ${toolName}?`, summary);
		return ok ? "allow" : "block";
	}

	const decision = await openModalCard<"allow" | "allow-turn" | "block">(
		ctx,
		(_tui, theme, _kb, done) => {
			const card = createModalCard();

			return {
				invalidate() {},
				render(width: number): string[] {
					const palette = getThemeSurfacePalette(theme);
					const inner = Math.max(24, width - 4);
					const body = [
						`${theme.fg("muted", "Инструмент:")} ${fgRgb(palette.info[0], palette.info[1], palette.info[2], theme.bold(toolName))}`,
						truncateToWidth(theme.fg("text", summary), inner, "…"),
					];

					return card.render(width, theme, {
						title: fgRgb(palette.info[0], palette.info[1], palette.info[2], theme.bold("🛡 Auto-Safe Confirmation")),
						onClose: () => done("block"),
						bodyLines: body,
						borderVariant: "info",
						footerPills: [
							{
								id: "allow",
								label: "✓ Разрешить (Enter)",
								variant: "success",
								active: true,
								onClick: () => done("allow"),
							},
							{
								id: "turn",
								label: "✓ До конца хода (a)",
								variant: "secondary",
								active: true,
								onClick: () => done("allow-turn"),
							},
							{
								id: "deny",
								label: "✕ Отклонить (Esc)",
								variant: "danger",
								onClick: () => done("block"),
							},
						],
					});
				},
				handleInput(data: string): void {
					if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "y") done("allow");
					else if (data === "a" || data === "A") done("allow-turn");
					else if (matchesKey(data, "escape") || data === "n") done("block");
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const outcome = card.handleMouse(event);
					return { handled: true, render: outcome.render };
				},
			};
		},
		{ width: 72, minWidth: 44, anchor: "center", margin: 2 },
	);

	return decision ?? "block";
}
