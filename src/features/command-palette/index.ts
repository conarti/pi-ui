import {
	ExtensionRunner,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { bgRgb, fgRgb } from "../../shared/ansi.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import {
	createBracketedPasteTracker,
	matchesLayoutChord,
} from "../../shared/keyboard-layout.ts";
import {
	createModalCard,
	createSingleLineInput,
	getThemeSurfacePalette,
	hasBlockingModalOverlay,
	openModalCard,
} from "../../shared/modal-card.ts";
import {
	loadPiUiUserConfig,
	TIMESTAMP_DISPLAY_MODES,
	TOOL_DENSITY_PRESETS,
	updatePiUiUserConfig,
} from "../../shared/pi-ui-config.ts";
import { claimHover, hookMethod } from "../../shared/runtime-hooks.ts";
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
	const tStr = target.toLowerCase();
	if (tStr.includes(q)) return true;
	let qi = 0;
	for (let i = 0; i < tStr.length && qi < q.length; i++) {
		if (tStr[i] === q[qi]) qi++;
	}
	return qi === q.length;
}

export async function showCommandPalette(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	const wf = getSessionWorkflow();
	const stickyCfg = getStickyConfig();
	const outlineCfg = getOutlineSettings();
	const userCfg = loadPiUiUserConfig();

	const runAction = (actionId: string) => {
		runAppAction(actionId);
	};

	const items: PaletteItem[] = [
		{
			id: "mode-plan",
			group: t("palette.group.mode"),
			icon: "◈",
			label: wf.mode === "plan" ? t("palette.item.planModeOff") : t("palette.item.planModeOn"),
			hint: "Shift+Tab",
			keywords: "plan mode always-approve planning",
			run: () => setSessionMode(pi, ctx, wf.mode === "plan" ? "always-approve" : "plan"),
		},
		{
			id: "plan-studio",
			group: t("palette.group.mode"),
			icon: "📋",
			label:
				wf.planLines.length > 0
					? t("palette.item.planStudioWithLines", { count: wf.planLines.length })
					: t("palette.item.planStudio"),
			hint: "/plan",
			keywords: "plan studio review comments",
			run: () => showPlanStudio(pi, ctx),
		},
		{
			id: "mode-auto",
			group: t("palette.group.mode"),
			icon: "🛡",
			label: wf.mode === "auto" ? t("palette.item.autoModeOff") : t("palette.item.autoModeOn"),
			hint: "/auto",
			keywords: "auto mode confirm permission always-approve",
			run: () => setSessionMode(pi, ctx, wf.mode === "auto" ? "always-approve" : "auto"),
		},
		{
			id: "context",
			group: t("palette.group.context"),
			icon: "◐",
			label: t("palette.item.contextInspector"),
			hint: "/context",
			keywords: "context tokens usage cost inspector",
			run: () => showContextInspector(pi, ctx),
		},
		{
			id: "compact",
			group: t("palette.group.context"),
			icon: "⚡",
			label: t("palette.item.compact"),
			hint: "/compact",
			keywords: "compact compress context history",
			run: () => {
				if (!ctx.isIdle()) {
					ctx.ui.notify(t("palette.compactBusy"), "warning");
					return;
				}
				ctx.ui.notify(t("palette.compactStarted"), "info");
				ctx.compact({
					onComplete: () => ctx.ui.notify(t("palette.compactDone"), "info"),
					onError: (e) => ctx.ui.notify(t("palette.compactError", { message: e.message }), "error"),
				});
			},
		},
		{
			id: "toggle-sticky",
			group: t("palette.group.ui"),
			icon: "📌",
			label: t("palette.item.stickyToggle", {
				action: stickyCfg.enabled ? t("palette.action.disable") : t("palette.action.enable"),
			}),
			hint: "/sticky",
			keywords: "sticky header prompt top",
			run: () => {
				stickyCfg.enabled = !stickyCfg.enabled;
				requestRender();
				ctx.ui.notify(
					t("sticky.toggled", { state: stickyCfg.enabled ? t("state.on") : t("state.off") }),
					"info",
				);
			},
		},
		{
			id: "toggle-outline",
			group: t("palette.group.ui"),
			icon: "☰",
			label: t("palette.item.outlineToggle", {
				action: outlineCfg.enabled ? t("palette.action.hide") : t("palette.action.show"),
			}),
			hint: "Ctrl+Alt+O",
			keywords: "outline rail navigation turns",
			run: () => {
				outlineCfg.enabled = !outlineCfg.enabled;
				requestRender();
				ctx.ui.notify(
					t("outline.toggled", { state: outlineCfg.enabled ? t("state.shown") : t("state.hidden") }),
					"info",
				);
			},
		},
		{
			id: "cycle-tool-density",
			group: t("palette.group.settings"),
			icon: "▤",
			label: t("palette.item.densityCycle", { current: userCfg.toolDensity }),
			hint: "/density",
			keywords: "tool density balanced compact grouped diff-focus detailed",
			run: () => {
				const cur = loadPiUiUserConfig().toolDensity;
				const next =
					TOOL_DENSITY_PRESETS[(TOOL_DENSITY_PRESETS.indexOf(cur) + 1) % TOOL_DENSITY_PRESETS.length]!;
				updatePiUiUserConfig({ toolDensity: next });
				requestRender();
				ctx.ui.notify(t("config.updated", { setting: "Tool Density", value: next }), "info");
			},
		},
		{
			id: "toggle-prompt-suggestions",
			group: t("palette.group.settings"),
			icon: "✦",
			label: t("palette.item.suggestionsToggle", {
				action: userCfg.promptSuggestions
					? t("palette.action.disable")
					: t("palette.action.enable"),
			}),
			hint: "/suggestions",
			keywords: "prompt suggestions follow-up background tokens",
			run: () => {
				const next = !loadPiUiUserConfig().promptSuggestions;
				updatePiUiUserConfig({ promptSuggestions: next });
				requestRender();
				ctx.ui.notify(
					t("suggestions.toggled", { state: next ? t("state.on") : t("state.off") }),
					"info",
				);
			},
		},
		{
			id: "toggle-shortcuts-bar",
			group: t("palette.group.settings"),
			icon: "⌨",
			label: t("palette.item.shortcutsBarToggle", {
				action: userCfg.showShortcutsBar
					? t("palette.action.hide")
					: t("palette.action.show"),
			}),
			hint: "/shortcuts-bar",
			keywords: "shortcuts bar hints footer",
			run: () => {
				const next = !loadPiUiUserConfig().showShortcutsBar;
				updatePiUiUserConfig({ showShortcutsBar: next });
				requestRender();
				ctx.ui.notify(
					t("shortcutsBar.toggled", { state: next ? t("state.on") : t("state.off") }),
					"info",
				);
			},
		},
		{
			id: "toggle-response-metrics",
			group: t("palette.group.settings"),
			icon: "⏱",
			label: t("palette.item.responseMetricsToggle", {
				action: userCfg.responseMetrics
					? t("palette.action.disable")
					: t("palette.action.enable"),
			}),
			keywords: "response metrics latency throughput duration",
			run: () => {
				const next = !loadPiUiUserConfig().responseMetrics;
				updatePiUiUserConfig({ responseMetrics: next });
				requestRender();
				ctx.ui.notify(
					t("config.updated", {
						setting: "Response Metrics",
						value: next ? t("state.on") : t("state.off"),
					}),
					"info",
				);
			},
		},
		{
			id: "toggle-copy-on-select",
			group: t("palette.group.settings"),
			icon: "⎘",
			label: t("palette.item.copyOnSelectToggle", {
				action: userCfg.copyOnSelect
					? t("palette.action.disable")
					: t("palette.action.enable"),
			}),
			keywords: "copy on select clipboard selection",
			run: () => {
				const next = !loadPiUiUserConfig().copyOnSelect;
				updatePiUiUserConfig({ copyOnSelect: next });
				requestRender();
				ctx.ui.notify(
					t("config.updated", {
						setting: "Copy on Select",
						value: next ? t("state.on") : t("state.off"),
					}),
					"info",
				);
			},
		},
		{
			id: "cycle-timestamps",
			group: t("palette.group.settings"),
			icon: "🕒",
			label: t("palette.item.timestampsCycle", { current: userCfg.timestamps }),
			keywords: "timestamps datetime time off",
			run: () => {
				const cur = loadPiUiUserConfig().timestamps;
				const next =
					TIMESTAMP_DISPLAY_MODES[
						(TIMESTAMP_DISPLAY_MODES.indexOf(cur) + 1) % TIMESTAMP_DISPLAY_MODES.length
					]!;
				updatePiUiUserConfig({ timestamps: next });
				requestRender();
				ctx.ui.notify(t("config.updated", { setting: "Timestamps", value: next }), "info");
			},
		},
		{
			id: "toggle-mid-turn-enter",
			group: t("palette.group.settings"),
			icon: "↵",
			label: t("palette.item.midTurnEnterCycle", { current: userCfg.midTurnEnter }),
			keywords: "mid turn enter queue steer composer",
			run: () => {
				const next = loadPiUiUserConfig().midTurnEnter === "queue" ? "steer" : "queue";
				updatePiUiUserConfig({ midTurnEnter: next });
				requestRender();
				ctx.ui.notify(t("config.updated", { setting: "Mid-turn Enter", value: next }), "info");
			},
		},
		{
			id: "toggle-ai-working-status",
			group: t("palette.group.settings"),
			icon: "✧",
			label: t("palette.item.aiWorkingStatusToggle", {
				action: userCfg.aiWorkingStatus
					? t("palette.action.disable")
					: t("palette.action.enable"),
			}),
			keywords: "ai working status background llm",
			run: () => {
				const next = !loadPiUiUserConfig().aiWorkingStatus;
				updatePiUiUserConfig({ aiWorkingStatus: next });
				requestRender();
				ctx.ui.notify(
					t("config.updated", {
						setting: "AI Working Status",
						value: next ? t("state.on") : t("state.off"),
					}),
					"info",
				);
			},
		},
		{
			id: "model-select",
			group: t("palette.group.model"),
			icon: "✦",
			label: t("palette.item.modelSelect", {
				model: ctx.model?.name || ctx.model?.id || "current",
			}),
			hint: "Ctrl+L",
			keywords: "model select provider",
			run: () => runAction("app.model.select"),
		},
		{
			id: "thinking-cycle",
			group: t("palette.group.model"),
			icon: "⚡",
			label: t("palette.item.thinkingCycle", { level: pi.getThinkingLevel() }),
			hint: "Alt+T",
			keywords: "thinking reasoning effort level",
			run: () => runAction("app.thinking.cycle"),
		},
		{
			id: "thinking-toggle",
			group: t("palette.group.view"),
			icon: "💭",
			label: t("palette.item.thinkingToggle"),
			hint: "Ctrl+T",
			keywords: "thinking toggle hide show",
			run: () => runAction("app.thinking.toggle"),
		},
		{
			id: "tools-toggle",
			group: t("palette.group.view"),
			icon: "🔧",
			label: t("palette.item.toolsToggle"),
			hint: "Ctrl+O",
			keywords: "tools expand collapse output",
			run: () => runAction("app.tools.expand"),
		},
		{
			id: "theme-one-blue",
			group: t("palette.group.theme"),
			icon: "🎨",
			label: t("palette.item.themeOneBluePro"),
			keywords: "theme blue one dark slate",
			run: () => {
				ctx.ui.setTheme("one-blue-pro");
				ctx.ui.notify(t("palette.themeApplied", { name: "One Blue Pro" }), "info");
			},
		},
		{
			id: "theme-nordic-ocean",
			group: t("palette.group.theme"),
			icon: "🌊",
			label: t("palette.item.themeNordicOcean"),
			keywords: "theme nordic ocean arctic blue",
			run: () => {
				ctx.ui.setTheme("nordic-ocean");
				ctx.ui.notify(t("palette.themeApplied", { name: "Nordic Ocean" }), "info");
			},
		},
		{
			id: "theme-midnight-cobalt",
			group: t("palette.group.theme"),
			icon: "🌌",
			label: t("palette.item.themeMidnightCobalt"),
			keywords: "theme midnight cobalt electric blue",
			run: () => {
				ctx.ui.setTheme("midnight-cobalt");
				ctx.ui.notify(t("palette.themeApplied", { name: "Midnight Cobalt" }), "info");
			},
		},
		{
			id: "theme-one-blue-light",
			group: t("palette.group.theme"),
			icon: "☀",
			label: t("palette.item.themeOneBlueLight"),
			keywords: "theme light blue bright",
			run: () => {
				ctx.ui.setTheme("one-blue-light");
				ctx.ui.notify(t("palette.themeApplied", { name: "One Blue Light" }), "info");
			},
		},
		{
			id: "session-new",
			group: t("palette.group.session"),
			icon: "＋",
			label: t("palette.item.sessionNew"),
			hint: "Ctrl+N",
			keywords: "new clear session",
			run: () => runAction("app.session.new"),
		},
		{
			id: "session-resume",
			group: t("palette.group.session"),
			icon: "↺",
			label: t("palette.item.sessionResume"),
			hint: "Ctrl+R",
			keywords: "resume history sessions",
			run: () => runAction("app.session.resume"),
		},
		{
			id: "session-tree",
			group: t("palette.group.session"),
			icon: "⎇",
			label: t("palette.item.sessionTree"),
			hint: "Ctrl+Alt+T",
			keywords: "tree branches session",
			run: () => runAction("app.session.tree"),
		},
		{
			id: "session-fork",
			group: t("palette.group.session"),
			icon: "⑂",
			label: t("palette.item.sessionFork"),
			hint: "Ctrl+Alt+F",
			keywords: "fork branch session",
			run: () => runAction("app.session.fork"),
		},
	];

	const ownedCommands = new Set([
		"palette",
		"context",
		"plan",
		"auto",
		"always-approve",
		"mode",
		"sticky",
		"outline",
		"quote",
		"quotes",
		"density",
		"suggestions",
		"shortcuts-bar",
		"slots",
	]);
	for (const cmd of pi.getCommands()) {
		if (ownedCommands.has(cmd.name)) continue;
		items.push({
			id: `cmd:${cmd.name}`,
			group: cmd.source === "skill" ? t("palette.group.skill") : t("palette.group.command"),
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
			const rowHoverOwner = {};
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
						placeholder: t("palette.searchPlaceholder"),
					});
					const searchRow = truncateToWidth(` ${searchPrompt}${inputRendered}`, innerWidth, "…");

					const body: string[] = [searchRow, theme.fg("borderMuted", "─".repeat(innerWidth))];

					if (filtered.length === 0) {
						body.push(theme.fg("muted", t("palette.empty")));
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
						wf.mode === "plan" ? palette.warning : wf.mode === "auto" ? palette.info : palette.accent;
					const footer = `${fgRgb(modeRgb, `${modeMeta.icon} ${modeMeta.label}`)}  ${theme.fg("dim", t("palette.footerHint"))}`;

					return card.render(width, theme, {
						title: fgRgb(palette.accentBright, theme.bold(t("palette.title"))),
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
						if (nextHover !== null) {
							claimHover(rowHoverOwner, () => {
								hoveredIdx = null;
							});
						}
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

function installCtrlKDiagnosticFilter(): void {
	const proto = (ExtensionRunner as unknown as { prototype?: object } | undefined)?.prototype;
	if (!proto) return;

	/* Убираем ctrl+k из карты шорткатов ExtensionRunner, чтобы хост не выводил предупреждение о конфликте с deleteToLineEnd */
	hookMethod(proto, "getShortcuts", "commandPalette.filterCtrlKConflict", (self, args, original) => {
		const extensions = (self as { extensions?: Array<{ shortcuts?: Map<string, { description?: string }> }> })
			.extensions;
		if (Array.isArray(extensions)) {
			for (const ext of extensions) {
				const ctrlK = ext.shortcuts?.get("ctrl+k");
				if (ctrlK?.description?.includes("Command Palette")) {
					ext.shortcuts?.delete("ctrl+k");
				}
			}
		}
		return original.apply(self, args);
	});
}

export function registerCommandPaletteFeature(pi: ExtensionAPI): void {
	installCtrlKDiagnosticFilter();
	let unsubscribeInput: (() => void) | undefined;

	pi.registerShortcut("ctrl+k", {
		description: t("palette.shortcut"),
		handler: async (ctx) => {
			await showCommandPalette(pi, ctx);
		},
	});

	pi.registerCommand("palette", {
		description: t("palette.command"),
		handler: async (_args, ctx) => {
			await showCommandPalette(pi, ctx);
		},
	});

	/* Ctrl+K зарезервирован в Pi под tui.editor.deleteToLineEnd (restrictOverride: true), поэтому перехватываем напрямую на входе TUI */
	pi.on("session_start", (_event, ctx) => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		const pasteTracker = createBracketedPasteTracker();
		const isCtrlKInput = (seq: string): boolean =>
			Boolean(seq) &&
			!isKeyRelease(seq) &&
			!isKeyRepeat(seq) &&
			(matchesKey(seq, "ctrl+k") || matchesLayoutChord(seq, "ctrl+k"));

		const resolveCtrlKDisposition = (): "passthrough" | "consume" | "open" => {
			const hostTui = getActiveHostRuntime()?.tui;
			if (hostTui) {
				const inspectable = hostTui as TUI & { getTopmostVisibleOverlay?: () => unknown };
				if (
					typeof inspectable.getTopmostVisibleOverlay === "function" &&
					inspectable.getTopmostVisibleOverlay()
				) {
					return "passthrough";
				}
				if (hasBlockingModalOverlay(hostTui)) {
					return "consume";
				}
			}
			return "open";
		};

		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const segments = pasteTracker.split(data);
			if (segments.length === 0 || segments.every((seg) => seg.inPaste)) {
				return undefined;
			}

			if (segments.length === 1) {
				if (!isCtrlKInput(data)) {
					return undefined;
				}
				const disposition = resolveCtrlKDisposition();
				if (disposition === "passthrough") return undefined;
				if (disposition === "open") {
					void showCommandPalette(pi, ctx);
				}
				return { consume: true };
			}

			let matchedCtrlK = false;
			let forwarded = "";
			for (const seg of segments) {
				if (!seg.inPaste && isCtrlKInput(seg.text)) {
					matchedCtrlK = true;
				} else {
					forwarded += seg.text;
				}
			}
			if (!matchedCtrlK) {
				return undefined;
			}

			const disposition = resolveCtrlKDisposition();
			if (disposition === "passthrough") {
				return undefined;
			}
			if (!forwarded) {
				if (disposition === "open") {
					void showCommandPalette(pi, ctx);
				}
				return { consume: true };
			}
			if (disposition === "open") {
				queueMicrotask(() => {
					if (resolveCtrlKDisposition() === "open") {
						void showCommandPalette(pi, ctx);
					}
				});
			}
			return { data: forwarded };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
	});
}
