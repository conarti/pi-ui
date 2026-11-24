import { classifyShellEffect, type ShellDialect } from "./shell-analysis.ts";

export type SessionMode = "code" | "plan" | "safe";

export interface PlanStep {
	step: number;
	text: string;
	completed: boolean;
}

export interface PersistedSessionWorkflowState {
	mode: SessionMode;
	planRaw: string;
	planComments: Record<number, string>;
	planSteps: PlanStep[];
	executingPlan: boolean;
	withheldWriteTools?: string[];
}

export interface ToolMetadata {
	name: string;
	annotations?: {
		destructiveHint?: boolean;
	};
	destructiveHint?: boolean;
}

export interface ToolAccessPort {
	getActiveTools(): string[];
	setActiveTools(tools: string[]): void;
	getAllTools?(): readonly ToolMetadata[];
}

export type SafeConfirmationDecision = "allow" | "allow-turn" | "block";

export type SafeConfirmationPrompt = (
	toolName: string,
	summary: string,
) => Promise<SafeConfirmationDecision>;

export interface ToolCallPreflightRequest {
	toolName: string;
	input?: Record<string, unknown>;
	tools?: ToolAccessPort;
}

export type ToolCallPreflightResult =
	| { block: true; reason: string }
	| undefined;

export interface EntryPersistencePort {
	appendEntry(customType: string, data: unknown): void;
}

export type PlanApprovalResult =
	| { ok: true; prompt: string; executingPlan: boolean }
	| { ok: false; reason: "empty-plan" };

export type PlanRevisionResult =
	| { ok: true; prompt: string }
	| { ok: false; reason: "no-comments" };

export const SESSION_ENTRY_TYPE = "conarti-ui-state";
export const LEGACY_SESSION_ENTRY_TYPE = "grok-ui-state";
export const WRITE_TOOL_NAMES = ["edit", "write"] as const;
export const WRITE_TOOLS: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

export const MODE_META: Record<
	SessionMode,
	{ icon: string; label: string; short: string; rgb: [number, number, number]; desc: string }
> = {
	code: {
		icon: "●",
		label: "Code",
		short: "Code",
		rgb: [97, 175, 239],
		desc: "Полный доступ к чтению, правкам и командам",
	},
	plan: {
		icon: "◈",
		label: "Plan",
		short: "Plan",
		rgb: [229, 192, 123],
		desc: "Read-only исследование + план без воды с построчными комментариями",
	},
	safe: {
		icon: "🛡",
		label: "Auto-Safe",
		short: "Safe",
		rgb: [86, 182, 194],
		desc: "Чтение и безопасные команды сразу, правки/риск — через подтверждение",
	},
};

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

function normalizeWriteTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const deduped: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && WRITE_TOOLS.has(item) && !deduped.includes(item)) {
			deduped.push(item);
		}
	}
	return deduped;
}

function clonePlanSteps(value: unknown): PlanStep[] {
	if (!Array.isArray(value)) return [];
	const steps: PlanStep[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const rec = raw as Record<string, unknown>;
		if (typeof rec.step !== "number" || typeof rec.text !== "string") continue;
		steps.push({
			step: rec.step,
			text: rec.text,
			completed: Boolean(rec.completed),
		});
	}
	return steps;
}

function clonePlanComments(value: unknown): Record<number, string> {
	if (!value || typeof value !== "object") return {};
	const comments: Record<number, string> = {};
	for (const [key, note] of Object.entries(value as Record<string, unknown>)) {
		const lineIdx = Number.parseInt(key, 10);
		if (!Number.isNaN(lineIdx) && typeof note === "string" && note.trim().length > 0) {
			comments[lineIdx] = note;
		}
	}
	return comments;
}

function inferAvailableWriteTools(tools: ToolAccessPort): string[] {
	if (typeof tools.getAllTools === "function") {
		const available = tools
			.getAllTools()
			.map((t) => t.name)
			.filter((name) => WRITE_TOOLS.has(name));
		if (available.length > 0) return [...new Set(available)];
	}
	return [...WRITE_TOOL_NAMES];
}

