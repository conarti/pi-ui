import { homedir } from "node:os";
import { VERSION, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	formatCompactTokens,
	getThemeSurfacePalette,
	paintThemeSurfaceRow,
	themeFgRgb,
	type HitBox,
} from "../../shared/ansi.ts";
import { openModalCard } from "../../shared/modal-card.ts";
import { claimHover, copyToClipboard } from "../../shared/runtime-hooks.ts";
import { collectSessionMetrics } from "../transcript/response-metrics.ts";

export type ContextModalTab = "context" | "usage" | "session";

const BOUND_CONTEXT_MODAL_SESSION_KEY = Symbol.for("conarti.pi-ui.context-modal-session.v1");

export function bindContextMenuModalSession(pi: ExtensionAPI, ctx: ExtensionContext): void {
	(
		globalThis as Record<
			symbol,
			{ pi: ExtensionAPI; ctx: ExtensionContext } | undefined
		>
	)[BOUND_CONTEXT_MODAL_SESSION_KEY] = { pi, ctx };
}

export async function openBoundContextMenuModal(
	fallbackCtx?: ExtensionContext,
	initialTab: ContextModalTab = "context",
): Promise<boolean> {
	const bound = (
		globalThis as Record<
			symbol,
			{ pi: ExtensionAPI; ctx: ExtensionContext } | undefined
		>
	)[BOUND_CONTEXT_MODAL_SESSION_KEY];
	if (!bound) return false;
	await showContextMenuModal(bound.pi, fallbackCtx ?? bound.ctx, initialTab);
	return true;
}

interface ContextSummary {
	totalTokens: number;
	contextWindow: number;
	percent: number;
	systemTokens: number;
	messageTokens: number;
	toolTokens: number;
	freeTokens: number;
	inputTotal: number;
	outputTotal: number;
	reasoningTotal: number;
	cacheReadTotal: number;
	costTotal: number;
	modelCalls: number;
	turnCount: number;
	toolCount: number;
	skillCount: number;
	modelLabel: string;
	sessionId: string;
	sessionTitle: string;
}

function shortenPathForDisplay(cwd: string): string {
	const home = homedir();
	if (home && cwd.startsWith(home)) {
		const rest = cwd.slice(home.length);
		return rest ? `~${rest}` : "~";
	}
	return cwd;
}

export function computeLiveContextTokens(ctx: ExtensionContext): {
	usedTokens: number;
	contextWindow: number;
	percent: number;
} {
	const usage = ctx.getContextUsage?.();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200_000;
	const usedTokens = usage?.tokens ?? 0;
	const percent =
		usage?.percent ?? Math.min(100, (usedTokens / Math.max(1, contextWindow)) * 100);
	return { usedTokens, contextWindow, percent };
}

