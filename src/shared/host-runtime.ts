import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	TuiAltScreen,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	ViewportChromeCompositor,
	type FullscreenShellContext,
	type MountedViewportSlots,
} from "./fullscreen-layout.ts";
import { beginHoverMovePass, finishHoverMovePass, hookMethod } from "./runtime-hooks.ts";
import { setRequestRender } from "./ui-action-bridge.ts";

export type { FullscreenShellContext, MountedViewportSlots };

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
	readonly viewportSlots: MountedViewportSlots | undefined;
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
const COMPOSITOR_MAP_KEY = Symbol.for("conarti.pi-ui.viewport-compositors.v1");

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

function getCompositorMap(): WeakMap<object, ViewportChromeCompositor> {
	const g = globalThis as Record<symbol, WeakMap<object, ViewportChromeCompositor> | undefined>;
	if (!g[COMPOSITOR_MAP_KEY]) {
		g[COMPOSITOR_MAP_KEY] = new WeakMap();
	}
	return g[COMPOSITOR_MAP_KEY]!;
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
	setRequestRender(undefined);
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

function resolveContainerCandidate(candidate: unknown): Container | undefined {
	if (!candidate || typeof candidate !== "object") return undefined;
	const children = (candidate as { children?: unknown }).children;
	if (!Array.isArray(children)) return undefined;
	const last = children.at(-1);
	return isPlainContainer(last) ? last : (candidate as Container);
}

/**
 * Resolves the transcript chat container in both fullscreen and non-fullscreen modes,
 * supporting both Pi's nested document layout (`[header, ..., chatContainer]`) and
 * flat test/fake containers where messages live directly under `scroll.child` or `tui.children[0]`.
 */
export function findChatContainer(tui: unknown, scroll?: ScrollView): Container | undefined {
	const scrollChild = (scroll as unknown as { child?: unknown } | undefined)?.child;
	const fromScroll = resolveContainerCandidate(scrollChild);
	if (fromScroll) return fromScroll;

	const rootChildren = (tui as { children?: unknown[] } | undefined)?.children;
	return resolveContainerCandidate(Array.isArray(rootChildren) ? rootChildren[0] : undefined);
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

function installViewportChromeHooks(): void {
	const altProto = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
	if (!altProto) return;

	hookMethod(
		altProto,
		"compositeScrollToEndIndicator",
		"viewport.passthroughEndIndicator",
		(self, args, original) => {
			const base = original.apply(self, args) as string[];
			const compositor = getCompositorMap().get(self);
			if (!compositor) return base;
			const layout = args[1] as { root?: any } | undefined;
			const width = Number(args[2] ?? self.terminal?.columns ?? 80);
			return compositor.compositeFrame(base, layout, width);
		},
		["pi.grok-ui.hook.chat.timelineComposite"],
	);

	hookMethod(
		altProto,
		"getSelectionColumns",
		"viewport.clampChromeSelectionColumns",
		(self, args, original) => {
			const columns = original.apply(self, args) as { start: number; end: number };
			const compositor = getCompositorMap().get(self);
			if (!compositor || !compositor.applyingSelection) return columns;
			const row = Number(args[1] ?? -1);
			return compositor.clampSelectionColumns(row, columns);
		},
	);

	hookMethod(
		altProto,
		"applySelection",
		"viewport.maskChromeSelection",
		(self, args, original) => {
			const compositor = getCompositorMap().get(self);
			if (!compositor) return original.apply(self, args);
			const preSelection = args[0] as string[];
			const selectionBounds = self.getSelectionBounds?.();
			const isPrimaryScrollSelection = selectionBounds?.start?.scrollView === compositor.scrollRef;
			compositor.applyingSelection = isPrimaryScrollSelection;
			try {
				const postSelection = original.apply(self, args) as string[];
				if (postSelection === preSelection || isPrimaryScrollSelection) return postSelection;
				const width = Math.max(1, Number(self.terminal?.columns ?? 80));
				return compositor.maskSelection(preSelection, postSelection, width);
			} finally {
				compositor.applyingSelection = false;
			}
		},
	);

	hookMethod(
		altProto,
		"dispatchMouseToLayout",
		"viewport.blockChromeWheelPassthrough",
		(self, args, original) => {
			const event = args[0] as { type?: string; screenX?: number; screenY?: number } | undefined;
			if (event?.type === "wheel" && typeof event.screenX === "number" && typeof event.screenY === "number") {
				const compositor = getCompositorMap().get(self);
				if (compositor?.isChromeHit(self, event.screenX, event.screenY)) {
					return undefined;
				}
			}
			return original.apply(self, args);
		},
	);

	hookMethod(
		altProto,
		"handleMouseEvent",
		"viewport.hoverSweep",
		(self, args, original) => {
			const raw = args[0] as { button: number; x: number; y: number; release: boolean };
			const isPureMove = (raw.button & 32) !== 0 && (raw.button & 3) === 3 && !raw.release;
			const compositor = getCompositorMap().get(self);

			if (isPureMove) {
				beginHoverMovePass();
				const handledByChrome = compositor?.handleMouseEvent(self, raw) ?? false;
				const res = handledByChrome ? undefined : original.apply(self, args);
				if (finishHoverMovePass()) {
					self.requestRender?.();
				}
				return res;
			}

			if (compositor?.handleMouseEvent(self, raw)) {
				return undefined;
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
	/* Сначала ищем основной ScrollView в layoutRoot, т.к. до первого doRender() getPrimaryScrollView() возвращает implicitScrollView */
	const scroll =
		(layoutHost ? findPrimaryScroll(layoutHost.layoutRoot) : undefined) ??
		((tui as TUI & { getPrimaryScrollView?: () => ScrollView | undefined }).getPrimaryScrollView?.());

	const isFullscreen = Boolean(layoutHost && scroll);
	if (scroll) {
		healLegacyTranscriptPatches(scroll);
	}
	installViewportChromeHooks();
	enablePointerMotionTracking(tui);

	const chatContainer = findChatContainer(tui, scroll);
	let disposeMountedSlots: (() => void) | undefined;
	let currentViewportSlots: MountedViewportSlots | undefined;
	let disposed = false;

	const handle: HostRuntimeHandle = {
		ctx,
		tui,
		keybindings,
		isFullscreen,
		scroll,
		chatContainer,
		get viewportSlots() {
			return currentViewportSlots;
		},
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

			const shellCtx: FullscreenShellContext = {
				tui,
				theme,
				keybindings,
				scroll,
				requestRender: () => tui.requestRender(),
			};

			const slots = buildSlots(shellCtx);
			currentViewportSlots = slots;

			const compositor = new ViewportChromeCompositor(tui, scroll, slots);
			const compositorMap = getCompositorMap();
			compositorMap.set(tui, compositor);
			tui.requestRender();

			const dispose = () => {
				if (compositorMap.get(tui) === compositor) {
					compositorMap.delete(tui);
				}
				if (currentViewportSlots === slots) {
					currentViewportSlots = undefined;
				}
				compositor.dispose();
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
			currentViewportSlots = undefined;
			if (slot.active === handle) {
				slot.active = undefined;
			}
			setRequestRender(undefined);
		},
	};

	slot.active = handle;
	setRequestRender(() => handle.requestRender());
	return handle;
}
