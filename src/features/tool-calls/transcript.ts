import { ToolExecutionComponent, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findChatContainer, getActiveHostRuntime, type HostRuntimeHandle } from "../../shared/host-runtime.ts";
import type { RowRenderers, ToolRow } from "./custom.ts";
import { refreshRowShell, syncNativeToolTimer } from "./rendering.ts";
import type { ToolRuntime } from "./runtime.ts";
import { isKind } from "./silent.ts";

type Definition = ToolDefinition<any, any, any> | undefined;
export interface UIFailure { operation: string; error: unknown }

/** Attempt every independent cleanup/row action; the caller reports failures once. */
export function attemptUI(failures: UIFailure[], operation: string, action: () => void): void {
	try { action(); } catch (error) { failures.push({ operation, error }); }
}

interface TranscriptOptions {
	runtime: ToolRuntime;
	publicRendering: boolean;
	resolve(row: ToolRow): RowRenderers | undefined;
	definition(name: string, base: Definition): Definition;
	unwrap(definition: Definition): Definition;
}

/** Own the Host Runtime binding and the private host-row reconciliation boundary together. */
export function createTranscriptRenderer(options: TranscriptOptions) {
	let refresh: ((failures: UIFailure[]) => void) | undefined;

	const reconcile = (host: HostRuntimeHandle, failures: UIFailure[]) => {
		const visit = (parent: { children?: unknown[] }) => {
			for (const child of parent.children ?? []) {
				if (!child || typeof child !== "object") continue;
				attemptUI(failures, "tool row", () => {
					if (!isKind(child, ToolExecutionComponent)) { visit(child); return; }
					const row = child as ToolRow & { toolCallId: string; updateDisplay?(): void; callRendererComponent?: unknown; resultRendererComponent?: unknown };
					const base = options.unwrap(row.toolDefinition);
					syncNativeToolTimer(row, row.toolName, base, !options.resolve({ toolName: row.toolName, toolDefinition: base }), options.runtime.timing(row.toolCallId));
					if (options.publicRendering) {
						row.toolDefinition = options.definition(row.toolName, base);
						// Components must not cross native/compact renderer ownership,
						// even when both definitions request the same shell.
						row.callRendererComponent = undefined;
						row.resultRendererComponent = undefined;
					}
					refreshRowShell(row);
					row.updateDisplay?.();
				});
			}
		};
		attemptUI(failures, "transcript", () => {
			const chat = host.chatContainer ?? findChatContainer(host.tui, host.scroll);
			if (chat && chat.children.length > 0) {
				visit(chat);
				attemptUI(failures, "repaint", () => host.requestRender());
			}
		});
	};

	return {
		bind(_ctx: ExtensionContext, failures: UIFailure[], host?: HostRuntimeHandle): void {
			const resolved = host ?? getActiveHostRuntime();
			if (!resolved) {
				options.runtime.bindRenderer(undefined);
				refresh = undefined;
				return;
			}
			options.runtime.bindRenderer(() => resolved.requestRender());
			refresh = (errors) => reconcile(resolved, errors);
			refresh(failures);
		},
		refresh(failures: UIFailure[]): void { refresh?.(failures); },
		detach(): void {
			refresh = undefined;
			options.runtime.bindRenderer(undefined);
		},
		/** Reconcile provisional startup rows without binding runtime animation. */
		reconcileOnce(_ctx: ExtensionContext, failures: UIFailure[], host?: HostRuntimeHandle): void {
			if (refresh) { refresh(failures); return; }
			const resolved = host ?? getActiveHostRuntime();
			if (resolved) reconcile(resolved, failures);
		},
	};
}
