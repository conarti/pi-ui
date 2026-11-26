import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fgRgb, renderCloseButton, renderPill, type HitBox } from "../../shared/ansi.ts";
import { t } from "../../shared/i18n.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import {
	extractPlanSteps,
	getSessionWorkflow,
	MODE_META,
	normalizeSessionMode,
	SESSION_MODE_ORDER,
	type SessionMode,
} from "../../shared/session-workflow.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { openComposerPopover } from "../chrome/composer-popovers.ts";
import { confirmSafeToolCall, showPlanApproval } from "./approval-overlay.ts";

export { extractPlanSteps };

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

export function applyModeTools(
	pi: ExtensionAPI,
	mode: SessionMode,
	options?: { inferMissingOnPlanRestore?: boolean },
): void {
	const wf = getSessionWorkflow();
	wf.mode = mode;
	wf.syncActiveTools(pi, options);
}

export function setSessionMode(pi: ExtensionAPI, ctx: ExtensionContext, nextMode: SessionMode, silent = false): void {
	const wf = getSessionWorkflow();
	wf.setMode(nextMode, pi);
	updatePlanWidget(pi, ctx);
	wf.persist(pi);
	requestRender();

	if (!silent && ctx.hasUI) {
		const meta = MODE_META[nextMode];
		ctx.ui.notify(
			t("sessionMode.notification", { icon: meta.icon, label: meta.label, desc: meta.desc }),
			"info",
		);
	}
}

export function cycleSessionMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const wf = getSessionWorkflow();
	const currentIdx = SESSION_MODE_ORDER.indexOf(wf.mode);
	const next = SESSION_MODE_ORDER[(currentIdx + 1) % SESSION_MODE_ORDER.length]!;
	setSessionMode(pi, ctx, next);
}

export function clearPlanState(pi: ExtensionAPI, ctx: ExtensionContext, notify = false): void {
	const wf = getSessionWorkflow();
	wf.clearPlan();
	updatePlanWidget(pi, ctx);
	wf.persist(pi);
	requestRender();
	if (notify && ctx.hasUI) {
		ctx.ui.notify(t("plan.cleared"), "info");
	}
}

