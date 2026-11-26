export type Locale = "en";

export const DEFAULT_LOCALE: Locale = "en";

export type I18nParams = Readonly<Record<string, string | number>>;

export const EN_MESSAGES = {
	/* Composer & Header */
	"composer.placeholder": "Ask or describe a task…",
	"composer.pill.plan": "Plan",
	"composer.pill.planWithComments": "Plan ({count})",
	"header.menu": "⌃K menu",
	"header.copiedPath": "Copied path: {path}",

	/* Session Mode & Preflight */
	"sessionMode.alwaysApprove.label": "Always-approve",
	"sessionMode.alwaysApprove.short": "Always",
	"sessionMode.alwaysApprove.desc": "Full access to reads, edits, and commands",
	"sessionMode.plan.label": "Plan",
	"sessionMode.plan.short": "Plan",
	"sessionMode.plan.desc": "Read-only exploration and concise plan with inline comments",
	"sessionMode.auto.label": "Auto",
	"sessionMode.auto.short": "Auto",
	"sessionMode.auto.desc": "Runs reads and safe commands automatically; confirms edits and risky calls",
	"sessionMode.notification": "{icon} Mode: {label} — {desc}",
	"sessionMode.flag.plan": "Start the session directly in Plan mode",
	"sessionMode.shortcut.cycle": "Cycle Session Mode (Always-approve / Plan / Auto)",
	"sessionMode.shortcut.planStudio": "Toggle Plan mode or open Plan Studio",
	"sessionMode.command.alwaysApprove": "Switch Session Mode to Always-approve",
	"sessionMode.command.auto": "Switch Session Mode to Auto",
	"sessionMode.command.plan": "Plan mode and line-commentable plan review",
	"sessionMode.command.mode": "Switch Session Mode: /mode [always-approve|plan|auto]",

	"preflight.plan.writeBlocked":
		"File writes are disabled in Plan mode. Complete and approve the plan with the user first.",
	"preflight.plan.shellBlocked":
		"Only read-only commands are allowed in Plan mode ({reason}). Blocked: {cmd}",
	"preflight.plan.destructiveBlocked":
		"Destructive tool \"{toolName}\" is blocked in Plan mode.",
	"preflight.confirm.fileEdit": "Modify file: {targetPath}",
	"preflight.confirm.destructive": "Destructive tool: {toolName}",
	"preflight.auto.editBlocked": "Rejected by user in Auto mode",
	"preflight.auto.shellBlocked": "Command rejected by user in Auto mode",
	"preflight.auto.toolBlocked": "Tool \"{toolName}\" rejected by user in Auto mode",

	/* Plan & Plan Studio */
	"plan.prompt.system":
		"[PLAN MODE — STRICT PLANNING]\nModifying files is prohibited (write tools are disabled, bash is read-only).\nInspect the relevant project files first, then output a concise engineering plan:\n- No preamble, filler, or task restatement.\n- Brief goal (1-2 sentences).\n- Numbered steps (`1.`, `2.`, ...) with exact file paths, function/component names, and concrete changes.\n- Risks / edge cases — only real ones (1-3 bullets max).\n- Verification — concrete commands or checks.\nWrite compactly and structurally so the user can attach inline comments to specific lines.",
	"plan.prompt.execContext":
		"[Plan execution] Remaining steps:\n{list}\nAfter finishing each step, include a `[DONE:n]` marker.",
	"plan.prompt.lineComment": "- Line {line} (`{source}`): {note}",
	"plan.prompt.doneInstruction":
		"\nAfter completing each numbered plan step, emit a `[DONE:n]` marker (for example `[DONE:1]`) so progress updates automatically.",
	"plan.prompt.approveWithComments":
		"Implement the approved plan taking my line comments into account:\n\n### Plan line comments\n{comments}{stepInstruction}",
	"plan.prompt.approve": "Plan approved. Proceed with step-by-step implementation.{stepInstruction}",
	"plan.prompt.revise":
		"Update the plan concisely, addressing my line comments directly:\n\n{comments}",
	"plan.cleared": "Saved plan cleared",
	"plan.allStepsDone": "✓ All plan steps completed",
	"plan.emptyNotify": "Generate a plan in Plan mode first",
	"plan.waitForIdle": "Wait for the current assistant response to finish",
	"plan.needComment": "Add at least one line comment first (click a line or press Enter)",
	"plan.widget.progress": "📋 Plan {done}/{total}",
	"plan.widget.hide": "✕ Hide",
	"plan.widget.currentStep": " · Now: {step}. {text}",
	"plan.widget.allDone": " · All steps completed ✓",
	"plan.widget.openWithComments": "📋 Open plan · 💬 {count} comments",
	"plan.widget.open": "📋 Open plan ({count} lines)",
	"plan.widget.approve": "✓ Implement",
	"plan.widget.modeBadge": "◈ Plan Mode",
	"plan.widget.modeHint": " Describe a task to generate a concise plan with line-by-line review",
	"planStudio.emptyNotify":
		"No plan yet — send a prompt in Plan mode and review will open automatically",
	"planStudio.subHeader": "Click any line (or press Enter / c) to attach an inline comment below it",
	"planStudio.editHint": "  [Enter save · Esc cancel]",
	"planStudio.commentPlaceholder": "Comment…",
	"planStudio.pill.approve": "✓ Implement (Ctrl+↵)",
	"planStudio.pill.reviseWithCount": "↻ Revise ({count}) (Ctrl+R)",
	"planStudio.pill.revise": "↻ Revise (Ctrl+R)",
	"planStudio.pill.clearComments": "🗑 Clear comments",
	"planStudio.pill.close": "✕ Close (Esc)",
	"planStudio.title": "◈ Plan Studio",

	/* Auto Mode Permission Confirmation */
	"permission.confirmTitle": "Auto: allow {toolName}?",
	"permission.toolLabel": "Tool:",
	"permission.modalTitle": "🛡 Auto Permission",
	"permission.pill.allow": "✓ Allow (Enter)",
	"permission.pill.allowTurn": "✓ Allow for turn (a)",
	"permission.pill.deny": "✕ Deny (Esc)",

	/* Command Palette */
	"palette.title": "⌘ Command Palette",
	"palette.searchPlaceholder": "Search commands, modes, themes, settings, skills…",
	"palette.empty": "  No matching commands",
	"palette.footerHint": "·  ↑↓ / wheel select  ·  Enter / click run  ·  Esc close",
	"palette.shortcut": "Open Command Palette (@conarti/pi-ui)",
	"palette.command": "Open Command Palette (Ctrl+K)",
	"palette.group.mode": "Mode",
	"palette.group.context": "Context",
	"palette.group.ui": "Interface",
	"palette.group.settings": "Settings",
	"palette.group.model": "Model",
	"palette.group.view": "View",
	"palette.group.theme": "Theme",
	"palette.group.session": "Session",
	"palette.group.skill": "Skill",
	"palette.group.command": "Command",
	"palette.item.planModeOff": "Exit Plan mode → Always-approve",
	"palette.item.planModeOn": "Enable Plan mode (read-only planning)",
	"palette.item.planStudioWithLines": "Open Plan Studio ({count} lines, inline comments)",
	"palette.item.planStudio": "Open Plan Studio",
	"palette.item.autoModeOff": "Exit Auto mode → Always-approve",
	"palette.item.autoModeOn": "Enable Auto mode (confirm edits & risky calls)",
	"palette.item.contextInspector": "Context & token inspector",
	"palette.item.compact": "Compact conversation history",
	"palette.item.stickyToggle": "Sticky Prompt: {action}",
	"palette.item.outlineToggle": "Outline Rail: {action}",
	"palette.item.densityCycle": "Tool Density: {current} (cycle)",
	"palette.item.suggestionsToggle": "Prompt Suggestion: {action}",
	"palette.item.shortcutsBarToggle": "Shortcuts Bar: {action}",
	"palette.item.responseMetricsToggle": "Response Metrics: {action}",
	"palette.item.copyOnSelectToggle": "Copy on Select: {action}",
	"palette.item.timestampsCycle": "Timestamps: {current} (cycle)",
	"palette.item.midTurnEnterCycle": "Mid-turn Enter: {current} (toggle)",
	"palette.item.aiWorkingStatusToggle": "AI Working Status: {action}",
	"palette.item.modelSelect": "Select model ({model})",
	"palette.item.thinkingCycle": "Cycle thinking level (current: {level})",
	"palette.item.thinkingToggle": "Collapse / expand Thinking blocks",
	"palette.item.toolsToggle": "Collapse / expand tool output",
	"palette.item.themeOneBluePro": "Theme: One Blue Pro (dark slate blue)",
	"palette.item.themeNordicOcean": "Theme: Nordic Ocean (deep arctic blue)",
	"palette.item.themeMidnightCobalt": "Theme: Midnight Cobalt (high-contrast electric blue)",
	"palette.item.themeOneBlueLight": "Theme: One Blue Light (crisp light blue)",
	"palette.item.sessionNew": "New session",
	"palette.item.sessionResume": "Resume previous session",
	"palette.item.sessionTree": "Navigate session tree",
	"palette.item.sessionFork": "Fork session from a previous turn",
	"palette.action.enable": "enable",
	"palette.action.disable": "disable",
	"palette.action.show": "show",
	"palette.action.hide": "hide",
	"palette.themeApplied": "Theme: {name}",
	"palette.compactBusy": "Wait for the current response to finish before compacting",
	"palette.compactStarted": "Compacting context…",
	"palette.compactDone": "Context compacted ✓",
	"palette.compactError": "Compaction failed: {message}",

	/* Context Inspector & Response Metrics */
	"context.command": "Inspect context usage, session telemetry, and session info (/context)",
	"context.statsCommand": "Open Context Inspector on Session usage (/stats)",
	"context.metricsCommand": "Open Session usage or toggle Response Metrics row (/metrics [on|off|toggle])",
	"context.title": "◐ Context Inspector",
	"context.tab.context": "Context usage",
	"context.tab.usage": "Session usage",
	"context.tab.session": "Session info",
	"context.tokensSummary": "({used} / {window} tokens)",
	"context.contextHeader": "Context",
	"context.tokensLine": "{used} / {window} tokens ({percent}%)",
	"context.row.system": "System prompt",
	"context.row.systemDesc": "system prompt, rules, and skills",
	"context.row.chat": "Messages",
	"context.row.chatDesc": "messages and reasoning ({turns} turns)",
	"context.row.tools": "Reasoning & overhead",
	"context.row.toolsDesc": "tool calls and results",
	"context.row.free": "Free",
	"context.row.reserve": "Compact buffer",
	"context.row.reserveDesc": "reserved before auto-compaction",
	"context.alreadyCounted": "Already counted above",
	"context.row.toolDefs": "Tool definitions",
	"context.row.skills": "Skills",
	"context.toolsCount": "{count} tools",
	"context.skillsCount": "{count} skills",
	"context.tokensValue": "{count} tokens",
	"context.usageHeader": "Session usage (since start or last resume)",
	"context.usage.input": "Input tokens:",
	"context.usage.output": "Output tokens:",
	"context.usage.total": "Total tokens:",
	"context.usage.calls": "Model calls:",
	"context.usage.cost": "Cost:",
	"context.usage.cachedSuffix": " ({count} cached)",
	"context.usage.reasoningSuffix": " ({count} reasoning)",
	"context.usage.apiTimeSuffix": " · API time: {duration}",
	"context.usage.byModel": "Model + Effort",
	"context.usage.byTurn": "Per-turn throughput",
	"context.usage.empty": "No completed turns recorded yet.",
	"context.info.title": "Title",
	"context.info.piVersion": "Pi version",
	"context.info.sessionId": "Session ID",
	"context.info.workingDir": "Working directory",
	"context.info.model": "Model",
	"context.info.turn": "Turn",
	"context.info.context": "Context",
	"context.sessionLine": "Session:",
	"context.pill.copyMarkdown": "Copy Markdown · m",
	"context.pill.copiedMarkdown": "✓ Copied MD",
	"context.pill.copyAll": "Copy all · y",
	"context.pill.copiedAll": "✓ Copied all",
	"context.pill.copyId": "Copy ID · c",
	"context.pill.copiedId": "✓ Copied ID",
	"context.pill.compact": "⚡ Compact context",
	"context.pill.close": "Close · Esc",
	"context.compactBusy": "Wait for the current response to finish before compacting context",
	"context.compactDone": "Context compacted successfully",
	"metrics.workedFor": "Worked for {duration}",
	"metrics.ttftPart": "ttft {duration}",
	"metrics.ratePart": "{rate} tok/s",
	"metrics.enabledNotify": "Response Metrics row enabled.",
	"metrics.disabledNotify": "Response Metrics row hidden.",
	"metrics.usageNotify": "Usage: /metrics [on|off|toggle]",

	/* Quotes */
	"quotes.selectionPopup.copy": "Copy",
	"quotes.selectionPopup.copied": "✓ Copied",
	"quotes.selectionPopup.quoteAction": "Quote · Alt+Q",
	"quotes.selectionPopup.word": "Quote",
	"quotes.selectionPopup.label": "[Copy]  [Quote · Alt+Q]",
	"quotes.shortcut": "Insert selected text or clipboard as a quote chip",
	"quotes.command.quote": "Quote an assistant reply from history (/quote [n], default 1)",
	"quotes.command.quotes": "Inspect, edit, and clear active draft quotes",
	"quotes.needSelectionOrClipboard":
		"Select text in the transcript or copy it to the clipboard before pressing Alt+Q",
	"quotes.emptyHistory": "No assistant replies in this session yet",
	"quotes.outOfRange": "Available assistant replies in this session: {total} (requested #{requested})",
	"quotes.usage.quote": "Usage: /quote [n] (n >= 1, default 1)",
	"quotes.noneInDraft": "No active quotes in the draft",
	"quotes.modal.title": "❝ Draft Quotes",
	"quotes.modal.emptyTitle": "❝ Quotes",
	"quotes.modal.emptyBody": "No active quotes in the draft",
	"quotes.modal.editTitle": "❝ Quote #{num}",
	"quotes.modal.editHeader": "Editing chip #{num}",
	"quotes.modal.save": "Save",
	"quotes.modal.cancel": "Cancel",
	"quotes.modal.edit": "Edit",
	"quotes.modal.remove": "Remove",
	"quotes.modal.clearAll": "Clear all",
	"quotes.modal.close": "Close",
	"quotes.clearedCount": "Removed quotes: {count}",
	"quotes.usage.remove": "Usage: /quotes remove <number>",
	"quotes.usage.edit": "Usage: /quotes edit <number> [new text]",
	"quotes.usage.quotes": "Usage: /quotes [edit <number> [text] | remove <number> | clear]",
	"quotes.notFound": "Quote #{num} not found in the draft",
	"quotes.removed": "Quote #{num} removed",
	"quotes.updated": "Quote #{num} updated",

	/* Sticky Prompt & Outline Rail */
	"sticky.command": "Pinned active prompt at top of viewport: {usage}",
	"sticky.fullscreenOnly": "Sticky Prompt is available in fullscreen TUI",
	"sticky.toggled": "Sticky Prompt: {state}",
	"sticky.modeChanged": "Sticky mode: {mode}",
	"sticky.usage": "Usage: {usage}",
	"outline.fullscreenOnly": "Outline Rail is available in fullscreen TUI",
	"outline.toggled": "Outline Rail: {state}",
	"outline.shortcut": "Show / hide right-side Outline Rail",
	"outline.command": "Show / hide right-side Outline Rail (Ctrl+Alt+O)",
	"state.on": "on",
	"state.off": "off",
	"state.shown": "shown",
	"state.hidden": "hidden",

	/* Prompt Suggestions & Unified Config Commands */
	"suggestions.command": "Enable or disable Prompt Suggestion (/suggestions [on|off])",
	"suggestions.usage": "Usage: /suggestions [on|off]",
	"suggestions.toggled": "Prompt Suggestion: {state}",
	"shortcutsBar.command": "Show or hide Shortcuts Bar (/shortcuts-bar [on|off|status])",
	"shortcutsBar.usage": "Usage: /shortcuts-bar [on|off|status]",
	"shortcutsBar.toggled": "Shortcuts Bar: {state}",
	"shortcutsBar.status": "Shortcuts Bar is currently {state}",
	"slots.command": "Inspect or update Slot Arbitration owners (/slots [status|clear|<slot> <owner>])",
	"slots.usage": "Usage: /slots [status|clear|<slot> <owner>]",
	"slots.empty": "Slot owners: default (@conarti/pi-ui manages available UI slots)",
	"slots.status": "Slot owners: {entries}",
	"slots.cleared": "Slot owners cleared",
	"slots.updated": "Slot \"{slot}\" assigned to \"{owner}\"",
	"config.updated": "{setting}: {value}",

	/* Transcript & Turns */
	"transcript.truncated": "Response truncated by token limit.",
	"transcript.stopped": "Stopped",
	"transcript.error": "Error: {message}",
	"turn.fallbackTitle": "Turn #{ordinal}",

	/* Ask User Question */
	"askUser.label": "Ask user",
	"askUser.callTitle": "Ask user · {count} {noun}",
	"askUser.questionSingular": "question",
	"askUser.questionPlural": "questions",
	"askUser.cancelled": "Questionnaire cancelled",
	/* Working Status & Thinking */
	"working.drafting": "Drafting…",
	"working.stop": "[stop]",
	"thinking.streaming": "Thinking…",
	"thinking.thought": "Thought",
	"thinking.thoughtFor": "Thought for {duration}",

	"askUser.notePrefix": "Note: {note}",
	"askUser.globalNotePrefix": "Global note: {note}",
	"askUser.wantsToChat": "User wants to chat about this",
} as const;

