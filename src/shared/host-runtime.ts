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
import { getStore } from "./session-store.ts";

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

export interface AcquiredHostTui {
	tui: TUI;
	keybindings?: KeybindingsManager;
	theme?: () => Theme;
}

export interface HostRuntimeAdapter {
	acquire(ctx: ExtensionContext): Promise<AcquiredHostTui | undefined>;
}

export interface HostRuntimeHandle {
	readonly ctx: ExtensionContext;
	readonly tui: TUI;
	readonly keybindings: KeybindingsManager | undefined;
	readonly isFullscreen: boolean;
	readonly scroll: ScrollView | undefined;
	readonly chatContainer: Container | undefined;
	readonly theme: () => Theme;
	requestRender(): void;
	mountViewportSlots(
		buildSlots: (shell: FullscreenShellContext) => MountedViewportSlots,
	): (() => void) | undefined;
	dispose(): void;
}

interface LayoutHost {
	layoutRoot: Component;
	setLayoutRoot(root: Component): void;
}

const LEGACY_OUTLINE_GUTTER = Symbol.for("pi-outline.gutter");
const ALL_MOTION_SEQ = "\x1b[?1003h";
const MOTION_APPLIED = Symbol.for("conarti.pi-ui.mouse-motion");
const ACTIVE_RUNTIME_KEY = Symbol.for("conarti.pi-ui.host-runtime.v1");

interface RuntimeSlot {
	active?: HostRuntimeHandle;
	adapter?: HostRuntimeAdapter;
}

function getRuntimeSlot(): RuntimeSlot {
	const g = globalThis as Record<symbol, RuntimeSlot | undefined>;
	if (!g[ACTIVE_RUNTIME_KEY]) {
		g[ACTIVE_RUNTIME_KEY] = {};
	}
	return g[ACTIVE_RUNTIME_KEY]!;
}

export function setHostRuntimeAdapter(adapter: HostRuntimeAdapter | undefined): void {
	getRuntimeSlot().adapter = adapter;
}

export function getActiveHostRuntime(): HostRuntimeHandle | undefined {
	return getRuntimeSlot().active;
}

export function disposeActiveHostRuntime(): void {
	const slot = getRuntimeSlot();
	const active = slot.active;
	slot.active = undefined;
	if (active) {
		active.dispose();
	}
	getStore().requestRender = undefined;
}

export function findPrimaryScroll(component: Component | undefined): ScrollView | undefined {
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

function isPlainContainer(value: unknown): value is Container {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { children?: unknown }).children) &&
		(value.constructor === Container || value.constructor?.name === "Container")
	);
}

/**
 * Resolves the transcript chat container in both fullscreen and non-fullscreen modes,
 * supporting both Pi's nested document layout (`[header, ..., chatContainer]`) and
 * flat test/fake containers where messages live directly under `scroll.child` or `tui.children[0]`.
 */
export function findChatContainer(tui: unknown, scroll?: ScrollView): Container | undefined {
	const scrollChild = (scroll as unknown as { child?: unknown } | undefined)?.child;
	if (scrollChild && typeof scrollChild === "object" && Array.isArray((scrollChild as { children?: unknown }).children)) {
		const children = (scrollChild as { children: unknown[] }).children;
		const last = children.at(-1);
		if (isPlainContainer(last)) return last;
		return scrollChild as Container;
	}

	const rootChildren = (tui as { children?: unknown[] } | undefined)?.children;
	const doc = Array.isArray(rootChildren) ? rootChildren[0] : undefined;
	if (doc && typeof doc === "object" && Array.isArray((doc as { children?: unknown }).children)) {
		const docChildren = (doc as { children: unknown[] }).children;
		const last = docChildren.at(-1);
		if (isPlainContainer(last)) return last;
		return doc as Container;
	}
	return undefined;
}

function hasLayoutHost(tui: unknown): tui is TUI & LayoutHost {
	if (!tui || typeof tui !== "object") return false;
	const rawRoot: unknown = Reflect.get(tui, "layoutRoot");
	return Boolean(
		rawRoot &&
			typeof rawRoot === "object" &&
			typeof Reflect.get(tui, "setLayoutRoot") === "function",
	);
}

function installHoverSweepHook(): void {
	const altProto = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
	if (!altProto) return;
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
}

