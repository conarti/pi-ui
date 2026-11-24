import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, isLightTheme, renderPill, type HitBox } from "../../shared/ansi.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { getStore, MODE_META } from "../../shared/session-store.ts";
import { setSessionMode } from "../plan-studio/index.ts";
import { showPlanStudio } from "../plan-studio/studio-overlay.ts";

export function buildWaveIndicator(): WorkingIndicatorOptions {
	const c1 = (s: string) => fgRgb(62, 84, 118, s);
	const c2 = (s: string) => fgRgb(86, 148, 214, s);
	const c3 = (s: string) => fgRgb(125, 207, 255, s);
	const c4 = (s: string) => fgRgb(86, 212, 224, s);

	return {
		intervalMs: 95,
		frames: [
			`${c3("●")}${c2("∙")}${c1("∙")}`,
			`${c4("●")}${c3("●")}${c1("∙")}`,
			`${c2("∙")}${c4("●")}${c3("●")}`,
			`${c1("∙")}${c2("∙")}${c4("●")}`,
			`${c1("∙")}${c3("●")}${c2("∙")}`,
			`${c2("●")}${c1("∙")}${c1("∙")}`,
		],
	};
}

export function mountComposer(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	ctx.ui.setWorkingIndicator(buildWaveIndicator());

	const previousFactory = ctx.ui.getEditorComponent();

	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
		const baseEditor =
			previousFactory?.(tui, editorTheme, keybindings) ??
			new CustomEditor(tui, editorTheme, keybindings, {
				paddingX: 2,
				autocompleteMaxVisible: 10,
				embedWorkingStatus: true,
			});

		const anyEditor = baseEditor as any;
		anyEditor.embedWorkingStatus = true;
		if (typeof baseEditor.setPaddingX === "function" && baseEditor.getPaddingX() < 2) {
			baseEditor.setPaddingX(2);
		}
		if (typeof baseEditor.setAutocompleteMaxVisible === "function" && baseEditor.getAutocompleteMaxVisible() < 10) {
			baseEditor.setAutocompleteMaxVisible(10);
		}

		const st = getStore();
		st.requestRender = () => tui.requestRender();
		st.runAppAction = (actionId: string): boolean => {
			const handler = anyEditor.actionHandlers?.get?.(actionId);
			if (typeof handler === "function") {
				handler();
				return true;
			}
			return false;
		};
		st.jumpPrompt = (delta: -1 | 1) => {
			if (typeof (tui as any).scrollToPrompt === "function") {
				(tui as any).scrollToPrompt(delta);
				tui.requestRender();
			}
		};

		let editorHovered = false;
		let hoveredBadge: string | null = null;
		let topHits: HitBox[] = [];

		baseEditor.borderColor = (str: string) => {
			const light = isLightTheme(ctx.ui.theme);
			if (st.mode === "plan") return light ? fgRgb(180, 83, 9, str) : fgRgb(196, 160, 92, str);
			if (st.mode === "safe") return light ? fgRgb(15, 118, 110, str) : fgRgb(76, 162, 174, str);
			if (st.isStreaming) return light ? fgRgb(37, 99, 235, str) : fgRgb(97, 175, 239, str);
			if (editorHovered) return light ? fgRgb(59, 130, 246, str) : fgRgb(92, 138, 198, str);
			return light ? fgRgb(203, 213, 225, str) : fgRgb(58, 68, 86, str);
		};

		const origHandleInput = baseEditor.handleInput.bind(baseEditor);
		baseEditor.handleInput = (data: string) => {
			if (matchesKey(data, "alt+enter") || matchesKey(data, "alt+return") || data === "\x1b\r" || data === "\x1b\n") {
				origHandleInput("\n");
				return;
			}
			origHandleInput(data);
		};

		st.submitPrompt = () => {
			if (baseEditor.getText().trim().length > 0) {
				origHandleInput("\r");
			}
		};

		const origRender = baseEditor.render.bind(baseEditor);
		baseEditor.render = (width: number): string[] => {
			const lines = [...origRender(width)];
			topHits = [];
			if (lines.length < 2 || width < 28) return lines;

			const theme = ctx.ui.theme;
			const bLine = (s: string) => baseEditor.borderColor(s);
			const visibleRows: number = anyEditor.renderedVisibleLineCount ?? Math.max(1, lines.length - 2);
			const bottomRowIdx = Math.min(lines.length - 1, visibleRows + 1);

			const pills: Array<{ id: string; str: string; onClick: () => void }> = [];
			if (st.mode !== "code") {
				const meta = MODE_META[st.mode];
				pills.push({
					id: "mode",
					str: renderPill(`${meta.icon} ${meta.label}`, {
						hovered: hoveredBadge === "mode",
						active: true,
						rgb: meta.rgb,
						theme,
					}),
					onClick: () => setSessionMode(pi, ctx, "code"),
				});
			}
			if (st.planLines.length > 0) {
				const commentCount = Object.keys(st.planComments).length;
				pills.push({
					id: "plan",
					str: renderPill(commentCount > 0 ? `📋 План (${commentCount})` : "📋 План", {
						hovered: hoveredBadge === "plan",
						active: true,
						rgb: [229, 192, 123],
						theme,
					}),
					onClick: () => void showPlanStudio(pi, ctx),
				});
			}

			if (pills.length > 0) {
				let leftPart = bLine("──");
				if (anyEditor.workingStatusIndicator && typeof anyEditor.workingStatusIndicator.renderInBorder === "function") {
					const statusStr: string = anyEditor.workingStatusIndicator.renderInBorder(Math.max(12, Math.floor(width * 0.5)));
					if (visibleWidth(statusStr) > 0) {
						leftPart = `${bLine("── ")}${statusStr} `;
					}
				}
				const pillsWidth = pills.reduce((sum, p) => sum + visibleWidth(p.str) + 1, 0);
				if (visibleWidth(leftPart) + pillsWidth + 3 <= width) {
					const fill = Math.max(1, width - visibleWidth(leftPart) - pillsWidth - 1);
					let row = `${leftPart}${bLine("─".repeat(fill))}`;
					let curX = visibleWidth(row);
					for (const p of pills) {
						const pw = visibleWidth(p.str);
						topHits.push({ id: p.id, xStart: curX, xEnd: curX + pw, y: 0, onClick: p.onClick });
						row += `${p.str}${bLine("─")}`;
						curX += pw + 1;
					}
					const rem = Math.max(0, width - visibleWidth(row));
					lines[0] = truncateToWidth(row + bLine("─".repeat(rem)), width, "");
				}
			}

			const draftText = baseEditor.getText();
			if (draftText.length > 0 && width >= 44) {
				const hint = theme.fg("dim", " ⌥↵ строка · ↵ отправить ");
				const fill = Math.max(2, width - visibleWidth(hint) - 2);
				lines[bottomRowIdx] = `${bLine("─".repeat(fill))}${hint}${bLine("──")}`;
			}

			return lines;
		};

		const origHandleMouse = baseEditor.handleMouse?.bind(baseEditor);
		baseEditor.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
			if (event.type === "move") {
				claimHover(baseEditor, () => {
					if (editorHovered || hoveredBadge) {
						editorHovered = false;
						hoveredBadge = null;
						tui.requestRender();
					}
				});
				const nextBadge =
					event.y === 0 ? (topHits.find((h) => event.x >= h.xStart && event.x < h.xEnd)?.id ?? null) : null;
				if (!editorHovered || nextBadge !== hoveredBadge) {
					editorHovered = true;
					hoveredBadge = nextBadge;
					return { handled: true, render: true };
				}
			}

			if (event.type === "click" && event.button === "left" && event.y === 0) {
				const hit = topHits.find((h) => event.x >= h.xStart && event.x < h.xEnd);
				if (hit) {
					hit.onClick();
					return { handled: true, focus: true, render: true };
				}
			}

			return origHandleMouse ? origHandleMouse(event) : undefined;
		};

		return baseEditor;
	});
}
