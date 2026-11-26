import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { t } from "./i18n.ts";
import type { CanonicalSessionMode } from "./pi-ui-config.ts";
import { classifyShellEffect, type ShellDialect } from "./shell-analysis.ts";

export type SessionMode = CanonicalSessionMode;

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

export const SESSION_MODE_ORDER: readonly SessionMode[] = [
	"always-approve",
	"plan",
	"auto",
];

/**
 * Преобразует канонические и устаревшие идентификаторы `Session Mode` (`"code"`, `"safe"`)
 * в единую тройку `"always-approve" | "plan" | "auto"`.
 */
export function normalizeSessionMode(raw: unknown): SessionMode | undefined {
	if (typeof raw !== "string") return undefined;
	const value = raw.trim().toLowerCase();
	if (value === "always-approve" || value === "always_approve" || value === "code") {
		return "always-approve";
	}
	if (value === "plan") {
		return "plan";
	}
	if (value === "auto" || value === "safe" || value === "auto-safe") {
		return "auto";
	}
	return undefined;
}

export interface SessionModeMeta {
	readonly icon: string;
	readonly label: string;
	readonly short: string;
	readonly rgb: [number, number, number];
	readonly desc: string;
}

export const MODE_META: Record<SessionMode, SessionModeMeta> = {
	"always-approve": {
		icon: "●",
		get label() {
			return t("sessionMode.alwaysApprove.label");
		},
		get short() {
			return t("sessionMode.alwaysApprove.short");
		},
		rgb: [97, 175, 239],
		get desc() {
			return t("sessionMode.alwaysApprove.desc");
		},
	},
	plan: {
		icon: "◈",
		get label() {
			return t("sessionMode.plan.label");
		},
		get short() {
			return t("sessionMode.plan.short");
		},
		rgb: [229, 192, 123],
		get desc() {
			return t("sessionMode.plan.desc");
		},
	},
	auto: {
		icon: "🛡",
		get label() {
			return t("sessionMode.auto.label");
		},
		get short() {
			return t("sessionMode.auto.short");
		},
		rgb: [100, 178, 240],
		get desc() {
			return t("sessionMode.auto.desc");
		},
	},
};

function isShiftTabBinding(value: unknown): boolean {
	if (typeof value === "string") {
		return value.trim().toLowerCase() === "shift+tab";
	}
	if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
		return value[0].trim().toLowerCase() === "shift+tab";
	}
	return false;
}

/**
 * Синхронизирует `"app.thinking.cycle": "alt+t"` в `keybindings.json` хоста Pi,
 * если биндинг ещё не задан пользователем или всё ещё указывает на `"shift+tab"`,
 * чтобы `Shift+Tab` переключал только `Session Mode` без двойного срабатывания thinking.
 */
