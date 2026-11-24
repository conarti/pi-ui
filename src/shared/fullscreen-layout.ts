import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	HStack,
	ScrollView,
	TuiAltScreen,
	VStack,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { beginHoverMovePass, finishHoverMovePass, hookMethod } from "./runtime-hooks.ts";

export interface FullscreenShellContext {
	tui: TUI;
	theme: () => Theme;
	keybindings: KeybindingsManager;
	scroll: ScrollView;
	requestRender: () => void;
}

export interface MountedViewportSlots {
	topSlot?: Component & { dispose?(): void };
	rightRail?: Component & {
		basisWidth: number;
		isVisible: (viewport: { width: number; height: number }) => boolean;
		dispose?(): void;
	};
}

interface LayoutHost {
	layoutRoot: Component;
	setLayoutRoot(root: Component): void;
}

const LEGACY_OUTLINE_GUTTER = Symbol.for("pi-outline.gutter");
const ALL_MOTION_SEQ = "\x1b[?1003h";
const MOTION_APPLIED = Symbol.for("conarti.pi-ui.mouse-motion");

function findPrimaryScroll(component: Component | undefined): ScrollView | undefined {
	if (!component) return undefined;
	if (component instanceof ScrollView) return component.primary ? component : undefined;
	if (component instanceof Container) {
		for (const child of component.children) {
			const found = findPrimaryScroll(child);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Cleans up any leftover gutter/hidden-scrollbar patch left in memory by older
 * standalone extensions (e.g. `pi-conversation-outline` or `grok-ui` timeline-rail)
 * when hot-reloading inside an existing Pi session.
 */
function healLegacyTranscriptPatches(scroll: ScrollView): void {
	const svAny = scroll as any;
	const legacyGutter = svAny[LEGACY_OUTLINE_GUTTER];
	if (legacyGutter) {
		if (typeof legacyGutter.getContentWidth === "function") {
			svAny.getContentWidth = legacyGutter.getContentWidth;
		}
		delete svAny[LEGACY_OUTLINE_GUTTER];
	}
	if (scroll.scrollbar === "hidden") {
		scroll.setScrollbar("auto");
	}

	// Neutralize legacy grok-ui timeline rail hooks if still present on TuiAltScreen.prototype
	const altProto = TuiAltScreen.prototype as any;
	hookMethod(
		altProto,
		"compositeScrollToEndIndicator",
		"viewport.passthroughEndIndicator",
		(self, args, original) => original.apply(self, args),
		["pi.grok-ui.hook.chat.timelineComposite"],
	);
	hookMethod(
		altProto,
		"handleMouseEvent",
		"viewport.hoverSweep",
		(self, args, original) => {
			const raw = args[0] as { button: number; release: boolean };
			const isPureMove = (raw.button & 32) !== 0 && (raw.button & 3) === 3 && !raw.release;
			if (isPureMove) {
				beginHoverMovePass();
				const res = original.apply(self, args);
				if (finishHoverMovePass()) {
					self.requestRender?.();
				}
				return res;
			}
			return original.apply(self, args);
		},
		["pi.grok-ui.hook.chat.timelineMouse"],
	);
}

/**
 * Acquires the active fullscreen TUI instance and mounts a single unified layout:
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
	if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;

	let disposeFn: (() => void) | undefined;
	let finishProbe: (() => void) | undefined;

	await ctx.ui.custom<void>(
		(tui, _theme, keybindings, done) => {
			finishProbe = () => done();
			const rawRoot: unknown = Reflect.get(tui, "layoutRoot");
			if (
				!rawRoot ||
				typeof rawRoot !== "object" ||
				typeof Reflect.get(tui, "setLayoutRoot") !== "function"
			) {
				return { render: () => [], invalidate() {} };
			}

			const host = tui as unknown as LayoutHost;
			const originalRoot = host.layoutRoot;
			const scroll = findPrimaryScroll(originalRoot);
			if (!scroll) {
				return { render: () => [], invalidate() {} };
			}

			healLegacyTranscriptPatches(scroll);

			// Clean up any orphaned hidden nonCapturing overlays left from earlier extensions before /reload
			const stack = (tui as any).overlayStack;
			if (Array.isArray(stack)) {
				for (let i = stack.length - 1; i >= 0; i--) {
					const entry = stack[i];
					if (entry?.options?.nonCapturing && !(tui as any).isOverlayVisible?.(entry)) {
						// Skip our own active probe overlay (the very last entry mounted by this custom() call)
						if (i === stack.length - 1) continue;
						stack.splice(i, 1);
					}
				}
			}

			// Enable pointer motion tracking so hover previews on Sticky, Code Cards, and Outline Rail work smoothly
			if (!(tui as any)[MOTION_APPLIED]) {
				(tui as any).terminal?.write?.(ALL_MOTION_SEQ);
				(tui as any)[MOTION_APPLIED] = true;
			}

			const shellCtx: FullscreenShellContext = {
				tui,
				theme: () => ctx.ui.theme,
				keybindings,
				scroll,
				requestRender: () => tui.requestRender(),
			};

			const slots = buildSlots(shellCtx);

			// Extract dock siblings if originalRoot is Pi's standard VStack([transcript, dock])
			const rootEntries: any[] | undefined = (originalRoot as any).entries;
			const transcriptIdx = Array.isArray(rootEntries)
				? rootEntries.findIndex((e) => e?.component === scroll)
				: -1;

			let customRoot: VStack;
			if (transcriptIdx !== -1 && Array.isArray(rootEntries)) {
				const middleRow = slots.rightRail
					? new HStack([
							{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
							{
								component: slots.rightRail,
								basis: slots.rightRail.basisWidth,
								grow: 0,
								shrink: 0,
								visible: slots.rightRail.isVisible,
							},
						])
					: scroll;

				const nextEntries = [
					...(slots.topSlot
						? [{ component: slots.topSlot, basis: "auto" as const, grow: 0, shrink: 0 }]
						: []),
					...rootEntries.slice(0, transcriptIdx),
					{ component: middleRow, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					...rootEntries.slice(transcriptIdx + 1),
				];
				customRoot = new VStack(nextEntries);
			} else {
				customRoot = new VStack([
					...(slots.topSlot
						? [{ component: slots.topSlot, basis: "auto" as const, grow: 0, shrink: 0 }]
						: []),
					{ component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				]);
			}

			host.setLayoutRoot(customRoot);

			disposeFn = () => {
				if (host.layoutRoot === customRoot) {
					host.setLayoutRoot(originalRoot);
				}
				slots.topSlot?.dispose?.();
				slots.rightRail?.dispose?.();
				tui.requestRender();
			};

			return { render: () => [], invalidate() {} };
		},
		{
			overlay: true,
			overlayOptions: { nonCapturing: true, visible: () => false },
			onHandle: () => finishProbe?.(),
		},
	);

	return disposeFn;
}
