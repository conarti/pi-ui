import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	matchesKey,
	renderFakeCursor,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { bgRgb, fgRgb, renderCardFrame, renderPill, type HitBox } from "../../shared/ansi.ts";
import { getStore, persistSessionStore } from "../../shared/session-store.ts";
import { approveAndExecutePlan, revisePlanWithComments, setSessionMode, updatePlanWidget } from "./index.ts";

function stylePlanLine(raw: string, theme: any): string {
	const trimmed = raw.trimStart();
	const indent = raw.slice(0, raw.length - trimmed.length);
	if (/^#{1,6}\s+/.test(trimmed)) {
		const clean = trimmed.replace(/^#{1,6}\s+/, "");
		return indent + fgRgb(125, 207, 255, theme.bold(clean));
	}
	const stepMatch = trimmed.match(/^(\d+[.)])\s+(.*)$/);
	if (stepMatch) {
		return `${indent}${fgRgb(229, 192, 123, theme.bold(stepMatch[1]!))} ${theme.fg("text", stepMatch[2]!)}`;
	}
	if (/^[-*•]\s+/.test(trimmed)) {
		const clean = trimmed.slice(2);
		return `${indent}${fgRgb(97, 175, 239, "•")} ${theme.fg("text", clean)}`;
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

	const outcome = await ctx.ui.custom<"close" | "approve" | "revise">(
		(_tui, theme, _kb, done) => {
			let cursorIdx = 0;
			let scrollTop = 0;
			let editingLine: number | null = null;
			let draft = "";
			let hoveredRowLine: number | null = null;
			let hoveredBtn: string | null = null;
			let rowToPlanLine = new Map<number, number>();
			let btnHits: HitBox[] = [];
			let closeHit: { xStart: number; xEnd: number } | null = null;

			const startCommentEdit = (lineIdx: number) => {
				cursorIdx = Math.max(0, Math.min(st.planLines.length - 1, lineIdx));
				editingLine = cursorIdx;
				draft = st.planComments[cursorIdx] ?? "";
			};

			const saveCommentEdit = () => {
				if (editingLine === null) return;
				const trimmed = draft.trim();
				if (trimmed) st.planComments[editingLine] = trimmed;
				else delete st.planComments[editingLine];
				editingLine = null;
				draft = "";
				persistSessionStore(pi);
			};

			const comp: Component & Focusable = {
				focused: true,
				capturesViewportInput: true,
				invalidate() {},
				render(width: number): string[] {
					rowToPlanLine = new Map();
					btnHits = [];
					const innerWidth = Math.max(24, width - 4);
					const termRows = _tui.terminal?.rows ?? 32;
					const maxBodyRows = Math.max(10, Math.min(24, termRows - 9));

					if (cursorIdx < scrollTop) scrollTop = cursorIdx;
					if (cursorIdx >= scrollTop + maxBodyRows - 3) {
						scrollTop = Math.max(0, cursorIdx - Math.floor(maxBodyRows * 0.6));
					}

					const commentCount = Object.keys(st.planComments).length;
					const subHeader = `${theme.fg("muted", "Кликни по любой строке (или Enter / c), чтобы оставить комментарий прямо под ней")}${
						commentCount > 0 ? `  ${fgRgb(229, 192, 123, theme.bold(`· 💬 ${commentCount}`))}` : ""
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
							? fgRgb(229, 192, 123, "💬")
							: isSelected
								? fgRgb(97, 175, 239, "▸ ")
								: "  ";
						const numStyled = isSelected ? fgRgb(125, 207, 255, theme.bold(numStr)) : theme.fg("dim", numStr);

						const contentAvail = Math.max(8, innerWidth - 8);
						const styledContent = truncateToWidth(stylePlanLine(raw, theme), contentAvail, "…");
						let lineOut = `${marker}${numStyled} │ ${styledContent}`;
						const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(lineOut)));
						lineOut += pad;

						if (isSelected) lineOut = bgRgb(38, 49, 68, lineOut);
						else if (isHovered) lineOut = bgRgb(31, 38, 50, lineOut);

						rowToPlanLine.set(currentBodyRow, i);
						body.push(lineOut);
						currentBodyRow++;

						if (editingLine === i && body.length < maxBodyRows) {
							const markerCur = comp.focused ? CURSOR_MARKER : "";
							const editPrefix = `      ${fgRgb(229, 192, 123, "↳ 💬 ")}`;
							const maxDraft = Math.max(6, innerWidth - visibleWidth(editPrefix) - 18);
							const shownDraft = draft.length > maxDraft ? `…${draft.slice(-(maxDraft - 1))}` : draft;
							const editHint = theme.fg("dim", "  [Enter сохр · Esc отмена]");
							const editRow = truncateToWidth(
								`${editPrefix}${fgRgb(235, 244, 255, shownDraft)}${markerCur}${renderFakeCursor(" ")}${editHint}`,
								innerWidth,
								"…",
							);
							const editPad = " ".repeat(Math.max(0, innerWidth - visibleWidth(editRow)));
							body.push(bgRgb(44, 42, 34, editRow + editPad));
							currentBodyRow++;
						} else if (hasComment && body.length < maxBodyRows) {
							const notePrefix = `      ${fgRgb(229, 192, 123, "↳ 💬 ")}`;
							const noteText = fgRgb(232, 210, 156, st.planComments[i]!);
							const noteRow = truncateToWidth(`${notePrefix}${noteText}`, innerWidth, "…");
							const notePad = " ".repeat(Math.max(0, innerWidth - visibleWidth(noteRow)));
							rowToPlanLine.set(currentBodyRow, i);
							body.push(bgRgb(40, 39, 33, noteRow + notePad));
							currentBodyRow++;
						}
					}

					const btnApprove = renderPill("✓ В работу (Ctrl+↵)", {
						hovered: hoveredBtn === "approve",
						active: true,
						rgb: [140, 194, 101],
						theme,
					});
					const btnRevise = renderPill(
						commentCount > 0 ? `↻ Пересобрать (${commentCount}) (Ctrl+R)` : "↻ Пересобрать (Ctrl+R)",
						{
							hovered: hoveredBtn === "revise",
							active: commentCount > 0,
							rgb: [229, 192, 123],
							theme,
						},
					);
					const btnClear =
						commentCount > 0
							? renderPill("🗑 Сбросить комменты", { hovered: hoveredBtn === "clear", theme })
							: "";
					const btnClose = renderPill("✕ Закрыть (Esc)", { hovered: hoveredBtn === "close", theme });

					const footerLine = [btnApprove, btnRevise, ...(btnClear ? [btnClear] : []), btnClose].join("  ");
					const footerRow = body.length + 2;

					let x = 2;
					const registerBtn = (id: string, rendered: string, onClick: () => void) => {
						const w = visibleWidth(rendered);
						btnHits.push({ id, xStart: x, xEnd: x + w, y: footerRow, onClick });
						x += w + 2;
					};
					registerBtn("approve", btnApprove, () => {
						if (editingLine !== null) saveCommentEdit();
						done("approve");
					});
					registerBtn("revise", btnRevise, () => {
						if (editingLine !== null) saveCommentEdit();
						done("revise");
					});
					if (btnClear) {
						registerBtn("clear", btnClear, () => {
							st.planComments = {};
							persistSessionStore(pi);
						});
					}
					registerBtn("close", btnClose, () => {
						if (editingLine !== null) saveCommentEdit();
						done("close");
					});

					const posLabel = theme.fg("muted", `${cursorIdx + 1}/${st.planLines.length}`);
					const closeGlyph = hoveredBtn === "top-close" ? fgRgb(224, 108, 117, "✕") : theme.fg("muted", "✕");
					closeHit = { xStart: Math.max(0, width - 5), xEnd: width - 1 };

					return renderCardFrame(
						fgRgb(229, 192, 123, theme.bold("◈ Plan Studio")),
						`${posLabel}  ${closeGlyph}`,
						body,
						footerLine,
						width,
						theme,
						[229, 192, 123],
					);
				},
				handleInput(data: string): void {
					if (editingLine !== null) {
						if (matchesKey(data, "escape")) {
							editingLine = null;
							draft = "";
							return;
						}
						if (matchesKey(data, "enter") || matchesKey(data, "return")) {
							saveCommentEdit();
							return;
						}
						if (matchesKey(data, "ctrl+u")) {
							delete st.planComments[editingLine];
							editingLine = null;
							draft = "";
							persistSessionStore(pi);
							return;
						}
						if (matchesKey(data, "backspace")) {
							const segs = [...new Intl.Segmenter().segment(draft)];
							segs.pop();
							draft = segs.map((s) => s.segment).join("");
							return;
						}
						if (data.length >= 1 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) {
							draft += data;
						}
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
					if (event.type === "move") {
						const lineHit = rowToPlanLine.get(event.y) ?? null;
						let nextBtn: string | null = null;
						if (event.y === 0 && closeHit && event.x >= closeHit.xStart && event.x <= closeHit.xEnd) {
							nextBtn = "top-close";
						} else {
							const bHit = btnHits.find((b) => b.y === event.y && event.x >= b.xStart && event.x < b.xEnd);
							if (bHit) nextBtn = bHit.id;
						}
						if (lineHit !== hoveredRowLine || nextBtn !== hoveredBtn) {
							hoveredRowLine = lineHit;
							hoveredBtn = nextBtn;
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					if (event.type === "click" && event.button === "left") {
						if (event.y === 0 && closeHit && event.x >= closeHit.xStart && event.x <= closeHit.xEnd) {
							if (editingLine !== null) saveCommentEdit();
							done("close");
							return { handled: true };
						}
						const bHit = btnHits.find((b) => b.y === event.y && event.x >= b.xStart && event.x < b.xEnd);
						if (bHit) {
							bHit.onClick();
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
		{
			overlay: true,
			overlayOptions: { width: "86%", minWidth: 52, maxHeight: "84%", anchor: "center", margin: 1 },
		},
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

	return await ctx.ui.custom<"allow" | "allow-turn" | "block">(
		(_tui, theme, _kb, done) => {
			let hovered: string | null = null;
			let hits: HitBox[] = [];

			return {
				invalidate() {},
				render(width: number): string[] {
					hits = [];
					const inner = Math.max(24, width - 4);
					const body = [
						`${theme.fg("muted", "Инструмент:")} ${fgRgb(86, 182, 194, theme.bold(toolName))}`,
						truncateToWidth(theme.fg("text", summary), inner, "…"),
					];

					const bAllow = renderPill("✓ Разрешить (Enter)", {
						hovered: hovered === "allow",
						active: true,
						rgb: [140, 194, 101],
						theme,
					});
					const bTurn = renderPill("✓ До конца хода (a)", {
						hovered: hovered === "turn",
						active: true,
						rgb: [86, 182, 194],
						theme,
					});
					const bDeny = renderPill("✕ Отклонить (Esc)", {
						hovered: hovered === "deny",
						rgb: [224, 108, 117],
						theme,
					});

					const footer = `${bAllow}  ${bTurn}  ${bDeny}`;
					const footerRow = body.length + 2;
					let x = 2;
					for (const [id, pill, res] of [
						["allow", bAllow, "allow"],
						["turn", bTurn, "allow-turn"],
						["deny", bDeny, "block"],
					] as const) {
						const w = visibleWidth(pill);
						hits.push({ id, xStart: x, xEnd: x + w, y: footerRow, onClick: () => done(res) });
						x += w + 2;
					}

					return renderCardFrame(
						fgRgb(86, 182, 194, theme.bold("🛡 Auto-Safe Confirmation")),
						"",
						body,
						footer,
						width,
						theme,
						[86, 182, 194],
					);
				},
				handleInput(data: string): void {
					if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "y") done("allow");
					else if (data === "a" || data === "A") done("allow-turn");
					else if (matchesKey(data, "escape") || data === "n") done("block");
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.type === "move") {
						const hit = hits.find((h) => h.y === event.y && event.x >= h.xStart && event.x < h.xEnd);
						const next = hit?.id ?? null;
						if (next !== hovered) {
							hovered = next;
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					if (event.type === "click" && event.button === "left") {
						const hit = hits.find((h) => h.y === event.y && event.x >= h.xStart && event.x < h.xEnd);
						if (hit) {
							hit.onClick();
							return { handled: true };
						}
					}
					return { handled: true, render: false };
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: 72, minWidth: 44, anchor: "center", margin: 2 },
		},
	);
}
