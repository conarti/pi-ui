import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, formatCompactTokens } from "../../shared/ansi.ts";
import { t } from "../../shared/i18n.ts";
import { createModalCard, getThemeSurfacePalette, openModalCard } from "../../shared/modal-card.ts";

interface ContextBreakdown {
	totalTokens: number;
	contextWindow: number;
	percent: number;
	systemTokensEst: number;
	chatTokensEst: number;
	toolTokensEst: number;
	reserveTokens: number;
	inputTotal: number;
	outputTotal: number;
	cacheReadTotal: number;
	costTotal: number;
	turnCount: number;
	modelLabel: string;
}

function computeBreakdown(pi: ExtensionAPI, ctx: ExtensionContext): ContextBreakdown {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200_000;
	const sysPrompt = ctx.getSystemPrompt?.() ?? "";
	const systemChars = sysPrompt.length;

	let userChars = 0;
	let assistantChars = 0;
	let toolChars = 0;
	let inputTotal = 0;
	let outputTotal = 0;
	let cacheReadTotal = 0;
	let costTotal = 0;
	let turnCount = 0;

	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
	for (const entry of entries as any[]) {
		if (entry?.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role === "user") {
			turnCount++;
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
			userChars += content.length;
		} else if (msg.role === "assistant") {
			if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "text") assistantChars += (part.text ?? "").length;
					else if (part.type === "thinking") assistantChars += (part.thinking ?? "").length;
					else toolChars += JSON.stringify(part).length;
				}
			}
			if (msg.usage) {
				inputTotal += msg.usage.input ?? 0;
				outputTotal += msg.usage.output ?? 0;
				cacheReadTotal += msg.usage.cacheRead ?? 0;
				costTotal += msg.usage.cost?.total ?? 0;
			}
		} else if (msg.role === "toolResult") {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
			toolChars += content.length;
		}
	}

	const rawSys = Math.round(systemChars / 3.8);
	const rawChat = Math.round((userChars + assistantChars) / 3.8);
	const rawTools = Math.round(toolChars / 3.8);
	const rawSum = Math.max(1, rawSys + rawChat + rawTools);

	const totalTokens = usage?.tokens ?? rawSys + rawChat + rawTools;
	const scale = totalTokens > 0 ? totalTokens / rawSum : 1;

	const systemTokensEst = Math.min(totalTokens, Math.round(rawSys * scale));
	const toolTokensEst = Math.min(Math.max(0, totalTokens - systemTokensEst), Math.round(rawTools * scale));
	const chatTokensEst = Math.max(0, totalTokens - systemTokensEst - toolTokensEst);

	const settings = pi.getSettings?.() as any;
	const reserveTokens = settings?.compaction?.reserveTokens ?? 16_384;
	const percent = usage?.percent ?? Math.min(100, (totalTokens / Math.max(1, contextWindow)) * 100);
	const modelLabel = ctx.model ? `${ctx.model.name || ctx.model.id}` : "unknown";

	return {
		totalTokens,
		contextWindow,
		percent,
		systemTokensEst,
		chatTokensEst,
		toolTokensEst,
		reserveTokens,
		inputTotal,
		outputTotal,
		cacheReadTotal,
		costTotal,
		turnCount,
		modelLabel,
	};
}