function isDestructiveAnnotatedTool(toolName: string, tools?: ToolAccessPort): boolean {
	if (!tools || typeof tools.getAllTools !== "function") return false;
	const meta = tools.getAllTools().find((t) => t.name === toolName);
	if (!meta) return false;
	return meta.annotations?.destructiveHint === true || meta.destructiveHint === true;
}

type ToolMutationClassification =
	| { mutating: false }
	| { mutating: true; planReason: string; confirmSummary: string; safeBlockReason: string };

function classifyToolMutation(req: ToolCallPreflightRequest): ToolMutationClassification {
	const { toolName, input, tools } = req;

	if (WRITE_TOOLS.has(toolName)) {
		const targetPath = String(input?.path ?? "");
		return {
			mutating: true,
			planReason: "В режиме Plan запись в файлы отключена. Сначала заверши план и утверди его с пользователем.",
			confirmSummary: `Изменение файла: ${targetPath}`,
			safeBlockReason: "Отклонено пользователем в режиме Auto-Safe",
		};
	}

	if (toolName === "bash" || toolName === "powershell") {
		const dialect: ShellDialect = toolName === "powershell" ? "powershell" : "bash";
		const cmd = String(input?.command ?? "");
		const effect = classifyShellEffect(cmd, dialect);
		if (effect.kind === "read-only") {
			return { mutating: false };
		}
		return {
			mutating: true,
			planReason: `В режиме Plan разрешены только команды чтения (${effect.reason}). Заблокировано: ${cmd}`,
			confirmSummary: cmd,
			safeBlockReason: "Команда отклонена пользователем в режиме Auto-Safe",
		};
	}

	if (isDestructiveAnnotatedTool(toolName, tools)) {
		return {
			mutating: true,
			planReason: `В режиме Plan деструктивный инструмент "${toolName}" заблокирован.`,
			confirmSummary: `Деструктивный инструмент: ${toolName}`,
			safeBlockReason: `Инструмент "${toolName}" отклонён пользователем в режиме Auto-Safe`,
		};
	}

	return { mutating: false };
}

export class SessionWorkflow {
	mode: SessionMode = "code";
	planRaw = "";
	planLines: string[] = [];
	planComments: Record<number, string> = {};
	planSteps: PlanStep[] = [];
	executingPlan = false;
	safeAllowTurn = false;
	isStreaming = false;
	withheldWriteTools: string[] | undefined = undefined;
	private safeConfirmActive = false;
	private safeConfirmWaiters: Array<() => void> = [];

	reset(defaultPlanFlag = false): void {
		this.mode = defaultPlanFlag ? "plan" : "code";
		this.planRaw = "";
		this.planLines = [];
		this.planComments = {};
		this.planSteps = [];
		this.executingPlan = false;
		this.safeAllowTurn = false;
		this.isStreaming = false;
		this.withheldWriteTools = undefined;
		this.safeConfirmActive = false;
		this.safeConfirmWaiters = [];
	}

	hasPlan(): boolean {
		return this.planLines.length > 0;
	}

	getCommentCount(): number {
		return Object.keys(this.planComments).length;
	}

	beginAgentTurn(): void {
		this.isStreaming = true;
		this.safeAllowTurn = false;
	}

	endAgentTurn(): void {
		this.isStreaming = false;
		this.safeAllowTurn = false;
	}

	private async enqueueSafeConfirmation<T>(task: () => Promise<T>): Promise<T> {
		if (this.safeConfirmActive) {
			await new Promise<void>((resolve) => {
				this.safeConfirmWaiters.push(resolve);
			});
		}
		this.safeConfirmActive = true;
		try {
			return await task();
		} finally {
			const next = this.safeConfirmWaiters.shift();
			if (next) {
				next();
			} else {
				this.safeConfirmActive = false;
			}
		}
	}

