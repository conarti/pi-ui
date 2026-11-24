import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fgRgb, renderPill, type HitBox } from "../../shared/ansi.ts";
import {
	getStore,
	MODE_META,
	persistSessionStore,
	type PlanStep,
	type SessionMode,
} from "../../shared/session-store.ts";
import { confirmSafeToolCall, showPlanStudio } from "./studio-overlay.ts";

const WRITE_TOOLS = new Set(["edit", "write"]);

const DESTRUCTIVE_BASH_RE =
	/(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|dd|mkfs|kill|pkill|killall|sudo|brew|apt|yum|pacman|npm\s+(?:i|install|un|uninstall|publish|ci)|pnpm\s+(?:add|i|install|remove)|yarn\s+(?:add|remove)|git\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|tag)|sed\s+-i|perl\s+-i|tee\b)/i;

const REDIRECT_WRITE_RE = /(?:^|[^<>])>(?!&)/;

function isReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;
	if (DESTRUCTIVE_BASH_RE.test(trimmed)) return false;
	const strippedRedirects = trimmed.replace(/\d*>&\d+/g, "").replace(/2>\/dev\/null/g, "");
	if (REDIRECT_WRITE_RE.test(strippedRedirects)) return false;
	return true;
}

export function extractPlanSteps(markdown: string): PlanStep[] {
	const steps: PlanStep[] = [];
	const seen = new Set<number>();
	for (const line of markdown.split("\n")) {
		const m = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
		if (!m) continue;
		const num = Number.parseInt(m[1]!, 10);
		const clean = m[2]!.replace(/\*\*/g, "").replace(/`/g, "").trim();
		if (!clean || seen.has(num)) continue;
		seen.add(num);
		steps.push({ step: num, text: clean, completed: false });
	}
	return steps;
}

function markDoneTokens(text: string, steps: PlanStep[]): number {
	let changed = 0;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const num = Number.parseInt(match[1]!, 10);
		const item = steps.find((s) => s.step === num);
		if (item && !item.completed) {
			item.completed = true;
			changed++;
		}
	}
	return changed;
}

const ZERO_FLUFF_PLAN_PROMPT = `[PLAN MODE — СТРОГИЙ РЕЖИМ ПЛАНИРОВАНИЯ]
Файлы менять запрещено (инструменты записи отключены, bash только для чтения).
Сначала изучи нужные файлы проекта инструментами чтения, затем выдай **чёткий инженерный план без воды**:
- Никаких вступлений, вежливых штампов и пересказа задачи.
- Короткая цель (1–2 предложения).
- Пронумерованные шаги (\`1.\`, \`2.\`, ...) с точными путями к файлам, именами функций/компонентов и сутью изменений.
- Подводные камни / крайние случаи — только реальные, по существу (1–3 пункта максимум).
- Проверка — конкретные команды/сценарии верификации.
Пиши компактно и структурно: пользователь сможет оставлять построчные комментарии прямо под строками твоего плана.`;

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function extractVisibleText(message: AssistantMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

function extractAllText(message: AssistantMessage): string {
	return message.content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return (part as { thinking?: string }).thinking ?? "";
			return "";
		})
		.join("\n");
}

export function applyModeTools(pi: ExtensionAPI, mode: SessionMode): void {
	const st = getStore();
	if (mode === "plan") {
		const active = pi.getActiveTools();
		if (active.some((t) => WRITE_TOOLS.has(t))) {
			st.toolsBeforePlan = active;
		}
		pi.setActiveTools(active.filter((t) => !WRITE_TOOLS.has(t)));
	} else if (st.toolsBeforePlan && st.toolsBeforePlan.length > 0) {
		pi.setActiveTools(st.toolsBeforePlan);
		st.toolsBeforePlan = undefined;
	}
}

export function setSessionMode(pi: ExtensionAPI, ctx: ExtensionContext, nextMode: SessionMode, silent = false): void {
	const st = getStore();
	st.mode = nextMode;
	if (nextMode === "plan") st.executingPlan = false;
	applyModeTools(pi, nextMode);
	updatePlanWidget(pi, ctx);
	persistSessionStore(pi);
	st.requestRender?.();

	if (!silent && ctx.hasUI) {
		const meta = MODE_META[nextMode];
		ctx.ui.notify(`${meta.icon} Режим: ${meta.label} — ${meta.desc}`, "info");
	}
}

export function cycleSessionMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const st = getStore();
	const order: SessionMode[] = ["code", "plan", "safe"];
	const next = order[(order.indexOf(st.mode) + 1) % order.length]!;
	setSessionMode(pi, ctx, next);
}

export function updatePlanWidget(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	const st = getStore();
	const hasPlan = st.planLines.length > 0;
	const commentCount = Object.keys(st.planComments).length;

	if (st.mode !== "plan" && !st.executingPlan && !hasPlan) {
		ctx.ui.setWidget("conarti-plan", undefined);
		return;
	}

	ctx.ui.setWidget("conarti-plan", (_tui, theme) => {
		let hovered: string | null = null;
		let boxes: HitBox[] = [];

		return {
			invalidate() {},
			render(width: number): string[] {
				boxes = [];
				if (st.executingPlan && st.planSteps.length > 0) {
					const doneCount = st.planSteps.filter((s) => s.completed).length;
					const total = st.planSteps.length;
					const barW = 12;
					const filled = Math.round((doneCount / Math.max(1, total)) * barW);
					const bar = fgRgb(97, 175, 239, "━".repeat(filled)) + fgRgb(58, 68, 86, "─".repeat(barW - filled));

					const btnOpen = renderPill(`📋 План ${doneCount}/${total}`, {
						hovered: hovered === "open",
						active: true,
						rgb: [97, 175, 239],
						theme,
					});
					const btnClear = renderPill("✕ Скрыть", { hovered: hovered === "clear", theme });
					const nextStep = st.planSteps.find((s) => !s.completed);
					const stepPreview = nextStep
						? theme.fg("muted", ` · Сейчас: ${nextStep.step}. ${nextStep.text}`)
						: fgRgb(140, 194, 101, " · Все шаги выполнены ✓");

					boxes.push({
						id: "open",
						xStart: 1,
						xEnd: 1 + visibleWidth(btnOpen),
						y: 0,
						onClick: () => void showPlanStudio(pi, ctx),
					});
					const prefix = ` ${btnOpen}  ${bar} `;
					const availPreview = Math.max(0, width - visibleWidth(prefix) - visibleWidth(btnClear) - 3);
					const clippedPreview = availPreview > 8 ? truncateToWidth(stepPreview, availPreview, "…") : "";
					const gap = " ".repeat(
						Math.max(1, width - visibleWidth(prefix) - visibleWidth(clippedPreview) - visibleWidth(btnClear) - 1),
					);
					const xClear = visibleWidth(prefix) + visibleWidth(clippedPreview) + gap.length;
					boxes.push({
						id: "clear",
						xStart: xClear,
						xEnd: xClear + visibleWidth(btnClear),
						y: 0,
						onClick: () => {
							st.executingPlan = false;
							st.planRaw = "";
							st.planLines = [];
							st.planSteps = [];
							st.planComments = {};
							updatePlanWidget(pi, ctx);
							persistSessionStore(pi);
						},
					});
					return [truncateToWidth(`${prefix}${clippedPreview}${gap}${btnClear}`, width, "…")];
				}

				if (hasPlan) {
					const btnReview = renderPill(
						commentCount > 0
							? `📋 Открыть план · 💬 ${commentCount} комм.`
							: `📋 Открыть план (${st.planSteps.length || st.planLines.length} стр.)`,
						{ hovered: hovered === "review", active: true, rgb: [229, 192, 123], theme },
					);
					const btnRun = renderPill("✓ В работу", {
						hovered: hovered === "run",
						active: true,
						rgb: [140, 194, 101],
						theme,
					});
					const btnDismiss = renderPill("✕", { hovered: hovered === "dismiss", theme });

					let x = 1;
					const wRev = visibleWidth(btnReview);
					boxes.push({ id: "review", xStart: x, xEnd: x + wRev, y: 0, onClick: () => void showPlanStudio(pi, ctx) });
					x += wRev + 2;
					const wRun = visibleWidth(btnRun);
					boxes.push({ id: "run", xStart: x, xEnd: x + wRun, y: 0, onClick: () => approveAndExecutePlan(pi, ctx) });
					const hint = theme.fg("dim", "кликни для построчных комментариев");
					const leftPart = ` ${btnReview}  ${btnRun}  `;
					const availHint = Math.max(0, width - visibleWidth(leftPart) - visibleWidth(btnDismiss) - 2);
					const showHint = availHint > 16 ? truncateToWidth(hint, availHint, "…") : "";
					const gap = " ".repeat(
						Math.max(1, width - visibleWidth(leftPart) - visibleWidth(showHint) - visibleWidth(btnDismiss) - 1),
					);
					const xDismiss = visibleWidth(leftPart) + visibleWidth(showHint) + gap.length;
					boxes.push({
						id: "dismiss",
						xStart: xDismiss,
						xEnd: xDismiss + visibleWidth(btnDismiss),
						y: 0,
						onClick: () => {
							st.planRaw = "";
							st.planLines = [];
							st.planSteps = [];
							st.planComments = {};
							updatePlanWidget(pi, ctx);
							persistSessionStore(pi);
						},
					});
					return [truncateToWidth(`${leftPart}${showHint}${gap}${btnDismiss}`, width, "…")];
				}

				const badge = renderPill("◈ Plan Mode", {
					hovered: hovered === "exit-plan",
					active: true,
					rgb: [229, 192, 123],
					theme,
				});
				boxes.push({
					id: "exit-plan",
					xStart: 1,
					xEnd: 1 + visibleWidth(badge),
					y: 0,
					onClick: () => setSessionMode(pi, ctx, "code"),
				});
				const info = theme.fg("muted", " Опиши задачу — агент соберёт компактный план без воды с построчным ревью");
				return [truncateToWidth(` ${badge}${info}`, width, "…")];
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type === "move") {
					const hit = boxes.find((b) => b.y === event.y && event.x >= b.xStart && event.x < b.xEnd);
					const next = hit?.id ?? null;
					if (next !== hovered) {
						hovered = next;
						return { handled: true, render: true };
					}
					return undefined;
				}
				if (event.type === "click" && event.button === "left") {
					const hit = boxes.find((b) => b.y === event.y && event.x >= b.xStart && event.x < b.xEnd);
					if (hit) {
						hit.onClick();
						return { handled: true };
					}
				}
				return undefined;
			},
		};
	});
}

function formatLineCommentsBlock(): string {
	const st = getStore();
	const entries = Object.entries(st.planComments)
		.map(([k, v]) => [Number.parseInt(k, 10), v.trim()] as const)
		.filter(([, v]) => v.length > 0)
		.sort((a, b) => a[0] - b[0]);

	if (entries.length === 0) return "";
	return entries
		.map(([lineIdx, note]) => `- Строка ${lineIdx + 1} (\`${(st.planLines[lineIdx] ?? "").trim()}\`): ${note}`)
		.join("\n");
}

export function approveAndExecutePlan(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const st = getStore();
	if (!st.planRaw.trim()) {
		ctx.ui.notify("Сначала сгенерируй план в режиме Plan", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Подожди завершения текущего ответа агента", "warning");
		return;
	}

	st.executingPlan = st.planSteps.length > 0;
	setSessionMode(pi, ctx, "code", true);

	const commentsText = formatLineCommentsBlock();
	st.planComments = {};
	persistSessionStore(pi);
	updatePlanWidget(pi, ctx);

	const stepInstruction =
		st.planSteps.length > 0
			? `\nПосле завершения каждого пронумерованного шага плана добавляй маркер \`[DONE:n]\` (например \`[DONE:1]\`), чтобы обновлялся прогресс.`
			: "";

	const prompt = commentsText
		? `Реализуй утверждённый план с учётом моих построчных комментариев:\n\n### Комментарии к строкам плана\n${commentsText}${stepInstruction}`
		: `План утверждён. Приступай к реализации по шагам.${stepInstruction}`;

	pi.sendUserMessage(prompt);
}

export function revisePlanWithComments(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const st = getStore();
	const commentsText = formatLineCommentsBlock();
	if (!commentsText) {
		ctx.ui.notify("Добавь хотя бы один комментарий к строке плана (клик мышкой или Enter)", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Подожди завершения текущего ответа агента", "warning");
		return;
	}

	if (st.mode !== "plan") setSessionMode(pi, ctx, "plan", true);
	st.planComments = {};
	persistSessionStore(pi);
	updatePlanWidget(pi, ctx);

	pi.sendUserMessage(`Обнови план без воды, точечно учитывая мои комментарии к строкам:\n\n${commentsText}`);
}

export function registerPlanStudioFeature(pi: ExtensionAPI): void {
	pi.on("agent_start", async () => {
		const st = getStore();
		st.isStreaming = true;
		st.safeAllowTurn = false;
	});

	pi.on("before_agent_start", async () => {
		const st = getStore();
		if (st.mode === "plan") {
			return {
				message: {
					customType: "conarti-plan-context",
					content: ZERO_FLUFF_PLAN_PROMPT,
					display: false,
				},
			};
		}
		if (st.executingPlan && st.planSteps.length > 0) {
			const remaining = st.planSteps.filter((s) => !s.completed);
			if (remaining.length > 0) {
				const list = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
				return {
					message: {
						customType: "conarti-plan-exec-context",
						content: `[Выполнение плана] Оставшиеся шаги:\n${list}\nПосле завершения каждого шага добавляй маркер [DONE:n].`,
						display: false,
					},
				};
			}
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const st = getStore();
		if (st.mode === "plan") {
			if (WRITE_TOOLS.has(event.toolName)) {
				return {
					block: true,
					reason: "В режиме Plan запись в файлы отключена. Сначала заверши план и утверди его с пользователем.",
				};
			}
			if (event.toolName === "bash") {
				const cmd = String((event.input as any)?.command ?? "");
				if (!isReadOnlyBash(cmd)) {
					return { block: true, reason: `В режиме Plan разрешены только команды чтения. Заблокировано: ${cmd}` };
				}
			}
			return undefined;
		}

		if (st.mode === "safe" && !st.safeAllowTurn) {
			if (WRITE_TOOLS.has(event.toolName)) {
				const targetPath = String((event.input as any)?.path ?? "");
				const decision = await confirmSafeToolCall(ctx, event.toolName, `Изменение файла: ${targetPath}`);
				if (decision === "allow-turn") st.safeAllowTurn = true;
				if (decision === "block") return { block: true, reason: "Отклонено пользователем в режиме Auto-Safe" };
				return undefined;
			}
			if (event.toolName === "bash") {
				const cmd = String((event.input as any)?.command ?? "");
				if (!isReadOnlyBash(cmd)) {
					const decision = await confirmSafeToolCall(ctx, "bash", cmd);
					if (decision === "allow-turn") st.safeAllowTurn = true;
					if (decision === "block") return { block: true, reason: "Команда отклонена пользователем в режиме Auto-Safe" };
				}
			}
		}
		return undefined;
	});

	pi.on("context", async (event) => {
		const st = getStore();
		if (st.mode === "plan") return undefined;
		return {
			messages: event.messages.filter((m: any) => m.customType !== "conarti-plan-context"),
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		const st = getStore();
		if (!st.executingPlan || st.planSteps.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		if (markDoneTokens(extractAllText(event.message), st.planSteps) > 0) {
			updatePlanWidget(pi, ctx);
			persistSessionStore(pi);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const st = getStore();
		st.isStreaming = false;
		st.safeAllowTurn = false;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		if (st.mode === "plan") {
			const visible = extractVisibleText(lastAssistant);
			if (visible.length > 0) {
				st.planRaw = visible;
				st.planLines = visible.split("\n");
				st.planSteps = extractPlanSteps(visible);
				persistSessionStore(pi);
				updatePlanWidget(pi, ctx);

				if (ctx.mode === "tui" && ctx.hasUI && lastAssistant.stopReason === "stop") {
					void showPlanStudio(pi, ctx);
				}
			}
		} else if (st.executingPlan && st.planSteps.length > 0) {
			markDoneTokens(extractAllText(lastAssistant), st.planSteps);
			if (st.planSteps.every((s) => s.completed)) {
				ctx.ui.notify("✓ Все шаги плана выполнены", "info");
			}
			updatePlanWidget(pi, ctx);
			persistSessionStore(pi);
		}
	});

	pi.registerCommand("plan", {
		description: "Режим планирования без воды и ревью плана с построчными комментариями",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			const st = getStore();

			if (sub === "off" || sub === "code") return setSessionMode(pi, ctx, "code");
			if (sub === "on") return setSessionMode(pi, ctx, "plan");
			if (sub === "run" || sub === "approve") return approveAndExecutePlan(pi, ctx);
			if (sub === "clear") {
				st.planRaw = "";
				st.planLines = [];
				st.planSteps = [];
				st.planComments = {};
				st.executingPlan = false;
				updatePlanWidget(pi, ctx);
				persistSessionStore(pi);
				ctx.ui.notify("Сохранённый план очищен", "info");
				return;
			}
			if (sub === "review" || st.planLines.length > 0) {
				await showPlanStudio(pi, ctx);
				return;
			}
			setSessionMode(pi, ctx, st.mode === "plan" ? "code" : "plan");
		},
	});

	pi.registerCommand("mode", {
		description: "Выбрать режим работы: /mode [code|plan|safe]",
		handler: async (args, ctx) => {
			const target = args.trim().toLowerCase();
			if (target === "code" || target === "plan" || target === "safe") {
				setSessionMode(pi, ctx, target);
				return;
			}
			cycleSessionMode(pi, ctx);
		},
	});
}