function buildContextSummary(pi: ExtensionAPI, ctx: ExtensionContext): ContextSummary {
	const { usedTokens, contextWindow, percent } = computeLiveContextTokens(ctx);
	const sysPrompt = ctx.getSystemPrompt?.() ?? "";
	const systemChars = sysPrompt.length;

	let msgChars = 0;
	let toolChars = 0;
	let inputTotal = 0;
	let outputTotal = 0;
	let reasoningTotal = 0;
	let cacheReadTotal = 0;
	let costTotal = 0;
	let modelCalls = 0;
	let turnCount = 0;

	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
	for (const entry of entries as any[]) {
		if (entry?.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role === "user") {
			turnCount += 1;
			const content =
				typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
			msgChars += content.length;
		} else if (msg.role === "assistant") {
			modelCalls += 1;
			if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "text") msgChars += (part.text ?? "").length;
					else if (part.type === "thinking") msgChars += (part.thinking ?? "").length;
					else toolChars += JSON.stringify(part).length;
				}
			}
			if (msg.usage) {
				inputTotal += msg.usage.input ?? 0;
				outputTotal += msg.usage.output ?? 0;
				reasoningTotal += msg.usage.reasoning ?? 0;
				cacheReadTotal += msg.usage.cacheRead ?? 0;
				costTotal += msg.usage.cost?.total ?? 0;
			}
		} else if (msg.role === "toolResult") {
			const content =
				typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
			toolChars += content.length;
		}
	}

	const rawSys = Math.round(systemChars / 3.8);
	const rawMsg = Math.round(msgChars / 3.8);
	const rawTool = Math.round(toolChars / 3.8);
	const rawSum = Math.max(1, rawSys + rawMsg + rawTool);
	const totalTokens = usedTokens > 0 ? usedTokens : rawSys + rawMsg + rawTool;
	const scale = totalTokens > 0 ? totalTokens / rawSum : 1;

	const systemTokens = Math.min(totalTokens, Math.round(rawSys * scale));
	const toolTokens = Math.min(Math.max(0, totalTokens - systemTokens), Math.round(rawTool * scale));
	const messageTokens = Math.max(0, totalTokens - systemTokens - toolTokens);
	const freeTokens = Math.max(0, contextWindow - totalTokens);

	const allTools = (pi as unknown as { getAllTools?: () => unknown[] }).getAllTools?.() ?? [];
	const skillMatches = sysPrompt.match(/<skill>/g);
	const skillCount = skillMatches ? skillMatches.length : 0;

	const sessionId =
		(ctx.sessionManager as unknown as { getSessionId?: () => string }).getSessionId?.() ??
		"local-session";
	const sessionTitle =
		ctx.sessionManager.getSessionName?.()?.trim() || shortenPathForDisplay(ctx.cwd);
	const modelLabel = ctx.model ? `${ctx.model.name || ctx.model.id}` : "unknown";

	return {
		totalTokens,
		contextWindow,
		percent,
		systemTokens,
		messageTokens,
		toolTokens,
		freeTokens,
		inputTotal,
		outputTotal,
		reasoningTotal,
		cacheReadTotal,
		costTotal,
		modelCalls,
		turnCount,
		toolCount: allTools.length,
		skillCount,
		modelLabel,
		sessionId,
		sessionTitle,
	};
}

