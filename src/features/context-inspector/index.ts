import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	fgRgb,
	formatCompactTokens,
	renderCardFrame,
	renderPill,
	type HitBox,
} from "../../shared/ansi.ts";

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

	const action = await ctx.ui.custom<"close" | "compact">(
		(_tui, theme, _kb, done) => {
			let hoveredId: string | null = null;
			let hitboxes: HitBox[] = [];
			let closeHit: { xStart: number; xEnd: number } | null = null;

			const comp: Component = {
				invalidate() {},
				render(width: number): string[] {
					hitboxes = [];
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

					const segSys = fgRgb(97, 175, 239, "█".repeat(Math.min(barWidth, sysCells)));
					const remAfterSys = Math.max(0, barWidth - sysCells);
					const segChat = fgRgb(86, 182, 194, "█".repeat(Math.min(remAfterSys, chatCells)));
					const remAfterChat = Math.max(0, remAfterSys - chatCells);
					const segTool = fgRgb(122, 162, 247, "█".repeat(Math.min(remAfterChat, toolCells)));
					const segFree = fgRgb(52, 62, 80, "░".repeat(freeCells));
					const segReserve = fgRgb(229, 192, 123, "▒".repeat(reserveCells));

					const pctColor =
						data.percent >= 85 ? [224, 108, 117] : data.percent >= 65 ? [229, 192, 123] : [97, 175, 239];
					const pctBadge = fgRgb(pctColor[0]!, pctColor[1]!, pctColor[2]!, theme.bold(`${data.percent.toFixed(1)}%`));
					const cacheRatio =
						data.inputTotal + data.cacheReadTotal > 0
							? Math.round((data.cacheReadTotal / (data.inputTotal + data.cacheReadTotal)) * 100)
							: 0;

					const body: string[] = [
						`${theme.bold(data.modelLabel)}  ${theme.fg("dim", "·")}  ${pctBadge} ${theme.fg("muted", `(${formatCompactTokens(data.totalTokens)} / ${formatCompactTokens(data.contextWindow)} tokens)`)}`,
						"",
						` ${segSys}${segChat}${segTool}${segFree}${segReserve}`,
						"",
						` ${fgRgb(97, 175, 239, "●")} System & Skills   ${theme.bold(formatCompactTokens(data.systemTokensEst).padStart(6))}   ${theme.fg("dim", "системный промпт, правила и скиллы")}`,
						` ${fgRgb(86, 182, 194, "●")} Диалог            ${theme.bold(formatCompactTokens(data.chatTokensEst).padStart(6))}   ${theme.fg("dim", `сообщения и рассуждения (${data.turnCount} реплик)`)}`,
						` ${fgRgb(122, 162, 247, "●")} Инструменты       ${theme.bold(formatCompactTokens(data.toolTokensEst).padStart(6))}   ${theme.fg("dim", "вызовы и результаты тулзов")}`,
						` ${fgRgb(229, 192, 123, "▒")} Буфер компакта    ${theme.bold(formatCompactTokens(data.reserveTokens).padStart(6))}   ${theme.fg("dim", "резерв до авто-сжатия")}`,
						"",
						` ${theme.fg("muted", "Сессия:")} in ${formatCompactTokens(data.inputTotal)} · cache ${formatCompactTokens(data.cacheReadTotal)} (${cacheRatio}%) · out ${formatCompactTokens(data.outputTotal)}${data.costTotal > 0 ? ` · $${data.costTotal.toFixed(3)}` : ""}`,
					];

					const btnCompact = renderPill("⚡ Сжать контекст (c)", {
						hovered: hoveredId === "compact",
						active: true,
						rgb: [97, 175, 239],
						theme,
					});
					const btnClose = renderPill("✕ Закрыть (Esc)", {
						hovered: hoveredId === "close",
						theme,
					});
					const footerLine = `${btnCompact}  ${btnClose}`;
					const footerRow = body.length + 2;

					let cursorX = 2;
					const wCompact = visibleWidth(btnCompact);
					hitboxes.push({
						id: "compact",
						xStart: cursorX,
						xEnd: cursorX + wCompact,
						y: footerRow,
						onClick: () => done("compact"),
					});
					cursorX += wCompact + 2;
					const wClose = visibleWidth(btnClose);
					hitboxes.push({
						id: "close",
						xStart: cursorX,
						xEnd: cursorX + wClose,
						y: footerRow,
						onClick: () => done("close"),
					});

					const rightHint = hoveredId === "top-close" ? fgRgb(224, 108, 117, "✕") : theme.fg("muted", "✕");
					closeHit = { xStart: Math.max(0, width - 5), xEnd: width - 1 };

					return renderCardFrame(
						fgRgb(125, 207, 255, theme.bold("◐ Context Inspector")),
						rightHint,
						body,
						footerLine,
						width,
						theme,
						[97, 175, 239],
					);
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
					if (event.type === "move") {
						let nextHover: string | null = null;
						if (event.y === 0 && closeHit && event.x >= closeHit.xStart && event.x <= closeHit.xEnd) {
							nextHover = "top-close";
						} else {
							const hit = hitboxes.find((h) => h.y === event.y && event.x >= h.xStart && event.x < h.xEnd);
							if (hit) nextHover = hit.id;
						}
						if (nextHover !== hoveredId) {
							hoveredId = nextHover;
							return { handled: true, render: true };
						}
						return { handled: true, render: false };
					}
					if (event.type === "click" && event.button === "left") {
						if (event.y === 0 && closeHit && event.x >= closeHit.xStart && event.x <= closeHit.xEnd) {
							done("close");
							return { handled: true };
						}
						const hit = hitboxes.find((h) => h.y === event.y && event.x >= h.xStart && event.x < h.xEnd);
						if (hit) {
							hit.onClick();
							return { handled: true };
						}
					}
					return { handled: true, render: false };
				},
			};
			return comp;
		},
		{
			overlay: true,
			overlayOptions: { width: 76, minWidth: 44, anchor: "center", margin: 2 },
		},
	);

	if (action === "compact") {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Дождись завершения ответа перед сжатием контекста", "warning");
			return;
		}
		ctx.ui.notify("Сжимаю контекст…", "info");
		ctx.compact({
			onComplete: () => ctx.ui.notify("Контекст успешно сжат", "info"),
			onError: (err) => ctx.ui.notify(`Ошибка сжатия: ${err.message}`, "error"),
		});
	}
}