	async preflightToolCall(
		req: ToolCallPreflightRequest,
		confirmSafe: SafeConfirmationPrompt,
	): Promise<ToolCallPreflightResult> {
		if (this.mode === "code") return undefined;

		const classification = classifyToolMutation(req);
		if (!classification.mutating) return undefined;

		if (this.mode === "plan") {
			return { block: true, reason: classification.planReason };
		}

		if (this.safeAllowTurn) return undefined;

		return await this.enqueueSafeConfirmation(async () => {
			if (this.mode === "code") return undefined;
			if (this.mode === "plan") {
				return { block: true, reason: classification.planReason };
			}
			if (this.safeAllowTurn) return undefined;

			let decision: SafeConfirmationDecision;
			try {
				decision = await confirmSafe(req.toolName, classification.confirmSummary);
			} catch {
				return { block: true, reason: classification.safeBlockReason };
			}

			if (decision === "allow-turn") {
				this.safeAllowTurn = true;
				return undefined;
			}
			if (decision === "allow") {
				return undefined;
			}
			return { block: true, reason: classification.safeBlockReason };
		});
	}

	syncActiveTools(tools: ToolAccessPort, options?: { inferMissingOnPlanRestore?: boolean }): void {
		const active = tools.getActiveTools();
		if (this.mode === "plan") {
			const activeWriteTools = active.filter((t) => WRITE_TOOLS.has(t));
			if (activeWriteTools.length > 0) {
				const merged = new Set(this.withheldWriteTools ?? []);
				for (const name of activeWriteTools) merged.add(name);
				this.withheldWriteTools = [...merged];
				tools.setActiveTools(active.filter((t) => !WRITE_TOOLS.has(t)));
			} else if (this.withheldWriteTools === undefined) {
				this.withheldWriteTools = options?.inferMissingOnPlanRestore
					? inferAvailableWriteTools(tools)
					: [];
			}
			return;
		}

		if (this.withheldWriteTools !== undefined) {
			if (this.withheldWriteTools.length > 0) {
				const activeSet = new Set(active);
				const toRestore = this.withheldWriteTools.filter((t) => !activeSet.has(t));
				if (toRestore.length > 0) {
					tools.setActiveTools([...active, ...toRestore]);
				}
			}
			this.withheldWriteTools = undefined;
		}
	}

	setMode(nextMode: SessionMode, tools?: ToolAccessPort): SessionMode {
		this.mode = nextMode;
		if (nextMode === "plan") {
			this.executingPlan = false;
		}
		if (tools) {
			this.syncActiveTools(tools);
		}
		return this.mode;
	}

	cycleMode(tools?: ToolAccessPort): SessionMode {
		const order: SessionMode[] = ["code", "plan", "safe"];
		const next = order[(order.indexOf(this.mode) + 1) % order.length]!;
		return this.setMode(next, tools);
	}

	capturePlan(markdown: string): boolean {
		const trimmed = markdown.trim();
		if (!trimmed) return false;
		this.planRaw = trimmed;
		this.planLines = trimmed.split("\n");
		this.planSteps = extractPlanSteps(trimmed);
		this.planComments = {};
		this.executingPlan = false;
		return true;
	}

	setPlanComment(lineIdx: number, comment: string): void {
		const trimmed = comment.trim();
		if (trimmed) {
			this.planComments[lineIdx] = trimmed;
		} else {
			delete this.planComments[lineIdx];
		}
	}

	deletePlanComment(lineIdx: number): boolean {
		if (this.planComments[lineIdx] === undefined) return false;
		delete this.planComments[lineIdx];
		return true;
	}

	clearPlanComments(): void {
		this.planComments = {};
	}

	clearPlan(): void {
		this.planRaw = "";
		this.planLines = [];
		this.planSteps = [];
		this.planComments = {};
		this.executingPlan = false;
	}

	formatLineComments(): string {
		const entries = Object.entries(this.planComments)
			.map(([k, v]) => [Number.parseInt(k, 10), v.trim()] as const)
			.filter(([, v]) => v.length > 0)
			.sort((a, b) => a[0] - b[0]);

		if (entries.length === 0) return "";
		return entries
			.map(([lineIdx, note]) => `- Строка ${lineIdx + 1} (\`${(this.planLines[lineIdx] ?? "").trim()}\`): ${note}`)
			.join("\n");
	}

