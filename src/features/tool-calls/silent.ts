import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	DynamicBorder,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import { findChatContainer, getActiveHostRuntime, type HostRuntimeHandle } from "../../shared/host-runtime.ts";
import { hookMethod } from "../../shared/runtime-hooks.ts";
import { isThinkingBlock } from "../transcript/thinking-block.ts";
import type { DisplayMode } from "./types.ts";
import { captureViewport } from "./viewport.ts";
import { SilentActivityAnimator } from "./activity.ts";

const STATUS_KEY = "compact-tools";
const COMMAND_ARGUMENTS = ["on", "off"] as const;
export const SILENT_SHORTCUT = "ctrl+'";
// Symbol.for keys resolve to the same symbol in every evaluation of this module.
// /reload re-evaluates the module, but the patched prototypes belong to Pi and
// outlive it, so the flag they read and the patch marker must be shared.
const STATE_KEY = Symbol.for("pi-compact-tools.silent.state");
// Versioned: an instance loaded before thinking was hidden may already have
// wrapped these prototypes in the running process. A new key wraps once more
// rather than silently keeping the older behavior until Pi restarts.
const ORIGINAL_RENDER = Symbol.for("pi-compact-tools.silent.originalRender.v2");
const OVERRIDES_KEY = Symbol.for("pi-compact-tools.silent.overrides.v2");

interface SilentState {
	active: boolean;
	enabled: boolean;
	/** Set by /silent so that a /reload keeps the user's choice over the configured mode. */
	overridden: boolean;
}

type Renderable = { render(width: number): readonly string[] };
type Render = (width: number) => readonly string[];
export type RenderOverride = (component: any, width: number, render: Render) => readonly string[];

type AssistantLike = {
	hasToolCalls?: unknown;
	contentContainer?: { children?: unknown[] };
};

interface RenderOverrides {
	tool: RenderOverride;
	assistant: RenderOverride;
	notice: RenderOverride;
}

function sharedState(): SilentState {
	const holder = globalThis as typeof globalThis & { [STATE_KEY]?: SilentState };
	holder[STATE_KEY] ??= { active: false, enabled: false, overridden: false };
	return holder[STATE_KEY];
}

/**
 * Pi's own pi-tui classes. Inside Pi an extension imports the same copy Pi uses;
 * an install with a second copy (a development checkout, for one) still builds
 * the same classes, so a matching name identifies them there.
 */
export function isKind(child: unknown, kind: abstract new (...args: any[]) => unknown): boolean {
	return child instanceof kind
		|| (typeof child === "object" && child !== null && child.constructor?.name === kind.name);
}

/** Whether silent mode is currently hiding the transcript's tool rows. */
export function isSilent(): boolean {
	const state = sharedState();
	return state.active && state.enabled;
}

/** A turn that hands off to tools is progress, not an answer, however it ended. */
export function isIntermediateAssistant(component: AssistantLike): boolean {
	return component.hasToolCalls === true;
}

function isThinkingNode(child: unknown): boolean {
	return isKind(child, MouseRegion) || isThinkingBlock(child);
}

/**
 * Render only an assistant turn's answer text. Pi builds a turn from three kinds
 * of children: each thinking run (either native MouseRegion or custom ThinkingBlock),
 * the answer Markdown, and any error, abort, or truncation notice (Spacer + Text).
 * The children are swapped only for this one render, so the component and its
 * message stay untouched and reappear in full once silent mode is off.
 */
export function renderAnswerOnly(component: AssistantLike, width: number, render: Render): readonly string[] {
	const container = component.contentContainer;
	const children = container?.children;
	if (!container || !Array.isArray(children)) return render(width);
	// Most renders have nothing to drop; skip building a filtered copy for them.
	if (!children.some((child) => isThinkingNode(child) || isKind(child, Text))) return render(width);
	const kept: unknown[] = [];
	let afterThinking = false;
	for (const child of children) {
		if (isThinkingNode(child)) {
			afterThinking = true;
			continue;
		}
		if (afterThinking && isKind(child, Spacer)) {
			afterThinking = false;
			continue;
		}
		afterThinking = false;
		if (isKind(child, Text)) {
			if (isKind(kept.at(-1), Spacer)) kept.pop();
			continue;
		}
		kept.push(child);
	}
	while (isKind(kept.at(-1), Spacer)) kept.pop();
	if (kept.length === children.length) return render(width);
	// A turn that was only thinking would otherwise leave its leading blank line.
	if (kept.length === 0 || kept.every((child) => isKind(child, Spacer))) return [];
	container.children = kept;
	try {
		return render(width);
	} finally {
		container.children = children;
	}
}