function formatDurationCompact(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const sec = ms / 1000;
	if (sec < 10) return `${sec.toFixed(1)}s`;
	const whole = Math.round(sec);
	if (whole < 60) return `${whole}s`;
	const m = Math.floor(whole / 60);
	const rem = whole % 60;
	return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

function padRight(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return text + " ".repeat(width - w);
}

function padLeft(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return " ".repeat(width - w) + text;
}

const TABS: ReadonlyArray<{ id: ContextModalTab; label: string }> = [
	{ id: "context", label: "Context usage" },
	{ id: "usage", label: "Session usage" },
	{ id: "session", label: "Session info" },
];

export async function showContextMenuModal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialTab: ContextModalTab = "context",
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	await openModalCard<void>(
		ctx,
		(tui, theme, _kb, done) => {
			let activeTab: ContextModalTab = initialTab;
			let scrollOffset = 0;
			let copiedHint: string | null = null;
			let hoveredId: string | null = null;
			let hits: HitBox[] = [];
			const hoverOwner = {};
			const data = buildContextSummary(pi, ctx);
			const branch = ctx.sessionManager.getBranch?.() ?? [];
			const metricsBundle = collectSessionMetrics(branch);

			const setCopied = (msg: string) => {
				copiedHint = msg;
				tui.requestRender();
				setTimeout(() => {
					if (copiedHint === msg) {
						copiedHint = null;
						tui.requestRender();
					}
				}, 1500);
			};

			const copySessionId = () => {
				copyToClipboard(data.sessionId);
				setCopied("copied ID");
			};

			const copyAllInfo = () => {
				const summary = [
					`Title: ${data.sessionTitle}`,
					`Pi version: ${VERSION}`,
					`Session ID: ${data.sessionId}`,
					`Working directory: ${ctx.cwd}`,
					`Model: ${data.modelLabel}`,
					`Turn: ${data.turnCount}`,
					`Context: ${data.totalTokens} / ${data.contextWindow} tokens (${data.percent.toFixed(1)}%)`,
				].join("\n");
				copyToClipboard(summary);
				setCopied("copied all");
			};

			const buildBodyLines = (innerW: number, th: Theme): string[] => {
				const pal = getThemeSurfacePalette(th);
				const dim = (s: string) => themeFgRgb(th, pal.codeMetaFg, s);
				const bright = (s: string) => th.bold(th.fg("text", s));
				const val = (s: string) => th.fg("text", s);

				if (activeTab === "context") {
					const lines: string[] = [
						bright("Context"),
						"",
						`${val(`${formatCompactTokens(data.totalTokens)} / ${formatCompactTokens(data.contextWindow)} tokens (${data.percent.toFixed(2)}%)`)}`,
						dim(data.modelLabel),
						"",
					];

					/* 20x5 diamond grid (100 cells = 1% per diamond) matching Context usage view */
					const cols = Math.min(20, Math.max(10, Math.floor((innerW - 2) / 2)));
					const rows = 5;
					const totalCells = cols * rows;
					const win = Math.max(1, data.contextWindow);
					const sysCells = Math.round((data.systemTokens / win) * totalCells);
					const msgCells = Math.round((data.messageTokens / win) * totalCells);
					const toolCells = Math.round((data.toolTokens / win) * totalCells);
					const usedTotal = Math.min(
						totalCells,
						Math.max(data.totalTokens > 0 ? 1 : 0, sysCells + msgCells + toolCells),
					);

					for (let r = 0; r < rows; r++) {
						const rowDiamonds: string[] = [];
						for (let c = 0; c < cols; c++) {
							const idx = r * cols + c;
							if (idx < sysCells) {
								rowDiamonds.push(themeFgRgb(th, pal.accent, "◆"));
							} else if (idx < sysCells + msgCells) {
								rowDiamonds.push(themeFgRgb(th, pal.accentBright, "◆"));
							} else if (idx < usedTotal) {
								rowDiamonds.push(themeFgRgb(th, pal.info, "◆"));
							} else {
								rowDiamonds.push(themeFgRgb(th, pal.borderSubtle, "◇"));
							}
						}
						lines.push(rowDiamonds.join(" "));
					}

					lines.push("");
					const pct = (n: number) => `(${((n / win) * 100).toFixed(1)}%)`;
					const rowItem = (dotRgb: readonly [number, number, number] | null, name: string, tok: number) => {
						const dot = dotRgb ? themeFgRgb(th, dotRgb, "◆") : themeFgRgb(th, pal.borderSubtle, "◇");
						return `${dot} ${padRight(val(name), 22)}${dim(padLeft(`${formatCompactTokens(tok)} tokens`, 13))}  ${dim(padLeft(pct(tok), 7))}`;
					};

					lines.push(rowItem(pal.accent, "System prompt", data.systemTokens));
					lines.push(rowItem(pal.accentBright, "Messages", data.messageTokens));
					lines.push(rowItem(pal.info, "Reasoning/overhead", data.toolTokens));
					lines.push(rowItem(null, "Free", data.freeTokens));
					lines.push("");
					lines.push(dim("Already counted above"));
					lines.push(
						`${themeFgRgb(th, pal.codeMetaFg, "◈")} ${padRight(val("Tool definitions"), 22)}${dim(`${data.toolCount} tools`)}`,
					);
					if (data.skillCount > 0) {
						lines.push(
							`${themeFgRgb(th, pal.codeMetaFg, "◈")} ${padRight(val("Skills"), 22)}${dim(`${data.skillCount} skills`)}`,
						);
					}
					return lines;
				}

				if (activeTab === "usage") {
					const totalTokensAll = data.inputTotal + data.outputTotal;
					const totalWallMs = metricsBundle.records.reduce(
						(acc, r) => acc + (r.computed.totalMs || 0),
						0,
					);
					const lines: string[] = [
						bright("Session usage (since start or last resume):"),
						`  ${padRight(dim("Input tokens:"), 18)}${val(data.inputTotal.toLocaleString("en-US"))}${data.cacheReadTotal > 0 ? dim(` (${data.cacheReadTotal.toLocaleString("en-US")} cached)`) : ""}`,
						`  ${padRight(dim("Output tokens:"), 18)}${val(data.outputTotal.toLocaleString("en-US"))}${data.reasoningTotal > 0 ? dim(` (${data.reasoningTotal.toLocaleString("en-US")} reasoning)`) : ""}`,
						`  ${padRight(dim("Total tokens:"), 18)}${val(totalTokensAll.toLocaleString("en-US"))}`,
						`  ${padRight(dim("Model calls:"), 18)}${val(`${data.modelCalls}`)}${totalWallMs > 0 ? dim(` · API time: ${formatDurationCompact(totalWallMs)}`) : ""}`,
					];
					if (data.costTotal > 0) {
						lines.push(`  ${padRight(dim("Cost:"), 18)}${val(`$${data.costTotal.toFixed(4)}`)}`);
					}

					lines.push("");
					lines.push(bright("Per-turn throughput:"));
					const recent = metricsBundle.records.slice(-6);
					for (const rec of recent) {
						const ttft =
							rec.computed.ttftMs !== undefined
								? formatDurationCompact(rec.computed.ttftMs)
								: "-";
						const rate =
							rec.computed.streamTps !== undefined
								? `${Math.round(rec.computed.streamTps)} tok/s`
								: rec.computed.effectiveTps !== undefined
									? `${Math.round(rec.computed.effectiveTps)} tok/s`
									: "-";
						const dur = formatDurationCompact(rec.computed.totalMs);
						lines.push(
							`  ${dim(`#${rec.turnIndex}`)}  ${padRight(val(rec.data.model ?? data.modelLabel), 22)}${dim(`ttft ${padRight(ttft, 7)}`)}${val(padRight(rate, 11))}${dim(dur)}`,
						);
					}
					return lines;
				}

				return [
					`${bright("Session info")}   ${dim("click or drag to copy")}`,
					"",
					dim("Title:"),
					val(data.sessionTitle),
					"",
					dim("Pi version:"),
					val(`${VERSION} [stable]`),
					"",
					dim("Session ID:"),
					val(data.sessionId),
					"",
					dim("Working directory:"),
					val(ctx.cwd),
					"",
					`${dim("Model:")} ${val(data.modelLabel)}`,
					`${dim("Turn:")} ${val(String(data.turnCount))}`,
					`${dim("Context:")} ${val(`${data.totalTokens.toLocaleString("en-US")} / ${data.contextWindow.toLocaleString("en-US")} tokens (${Math.round(data.percent)}%)`)}`,
				];
			};

			const comp: Component & {
				handleInput?(data: string): void;
				handleMouse?(e: TuiMouseEvent): TuiMouseEventResult | undefined;
			} = {
				invalidate() {},
				handleInput(raw: string) {
					if (isKeyRelease(raw)) return;
					if (matchesKey(raw, "escape") || raw === "q") {
						done(undefined);
						return;
					}
					if (matchesKey(raw, "tab") || matchesKey(raw, "right")) {
						const idx = TABS.findIndex((t) => t.id === activeTab);
						activeTab = TABS[(idx + 1) % TABS.length]!.id;
						scrollOffset = 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(raw, "shift+tab") || matchesKey(raw, "left")) {
						const idx = TABS.findIndex((t) => t.id === activeTab);
						activeTab = TABS[(idx - 1 + TABS.length) % TABS.length]!.id;
						scrollOffset = 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(raw, "up")) {
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(raw, "down")) {
						scrollOffset += 1;
						tui.requestRender();
						return;
					}
					if (raw === "c") {
						copySessionId();
						return;
					}
					if (raw === "y") {
						copyAllInfo();
						return;
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const evType = String(event.type);
					if (evType === "wheel" || evType === "mouse_wheel_up" || evType === "mouse_wheel_down") {
						const delta =
							evType === "mouse_wheel_up"
								? -2
								: evType === "mouse_wheel_down"
									? 2
									: ((event as unknown as { deltaY?: number }).deltaY ?? 0) < 0
										? -2
										: 2;
						scrollOffset = Math.max(0, scrollOffset + delta);
						return { handled: true, render: true };
					}

					const matched = hits.find(
						(h) => h.y === event.y && event.x >= h.xStart && event.x <= h.xEnd,
					);

					if (event.type === "move") {
						const next = matched?.id ?? null;
						if (next) {
							claimHover(hoverOwner, () => {
								if (hoveredId !== null) {
									hoveredId = null;
									tui.requestRender();
								}
							});
						}
						if (next !== hoveredId) {
							hoveredId = next;
							return { handled: true, render: true };
						}
						return undefined;
					}

					if (event.button === "left" && matched) {
						if (event.type === "press") return { handled: true, render: false };
						if (event.type === "click") {
							matched.onClick();
							return { handled: true, render: true };
						}
					}
					return undefined;
				},
				render(width: number): string[] {
					hits = [];
					const pal = getThemeSurfacePalette(theme);
					const safeW = Math.max(36, width);
					const innerSpan = safeW - 2;
					const contentW = Math.max(20, safeW - 6);
					const edge = (s: string) => themeFgRgb(theme, pal.borderSubtle, s);
					const dim = (s: string) => themeFgRgb(theme, pal.codeMetaFg, s);
					const surface = pal.popupSurfaceBg;

					const closePlain = "[x]";
					const closeStyled = hoveredId === "close" ? theme.fg("text", closePlain) : dim(closePlain);
					const rightCapDashes = 2;
					const leftTopDashes = Math.max(1, innerSpan - visibleWidth(closePlain) - rightCapDashes);
					const closeX = 1 + leftTopDashes;
					hits.push({
						id: "close",
						xStart: closeX,
						xEnd: closeX + visibleWidth(closePlain) - 1,
						y: 0,
						onClick: () => done(undefined),
					});

					const out: string[] = [
						paintThemeSurfaceRow(
							theme,
							`${edge("╭")}${edge("─".repeat(leftTopDashes))}${closeStyled}${edge("─".repeat(rightCapDashes))}${edge("╮")}`,
							safeW,
							surface,
						),
					];

					const tabParts: string[] = [];
					let cursorX = 3;
					for (let i = 0; i < TABS.length; i++) {
						const t = TABS[i]!;
						const isAct = activeTab === t.id;
						const isHov = hoveredId === `tab:${t.id}`;
						const styled = isAct
							? theme.bold(themeFgRgb(theme, pal.accentBright, t.label))
							: isHov
								? theme.fg("text", t.label)
								: dim(t.label);
						const w = visibleWidth(t.label);
						hits.push({
							id: `tab:${t.id}`,
							xStart: cursorX,
							xEnd: cursorX + w - 1,
							y: 1,
							onClick: () => {
								activeTab = t.id;
								scrollOffset = 0;
							},
						});
						tabParts.push(styled);
						cursorX += w + 3;
					}
					const leftTabs = tabParts.join("   ");
					const tabTrailPad = Math.max(0, innerSpan - 2 - visibleWidth(leftTabs));
					out.push(
						paintThemeSurfaceRow(
							theme,
							`${edge("│")}  ${leftTabs}${" ".repeat(tabTrailPad)}${edge("│")}`,
							safeW,
							surface,
						),
					);

					out.push(
						paintThemeSurfaceRow(
							theme,
							`${edge("├")}${edge("─".repeat(innerSpan))}${edge("┤")}`,
							safeW,
							surface,
						),
					);

					const allBody = buildBodyLines(contentW, theme);
					const termRows = tui.terminal?.rows ?? 30;
					const maxVisBody = Math.max(8, Math.min(18, termRows - 10));
					const maxScroll = Math.max(0, allBody.length - maxVisBody);
					scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
					const visibleSlice = allBody.slice(scrollOffset, scrollOffset + maxVisBody);
					while (visibleSlice.length < Math.min(14, maxVisBody)) {
						visibleSlice.push("");
					}

					for (const line of visibleSlice) {
						const clipped = truncateToWidth(line, contentW, "…");
						const pad = " ".repeat(Math.max(0, contentW - visibleWidth(clipped)));
						out.push(
							paintThemeSurfaceRow(
								theme,
								`${edge("│")}  ${clipped}${pad}  ${edge("│")}`,
								safeW,
								surface,
							),
						);
					}

					out.push(
						paintThemeSurfaceRow(theme, `${edge("│")}${" ".repeat(innerSpan)}${edge("│")}`, safeW, surface),
					);

					const footRowIdx = out.length;
					const footSpecs: Array<{ id: string; key: string; desc: string; onClick: () => void }> = [
						{
							id: "f:tab",
							key: "Tab",
							desc: "switch",
							onClick: () => {
								const idx = TABS.findIndex((t) => t.id === activeTab);
								activeTab = TABS[(idx + 1) % TABS.length]!.id;
								scrollOffset = 0;
							},
						},
						{
							id: "f:scroll",
							key: "↑/↓",
							desc: "scroll",
							onClick: () => {
								scrollOffset = (scrollOffset + 3) % Math.max(1, maxScroll + 1);
							},
						},
						{
							id: "f:copy",
							key: "c",
							desc: copiedHint === "copied ID" ? "copied!" : "copy session ID",
							onClick: copySessionId,
						},
						...(activeTab === "session"
							? [
									{
										id: "f:copyall",
										key: "y",
										desc: copiedHint === "copied all" ? "copied!" : "copy all",
										onClick: copyAllInfo,
									},
								]
							: []),
						{
							id: "f:esc",
							key: "Esc",
							desc: "close",
							onClick: () => done(undefined),
						},
					];

					const sepStr = `  ${edge("│")}  `;
					const sepW = visibleWidth(sepStr);
					const renderedItems = footSpecs.map((item) => {
						const isHov = hoveredId === item.id;
						const k = theme.bold(theme.fg("text", item.key));
						const d = isHov ? theme.fg("text", item.desc) : dim(item.desc);
						return { ...item, str: `${k} ${d}`, w: visibleWidth(item.key) + 1 + visibleWidth(item.desc) };
					});
					const totalFootW = renderedItems.reduce(
						(acc, it, idx) => acc + it.w + (idx > 0 ? sepW : 0),
						0,
					);
					const leftCenterPad = Math.max(2, Math.floor((innerSpan - totalFootW) / 2));
					let fx = 1 + leftCenterPad;
					for (let i = 0; i < renderedItems.length; i++) {
						const it = renderedItems[i]!;
						hits.push({
							id: it.id,
							xStart: fx,
							xEnd: fx + it.w - 1,
							y: footRowIdx,
							onClick: it.onClick,
						});
						fx += it.w + sepW;
					}
					const footJoined = renderedItems.map((it) => it.str).join(sepStr);
					const rightCenterPad = Math.max(0, innerSpan - leftCenterPad - visibleWidth(footJoined));
					out.push(
						paintThemeSurfaceRow(
							theme,
							`${edge("│")}${" ".repeat(leftCenterPad)}${footJoined}${" ".repeat(rightCenterPad)}${edge("│")}`,
							safeW,
							surface,
						),
					);

					out.push(
						paintThemeSurfaceRow(theme, `${edge("╰")}${edge("─".repeat(innerSpan))}${edge("╯")}`, safeW, surface),
					);
					return out;
				},
			};

			return comp;
		},
		{
			width: Math.min(78, Math.max(48, (ctx.hasUI ? 72 : 68))),
		},
	);
}