export async function showContextInspector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	const data = computeBreakdown(pi, ctx);

	const action = await openModalCard<"close" | "compact">(
		ctx,
		(_tui, theme, _kb, done) => {
			const card = createModalCard();

			const comp: Component = {
				invalidate() {},
				render(width: number): string[] {
					const palette = getThemeSurfacePalette(theme);
					const inner = Math.max(24, width - 4);
					const barWidth = Math.max(16, inner - 2);
					const win = Math.max(1, data.contextWindow);

					const sysCells = Math.max(data.systemTokensEst > 0 ? 1 : 0, Math.round((data.systemTokensEst / win) * barWidth));
					const chatCells = Math.max(data.chatTokensEst > 0 ? 1 : 0, Math.round((data.chatTokensEst / win) * barWidth));
					const toolCells = Math.max(data.toolTokensEst > 0 ? 1 : 0, Math.round((data.toolTokensEst / win) * barWidth));
					const reserveCells = Math.min(
						Math.max(1, Math.round((data.reserveTokens / win) * barWidth)),
						Math.max(0, barWidth - sysCells - chatCells - toolCells),
					);
					const usedCells = Math.min(barWidth, sysCells + chatCells + toolCells);
					const freeCells = Math.max(0, barWidth - usedCells - reserveCells);

					const segSys = fgRgb(palette.accent, "█".repeat(Math.min(barWidth, sysCells)));
					const remAfterSys = Math.max(0, barWidth - sysCells);
					const segChat = fgRgb(palette.info, "█".repeat(Math.min(remAfterSys, chatCells)));
					const remAfterChat = Math.max(0, remAfterSys - chatCells);
					const segTool = fgRgb(palette.accentBright, "█".repeat(Math.min(remAfterChat, toolCells)));
					const segFree = fgRgb(palette.freeBar, "░".repeat(freeCells));
					const segReserve = fgRgb(palette.warning, "▒".repeat(reserveCells));

					const pctColor =
						data.percent >= 85 ? palette.danger : data.percent >= 65 ? palette.warning : palette.accent;
					const pctBadge = fgRgb(pctColor, theme.bold(`${data.percent.toFixed(1)}%`));
					const cacheRatio =
						data.inputTotal + data.cacheReadTotal > 0
							? Math.round((data.cacheReadTotal / (data.inputTotal + data.cacheReadTotal)) * 100)
							: 0;

					const body: string[] = [
						`${theme.bold(data.modelLabel)}  ${theme.fg("dim", "·")}  ${pctBadge} ${theme.fg("muted", t("context.tokensSummary", { used: formatCompactTokens(data.totalTokens), window: formatCompactTokens(data.contextWindow) }))}`,
						"",
						` ${segSys}${segChat}${segTool}${segFree}${segReserve}`,
						"",
						` ${fgRgb(palette.accent, "●")} ${t("context.row.system").padEnd(17)} ${theme.bold(formatCompactTokens(data.systemTokensEst).padStart(6))}   ${theme.fg("dim", t("context.row.systemDesc"))}`,
						` ${fgRgb(palette.info, "●")} ${t("context.row.chat").padEnd(17)} ${theme.bold(formatCompactTokens(data.chatTokensEst).padStart(6))}   ${theme.fg("dim", t("context.row.chatDesc", { turns: data.turnCount }))}`,
						` ${fgRgb(palette.accentBright, "●")} ${t("context.row.tools").padEnd(17)} ${theme.bold(formatCompactTokens(data.toolTokensEst).padStart(6))}   ${theme.fg("dim", t("context.row.toolsDesc"))}`,
						` ${fgRgb(palette.warning, "▒")} ${t("context.row.reserve").padEnd(17)} ${theme.bold(formatCompactTokens(data.reserveTokens).padStart(6))}   ${theme.fg("dim", t("context.row.reserveDesc"))}`,
						"",
						` ${theme.fg("muted", t("context.sessionLine"))} in ${formatCompactTokens(data.inputTotal)} · cache ${formatCompactTokens(data.cacheReadTotal)} (${cacheRatio}%) · out ${formatCompactTokens(data.outputTotal)}${data.costTotal > 0 ? ` · $${data.costTotal.toFixed(3)}` : ""}`,
					];

					return card.render(width, theme, {
						title: fgRgb(palette.accentBright, theme.bold(t("context.title"))),
						onClose: () => done("close"),
						bodyLines: body,
						borderVariant: "primary",
						footerPills: [
							{
								id: "compact",
								label: t("context.pill.compact"),
								variant: "primary",
								active: true,
								onClick: () => done("compact"),
							},
							{
								id: "close",
								label: t("context.pill.close"),
								variant: "neutral",
								onClick: () => done("close"),
							},
						],
					});
				},
				handleInput(input: string): void {
					if (matchesKey(input, "escape") || matchesKey(input, "q") || matchesKey(input, "enter")) {
						done("close");
						return;
					}
					if (input === "c" || input === "C") {
						done("compact");
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const outcome = card.handleMouse(event);
					return { handled: true, render: outcome.render };
				},
			};
			return comp;
		},
		{ width: 76, minWidth: 44, anchor: "center", margin: 2 },
	);

	if (action === "compact") {
		if (!ctx.isIdle()) {
			ctx.ui.notify(t("context.compactBusy"), "warning");
			return;
		}
		ctx.ui.notify(t("palette.compactStarted"), "info");
		ctx.compact({
			onComplete: () => ctx.ui.notify(t("context.compactDone"), "info"),
			onError: (err) => ctx.ui.notify(t("palette.compactError", { message: err.message }), "error"),
		});
	}
}
