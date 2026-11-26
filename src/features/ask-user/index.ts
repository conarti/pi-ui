import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { t } from "../../shared/i18n.ts";
import { display } from "./display.ts";
import { runQuestionnaire } from "./questionnaire.ts";
import { description, parameters } from "./schema.ts";
import type { Result } from "./result.ts";
import type { Usage } from "@earendil-works/pi-ai";
import { addUsage, type Request } from "./explain.ts";

export function registerAskUserFeature(pi: ExtensionAPI): void {
  const pending = new Set<AbortController>();
  let lastRequest: Request | undefined;
  pi.on("context_with_system", event => { lastRequest = event.messages; });
  const excludeOutsideTerminal = (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      const active = pi.getActiveTools();
      if (active.includes("ask_user_question")) pi.setActiveTools(active.filter(name => name !== "ask_user_question"));
    }
  };
  pi.on("session_start", (event, ctx) => { lastRequest = undefined; excludeOutsideTerminal(event, ctx); });
  pi.on("before_agent_start", excludeOutsideTerminal);
  pi.on("session_shutdown", () => {
    for (const controller of pending) controller.abort();
    pending.clear();
  });
  pi.registerTool<typeof parameters, Result>({
    name: "ask_user_question", label: t("askUser.label"), description, parameters,
    exposure: "model-only", executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      const controller = new AbortController();
      pending.add(controller);
      try {
        let usage: Usage | undefined;
        const result = await runQuestionnaire(ctx, params, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, {
          lastRequest: () => lastRequest,
          onUsage: next => { usage = addUsage(usage, next); },
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(usage ? { usage } : {}) };
      } finally { pending.delete(controller); }
    },
    renderCall(args, theme) {
      const count = args.questions?.length ?? 0;
      const noun = count === 1 ? t("askUser.questionSingular") : t("askUser.questionPlural");
      return new Text(theme.fg("toolTitle", t("askUser.callTitle", { count, noun })), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const details = result.details;
      if (!details) return new Text(display(result.content.filter(item => item.type === "text").map(item => item.text).join("\n")), 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", t("askUser.cancelled")), 0, 0);
      const lines = details.answers.map(answer => {
        const question = context?.args?.questions?.[answer.questionIndex - 1]?.question;
        const label = question ? `${display(question)} ${theme.fg("muted", "→")}` : `${answer.questionIndex}.`;
        const value = theme.fg("accent", display([...answer.selected, answer.custom].filter(Boolean).join("; ")));
        return `${theme.fg("muted", "·")} ${label} ${value}${answer.notes ? `\n  ${theme.fg("muted", t("askUser.notePrefix", { note: display(answer.notes) }))}` : ""}`;
      });
      if (details.globalNote) lines.push(t("askUser.globalNotePrefix", { note: display(details.globalNote) }));
      if (details.chat) lines.unshift(theme.fg("warning", t("askUser.wantsToChat")));
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