/**
 * A summary Pi writes into the chat of its own accord: the context it compacted
 * away, or the /tree branch it left behind. Both are bookkeeping rather than a
 * prompt or an answer, and compaction arrives mid-turn, where a visible row
 * would come between the animating activity line and the editor below it.
 * Read through `typeof` so an older Pi without the export keeps its own rows.
 */
function isSummary(child: unknown): boolean {
	return (typeof CompactionSummaryMessageComponent === "function" && isKind(child, CompactionSummaryMessageComponent))
		|| (typeof BranchSummaryMessageComponent === "function" && isKind(child, BranchSummaryMessageComponent));
}

/**
 * A row Pi (or this extension) adds to the chat directly rather than as a message:
 * status lines are Text, "What's New" blocks add borders and Markdown too, and
 * compaction and branch summaries come as components of their own.
 */
function isNotice(child: unknown): boolean {
	return isKind(child, Text) || isKind(child, DynamicBorder) || isKind(child, Markdown) || isSummary(child);
}

/**
 * Render a transcript container without Pi's own notices. Pi writes warnings,
 * errors, and status lines ("Reloaded …", "Wait for the current response …")
 * straight into the chat as a spacer followed by a plain Text, while every
 * message has a component of its own. Dropping top-level Text rows and the
 * spacer before each leaves the conversation itself untouched.
 */
export function renderWithoutNotices(container: { children?: unknown[] }, width: number, render: Render): readonly string[] {
	const children = container.children;
	if (!Array.isArray(children) || !children.some(isNotice)) return render(width);
	const kept: unknown[] = [];
	for (const child of children) {
		if (isNotice(child)) {
			if (isKind(kept.at(-1), Spacer)) kept.pop();
			continue;
		}
		kept.push(child);
	}
	if (kept.length === children.length) return render(width);
	container.children = kept;
	try {
		return render(width);
	} finally {
		container.children = children;
	}
}

/**
 * Pi mounts the transcript document first in both regular and fullscreen mode, and
 * its chat is the document's last child, after the header and resource list.
 */
export function findChat(tui: unknown): { children: unknown[] } | undefined {
	return findChatContainer(tui) as { children: unknown[] } | undefined;
}

function hookChatNotices(host: HostRuntimeHandle | undefined): void {
	const chat = host?.chatContainer ?? (host ? findChatContainer(host.tui, host.scroll) : undefined);
	if (!chat) return;
	hookMethod(chat, "render", "silent.chatNotices", (self, args, original) => {
		const state = sharedState();
		if (!state.active || !state.enabled) return original.apply(self, args);
		return renderWithoutNotices(self, args[0], (width) => original.call(self, width));
	});
}

/**
 * Pi exposes no API to hide another extension's tool rows, so silent mode wraps
 * the shared component prototypes via the unified reload-safe hook registry.
 * Returns false when the host no longer has the expected shape, which leaves
 * the transcript untouched.
 */
export function patchRender(
	prototype: Renderable | undefined,
	override: RenderOverride,
	/** When this returns false the original render runs directly, with no override and no allocation. */
	engaged: () => boolean = () => true,
	hookName?: string,
): boolean {
	if (!prototype || typeof prototype.render !== "function") return false;
	const name = hookName ?? `silent.render.${prototype.constructor?.name || "component"}`;
	return hookMethod(
		prototype,
		"render",
		name,
		(self, args, original) => {
			const width = args[0] as number;
			if (!engaged()) return original.call(self, width);
			return override(self, width, (nextWidth) => original.call(self, nextWidth));
		},
		[ORIGINAL_RENDER],
	);
}

function sharedOverrides(): RenderOverrides | undefined {
	return (globalThis as typeof globalThis & { [OVERRIDES_KEY]?: RenderOverrides })[OVERRIDES_KEY];
}

function publishOverrides(): void {
	const state = sharedState();
	const silent = () => state.active && state.enabled;
	(globalThis as typeof globalThis & { [OVERRIDES_KEY]?: RenderOverrides })[OVERRIDES_KEY] = {
		tool: (_component, width, render) => silent() ? [] : render(width),
		// Only the prompt and the answer remain: intermediate turns go entirely, and
		// the final turn keeps its text but not its thinking or any stop notice.
		assistant: (component: AssistantLike, width, render) => {
			if (!silent()) return render(width);
			return isIntermediateAssistant(component) ? [] : renderAnswerOnly(component, width, render);
		},
		// Extension notices such as pi-web-access's "content ready" arrive between
		// tool calls; they are progress, not answers.
		notice: (_component, width, render) => silent() ? [] : render(width),
	};
}