export type I18nKey = keyof typeof EN_MESSAGES;

const CATALOGS: Readonly<Record<Locale, Readonly<Record<I18nKey, string>>>> = {
	en: EN_MESSAGES,
};

const LOCALE_STATE_KEY = Symbol.for("conarti.pi-ui.locale.v1");

function getLocaleSlot(): { locale: Locale } {
	const g = globalThis as Record<symbol, { locale: Locale } | undefined>;
	if (!g[LOCALE_STATE_KEY]) {
		g[LOCALE_STATE_KEY] = { locale: DEFAULT_LOCALE };
	}
	return g[LOCALE_STATE_KEY]!;
}

/**
 * Возвращает активную локаль пользовательского интерфейса (по умолчанию `"en"`).
 */
export function getLocale(): Locale {
	return getLocaleSlot().locale;
}

/**
 * Переключает активную локаль через единый фасад `i18n` для будущих локализаций.
 */
export function setLocale(next: Locale): void {
	getLocaleSlot().locale = next in CATALOGS ? next : DEFAULT_LOCALE;
}

/**
 * Разрешает типизированную строку каталога локализации и подставляет именованные параметры `{name}`.
 */
export function t(key: I18nKey, params?: I18nParams): string {
	const catalog = CATALOGS[getLocale()] ?? EN_MESSAGES;
	const template = catalog[key] ?? EN_MESSAGES[key];
	if (!params) return template;
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
		const value = params[name];
		return value !== undefined ? String(value) : match;
	});
}
