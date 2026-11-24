import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SessionMode = "code" | "plan" | "safe";

export interface PlanStep {
	step: number;
	text: string;
	completed: boolean;
}

export interface ConartiUiStore {
	mode: SessionMode;
	planRaw: string;
	planLines: string[];
	planComments: Record<number, string>;
	planSteps: PlanStep[];
	executingPlan: boolean;
	safeAllowTurn: boolean;
	toolsBeforePlan?: string[];
	isStreaming: boolean;
	requestRender?: () => void;
	runAppAction?: (action: string) => boolean;
	submitPrompt?: () => void;
	jumpPrompt?: (delta: -1 | 1) => void;
}

const STORE_KEY = Symbol.for("conarti.pi-ui.store.v1");
export const SESSION_ENTRY_TYPE = "conarti-ui-state";

export function getStore(): ConartiUiStore {
	const g = globalThis as Record<symbol, ConartiUiStore | undefined>;
	if (!g[STORE_KEY]) {
		g[STORE_KEY] = {
			mode: "code",
			planRaw: "",
			planLines: [],
			planComments: {},
			planSteps: [],
			executingPlan: false,
			safeAllowTurn: false,
			isStreaming: false,
		};
	}
	return g[STORE_KEY]!;
}

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

export function persistSessionStore(pi: ExtensionAPI): void {
	const st = getStore();
	pi.appendEntry(SESSION_ENTRY_TYPE, {
		mode: st.mode,
		planRaw: st.planRaw,
		planComments: st.planComments,
		planSteps: st.planSteps,
		executingPlan: st.executingPlan,
	});
}

export function restoreSessionStore(entries: readonly any[], defaultPlanFlag: boolean): void {
	const st = getStore();
	const saved = [...entries]
		.reverse()
		.find(
			(e) =>
				e?.type === "custom" &&
				(e?.customType === SESSION_ENTRY_TYPE || e?.customType === "grok-ui-state"),
		);

	if (saved?.data) {
		const d = saved.data;
		if (d.mode === "code" || d.mode === "plan" || d.mode === "safe") {
			st.mode = d.mode;
		}
		st.planRaw = typeof d.planRaw === "string" ? d.planRaw : "";
		st.planLines = st.planRaw ? st.planRaw.split("\n") : [];
		st.planComments = d.planComments && typeof d.planComments === "object" ? { ...d.planComments } : {};
		st.planSteps = Array.isArray(d.planSteps) ? d.planSteps : [];
		st.executingPlan = Boolean(d.executingPlan);
	} else {
		st.mode = defaultPlanFlag ? "plan" : "code";
		st.planRaw = "";
		st.planLines = [];
		st.planComments = {};
		st.planSteps = [];
		st.executingPlan = false;
	}
}