// The patched prototypes look behavior up here on every render, so after a
// /reload they follow the newly loaded module instead of the one that patched them.
function delegate(key: keyof RenderOverrides): RenderOverride {
	return (component, width, render) => {
		const override = sharedOverrides()?.[key];
		return override ? override(component, width, render) : render(width);
	};
}

export function parseSilentArgument(args: string, current: boolean): boolean | undefined {
	const argument = args.trim().toLowerCase();
	if (argument === "") return !current;
	if (argument === "on") return true;
	if (argument === "off") return false;
	return undefined;
}

function installPatches(): boolean {
	publishOverrides();
	// Every patch is checked before any is relied on, so a partial host change
	// cannot leave tool rows hidden while their surrounding turns remain visible.
	// Normal mode pays one flag check per render and nothing else.
	const tools = patchRender(ToolExecutionComponent?.prototype, delegate("tool"), isSilent, "silent.render.tool");
	const assistant = patchRender(AssistantMessageComponent?.prototype, delegate("assistant"), isSilent, "silent.render.assistant");
	const notices = patchRender(CustomMessageComponent?.prototype, delegate("notice"), isSilent, "silent.render.notice");
	return tools && assistant && notices;
}

/** Hides tool rows, intermediate assistant turns, thinking, and extension notices; the working label carries progress instead. */
export class SilentModeController {
	private context: ExtensionContext | undefined;
	private host: HostRuntimeHandle | undefined;
	private readonly activity: SilentActivityAnimator;

	constructor(pi: ExtensionAPI, private readonly onVisible?: (ctx: ExtensionContext) => void) {
		this.activity = new SilentActivityAnimator(pi);
		pi.registerCommand("silent", {
			description: `(${SILENT_SHORTCUT}) Show only prompts and final answers`,
			getArgumentCompletions: (prefix) => {
				// Pi applies a shown completion on Enter instead of running the command, so a value
				// already typed in full is not offered again: Enter then runs it the first time.
				const typed = prefix.trim().toLowerCase();
				const items = COMMAND_ARGUMENTS
					.filter((value) => value.startsWith(typed) && value !== typed)
					.map((value) => ({ value, label: value }));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const state = sharedState();
				const enabled = parseSilentArgument(args, state.enabled);
				if (enabled === undefined) {
					ctx.ui.notify("Usage: /silent [on|off]", "warning");
					return;
				}
				this.choose(enabled);
			},
		});
		pi.registerShortcut(SILENT_SHORTCUT, {
			description: "Toggle silent mode",
			handler: () => this.choose(!sharedState().enabled),
		});
	}

	/** A choice made in the session, which a /reload keeps over the configured mode. */
	private choose(enabled: boolean): void {
		sharedState().overridden = true;
		// No notification: Pi writes notices into the transcript, which is exactly
		// what silent mode keeps clean.
		this.apply(enabled);
		if (!sharedState().enabled && this.context) this.onVisible?.(this.context);
	}

	isEnabled(): boolean {
		return sharedState().enabled;
	}

	bind(ctx: ExtensionContext, mode: DisplayMode, reload: boolean, resume = false, host?: HostRuntimeHandle): void {
		this.context = ctx;
		const resolvedHost = host ?? getActiveHostRuntime();
		this.host = resolvedHost;
		this.activity.bind(ctx, resume, resolvedHost);
		hookChatNotices(resolvedHost);
		const state = sharedState();
		if (!reload) state.overridden = false;
		this.apply(state.overridden ? state.enabled : mode === "silent");
	}

	dispose(): void {
		const context = this.context;
		this.context = undefined;
		this.host = undefined;
		// Detach state before calling host UI: an exception must not reactivate
		// silent hiding or its animation while the extension is off.
		sharedState().active = false;
		try { this.activity.dispose(); }
		finally { context?.ui.setStatus(STATUS_KEY, undefined); }
	}

	private apply(enabled: boolean): boolean {
		const state = sharedState();
		if (enabled && !installPatches()) {
			state.active = false;
			state.enabled = false;
			this.activity.setEnabled(false);
			this.context?.ui.notify("Silent mode is unavailable in this version of Pi", "warning");
			return false;
		}
		// Hiding or revealing rows above the reader would otherwise move the view.
		if (enabled !== state.enabled) captureViewport();
		state.enabled = enabled;
		this.activity.setEnabled(enabled);
		state.active = this.context !== undefined;
		// Silent mode shows no indicator of its own; the transcript itself is the cue.
		// Clearing the status still requests a render, which is what reveals or hides
		// rows already in the transcript, and removes the label older versions left.
		this.context?.ui.setStatus(STATUS_KEY, undefined);
		this.host?.requestRender();
		return true;
	}
}