export function updatePlanWidget(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	const wf = getSessionWorkflow();
	const hasPlan = wf.hasPlan();
	const commentCount = wf.getCommentCount();

	if (wf.mode !== "plan" && !wf.executingPlan && !hasPlan) {
		ctx.ui.setWidget("conarti-plan", undefined);
		return;
	}

	ctx.ui.setWidget("conarti-plan", (_tui, theme) => {
		const hoverOwner = {};
		let hovered: string | null = null;
		let boxes: HitBox[] = [];

		return {
			invalidate() {},
			render(width: number): string[] {
				boxes = [];
				if (wf.executingPlan && wf.planSteps.length > 0) {
					const doneCount = wf.planSteps.filter((s) => s.completed).length;
					const total = wf.planSteps.length;
					const barW = 12;
					const filled = Math.round((doneCount / Math.max(1, total)) * barW);
					const bar = fgRgb(97, 175, 239, "━".repeat(filled)) + fgRgb(58, 68, 86, "─".repeat(barW - filled));

					const btnOpen = renderPill(
						t("plan.widget.progress", { done: doneCount, total }),
						{
							hovered: hovered === "open",
							active: true,
							rgb: [97, 175, 239],
							theme,
						},
					);
					const btnClear = renderPill(t("plan.widget.hide"), { hovered: hovered === "clear", theme });
					const nextStep = wf.planSteps.find((s) => !s.completed);
					const stepPreview = nextStep
						? theme.fg("muted", t("plan.widget.currentStep", { step: nextStep.step, text: nextStep.text }))
						: fgRgb(140, 194, 101, t("plan.widget.allDone"));

					boxes.push({
						id: "open",
						xStart: 0,
						xEnd: visibleWidth(btnOpen),
						y: 0,
						onClick: () => void showPlanApproval(pi, ctx),
					});
					const prefix = `${btnOpen}  ${bar} `;
					const availPreview = Math.max(0, width - visibleWidth(prefix) - visibleWidth(btnClear) - 2);
					const clippedPreview = availPreview > 8 ? truncateToWidth(stepPreview, availPreview, "…") : "";
					const gap = " ".repeat(
						Math.max(1, width - visibleWidth(prefix) - visibleWidth(clippedPreview) - visibleWidth(btnClear)),
					);
					const xClear = visibleWidth(prefix) + visibleWidth(clippedPreview) + gap.length;
					boxes.push({
						id: "clear",
						xStart: xClear,
						xEnd: xClear + visibleWidth(btnClear),
						y: 0,
						onClick: () => clearPlanState(pi, ctx),
					});
					return [truncateToWidth(`${prefix}${clippedPreview}${gap}${btnClear}`, width, "…")];
				}

				if (hasPlan) {
					const btnReview = renderPill(
						commentCount > 0
							? t("plan.widget.openWithComments", { count: commentCount })
							: t("plan.widget.open", { count: wf.planSteps.length || wf.planLines.length }),
						{ hovered: hovered === "review", active: true, rgb: [229, 192, 123], theme },
					);
					const btnRun = renderPill(t("plan.widget.approve"), {
						hovered: hovered === "run",
						active: true,
						rgb: [140, 194, 101],
						theme,
					});
					const btnDismiss = renderCloseButton(theme, hovered === "dismiss");

					let x = 0;
					const wRev = visibleWidth(btnReview);
					boxes.push({ id: "review", xStart: x, xEnd: x + wRev, y: 0, onClick: () => void showPlanApproval(pi, ctx) });
					x += wRev + 2;
					const wRun = visibleWidth(btnRun);
					boxes.push({ id: "run", xStart: x, xEnd: x + wRun, y: 0, onClick: () => approveAndExecutePlan(pi, ctx) });
					const leftPart = `${btnReview}  ${btnRun}`;
					const gap = " ".repeat(
						Math.max(1, width - visibleWidth(leftPart) - visibleWidth(btnDismiss)),
					);
					const xDismiss = visibleWidth(leftPart) + gap.length;
					boxes.push({
						id: "dismiss",
						xStart: xDismiss,
						xEnd: xDismiss + visibleWidth(btnDismiss),
						y: 0,
						onClick: () => clearPlanState(pi, ctx),
					});
					return [truncateToWidth(`${leftPart}${gap}${btnDismiss}`, width, "…")];
				}

				const badge = renderPill(t("plan.widget.modeBadge"), {
					hovered: hovered === "exit-plan",
					active: true,
					rgb: [229, 192, 123],
					theme,
				});
				boxes.push({
					id: "exit-plan",
					xStart: 0,
					xEnd: visibleWidth(badge),
					y: 0,
					onClick: () => setSessionMode(pi, ctx, "always-approve"),
				});
				const info = theme.fg("muted", t("plan.widget.modeHint"));
				return [truncateToWidth(`${badge}${info}`, width, "…")];
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				const hit = boxes.find((b) => b.y === event.y && event.x >= b.xStart && event.x < b.xEnd);
				if (event.type === "move") {
					claimHover(hoverOwner, () => {
						if (hovered !== null) {
							hovered = null;
							requestRender();
						}
					});
					const next = hit?.id ?? null;
					if (next !== hovered) {
						hovered = next;
						return { handled: true, render: true };
					}
					return hit ? { handled: true, render: false } : undefined;
				}
				if (event.type === "press" && event.button === "left" && hit) {
					return { handled: true, render: false };
				}
				if (event.type === "click" && event.button === "left") {
					if (hit) {
						hit.onClick();
						return { handled: true, render: true };
					}
				}
				return undefined;
			},
		};
	});
}

