import { execFile, spawn } from "node:child_process";
import {
	convertToPng,
	InteractiveMode,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getNativeClipboard,
	ScrollView,
	TuiAltScreen,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	isCoveredByRenderedOverlay,
	ViewportChromeCompositor,
	type FullscreenShellContext,
	type MountedViewportSlots,
} from "./fullscreen-layout.ts";
import { buildEditorOpenCommand } from "./link-targets.ts";
import { hasBlockingModalOverlay } from "./modal-card.ts";
import { loadPiUiUserConfig } from "./pi-ui-config.ts";
import {
	beginHoverMovePass,
	finishHoverMovePass,
	hookMethod,
	registerRuntimeClipboardSink,
} from "./runtime-hooks.ts";
import { stripSelectionCopyMetadata } from "./selection-copy.ts";
import { setRequestRender } from "./ui-action-bridge.ts";

export type { FullscreenShellContext, MountedViewportSlots };

export interface ClipboardImagePayload {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly fileName?: string;
	readonly filePath?: string;
}

export interface HostClipboardProvider {
	readFilePaths?(): Promise<readonly string[] | null | undefined>;
	readImage?(): Promise<ClipboardImagePayload | null | undefined>;
	readText?(): Promise<string | null | undefined>;
	writeText?(text: string): void | Promise<void>;
}

export interface ExternalOpenResult {
	readonly ok: boolean;
	readonly error?: string;
}

export interface HostExternalOpener {
	openUrl(url: string): Promise<ExternalOpenResult>;
	openPath(
		filePath: string,
		options?: { readonly line?: number; readonly column?: number },
	): Promise<ExternalOpenResult>;
}

interface AcquiredHostTui {
	tui: TUI;
	keybindings?: KeybindingsManager;
	theme?: () => Theme;
	clipboard?: HostClipboardProvider;
	externalOpener?: HostExternalOpener;
}