	approvePlan(tools?: ToolAccessPort): PlanApprovalResult {
		if (!this.planRaw.trim()) {
			return { ok: false, reason: "empty-plan" };
		}

		const commentsText = this.formatLineComments();
		this.executingPlan = this.planSteps.length > 0;
		this.setMode("code", tools);
		this.planComments = {};

		const stepInstruction =
			this.planSteps.length > 0
				? `\nПосле завершения каждого пронумерованного шага плана добавляй маркер \`[DONE:n]\` (например \`[DONE:1]\`), чтобы обновлялся прогресс.`
				: "";

		const prompt = commentsText
			? `Реализуй утверждённый план с учётом моих построчных комментариев:\n\n### Комментарии к строкам плана\n${commentsText}${stepInstruction}`
			: `План утверждён. Приступай к реализации по шагам.${stepInstruction}`;

		return { ok: true, prompt, executingPlan: this.executingPlan };
	}

	revisePlan(tools?: ToolAccessPort): PlanRevisionResult {
		const commentsText = this.formatLineComments();
		if (!commentsText) {
			return { ok: false, reason: "no-comments" };
		}

		if (this.mode !== "plan") {
			this.setMode("plan", tools);
		}
		this.planComments = {};

		return {
			ok: true,
			prompt: `Обнови план без воды, точечно учитывая мои комментарии к строкам:\n\n${commentsText}`,
		};
	}

	markCompletedSteps(text: string): { changed: number; allCompleted: boolean } {
		if (!this.executingPlan || this.planSteps.length === 0) {
			return { changed: 0, allCompleted: false };
		}
		let changed = 0;
		for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
			const num = Number.parseInt(match[1]!, 10);
			const item = this.planSteps.find((s) => s.step === num);
			if (item && !item.completed) {
				item.completed = true;
				changed++;
			}
		}
		return {
			changed,
			allCompleted: this.planSteps.every((s) => s.completed),
		};
	}

	snapshot(): PersistedSessionWorkflowState {
		const data: PersistedSessionWorkflowState = {
			mode: this.mode,
			planRaw: this.planRaw,
			planComments: { ...this.planComments },
			planSteps: this.planSteps.map((s) => ({ ...s })),
			executingPlan: this.executingPlan,
		};
		if (this.withheldWriteTools !== undefined) {
			data.withheldWriteTools = [...this.withheldWriteTools];
		}
		return data;
	}

	persist(port: EntryPersistencePort): void {
		port.appendEntry(SESSION_ENTRY_TYPE, this.snapshot());
	}

	restore(entries: readonly any[], defaultPlanFlag: boolean): { restored: boolean } {
		this.reset(defaultPlanFlag);

		const saved = [...entries]
			.reverse()
			.find(
				(e) =>
					e?.type === "custom" &&
					(e?.customType === SESSION_ENTRY_TYPE || e?.customType === LEGACY_SESSION_ENTRY_TYPE),
			);

		if (saved?.data && typeof saved.data === "object") {
			const d = saved.data as Record<string, unknown>;
			if (d.mode === "code" || d.mode === "plan" || d.mode === "safe") {
				this.mode = d.mode;
			}
			this.planRaw = typeof d.planRaw === "string" ? d.planRaw : "";
			this.planLines = this.planRaw ? this.planRaw.split("\n") : [];
			this.planComments = clonePlanComments(d.planComments);
			this.planSteps = clonePlanSteps(d.planSteps);
			this.executingPlan = Boolean(d.executingPlan);
			this.withheldWriteTools = normalizeWriteTools(d.withheldWriteTools);
			return { restored: true };
		}

		return { restored: false };
	}
}

const WORKFLOW_KEY = Symbol.for("conarti.pi-ui.workflow.v1");

export function getSessionWorkflow(): SessionWorkflow {
	const g = globalThis as Record<symbol, SessionWorkflow | undefined>;
	if (!g[WORKFLOW_KEY]) {
		g[WORKFLOW_KEY] = new SessionWorkflow();
	}
	return g[WORKFLOW_KEY]!;
}
