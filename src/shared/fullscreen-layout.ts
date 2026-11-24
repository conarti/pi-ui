import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	acquireHostRuntime,
	type FullscreenShellContext,
	type MountedViewportSlots,
} from "./host-runtime.ts";

export type { FullscreenShellContext, MountedViewportSlots };

/**
 * Acquires the active fullscreen TUI instance through the shared Host Runtime
 * seam and mounts a single unified layout:
 *
 *   VStack:
 *     ├── StickyPromptBar (top, auto height)
 *     ├── HStack (grow: 1):
 *     │     ├── Transcript ScrollView (grow: 1, native scrollbar intact!)
 *     │     └── OutlineRail (basis: 2, visible when >= 2 turns)
 *     └── Dock (pending messages, status, widgets, editor, footer)
 */
export async function mountFullscreenShell(
	ctx: ExtensionContext,
	buildSlots: (shell: FullscreenShellContext) => MountedViewportSlots,
): Promise<(() => void) | undefined> {
	const runtime = await acquireHostRuntime(ctx);
	if (!runtime || !runtime.isFullscreen) return undefined;
	return runtime.mountViewportSlots(buildSlots);
}