export interface HostRuntimeHandle {
	readonly ctx: ExtensionContext;
	readonly tui: TUI;
	readonly keybindings: KeybindingsManager | undefined;
	readonly clipboard: HostClipboardProvider;
	readonly externalOpener: HostExternalOpener;
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
const TRANSIENT_HOVER_DISMISSERS_KEY = Symbol.for("conarti.pi-ui.transient-hover-dismissers.v1");

interface InternalHostRuntimeHandle extends HostRuntimeHandle {
	syncRendererState(): void;
}

interface RuntimeSlot {
	active?: InternalHostRuntimeHandle;
	clipboard?: HostClipboardProvider;
	externalOpener?: HostExternalOpener;
}

function getTransientHoverDismissers(): Map<string, () => void> {
	const g = globalThis as Record<symbol, Map<string, () => void> | undefined>;
	if (!g[TRANSIENT_HOVER_DISMISSERS_KEY]) {
		g[TRANSIENT_HOVER_DISMISSERS_KEY] = new Map();
	}
	return g[TRANSIENT_HOVER_DISMISSERS_KEY]!;
}

/**
 * Регистрирует колбэк закрытия транзиентного неблокирующего Hover Popup,
 * чтобы переключение режима TUI (`fullscreen` <-> `regular`) не блокировалось висящими попапами.
 */
export function registerTransientHoverDismisser(id: string, dismiss: () => void): () => void {
	const map = getTransientHoverDismissers();
	map.set(id, dismiss);
	return () => {
		if (map.get(id) === dismiss) {
			map.delete(id);
		}
	};
}

export function dismissTransientHoverPopups(): void {
	for (const dismiss of [...getTransientHoverDismissers().values()]) {
		try {
			dismiss();
		} catch {
			/* Ошибки закрытия одиночного попапа не должны прерывать очистку остальных */
		}
	}
}

function getRuntimeSlot(): RuntimeSlot {
	const g = globalThis as Record<symbol, RuntimeSlot | undefined>;
	if (!g[ACTIVE_RUNTIME_KEY]) {
		g[ACTIVE_RUNTIME_KEY] = {};
	}
	return g[ACTIVE_RUNTIME_KEY]!;
}

registerRuntimeClipboardSink({
	writeClipboardText(text: string): boolean {
		const slot = getRuntimeSlot();
		const writer = slot.active?.clipboard?.writeText ?? slot.clipboard?.writeText;
		if (typeof writer !== "function") return false;
		void writer(text);
		return true;
	},
	writeHostTerminal(sequence: string): boolean {
		const terminal = getRuntimeSlot().active?.tui?.terminal;
		if (typeof terminal?.write !== "function") return false;
		terminal.write(sequence);
		return true;
	},
});

function getCompositorMap(): WeakMap<object, ViewportChromeCompositor> {
	const g = globalThis as Record<symbol, WeakMap<object, ViewportChromeCompositor> | undefined>;
	if (!g[COMPOSITOR_MAP_KEY]) {
		g[COMPOSITOR_MAP_KEY] = new WeakMap();
	}
	return g[COMPOSITOR_MAP_KEY]!;
}

export function getFocusedHostComponent(tui: TUI | undefined): Component | null | undefined {
	return (tui as (TUI & { getFocusedComponent?: () => Component | null }) | undefined)?.getFocusedComponent?.();
}

/**
 * Разворачивает Proxy-ссылку `InteractiveMode` (`this.ui`) до текущего рендерера (`this.renderer`),
 * чтобы `WeakMap` и проверки идентичности совпадали с `self` внутри прототипных хуков `TuiAltScreen`.
 */
export function unwrapHostTui<T>(tui: T): T {
	if (tui && typeof tui === "object" && typeof (tui as { valueOf?: unknown }).valueOf === "function") {
		const unwrapped = (tui as { valueOf(): unknown }).valueOf();
		if (unwrapped && typeof unwrapped === "object") {
			return unwrapped as T;
		}
	}
	return tui;
}

export function isSameHostTui(a: unknown, b: unknown): boolean {
	if (!a || !b) return false;
	return a === b || unwrapHostTui(a) === unwrapHostTui(b);
}

export function setHostClipboardProvider(clipboard: HostClipboardProvider | undefined): void {
	getRuntimeSlot().clipboard = clipboard;
}

export function getHostClipboardProvider(): HostClipboardProvider | undefined {
	return getRuntimeSlot().clipboard;
}

export function setHostExternalOpener(opener: HostExternalOpener | undefined): void {
	getRuntimeSlot().externalOpener = opener;
}

export function getHostExternalOpener(): HostExternalOpener | undefined {
	return getRuntimeSlot().externalOpener;
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
 * Разрешает контейнер сообщений транскрипта как в fullscreen (`ScrollView`),
 * так и в обычном (`regular`) режиме вложенного документа Pi (`[header, ..., chatContainer]`).
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
	const interactiveProto = (InteractiveMode as unknown as { prototype?: object } | undefined)
		?.prototype;
	if (interactiveProto) {
		hookMethod(
			interactiveProto,
			"switchTuiMode",
			"viewport.syncOnSwitchTuiMode",
			(self, args, original) => {
				const runtime = getRuntimeSlot().active;
				const currentUi = (self as { ui?: TUI; renderer?: TUI }).ui ?? (self as { renderer?: TUI }).renderer;
				if (currentUi && !hasBlockingModalOverlay(currentUi)) {
					dismissTransientHoverPopups();
					pruneOrphanedProbeOverlays(unwrapHostTui(currentUi), false);
				}
				const switched = original.apply(self, args);
				if (switched && runtime && currentUi && isSameHostTui(runtime.tui, currentUi)) {
					runtime.syncRendererState();
				}
				return switched;
			},
		);
	}

	const altProto = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
	if (!altProto) return;

	hookMethod(
		altProto,
		"beforeTerminalStart",
		"viewport.beforeTerminalStart",
		(self, args, original) => {
			const res = original.apply(self, args);
			const runtime = getRuntimeSlot().active;
			if (runtime && isSameHostTui(runtime.tui, self)) {
				/* Перезаписываем 1003h после super.beforeTerminalStart(), который в мультиплексорах ставит 1002h */
				enablePointerMotionTracking(self as TUI, true);
				runtime.syncRendererState();
			}
			return res;
		},
	);

	hookMethod(
		altProto,
		"setLayoutRoot",
		"viewport.syncOnSetLayoutRoot",
		(self, args, original) => {
			const res = original.apply(self, args);
			const runtime = getRuntimeSlot().active;
			if (runtime && (isSameHostTui(runtime.tui, self) || getCompositorMap().has(self))) {
				runtime.syncRendererState();
			}
			return res;
		},
	);

	hookMethod(
		altProto,
		"compositeScrollToEndIndicator",
		"viewport.passthroughEndIndicator",
		(self, args, original) => {
			const compositor = getCompositorMap().get(self);
			if (!compositor) return original.apply(self, args) as string[];
			/* Подавляем нативный баннер «Jump to latest message» хоста и рисуем компактный кликабельный ▼ */
			self.scrollToEndIndicatorRect = undefined;
			const screen = args[0] as string[];
			const layout = args[1] as { root?: any } | undefined;
			const width = Number(args[2] ?? self.terminal?.columns ?? 80);
			/* Метки остаются в строках документа для выделения, но не отправляются в терминал. */
			return compositor.compositeFrame(screen, layout, width).map(stripSelectionCopyMetadata);
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
				if (postSelection === preSelection) return postSelection;
				const width = Math.max(1, Number(self.terminal?.columns ?? 80));
				return compositor.maskSelection(self, preSelection, postSelection, width, isPrimaryScrollSelection);
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
			const event = args[0] as
				| {
						type?: string;
						screenX?: number;
						screenY?: number;
						wheelDelta?: number;
						button?: string;
						shift?: boolean;
						alt?: boolean;
						ctrl?: boolean;
				  }
				| undefined;
			if (event?.type === "wheel" && typeof event.screenX === "number" && typeof event.screenY === "number") {
				const topmostModal = (
					self as { getTopmostVisibleOverlay?: () => { component?: Component } | undefined }
				).getTopmostVisibleOverlay?.();
				if (topmostModal) {
					const modalLayouts = (
						self as {
							renderedOverlayLayouts?: ReadonlyArray<{
								entry: { component?: Component };
								col: number;
								row: number;
								width: number;
								height: number;
							}>;
						}
					).renderedOverlayLayouts;
					const layout = modalLayouts?.find((item) => item.entry === topmostModal);
					const modalComp = topmostModal.component as
						| { handleMouse?: (ev: unknown) => { handled?: boolean; render?: boolean } | undefined }
						| undefined;
					if (layout && typeof modalComp?.handleMouse === "function") {
						const res = modalComp.handleMouse({
							...event,
							x: event.screenX - layout.col,
							y: event.screenY - layout.row,
							width: layout.width,
							height: layout.height,
						});
						if (res?.render) {
							self.requestRender?.();
						}
					}
					return undefined;
				}

				if (!isCoveredByRenderedOverlay(self, event.screenX, event.screenY)) {
					dismissTransientHoverPopups();
				}

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
		"routeWheel",
		"viewport.wheelOverscrollContain",
		(self, args, original) => {
			const topmostModal = (
				self as { getTopmostVisibleOverlay?: () => unknown }
			).getTopmostVisibleOverlay?.();
			if (topmostModal) {
				/* overscroll = "contain": колесо при открытой модальной карточке не прокручивает ScrollView под ней */
				return undefined;
			}
			dismissTransientHoverPopups();
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

function enablePointerMotionTracking(tui: TUI, force = false): void {
	const renderer = unwrapHostTui(tui) as unknown as Record<symbol, unknown> & {
		altScreenActive?: boolean;
		terminal?: { write?: (data: string) => void };
	};
	if (renderer.altScreenActive === false && !force) {
		return;
	}
	if (force || !renderer[MOTION_APPLIED]) {
		renderer.terminal?.write?.(ALL_MOTION_SEQ);
		renderer[MOTION_APPLIED] = true;
	}
}

export const SUPPORTED_DIRECT_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function sniffSupportedImageMimeType(bytes: Uint8Array): string | null {
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return bytes[3] === 0xf7 ? null : "image/jpeg";
	}
	if (
		bytes.length >= 16 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp";
	}
	return null;
}

function runClipboardExec(command: string, args: string[], timeoutMs = 1500): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{ encoding: "buffer", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
			(err, stdout) => {
				if (err || !Buffer.isBuffer(stdout)) {
					resolve(undefined);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

export async function normalizeClipboardImageBytes(
	bytes: Uint8Array,
	rawMime?: string,
	fallbackMime = "application/octet-stream",
): Promise<ClipboardImagePayload | null> {
	if (bytes.length === 0) return null;
	const baseMime = rawMime?.split(";")[0]?.trim().toLowerCase();
	const detected = sniffSupportedImageMimeType(bytes) ?? baseMime ?? fallbackMime;
	if (SUPPORTED_DIRECT_IMAGE_MIMES.has(detected)) {
		return { bytes, mimeType: detected };
	}
	try {
		const b64 = Buffer.from(bytes).toString("base64");
		const converted = await convertToPng(b64, detected);
		if (!converted?.data) return null;
		return {
			bytes: new Uint8Array(Buffer.from(converted.data, "base64")),
			mimeType: "image/png",
		};
	} catch {
		return null;
	}
}

export function resolveActiveClipboardProvider(): HostClipboardProvider {
	return getActiveHostRuntime()?.clipboard ?? getHostClipboardProvider() ?? defaultHostClipboardProvider;
}

const ALLOWED_EXTERNAL_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function execOpenTarget(target: string): Promise<ExternalOpenResult> {
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "cmd.exe"
				: "xdg-open";
	const args =
		process.platform === "win32" ? ["/c", "start", "", target] : [target];
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 5000 }, (err) => {
			if (err) {
				resolve({ ok: false, error: err.message });
				return;
			}
			resolve({ ok: true });
		});
	});
}

let externalEditorRunning = false;

async function runTerminalEditor(command: string, args: readonly string[]): Promise<ExternalOpenResult> {
	if (externalEditorRunning) return { ok: false, error: "An external editor is already running" };
	const runtime = getActiveHostRuntime();
	const tui = runtime?.tui;
	externalEditorRunning = true;
	/* Интерактивный редактор читает тот же терминал: хост должен снять raw mode и обработчики ввода. */
	try {
		tui?.stop();
		return await new Promise<ExternalOpenResult>((resolve) => {
			const child = spawn(command, args, { stdio: "inherit" });
			child.once("error", (error) => resolve({ ok: false, error: error.message }));
			child.once("close", (code, signal) => resolve(code === 0
				? { ok: true }
				: { ok: false, error: `Editor exited with ${signal ?? code}` }));
		});
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		externalEditorRunning = false;
		if (tui && getActiveHostRuntime() === runtime) {
			tui.start();
			if (runtime?.isFullscreen) enablePointerMotionTracking(tui, true);
			tui.requestRender(true);
		}
	}
}

export const defaultHostExternalOpener: HostExternalOpener = {
	async openUrl(rawUrl: string): Promise<ExternalOpenResult> {
		const trimmed = rawUrl.trim();
		if (!trimmed) return { ok: false, error: "Empty URL" };
		try {
			const parsed = new URL(trimmed);
			if (!ALLOWED_EXTERNAL_URL_SCHEMES.has(parsed.protocol.toLowerCase())) {
				return { ok: false, error: `Unsupported URL scheme: ${parsed.protocol}` };
			}
		} catch {
			return { ok: false, error: "Invalid URL" };
		}
		return await execOpenTarget(trimmed);
	},

	async openPath(
		filePath: string,
		options?: { readonly line?: number; readonly column?: number },
	): Promise<ExternalOpenResult> {
		const trimmed = filePath.trim();
		if (!trimmed) return { ok: false, error: "Empty file path" };
		const editorCmd = buildEditorOpenCommand(
			process.env.VISUAL || process.env.EDITOR,
			trimmed,
			options,
		);
		if (editorCmd) {
			return await runTerminalEditor(editorCmd.command, editorCmd.args);
		}
		return await execOpenTarget(trimmed);
	},
};

export function resolveActiveExternalOpener(): HostExternalOpener {
	return (
		getActiveHostRuntime()?.externalOpener ??
		getHostExternalOpener() ??
		defaultHostExternalOpener
	);
}

export function installViewportScrollDismissHooks(
	namespace: string,
	isActive: () => boolean,
	onDismiss: () => void,
): void {
	const altProto = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
	if (altProto) {
		hookMethod(altProto, "parseWheelEvent", `${namespace}.wheelDismiss`, (self, args, original) => {
			const parsed = original.apply(self, args);
			if (parsed && isActive()) {
				onDismiss();
				self.requestRender?.();
			}
			return parsed;
		});
	}

	installPrimaryScrollDismissHooks(namespace, isActive, onDismiss);
}

/** Подключает общий жизненный цикл Hover Popup, открытого кликом по строке транскрипта. */
export function installClickedHoverPopupDismissHooks(
	namespace: string,
	getPopup: () => Component | undefined,
	onDismiss: () => void,
): () => void {
	installPrimaryScrollDismissHooks(namespace, () => Boolean(getPopup()), onDismiss);
	let opened = 0;
	hookMethod(TuiAltScreen.prototype, "handleMouseEvent", `${namespace}.pointerDismiss`, (self, args, original) => {
		const popup = getPopup();
		const raw = args[0] as { button: number; x: number; y: number; release: boolean };
		const move = !raw.release && (raw.button & 35) === 35;
		const release = raw.release && (raw.button & 32) === 0;
		if (!popup || (!move && !release) || !isSameHostTui(self, getActiveHostRuntime()?.tui)) {
			return original.apply(self, args);
		}
		const layouts = (self as {
			renderedOverlayLayouts?: readonly { entry: { component?: Component }; row: number; col: number; width: number; height: number }[];
		}).renderedOverlayLayouts;
		const rect = layouts?.find((layout) => layout.entry.component === popup);
		const inside = rect && raw.x >= rect.col && raw.x < rect.col + rect.width &&
			raw.y >= rect.row && raw.y < rect.row + rect.height;
		const before = opened;
		const result = original.apply(self, args);
		if (!inside && opened === before && getPopup() === popup) {
			onDismiss();
			self.requestRender?.();
		}
		return result;
	});
	return () => { opened += 1; };
}

export function installPrimaryScrollDismissHooks(namespace: string, isActive: () => boolean, onDismiss: () => void): void {
	const scrollProto = (ScrollView as unknown as { prototype?: object } | undefined)?.prototype;
	if (scrollProto) {
		for (const methodName of ["scrollTo", "scrollBy", "scrollToStart", "scrollToEnd"] as const) {
			hookMethod(
				scrollProto,
				methodName,
				`${namespace}.scrollDismiss.${methodName}`,
				(self, args, original) => {
					const prevTop = self.scrollTop;
					const result = original.apply(self, args);
					if (isActive() && self.scrollTop !== prevTop && self === getActiveHostRuntime()?.scroll) {
						onDismiss();
						getActiveHostRuntime()?.requestRender();
					}
					return result;
				},
			);
		}
	}
}

const PREFERRED_CLIPBOARD_IMAGE_MIMES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

function selectPreferredClipboardImageTarget(types: readonly string[]): string | undefined {
	const entries = types
		.map((raw) => raw.trim())
		.filter(Boolean)
		.map((raw) => ({ raw, base: raw.split(";")[0]?.trim().toLowerCase() ?? raw.toLowerCase() }));
	for (const preferred of PREFERRED_CLIPBOARD_IMAGE_MIMES) {
		const hit = entries.find((entry) => entry.base === preferred);
		if (hit) return hit.raw;
	}
	return entries.find((entry) => entry.base.startsWith("image/"))?.raw;
}

export const defaultHostClipboardProvider: HostClipboardProvider = {
	async readFilePaths() {
		try {
			const paths = await getNativeClipboard()?.getFilePaths?.();
			return paths && paths.length > 0 ? paths : null;
		} catch {
			return null;
		}
	},

	async readImage() {
		if (process.env.TERMUX_VERSION) return null;

		if (process.platform === "linux") {
			if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
				const listBuf = await runClipboardExec("wl-paste", ["--list-types"], 1000);
				if (listBuf !== undefined) {
					const types = listBuf.toString("utf8").split(/\r?\n/);
					const preferred = selectPreferredClipboardImageTarget(types);
					if (!preferred) return null;
					const imgBuf = await runClipboardExec("wl-paste", ["--type", preferred, "--no-newline"], 3000);
					if (!imgBuf || imgBuf.length === 0) return null;
					return await normalizeClipboardImageBytes(new Uint8Array(imgBuf), preferred);
				}
			}
			if (process.env.DISPLAY) {
				const targetsBuf = await runClipboardExec(
					"xclip",
					["-selection", "clipboard", "-t", "TARGETS", "-o"],
					1000,
				);
				if (targetsBuf !== undefined) {
					const types = targetsBuf.toString("utf8").split(/\r?\n/);
					const preferred = selectPreferredClipboardImageTarget(types);
					if (!preferred) return null;
					const imgBuf = await runClipboardExec(
						"xclip",
						["-selection", "clipboard", "-t", preferred, "-o"],
						3000,
					);
					if (!imgBuf || imgBuf.length === 0) return null;
					return await normalizeClipboardImageBytes(new Uint8Array(imgBuf), preferred);
				}
			}
		}

		try {
			const nativeBytes = await getNativeClipboard()?.getImage();
			if (!nativeBytes || nativeBytes.length === 0) return null;
			return await normalizeClipboardImageBytes(nativeBytes);
		} catch {
			return null;
		}
	},

	async readText() {
		if (process.env.TERMUX_VERSION) {
			const out = await runClipboardExec("termux-clipboard-get", [], 3000);
			if (out !== undefined) return out.toString("utf8") || null;
		}
		if (process.platform === "linux") {
			if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
				const out = await runClipboardExec("wl-paste", ["--no-newline", "--type", "text"], 3000);
				if (out !== undefined) return out.toString("utf8") || null;
			}
			if (process.env.DISPLAY) {
				const out =
					(await runClipboardExec("xclip", ["-selection", "clipboard", "-out"], 3000)) ??
					(await runClipboardExec("xsel", ["--clipboard", "--output"], 3000));
				if (out !== undefined) return out.toString("utf8") || null;
			}
		}
		try {
			return (await getNativeClipboard()?.getText()) || null;
		} catch {
			return null;
		}
	},
};

async function acquireHostTuiFromExtensionUi(
	ctx: ExtensionContext,
): Promise<AcquiredHostTui | undefined> {
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
}

/**
 * Получает активный хост TUI строго через публичный UI-контракт расширения Pi (`ctx.ui.custom`)
 * один раз при старте сессии, поддерживая как `fullscreen`, так и `regular` режим.
 */
export async function acquireHostRuntime(
	ctx: ExtensionContext,
	options?: { clipboard?: HostClipboardProvider; externalOpener?: HostExternalOpener },
): Promise<HostRuntimeHandle | undefined> {
	const slot = getRuntimeSlot();
	if (slot.active && slot.active.ctx === ctx) {
		return slot.active;
	}

	disposeActiveHostRuntime();

	const acquired = await acquireHostTuiFromExtensionUi(ctx);
	if (!acquired) return undefined;

	const { tui, keybindings } = acquired;
	const theme = acquired.theme ?? (() => ctx.ui.theme);
	const explicitClipboard = options?.clipboard ?? acquired.clipboard;
	const explicitExternalOpener = options?.externalOpener ?? acquired.externalOpener;

	const resolveFullscreenLayout = (): {
		renderer: TUI;
		layoutHost: (TUI & LayoutHost) | undefined;
		scroll: ScrollView | undefined;
	} => {
		const renderer = unwrapHostTui(tui);
		const layoutHost = hasLayoutHost(renderer) ? renderer : undefined;
		/* Сначала ищем основной ScrollView в layoutRoot, т.к. до первого doRender() getPrimaryScrollView() возвращает implicitScrollView */
		const scroll = layoutHost
			? (findPrimaryScroll(layoutHost.layoutRoot) ??
					(
						renderer as TUI & { getPrimaryScrollView?: () => ScrollView | undefined }
					).getPrimaryScrollView?.())
			: undefined;
		return { renderer, layoutHost, scroll };
	};

	installViewportChromeHooks();

	let registeredSlotBuilder:
		| ((shell: FullscreenShellContext) => MountedViewportSlots)
		| undefined;
	let activeCompositor: ViewportChromeCompositor | undefined;
	let mountedRenderer: object | undefined;
	let currentViewportSlots: MountedViewportSlots | undefined;
	let disposed = false;

	const detachCompositor = () => {
		const compositor = activeCompositor;
		const prevRenderer = mountedRenderer;
		activeCompositor = undefined;
		mountedRenderer = undefined;
		currentViewportSlots = undefined;
		if (!compositor) return;
		const compositorMap = getCompositorMap();
		if (prevRenderer && compositorMap.get(prevRenderer) === compositor) {
			compositorMap.delete(prevRenderer);
		}
		const liveRenderer = unwrapHostTui(tui);
		if (compositorMap.get(liveRenderer) === compositor) {
			compositorMap.delete(liveRenderer);
		}
		compositor.dispose();
	};

	const syncRendererState = () => {
		if (disposed) {
			detachCompositor();
			return;
		}
		const { renderer, layoutHost, scroll } = resolveFullscreenLayout();
		if (!layoutHost || !scroll) {
			if (activeCompositor) {
				detachCompositor();
			}
			return;
		}

		(renderer as { setCopyOnSelect?: (enabled: boolean) => void }).setCopyOnSelect?.(
			loadPiUiUserConfig().copyOnSelect,
		);

		if (!registeredSlotBuilder || !keybindings) {
			healLegacyTranscriptPatches(scroll);
			enablePointerMotionTracking(renderer);
			if (activeCompositor) {
				detachCompositor();
			}
			return;
		}

		if (
			activeCompositor &&
			mountedRenderer === renderer &&
			activeCompositor.scrollRef === scroll
		) {
			enablePointerMotionTracking(renderer);
			return;
		}

		healLegacyTranscriptPatches(scroll);
		enablePointerMotionTracking(renderer);

		detachCompositor();

		const shellCtx: FullscreenShellContext = {
			tui,
			theme,
			keybindings,
			scroll,
			requestRender: () => tui.requestRender(),
		};

		const slots = registeredSlotBuilder(shellCtx);
		currentViewportSlots = slots;

		const compositor = new ViewportChromeCompositor(tui, scroll, slots, layoutHost.layoutRoot, theme);
		activeCompositor = compositor;
		mountedRenderer = renderer;
		getCompositorMap().set(renderer, compositor);
		tui.requestRender();
	};

	syncRendererState();

	const handle: InternalHostRuntimeHandle = {
		ctx,
		tui,
		keybindings,
		get clipboard() {
			return explicitClipboard ?? slot.clipboard ?? defaultHostClipboardProvider;
		},
		get externalOpener() {
			return explicitExternalOpener ?? slot.externalOpener ?? defaultHostExternalOpener;
		},
		get isFullscreen() {
			syncRendererState();
			const { layoutHost, scroll } = resolveFullscreenLayout();
			return Boolean(layoutHost && scroll);
		},
		get scroll() {
			syncRendererState();
			return resolveFullscreenLayout().scroll;
		},
		get chatContainer() {
			const { scroll } = resolveFullscreenLayout();
			return findChatContainer(tui, scroll);
		},
		get viewportSlots() {
			syncRendererState();
			return currentViewportSlots;
		},
		theme,
		requestRender() {
			tui.requestRender();
		},
		syncRendererState,
		mountViewportSlots(buildSlots) {
			if (disposed || !keybindings) {
				return undefined;
			}
			registeredSlotBuilder = buildSlots;
			detachCompositor();
			syncRendererState();

			const dispose = () => {
				if (registeredSlotBuilder === buildSlots) {
					registeredSlotBuilder = undefined;
				}
				detachCompositor();
				tui.requestRender();
			};
			return dispose;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			registeredSlotBuilder = undefined;
			detachCompositor();
			dismissTransientHoverPopups();
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