function pruneOrphanedProbeOverlays(tui: TUI, preserveLast: boolean): void {
	const stack = (tui as any).overlayStack;
	if (!Array.isArray(stack)) return;
	for (let i = stack.length - 1; i >= 0; i--) {
		const entry = stack[i];
		if (entry?.options?.nonCapturing && !(tui as any).isOverlayVisible?.(entry)) {
			if (preserveLast && i === stack.length - 1) continue;
			stack.splice(i, 1);
		}
	}
}

function enablePointerMotionTracking(tui: TUI): void {
	if (!(tui as any)[MOTION_APPLIED]) {
		(tui as any).terminal?.write?.(ALL_MOTION_SEQ);
		(tui as any)[MOTION_APPLIED] = true;
	}
}

const defaultAdapter: HostRuntimeAdapter = {
	async acquire(ctx: ExtensionContext): Promise<AcquiredHostTui | undefined> {
		if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
		let acquired: AcquiredHostTui | undefined;
		let finishProbe: (() => void) | undefined;

		await ctx.ui.custom<void>(
			(tui, _theme, keybindings, done) => {
				finishProbe = () => done();
				pruneOrphanedProbeOverlays(tui, true);
				acquired = {
					tui,
					keybindings,
					theme: () => ctx.ui.theme,
				};
				return { render: () => [], invalidate() {} };
			},
			{
				overlay: true,
				overlayOptions: { nonCapturing: true, visible: () => false },
				onHandle: () => finishProbe?.(),
			},
		);

		return acquired;
	},
};

/**
 * Acquires the active Pi host TUI once per session start through either the
 * injected adapter (for tests) or the default single-probe production adapter.
 * Supports both fullscreen (`ScrollView` + `layoutRoot`) and non-fullscreen TUI modes.
 */
export async function acquireHostRuntime(
	ctx: ExtensionContext,
	options?: { adapter?: HostRuntimeAdapter },
): Promise<HostRuntimeHandle | undefined> {
	const slot = getRuntimeSlot();
	if (slot.active && slot.active.ctx === ctx) {
		return slot.active;
	}

	disposeActiveHostRuntime();

	const adapter = options?.adapter ?? slot.adapter ?? defaultAdapter;
	const acquired = await adapter.acquire(ctx);
	if (!acquired) return undefined;

	const { tui, keybindings } = acquired;
	const theme = acquired.theme ?? (() => ctx.ui.theme);

	const layoutHost = hasLayoutHost(tui) ? tui : undefined;
	const scroll =
		((tui as TUI & { getPrimaryScrollView?: () => ScrollView | undefined }).getPrimaryScrollView?.()) ??
		(layoutHost ? findPrimaryScroll(layoutHost.layoutRoot) : undefined);

	const isFullscreen = Boolean(layoutHost && scroll);
	if (scroll) {
		healLegacyTranscriptPatches(scroll);
	}
	installHoverSweepHook();
	enablePointerMotionTracking(tui);

	const chatContainer = findChatContainer(tui, scroll);
	let disposeMountedSlots: (() => void) | undefined;
	let disposed = false;

	const handle: HostRuntimeHandle = {
		ctx,
		tui,
		keybindings,
		isFullscreen,
		scroll,
		chatContainer,
		theme,
		requestRender() {
			tui.requestRender();
		},
		mountViewportSlots(buildSlots) {
			if (!isFullscreen || !layoutHost || !scroll || !keybindings) {
				return undefined;
			}
			disposeMountedSlots?.();
			disposeMountedSlots = undefined;

			const originalRoot = layoutHost.layoutRoot;
			const shellCtx: FullscreenShellContext = {
				tui,
				theme,
				keybindings,
				scroll,
				requestRender: () => tui.requestRender(),
			};

			const slots = buildSlots(shellCtx);
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

			layoutHost.setLayoutRoot(customRoot);

			const dispose = () => {
				if (layoutHost.layoutRoot === customRoot) {
					layoutHost.setLayoutRoot(originalRoot);
				}
				slots.topSlot?.dispose?.();
				slots.rightRail?.dispose?.();
				tui.requestRender();
				if (disposeMountedSlots === dispose) {
					disposeMountedSlots = undefined;
				}
			};
			disposeMountedSlots = dispose;
			return dispose;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			disposeMountedSlots?.();
			disposeMountedSlots = undefined;
			if (slot.active === handle) {
				slot.active = undefined;
			}
			getStore().requestRender = undefined;
		},
	};

	slot.active = handle;
	getStore().requestRender = () => handle.requestRender();
	return handle;
}
