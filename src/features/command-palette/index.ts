import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
} from "../../shared/modal-card.ts";
import { getSessionWorkflow, MODE_META } from "../../shared/session-workflow.ts";
import { requestRender, runAppAction } from "../../shared/ui-action-bridge.ts";
import { showContextInspector } from "../context-inspector/index.ts";
import { getOutlineSettings } from "../outline-rail/index.ts";
import { setSessionMode } from "../plan-studio/index.ts";
import { showPlanStudio } from "../plan-studio/studio-overlay.ts";
import { getStickyConfig } from "../sticky-prompt/index.ts";

interface PaletteItem {
	id: string;
	group: string;
	icon: string;
	label: string;
	hint?: string;
	keywords: string;
	run: () => void | Promise<void>;
}

function fuzzyMatch(query: string, target: string): boolean {
	if (!query) return true;
	const q = query.toLowerCase().trim();
	const t = target.toLowerCase();
	if (t.includes(q)) return true;
	let qi = 0;
	for (let i = 0; i < t.length && qi < q.length; i++) {
		if (t[i] === q[qi]) qi++;
	}
	return qi === q.length;
}

export async function showCommandPalette(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	const wf = getSessionWorkflow();
	const stickyCfg = getStickyConfig();
	const outlineCfg = getOutlineSettings();

	const runAction = (actionId: string) => {
		runAppAction(actionId);
	};

	const items: PaletteItem[] = [
		{
			id: "mode-plan",
			group: "Режим",
			icon: "◈",
			label: wf.mode === "plan" ? "Выключить Plan Mode → Code" : "Включить Plan Mode (планирование без воды)",
			hint: "Alt+M",
			keywords: "plan mode план планирование",
			run: () => setSessionMode(pi, ctx, wf.mode === "plan" ? "code" : "plan"),
		},
		{
			id: "plan-studio",
			group: "Режим",
			icon: "📋",
			label:
				wf.planLines.length > 0
					? `Открыть Plan Studio (${wf.planLines.length} стр., комментарии к строкам)`
					: "Открыть Plan Studio",
			hint: "/plan",
			keywords: "plan studio review comments ревью комментарии план",
			run: () => showPlanStudio(pi, ctx),
		},
		{
			id: "mode-safe",
			group: "Режим",
			icon: "🛡",
			label: wf.mode === "safe" ? "Выключить Auto-Safe → Code" : "Включить Auto-Safe (подтверждение правок/риска)",
			hint: "/mode safe",
			keywords: "auto safe confirm локальные модели безопасность",
			run: () => setSessionMode(pi, ctx, wf.mode === "safe" ? "code" : "safe"),
		},
		{
			id: "context",
			group: "Контекст",
			icon: "◐",
			label: "Инспектор контекста и токенов",
			hint: "/context",
			keywords: "context tokens usage cost контекст токены",
			run: () => showContextInspector(pi, ctx),
		},
		{
			id: "compact",
			group: "Контекст",
			icon: "⚡",
			label: "Сжать историю диалога (Compact)",
			hint: "/compact",
			keywords: "compact compress сжать контекст",
			run: () => {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Дождись завершения генерации перед сжатием", "warning");
					return;
				}
				ctx.ui.notify("Сжимаю контекст…", "info");
				ctx.compact({
					onComplete: () => ctx.ui.notify("Контекст сжат ✓", "info"),
					onError: (e) => ctx.ui.notify(`Ошибка сжатия: ${e.message}`, "error"),
				});
			},
		},
		{
			id: "toggle-sticky",
			group: "Интерфейс",
			icon: "📌",
			label: `Закреплённый промпт сверху: ${stickyCfg.enabled ? "выключить" : "включить"}`,
			hint: "/sticky",
			keywords: "sticky header prompt закрепленный промпт",
			run: () => {
				stickyCfg.enabled = !stickyCfg.enabled;
				requestRender();
				ctx.ui.notify(`Sticky prompt: ${stickyCfg.enabled ? "включён" : "выключен"}`, "info");
			},
		},
		{
			id: "toggle-outline",
			group: "Интерфейс",
			icon: "☰",
			label: `Навигация по репликам справа: ${outlineCfg.enabled ? "скрыть" : "показать"}`,
			hint: "Ctrl+Alt+O",
			keywords: "outline rail timeline навигация справа",
			run: () => {
				outlineCfg.enabled = !outlineCfg.enabled;
				requestRender();
				ctx.ui.notify(`Навигация справа: ${outlineCfg.enabled ? "показана" : "скрыта"}`, "info");
			},
		},
		{
			id: "model-select",
			group: "Модель",
			icon: "✦",
			label: `Выбрать модель (${ctx.model?.name || ctx.model?.id || "current"})`,
			hint: "Ctrl+L",
			keywords: "model select provider модель",
			run: () => runAction("app.model.select"),
		},
		{
			id: "thinking-cycle",
			group: "Модель",
			icon: "⚡",
			label: `Уровень рассуждений (сейчас: ${pi.getThinkingLevel()})`,
			hint: "Shift+Tab",
			keywords: "thinking reasoning effort рассуждения",
			run: () => runAction("app.thinking.cycle"),
		},
		{
			id: "thinking-toggle",
			group: "Вид",
			icon: "💭",
			label: "Свернуть / развернуть блоки Thinking",
			hint: "Ctrl+T",
			keywords: "thinking toggle hide show мысли",
			run: () => runAction("app.thinking.toggle"),
		},
		{
			id: "tools-toggle",
			group: "Вид",
			icon: "🔧",
			label: "Свернуть / развернуть вывод инструментов",
			hint: "Ctrl+O",
			keywords: "tools expand collapse тулзы вывод",
			run: () => runAction("app.tools.expand"),
		},
		{
			id: "theme-one-blue",
			group: "Тема",
			icon: "🎨",
			label: "Тема: One Blue Pro (под Ghostty One Dark, без фиолетового)",
			keywords: "theme blue one dark тема синяя",
			run: () => {
				ctx.ui.setTheme("one-blue-pro");
				ctx.ui.notify("Тема: One Blue Pro", "info");
			},
		},
		{
			id: "theme-nordic-ocean",
			group: "Тема",
			icon: "🌊",
			label: "Тема: Nordic Ocean (глубокий арктический синий)",
			keywords: "theme nordic ocean nightfox тема океан синяя",
			run: () => {
				ctx.ui.setTheme("nordic-ocean");
				ctx.ui.notify("Тема: Nordic Ocean", "info");
			},
		},
		{
			id: "theme-midnight-cobalt",
			group: "Тема",
			icon: "🌌",
			label: "Тема: Midnight Cobalt (контрастный электрик-синий)",
			keywords: "theme midnight cobalt electric тема кобальт",
			run: () => {
				ctx.ui.setTheme("midnight-cobalt");
				ctx.ui.notify("Тема: Midnight Cobalt", "info");
			},
		},
		{
			id: "theme-one-blue-light",
			group: "Тема",
			icon: "☀",
			label: "Тема: One Blue Light (светлая синяя)",
			keywords: "theme light blue светлая тема",
			run: () => {
				ctx.ui.setTheme("one-blue-light");
				ctx.ui.notify("Тема: One Blue Light", "info");
			},
		},
		{
			id: "session-new",
			group: "Сессия",
			icon: "＋",
			label: "Новая сессия",
			hint: "Ctrl+N",
			keywords: "new clear session новая сессия очистить",
			run: () => runAction("app.session.new"),
		},
		{
			id: "session-resume",
			group: "Сессия",
			icon: "↺",
			label: "Открыть историю сессий",
			hint: "Ctrl+R",
			keywords: "resume history sessions история сессии",
			run: () => runAction("app.session.resume"),
		},
		{
			id: "session-tree",
			group: "Сессия",
			icon: "⎇",
			label: "Дерево ветвлений диалога",
			hint: "Ctrl+Alt+T",
			keywords: "tree branches дерево ветки",
			run: () => runAction("app.session.tree"),
		},
		{
			id: "session-fork",
			group: "Сессия",
			icon: "⑂",
			label: "Ответвить диалог с выбранной реплики",
			hint: "Ctrl+Alt+F",
			keywords: "fork branch ответвить форк",
			run: () => runAction("app.session.fork"),
		},
	];

	const ownedCommands = new Set(["palette", "context", "plan", "mode", "sticky", "outline", "quote", "quotes"]);
	for (const cmd of pi.getCommands()) {
		if (ownedCommands.has(cmd.name)) continue;
		items.push({
			id: `cmd:${cmd.name}`,
			group: cmd.source === "skill" ? "Скилл" : "Команда",
			icon: cmd.source === "skill" ? "⚡" : "›",
			label: `/${cmd.name}${cmd.description ? ` — ${cmd.description}` : ""}`,
			keywords: `${cmd.name} ${cmd.description ?? ""}`,
			run: () => {
				ctx.ui.setEditorText(`/${cmd.name} `);
			},
		});
	}

	const picked = await openModalCard<PaletteItem | null>(
		ctx,
		(_tui, theme, _kb, done) => {
			const card = createModalCard();
			const searchInput = createSingleLineInput();
			let selectedIdx = 0;
			let scrollOffset = 0;
			let hoveredIdx: number | null = null;
			let rowMap = new Map<number, number>();

			const getFiltered = (): PaletteItem[] =>
				items.filter((it) =>
					fuzzyMatch(searchInput.getValue(), `${it.group} ${it.label} ${it.keywords} ${it.hint ?? ""}`),
				);

			const comp: Component & Focusable = {
				focused: true,
				capturesViewportInput: true,
				invalidate() {},
				render(width: number): string[] {
					rowMap = new Map();
					const palette = getThemeSurfacePalette(theme);
					const innerWidth = Math.max(24, width - 4);
					const filtered = getFiltered();

					if (selectedIdx >= filtered.length) selectedIdx = Math.max(0, filtered.length - 1);
					const maxVisible = 12;
					if (selectedIdx < scrollOffset) scrollOffset = selectedIdx;
					if (selectedIdx >= scrollOffset + maxVisible) scrollOffset = selectedIdx - maxVisible + 1;
					scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, filtered.length - maxVisible)));

					const searchPrompt = fgRgb(palette.accent, theme.bold("⌕ "));
					const inputRendered = searchInput.render({
						theme,
						focused: Boolean(comp.focused),
						maxWidth: Math.max(8, innerWidth - 3),
						placeholder: "Поиск команд, режимов, тем, тулзов, скиллов…",
					});
					const searchRow = truncateToWidth(` ${searchPrompt}${inputRendered}`, innerWidth, "…");

					const body: string[] = [searchRow, theme.fg("borderMuted", "─".repeat(innerWidth))];

					if (filtered.length === 0) {
						body.push(theme.fg("muted", "  Ничего не найдено"));
					} else {
						const slice = filtered.slice(scrollOffset, scrollOffset + maxVisible);
						let renderRowIdx = 3;
						for (let i = 0; i < slice.length; i++) {
							const itemIndex = scrollOffset + i;
							const item = slice[i]!;
							const isSelected = itemIndex === selectedIdx;
							const isHovered = itemIndex === hoveredIdx;

							const badge = theme.fg("dim", `[${item.group}]`);
							const rightHint = item.hint ? theme.fg("muted", ` ${item.hint} `) : "";
							const iconRgb = isSelected ? palette.accentBright : palette.accent;
							const iconPart = fgRgb(
								iconRgb,
								isSelected ? theme.bold(`${item.icon} `) : `${item.icon} `,
							);

							const availLeft = Math.max(10, innerWidth - visibleWidth(rightHint) - visibleWidth(badge) - 5);
							const mainText = truncateToWidth(
								isSelected
									? fgRgb(palette.selectedText, theme.bold(item.label))
									: theme.fg("text", item.label),
								availLeft,
								"…",
							);
							const leftComposed = ` ${iconPart}${mainText} ${badge}`;
							const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(leftComposed) - visibleWidth(rightHint)));
							let fullRow = truncateToWidth(`${leftComposed}${gap}${rightHint}`, innerWidth, "…");
							const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(fullRow)));
							fullRow += pad;

							if (isSelected) {
								fullRow = bgRgb(palette.selectedRowBg, fullRow);
							} else if (isHovered) {
								fullRow = bgRgb(palette.hoveredRowBg, fullRow);
							}

							rowMap.set(renderRowIdx, itemIndex);
							body.push(fullRow);
							renderRowIdx++;
						}
					}

					const modeMeta = MODE_META[wf.mode];
					const modeRgb =
						wf.mode === "plan" ? palette.warning : wf.mode === "safe" ? palette.info : palette.accent;
					const footer = `${fgRgb(modeRgb, `${modeMeta.icon} ${modeMeta.label}`)}  ${theme.fg("dim", "·  ↑↓ / колесо выбор  ·  Enter / клик запуск  ·  Esc закрыть")}`;

					return card.render(width, theme, {
						title: fgRgb(palette.accentBright, theme.bold("⌘ Command Palette")),
						headerMeta: theme.fg("muted", `${filtered.length}`),
						onClose: () => done(null),
						bodyLines: body,
						footerText: footer,
						borderVariant: "primary",
					});
				},
				handleInput(data: string): void {
					const filtered = getFiltered();
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+k")) {
						done(null);
						return;
					}
					if (matchesKey(data, "enter") || matchesKey(data, "return")) {
						done(filtered[selectedIdx] ?? null);
						return;
					}
					if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
						selectedIdx = Math.max(0, selectedIdx - 1);
						return;
					}
					if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
						selectedIdx = Math.min(Math.max(0, filtered.length - 1), selectedIdx + 1);
						return;
					}
					if (matchesKey(data, "pageUp")) {
						selectedIdx = Math.max(0, selectedIdx - 6);
						return;
					}
					if (matchesKey(data, "pageDown")) {
						selectedIdx = Math.min(Math.max(0, filtered.length - 1), selectedIdx + 6);
						return;
					}
					const inputRes = searchInput.handleInput(data);
					if (inputRes.changed) {
						selectedIdx = 0;
						scrollOffset = 0;
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const filtered = getFiltered();
					if (event.type === "wheel" && event.wheelDelta && filtered.length > 0) {
						const delta = event.wheelDelta < 0 ? -1 : 1;
						selectedIdx = Math.max(0, Math.min(filtered.length - 1, selectedIdx + delta));
						return { handled: true, render: true };
					}
					const cardOutcome = card.handleMouse(event);
					if (event.type === "move") {
						const nextHover = cardOutcome.handled ? null : (rowMap.get(event.y) ?? null);
						const rowChanged = nextHover !== hoveredIdx;
						hoveredIdx = nextHover;
						return { handled: true, render: cardOutcome.render || rowChanged };
					}
					if (event.type === "click" && event.button === "left") {
						if (cardOutcome.triggered) {
							return { handled: true };
						}
						const hitIdx = rowMap.get(event.y);
						if (hitIdx !== undefined && filtered[hitIdx]) {
							done(filtered[hitIdx]!);
							return { handled: true };
						}
					}
					return { handled: true, render: false };
				},
			};
			return comp;
		},
		{ width: 78, minWidth: 46, anchor: "center", margin: 2 },
	);

	if (picked) {
		await picked.run();
	}
}

export function registerCommandPaletteFeature(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+k", {
		description: "Открыть Command Palette (@conarti/pi-ui)",
		handler: async (ctx) => {
			await showCommandPalette(pi, ctx);
		},
	});

	pi.registerCommand("palette", {
		description: "Открыть центральное меню команд (Ctrl+K)",
		handler: async (_args, ctx) => {
			await showCommandPalette(pi, ctx);
		},
	});
}