export function syncThinkingCycleKeybinding(agentDir = getAgentDir()): boolean {
	let targetPath = join(agentDir, "keybindings.json");
	let linked = false;
	try {
		linked = lstatSync(targetPath).isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (linked) {
		try {
			targetPath = realpathSync(targetPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	let existing: Record<string, unknown> = {};
	let mode = 0o600;
	if (existsSync(targetPath)) {
		try {
			const rawText = readFileSync(targetPath, "utf8");
			mode = statSync(targetPath).mode & 0o777;
			const parsed: unknown = JSON.parse(rawText);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			} else {
				return false;
			}
		} catch {
			/* Не перезаписываем повреждённый пользовательский keybindings.json */
			return false;
		}
	}

	const hasCanonical = Object.hasOwn(existing, "app.thinking.cycle");
	const hasLegacy = Object.hasOwn(existing, "cycleThinkingLevel");
	const shouldSync =
		(!hasCanonical && !hasLegacy) ||
		(hasCanonical && isShiftTabBinding(existing["app.thinking.cycle"])) ||
		(!hasCanonical && hasLegacy && isShiftTabBinding(existing.cycleThinkingLevel));

	if (!shouldSync) {
		return false;
	}

	const payload: Record<string, unknown> = { ...existing };
	if (!hasCanonical && hasLegacy) {
		delete payload.cycleThinkingLevel;
	}
	payload["app.thinking.cycle"] = "alt+t";

	mkdirSync(dirname(targetPath), { recursive: true });
	const temporary = join(dirname(targetPath), `.keybindings-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		chmodSync(temporary, mode);
		renameSync(temporary, targetPath);
	} finally {
		rmSync(temporary, { force: true });
	}
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
			.map((tool) => tool.name)
			.filter((name) => WRITE_TOOLS.has(name));
		if (available.length > 0) return [...new Set(available)];
	}
	return [...WRITE_TOOL_NAMES];
}

function isDestructiveAnnotatedTool(toolName: string, tools?: ToolAccessPort): boolean {
	if (!tools || typeof tools.getAllTools !== "function") return false;
	const meta = tools.getAllTools().find((tool) => tool.name === toolName);
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
			planReason: t("preflight.plan.writeBlocked"),
			confirmSummary: t("preflight.confirm.fileEdit", { targetPath }),
			safeBlockReason: t("preflight.auto.editBlocked"),
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
			planReason: t("preflight.plan.shellBlocked", { reason: effect.reason, cmd }),
			confirmSummary: cmd,
			safeBlockReason: t("preflight.auto.shellBlocked"),
		};
	}

	if (isDestructiveAnnotatedTool(toolName, tools)) {
		return {
			mutating: true,
			planReason: t("preflight.plan.destructiveBlocked", { toolName }),
			confirmSummary: t("preflight.confirm.destructive", { toolName }),
			safeBlockReason: t("preflight.auto.toolBlocked", { toolName }),
		};
	}

	return { mutating: false };
}

export class SessionWorkflow {
	mode: SessionMode = "always-approve";
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
		this.mode = defaultPlanFlag ? "plan" : "always-approve";
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
		if (this.mode === "always-approve") return undefined;

		const classification = classifyToolMutation(req);
		if (!classification.mutating) return undefined;

		if (this.mode === "plan") {
			return { block: true, reason: classification.planReason };
		}

		if (this.safeAllowTurn) return undefined;

		return await this.enqueueSafeConfirmation(async () => {
			if (this.mode === "always-approve") return undefined;
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
			const activeWriteTools = active.filter((name) => WRITE_TOOLS.has(name));
			if (activeWriteTools.length > 0) {
				const merged = new Set(this.withheldWriteTools ?? []);
				for (const name of activeWriteTools) merged.add(name);
				this.withheldWriteTools = [...merged];
				tools.setActiveTools(active.filter((name) => !WRITE_TOOLS.has(name)));
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
				const toRestore = this.withheldWriteTools.filter((name) => !activeSet.has(name));
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
			.map(([lineIdx, note]) =>
				t("plan.prompt.lineComment", {
					line: lineIdx + 1,
					source: (this.planLines[lineIdx] ?? "").trim(),
					note,
				}),
			)
			.join("\n");
	}

	approvePlan(tools?: ToolAccessPort): PlanApprovalResult {
		if (!this.planRaw.trim()) {
			return { ok: false, reason: "empty-plan" };
		}

		const commentsText = this.formatLineComments();
		this.executingPlan = this.planSteps.length > 0;
		this.setMode("always-approve", tools);
		this.planComments = {};

		const stepInstruction =
			this.planSteps.length > 0 ? t("plan.prompt.doneInstruction") : "";

		const prompt = commentsText
			? t("plan.prompt.approveWithComments", { comments: commentsText, stepInstruction })
			: t("plan.prompt.approve", { stepInstruction });

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
			prompt: t("plan.prompt.revise", { comments: commentsText }),
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
			const restoredMode = normalizeSessionMode(d.mode);
			if (restoredMode) {
				this.mode = restoredMode;
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