export function approveAndExecutePlan(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const wf = getSessionWorkflow();
	if (!wf.planRaw.trim()) {
		ctx.ui.notify(t("plan.emptyNotify"), "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify(t("plan.waitForIdle"), "warning");
		return;
	}

	const result = wf.approvePlan(pi);
	if (!result.ok) {
		ctx.ui.notify(t("plan.emptyNotify"), "warning");
		return;
	}

	wf.persist(pi);
	updatePlanWidget(pi, ctx);
	requestRender();

	pi.sendUserMessage(result.prompt);
}

export function revisePlanWithComments(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const wf = getSessionWorkflow();
	if (!wf.formatLineComments()) {
		ctx.ui.notify(t("plan.needComment"), "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify(t("plan.waitForIdle"), "warning");
		return;
	}

	const result = wf.revisePlan(pi);
	if (!result.ok) {
		ctx.ui.notify(t("plan.needComment"), "warning");
		return;
	}

	wf.persist(pi);
	updatePlanWidget(pi, ctx);
	requestRender();

	pi.sendUserMessage(result.prompt);
}

export function registerPlanApprovalFeature(pi: ExtensionAPI): void {
	pi.on("agent_start", async () => {
		getSessionWorkflow().beginAgentTurn();
	});

	pi.on("before_agent_start", async () => {
		const wf = getSessionWorkflow();
		if (wf.mode === "plan") {
			return {
				message: {
					customType: "conarti-plan-context",
					content: t("plan.prompt.system"),
					display: false,
				},
			};
		}
		if (wf.executingPlan && wf.planSteps.length > 0) {
			const remaining = wf.planSteps.filter((s) => !s.completed);
			if (remaining.length > 0) {
				const list = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
				return {
					message: {
						customType: "conarti-plan-exec-context",
						content: t("plan.prompt.execContext", { list }),
						display: false,
					},
				};
			}
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const wf = getSessionWorkflow();
		return await wf.preflightToolCall(
			{
				toolName: event.toolName,
				input: (event.input as Record<string, unknown> | undefined) ?? undefined,
				tools: pi,
			},
			(toolName, summary) => confirmSafeToolCall(ctx, toolName, summary),
		);
	});

	pi.on("context", async (event) => {
		const wf = getSessionWorkflow();
		const keepPlanContext = wf.mode === "plan";
		const hasActiveExec =
			wf.executingPlan && wf.planSteps.some((step) => !step.completed);
		let lastExecIdx = -1;
		if (hasActiveExec) {
			for (let i = event.messages.length - 1; i >= 0; i -= 1) {
				if ((event.messages[i] as { customType?: string }).customType === "conarti-plan-exec-context") {
					lastExecIdx = i;
					break;
				}
			}
		}
		const filtered = event.messages.filter((m, idx) => {
			const customType = (m as { customType?: string }).customType;
			if (customType === "conarti-plan-context") return keepPlanContext;
			if (customType === "conarti-plan-exec-context") {
				return hasActiveExec && idx === lastExecIdx;
			}
			return true;
		});
		if (filtered.length === event.messages.length) return undefined;
		return { messages: filtered };
	});

	pi.on("turn_end", async (event, ctx) => {
		const wf = getSessionWorkflow();
		if (!wf.executingPlan || wf.planSteps.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		const { changed } = wf.markCompletedSteps(extractAllText(event.message));
		if (changed > 0) {
			updatePlanWidget(pi, ctx);
			wf.persist(pi);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const wf = getSessionWorkflow();
		wf.endAgentTurn();

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		if (wf.mode === "plan") {
			const visible = extractVisibleText(lastAssistant);
			if (wf.capturePlan(visible)) {
				wf.persist(pi);
				updatePlanWidget(pi, ctx);

				if (ctx.mode === "tui" && ctx.hasUI && lastAssistant.stopReason === "stop") {
					void showPlanApproval(pi, ctx);
				}
			}
		} else if (wf.executingPlan && wf.planSteps.length > 0) {
			const { allCompleted } = wf.markCompletedSteps(extractAllText(lastAssistant));
			if (allCompleted) {
				ctx.ui.notify(t("plan.allStepsDone"), "info");
			}
			updatePlanWidget(pi, ctx);
			wf.persist(pi);
		}
	});

	pi.registerCommand("always-approve", {
		description: t("sessionMode.command.alwaysApprove"),
		handler: async (_args, ctx) => {
			setSessionMode(pi, ctx, "always-approve");
		},
	});

	pi.registerCommand("auto", {
		description: t("sessionMode.command.auto"),
		handler: async (_args, ctx) => {
			setSessionMode(pi, ctx, "auto");
		},
	});

	pi.registerCommand("plan", {
		description: t("sessionMode.command.plan"),
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			const wf = getSessionWorkflow();

			if (sub === "off" || sub === "always-approve" || sub === "code") {
				return setSessionMode(pi, ctx, "always-approve");
			}
			if (sub === "on") return setSessionMode(pi, ctx, "plan");
			if (sub === "run" || sub === "approve") return approveAndExecutePlan(pi, ctx);
			if (sub === "clear") {
				clearPlanState(pi, ctx, true);
				return;
			}
			if (sub === "review" || wf.hasPlan()) {
				await showPlanApproval(pi, ctx);
				return;
			}
			setSessionMode(pi, ctx, wf.mode === "plan" ? "always-approve" : "plan");
		},
	});

	pi.registerCommand("mode", {
		description: t("sessionMode.command.mode"),
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const items = SESSION_MODE_ORDER.filter(
				(choice) => choice.startsWith(typed) && choice !== typed.trimEnd(),
			).map((choice) => ({ value: choice, label: choice }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const normalized = normalizeSessionMode(args);
			if (normalized) {
				setSessionMode(pi, ctx, normalized);
				return;
			}
			if (ctx.mode === "tui" && ctx.hasUI && args.trim() === "") {
				openComposerPopover(pi, ctx, "mode");
				return;
			}
			cycleSessionMode(pi, ctx);
		},
	});
}
