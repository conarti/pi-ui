import { createHash } from "node:crypto";
import { basename, dirname, extname, normalize } from "node:path";
import {
	ExtensionRunner,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionShortcut,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	isSupersededExtension,
	neutralizeRunnerExtensions,
} from "./extension-superseder.ts";
import { getActiveHostRuntime } from "./host-runtime.ts";
import { hasBlockingModalOverlay } from "./modal-card.ts";
import { loadPiUiUserConfig, updatePiUiUserConfig } from "./pi-ui-config.ts";
import { hookMethod } from "./runtime-hooks.ts";
import { requestRender } from "./ui-action-bridge.ts";

export const PI_UI_OWNER_ID = "@conarti/pi-ui";

export const SINGLETON_UI_SLOTS = [
	"footer",
	"header",
	"editor",
	"workingIndicator",
] as const;

export type SingletonUiSlot = (typeof SINGLETON_UI_SLOTS)[number];

export type CapabilityKind =
	| SingletonUiSlot
	| "command"
	| "shortcut"
	| "messageRenderer"
	| "entryRenderer"
	| "toolRenderer";

export interface ContendedSlotCandidate {
	readonly ownerId: string;
	readonly label: string;
}

export interface ContendedSlotSnapshot {
	readonly slotId: string;
	readonly kind: CapabilityKind;
	readonly target?: string;
	readonly activeOwnerId: string;
	readonly savedOwnerId?: string;
	readonly candidates: readonly ContendedSlotCandidate[];
}

export type SlotArbitrationPromptMode = "startup" | "manage";

export type SlotArbitrationModalOpener = (
	ctx: ExtensionContext,
	slots: ContendedSlotSnapshot[],
	mode: SlotArbitrationPromptMode,
	onShown: () => void,
) => Promise<void>;

export type SlotOwnershipChangeListener = (slotId: string, ownerId: string) => void;

const PI_UI_EXTENSION_MARKER = Symbol.for("conarti.pi-ui.extension-owner-marker.v1");
const SLOT_ARBITRATION_STATE_KEY = Symbol.for("conarti.pi-ui.slot-arbitration.state.v1");
const WRAPPED_FN_MARKER = Symbol.for("conarti.pi-ui.slot-arbitration.wrapped-fn.v1");

const CORE_TOOL_RENDERER_NAMES = new Set<string>([
	"read",
	"edit",
	"write",
	"bash",
	"powershell",
	"codemode",
]);

const PI_UI_PATH_RE = /(?:^|[/\\]|npm:)@conarti[/\\]pi-ui(?:$|[/\\])/i;
const GENERIC_SOURCE_TOKENS = new Set([
	"local",
	"temporary",
	"user",
	"project",
	"cli",
	"unknown",
	"inline",
	"auto",
]);

export const COMMAND_PALETTE_CHORD = "ctrl+k";
const LOCALLY_DISPATCHED_SHORTCUTS = [COMMAND_PALETTE_CHORD, "ctrl+l", "alt+t", "alt+s"] as const;
type LocallyDispatchedShortcut = (typeof LOCALLY_DISPATCHED_SHORTCUTS)[number];

const SENTINEL_TOOL_RENDERER = Object.freeze({
	renderCall: () => undefined,
	renderResult: () => undefined,
});

interface RunnerExtensionRecord {
	path?: string;
	resolvedPath?: string;
	hidden?: boolean;
	sourceInfo?: {
		source?: string;
		path?: string;
	};
	handlers?: Map<string, Array<(...args: unknown[]) => unknown>>;
	commands?: Map<
		string,
		{
			name: string;
			description?: string;
			handler: (args: string, ctx: ExtensionContext) => unknown;
			[key: string]: unknown;
		}
	>;
	shortcuts?: Map<string, ExtensionShortcut>;
	tools?: Map<
		string,
		{
			definition: {
				name: string;
				execute?: (...args: unknown[]) => unknown;
				renderCall?: unknown;
				renderResult?: unknown;
				[key: string]: unknown;
			};
			sourceInfo?: unknown;
		}
	>;
	messageRenderers?: Map<string, unknown>;
	entryRenderers?: Map<string, unknown>;
	toolRenderers?: Array<(toolName: string, next: () => unknown) => unknown>;
}

interface RunnerLike {
	extensions?: RunnerExtensionRecord[];
	mode?: string;
	hasUI?: () => boolean;
	getUIContext?: () => ExtensionUIContext;
	createContext?: () => ExtensionContext;
}

interface RawUiSlotMethods {
	setFooter?: ExtensionUIContext["setFooter"];
	setHeader?: ExtensionUIContext["setHeader"];
	setEditorComponent?: ExtensionUIContext["setEditorComponent"];
	setWorkingIndicator?: ExtensionUIContext["setWorkingIndicator"];
	getEditorComponent?: ExtensionUIContext["getEditorComponent"];
}

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
type EditorProbe = { ownerId: string; delegated?: ReturnType<EditorFactory> };

interface ArbitrationGlobalState {
	controllers: WeakMap<object, SessionArbitrationController>;
	activeController?: SessionArbitrationController;
	modalOpener?: SlotArbitrationModalOpener;
	ownershipListeners: Map<string, SlotOwnershipChangeListener>;
	hooksInstalled: boolean;
}

function getGlobalState(): ArbitrationGlobalState {
	const g = globalThis as Record<symbol, ArbitrationGlobalState | undefined>;
	if (!g[SLOT_ARBITRATION_STATE_KEY]) {
		g[SLOT_ARBITRATION_STATE_KEY] = {
			controllers: new WeakMap(),
			ownershipListeners: new Map(),
			hooksInstalled: false,
		};
	}
	return g[SLOT_ARBITRATION_STATE_KEY]!;
}

export function normalizeSlotOwnerId(owner: string | undefined): string | undefined {
	if (typeof owner !== "string") return undefined;
	const trimmed = owner.trim();
	if (!trimmed) return undefined;
	if (trimmed === "pi-ui" || trimmed === PI_UI_OWNER_ID) return PI_UI_OWNER_ID;
	return trimmed;
}

function isSingletonSlot(slotId: string): slotId is SingletonUiSlot {
	return (SINGLETON_UI_SLOTS as readonly string[]).includes(slotId);
}

function isBuiltinExtension(ext: RunnerExtensionRecord): boolean {
	if (ext.hidden === true) return true;
	if (typeof ext.path === "string" && ext.path.startsWith("builtin:")) return true;
	return false;
}

function hasPiUiMarker(ext: RunnerExtensionRecord): boolean {
	if (ext.handlers instanceof Map) {
		for (const list of ext.handlers.values()) {
			if (!Array.isArray(list)) continue;
			for (const fn of list) {
				if (
					typeof fn === "function" &&
					(fn as unknown as Record<symbol, unknown>)[PI_UI_EXTENSION_MARKER] === true
				) {
					return true;
				}
			}
		}
	}
	if (ext.commands instanceof Map) {
		for (const cmd of ext.commands.values()) {
			if (
				cmd &&
				typeof cmd.handler === "function" &&
				(cmd.handler as unknown as Record<symbol, unknown>)[PI_UI_EXTENSION_MARKER] === true
			) {
				return true;
			}
		}
	}
	return false;
}

export function isPiUiExtension(ext: unknown): boolean {
	if (!ext || typeof ext !== "object") return false;
	const rec = ext as RunnerExtensionRecord;
	if (hasPiUiMarker(rec)) return true;
	const candidates = [rec.path, rec.resolvedPath, rec.sourceInfo?.source, rec.sourceInfo?.path];
	return candidates.some((item) => typeof item === "string" && PI_UI_PATH_RE.test(item));
}

function sanitizeOwnerSlug(raw: string): string {
	const cleaned = raw
		.trim()
		.replace(/^npm:/i, "")
		.replace(/[^a-zA-Z0-9@/_.-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return cleaned || "extension";
}

function extractNodeModulesPackage(filePath: string): string | undefined {
	const normalized = filePath.replaceAll("\\", "/");
	const idx = normalized.lastIndexOf("/node_modules/");
	if (idx === -1) return undefined;
	const rest = normalized.slice(idx + "/node_modules/".length);
	const parts = rest.split("/").filter(Boolean);
	if (parts.length === 0) return undefined;
	if (parts[0]!.startsWith("@") && parts.length >= 2) {
		return `${parts[0]}/${parts[1]}`;
	}
	return parts[0];
}

/**
 * Вычисляет стабильный идентификатор расширения для хранения в `pi-ui.json` (`slotOwners`)
 * и отображения в модальной карточке `Slot Arbitration`.
 */
export function deriveExtensionOwnerId(ext: unknown): string {
	if (isPiUiExtension(ext)) return PI_UI_OWNER_ID;
	const rec = (ext && typeof ext === "object" ? ext : {}) as RunnerExtensionRecord;
	let candidate: string | undefined;

	const rawSource = rec.sourceInfo?.source?.trim();
	if (rawSource) {
		const stripped = rawSource.replace(/^npm:/i, "").trim();
		if (
			stripped &&
			!GENERIC_SOURCE_TOKENS.has(stripped.toLowerCase()) &&
			!stripped.startsWith("<")
		) {
			candidate = stripped;
		}
	}

	if (!candidate) {
		const rawPath = rec.path ?? rec.resolvedPath ?? rec.sourceInfo?.path ?? "";
		const inlineMatch = /^<inline:([^>]+)>$/.exec(rawPath);
		if (inlineMatch?.[1]) {
			const inner = inlineMatch[1].trim();
			candidate = /^\d+$/.test(inner) ? `inline-${inner}` : inner;
		} else if (rawPath && !rawPath.startsWith("<")) {
			const pkg = extractNodeModulesPackage(rawPath);
			if (pkg) {
				candidate = pkg;
			} else {
				const base = basename(rawPath, extname(rawPath));
				if (base.toLowerCase() === "index") {
					const parentName = basename(dirname(rawPath));
					candidate = parentName && parentName !== "." ? parentName : base;
				} else {
					candidate = base;
				}
			}
		}
	}

	const baseSlug = sanitizeOwnerSlug(candidate ?? "third-party");
	const path = rec.resolvedPath ?? rec.path ?? rec.sourceInfo?.path;
	if (!path || path.startsWith("<")) return baseSlug;
	/* Суффикс не зависит от наличия соседей и порядка загрузки; для npm сохраняем путь внутри пакета. */
	const normalized = normalize(path).replaceAll("\\", "/");
	const pkg = extractNodeModulesPackage(normalized);
	const identity = pkg ? normalized.slice(normalized.lastIndexOf("/node_modules/") + "/node_modules/".length) : normalized;
	const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
	return `${baseSlug}-${suffix}`;
}

function findShortcutKeyIgnoreCase(
	map: Map<string, ExtensionShortcut> | undefined,
	normChord: string,
): string | undefined {
	if (!map) return undefined;
	if (map.has(normChord)) return normChord;
	for (const key of map.keys()) {
		if (key.trim().toLowerCase() === normChord) return key;
	}
	return undefined;
}

function doesExtensionProvideToolRenderer(
	ext: RunnerExtensionRecord,
	toolName: string,
): boolean {
	const tool = ext.tools?.get(toolName);
	if (
		tool?.definition &&
		(typeof tool.definition.renderCall === "function" ||
			typeof tool.definition.renderResult === "function")
	) {
		return true;
	}
	if (Array.isArray(ext.toolRenderers) && ext.toolRenderers.length > 0) {
		for (const resolver of ext.toolRenderers) {
			try {
				const probed = resolver(toolName, () => SENTINEL_TOOL_RENDERER);
				if (probed !== undefined && probed !== SENTINEL_TOOL_RENDERER) {
					return true;
				}
			} catch {
				/* Ошибка стороннего резолвера при зондировании не должна ломать сессию */
			}
		}
	}
	return false;
}

function sortCandidates(candidates: ContendedSlotCandidate[]): ContendedSlotCandidate[] {
	return [...candidates].sort((a, b) => {
		if (a.ownerId === PI_UI_OWNER_ID) return -1;
		if (b.ownerId === PI_UI_OWNER_ID) return 1;
		return a.ownerId.localeCompare(b.ownerId);
	});
}

function slotSortOrder(slot: ContendedSlotSnapshot): number {
	const singletonIdx = SINGLETON_UI_SLOTS.indexOf(slot.kind as SingletonUiSlot);
	if (singletonIdx !== -1) return singletonIdx;
	switch (slot.kind) {
		case "command":
			return 10;
		case "shortcut":
			return 20;
		case "messageRenderer":
			return 30;
		case "entryRenderer":
			return 40;
		case "toolRenderer":
			return 50;
		default:
			return 99;
	}
}

function isWrappedFn(fn: unknown): boolean {
	return (
		typeof fn === "function" &&
		(fn as unknown as Record<symbol, unknown>)[WRAPPED_FN_MARKER] === true
	);
}

function markWrappedFn<T extends Function>(fn: T): T {
	(fn as unknown as Record<symbol, boolean>)[WRAPPED_FN_MARKER] = true;
	return fn;
}

class SessionArbitrationController {
	private rawUi: ExtensionUIContext | undefined;
	private rawSlots: RawUiSlotMethods = {};
	private readonly ownerIdsByExt = new WeakMap<RunnerExtensionRecord, string>();
	private readonly extsByOwnerId = new Map<string, RunnerExtensionRecord>();
	private readonly wrappedExtensions = new WeakSet<RunnerExtensionRecord>();
	private readonly wrappedCtxCache = new WeakMap<
		object,
		WeakMap<RunnerExtensionRecord, ExtensionContext>
	>();
	private readonly ownerUiCache = new WeakMap<
		ExtensionUIContext,
		Map<string, ExtensionUIContext>
	>();

	private readonly singletonCandidates: Record<SingletonUiSlot, Map<string, unknown>> = {
		footer: new Map(),
		header: new Map(),
		editor: new Map(),
		workingIndicator: new Map(),
	};

	private readonly appliedSingletonOwners: Partial<Record<SingletonUiSlot, string>> = {};
	private readonly appliedSingletonValues: Partial<Record<SingletonUiSlot, unknown>> = {};
	private readonly editorDelegates = new Map<string, EditorFactory>();
	private readonly cooperativeEditorWrappers = new Map<string, EditorFactory>();
	private editorProbe?: EditorProbe;
	private inSessionStart = false;
	private sessionStartFinished = false;
	private readonly promptedSlots = new Set<string>();
	private pendingPromptTimer: ReturnType<typeof setTimeout> | undefined;
	private modalOpen = false;
	private disposed = false;

	constructor(private readonly runner: RunnerLike) {}

	bindRawUi(ui: ExtensionUIContext | undefined): void {
		this.rawUi = ui;
		if (!ui) {
			this.rawSlots = {};
			return;
		}
		this.rawSlots = {
			setFooter: ui.setFooter?.bind(ui),
			setHeader: ui.setHeader?.bind(ui),
			setEditorComponent: ui.setEditorComponent?.bind(ui),
			setWorkingIndicator: ui.setWorkingIndicator?.bind(ui),
			getEditorComponent: ui.getEditorComponent?.bind(ui),
		};
		this.syncExtensionsAndWrap();
	}

	private getExtensions(): RunnerExtensionRecord[] {
		return Array.isArray(this.runner.extensions) ? this.runner.extensions : [];
	}

	private getPiUiExtension(): RunnerExtensionRecord | undefined {
		return this.getExtensions().find((ext) => isPiUiExtension(ext));
	}

	getOwnerId(ext: RunnerExtensionRecord): string {
		const cached = this.ownerIdsByExt.get(ext);
		if (cached) return cached;
		const derived = deriveExtensionOwnerId(ext);
		this.ownerIdsByExt.set(ext, derived);
		this.extsByOwnerId.set(derived, ext);
		return derived;
	}

	syncExtensionsAndWrap(): void {
		neutralizeRunnerExtensions(this.runner);
		for (const ext of this.getExtensions()) {
			if (isBuiltinExtension(ext) || isSupersededExtension(ext)) continue;
			this.getOwnerId(ext);
			this.wrapExtensionEntryPoints(ext);
		}
	}

	private wrapExtensionEntryPoints(ext: RunnerExtensionRecord): void {
		if (this.wrappedExtensions.has(ext)) return;
		this.wrappedExtensions.add(ext);

		if (ext.handlers instanceof Map) {
			for (const [eventName, list] of ext.handlers.entries()) {
				if (!Array.isArray(list)) continue;
				const wrappedList = list.map((fn) => {
					if (typeof fn !== "function" || isWrappedFn(fn)) return fn;
					const hasMarker =
						(fn as unknown as Record<symbol, unknown>)[PI_UI_EXTENSION_MARKER] === true;
					const wrapped = markWrappedFn((...args: unknown[]) => {
						if (args.length >= 2 && args[1] && typeof args[1] === "object") {
							args[1] = this.wrapContextForExtension(args[1] as ExtensionContext, ext);
						}
						return fn(...args);
					});
					if (hasMarker) {
						(wrapped as unknown as Record<symbol, boolean>)[PI_UI_EXTENSION_MARKER] = true;
					}
					return wrapped;
				});
				ext.handlers.set(eventName, wrappedList);
			}
		}

		if (ext.commands instanceof Map) {
			for (const cmd of ext.commands.values()) {
				if (!cmd || typeof cmd.handler !== "function" || isWrappedFn(cmd.handler)) continue;
				const origHandler = cmd.handler;
				const hasMarker =
					(origHandler as unknown as Record<symbol, unknown>)[PI_UI_EXTENSION_MARKER] ===
					true;
				const wrapped = markWrappedFn((args: string, ctx: ExtensionContext) =>
					origHandler(args, this.wrapContextForExtension(ctx, ext)),
				);
				if (hasMarker) {
					(wrapped as unknown as Record<symbol, boolean>)[PI_UI_EXTENSION_MARKER] = true;
				}
				cmd.handler = wrapped;
			}
		}

		if (ext.tools instanceof Map) {
			for (const registered of ext.tools.values()) {
				const origExecute = registered?.definition?.execute;
				if (typeof origExecute !== "function" || isWrappedFn(origExecute)) continue;
				registered.definition.execute = markWrappedFn((...args: unknown[]) => {
					/* Сигнатура execute(toolCallId, params, signal, onUpdate, ctx) — ctx всегда последний аргумент */
					const lastIdx = args.length - 1;
					const candidateCtx = args[lastIdx];
					if (
						candidateCtx &&
						typeof candidateCtx === "object" &&
						"ui" in candidateCtx &&
						"sessionManager" in candidateCtx
					) {
						args[lastIdx] = this.wrapContextForExtension(
							candidateCtx as ExtensionContext,
							ext,
						);
					}
					return origExecute(...args);
				});
			}
		}
	}

	wrapContextForExtension(ctx: ExtensionContext, ext: RunnerExtensionRecord): ExtensionContext {
		if (!ctx || typeof ctx !== "object") return ctx;
		let perExt = this.wrappedCtxCache.get(ctx);
		if (!perExt) {
			perExt = new WeakMap();
			this.wrappedCtxCache.set(ctx, perExt);
		}
		const cached = perExt.get(ext);
		if (cached) return cached;

		const ownerId = this.getOwnerId(ext);
		const controller = this;
		const proxied = new Proxy(ctx, {
			get(target, prop) {
				if (prop === "ui") {
					const baseUi = Reflect.get(target, "ui", target) as ExtensionUIContext;
					return controller.getOwnerScopedUi(baseUi, ownerId);
				}
				return Reflect.get(target, prop, target);
			},
		});
		perExt.set(ext, proxied);
		return proxied;
	}

	private getOwnerScopedUi(baseUi: ExtensionUIContext, ownerId: string): ExtensionUIContext {
		if (!baseUi || typeof baseUi !== "object") return baseUi;
		let perOwner = this.ownerUiCache.get(baseUi);
		if (!perOwner) {
			perOwner = new Map();
			this.ownerUiCache.set(baseUi, perOwner);
		}
		const cached = perOwner.get(ownerId);
		if (cached) return cached;

		const controller = this;
		const proxiedUi = new Proxy(baseUi, {
			get(target, prop) {
				if (prop === "setFooter") {
					return (factory: Parameters<ExtensionUIContext["setFooter"]>[0]) => {
						controller.registerSingletonSlot("footer", ownerId, factory);
					};
				}
				if (prop === "setHeader") {
					return (factory: Parameters<ExtensionUIContext["setHeader"]>[0]) => {
						controller.registerSingletonSlot("header", ownerId, factory);
					};
				}
				if (prop === "setEditorComponent") {
					return (factory: Parameters<ExtensionUIContext["setEditorComponent"]>[0]) => {
						controller.registerEditorComponent(ownerId, factory);
					};
				}
				if (prop === "setWorkingIndicator") {
					return (options: Parameters<ExtensionUIContext["setWorkingIndicator"]>[0]) => {
						controller.registerSingletonSlot("workingIndicator", ownerId, options);
					};
				}
				if (prop === "getEditorComponent") {
					return () => controller.getEditorComponentForOwner(ownerId);
				}
				return Reflect.get(target, prop, target);
			},
		});
		perOwner.set(ownerId, proxiedUi);
		return proxiedUi;
	}

	private getEditorComponentForOwner(
		ownerId: string,
	): ReturnType<ExtensionUIContext["getEditorComponent"]> {
		if (ownerId !== PI_UI_OWNER_ID) {
			const delegated = ([...this.cooperativeEditorWrappers.entries()].filter(([id]) => id !== ownerId).at(-1)?.[1] ??
				this.singletonCandidates.editor.get(PI_UI_OWNER_ID) ??
				this.rawSlots.getEditorComponent?.()) as EditorFactory | undefined;
			if (!delegated) return undefined;
			this.editorDelegates.set(ownerId, delegated);
			return (...args) => {
				const editor = delegated(...args);
				const probe = this.editorProbe;
				if (probe?.ownerId === ownerId) probe.delegated = editor;
				return editor;
			};
		}
		const own = this.singletonCandidates.editor.get(ownerId);
		if (own !== undefined) {
			return own as ReturnType<ExtensionUIContext["getEditorComponent"]>;
		}
		/* Изолируем конкурирующие фабрики редактора, чтобы Composer не оборачивал чужой редактор */
		if (this.singletonCandidates.editor.size > 0) {
			return undefined;
		}
		return this.rawSlots.getEditorComponent?.();
	}

	private registerEditorComponent(ownerId: string, factory: EditorFactory | undefined): void {
		const delegated = this.editorDelegates.get(ownerId);
		this.editorDelegates.delete(ownerId);
		this.cooperativeEditorWrappers.delete(ownerId);
		const candidates = this.singletonCandidates.editor;
		if (!factory || !delegated || !candidates.has(PI_UI_OWNER_ID) ||
			this.resolveWinnerForSingletonSlot("editor").ownerId !== PI_UI_OWNER_ID) {
			this.registerSingletonSlot("editor", ownerId, factory);
			return;
		}

		/* Хост синхронно вызывает фабрику с реальными аргументами; декоратор должен вернуть тот же экземпляр Composer. */
		let cooperative = false;
		this.cooperativeEditorWrappers.set(ownerId, (...args) => {
			const probe: EditorProbe = { ownerId };
			const previousProbe = this.editorProbe;
			this.editorProbe = probe;
			try {
				const proposed = factory(...args);
				cooperative = probe.delegated !== undefined && proposed === probe.delegated;
				if (cooperative) return proposed;
			} catch {
				/* Не ломаем Composer, если сторонняя фабрика не смогла его декорировать. */
				cooperative = false;
			} finally {
				this.editorProbe = previousProbe;
			}
			return probe.delegated ?? delegated(...args);
		});
		this.applySingletonSlot("editor", true);
		if (cooperative) {
			candidates.delete(ownerId);
		} else {
			this.cooperativeEditorWrappers.delete(ownerId);
			this.registerSingletonSlot("editor", ownerId, factory);
		}
	}

	registerSingletonSlot(slot: SingletonUiSlot, ownerId: string, value: unknown): void {
		const candidates = this.singletonCandidates[slot];
		if (value === undefined) {
			candidates.delete(ownerId);
		} else {
			candidates.set(ownerId, value);
		}

		this.applySingletonSlot(slot, false);

		if (
			this.sessionStartFinished &&
			!this.inSessionStart &&
			candidates.size > 1 &&
			candidates.has(PI_UI_OWNER_ID)
		) {
			this.schedulePromptIfUnsettled();
		}
	}

	private resolveWinnerForSingletonSlot(slot: SingletonUiSlot): {
		ownerId: string;
		value: unknown;
	} {
		const candidates = this.singletonCandidates[slot];
		const saved = normalizeSlotOwnerId(loadPiUiUserConfig().slotOwners[slot]);

		if (saved) {
			if (candidates.has(saved)) {
				return { ownerId: saved, value: candidates.get(saved) };
			}
		}

		if (candidates.has(PI_UI_OWNER_ID)) {
			if (slot === "editor" && this.cooperativeEditorWrappers.size > 0) {
				const topWrapper = [...this.cooperativeEditorWrappers.values()].at(-1);
				return { ownerId: PI_UI_OWNER_ID, value: topWrapper };
			}
			return { ownerId: PI_UI_OWNER_ID, value: candidates.get(PI_UI_OWNER_ID) };
		}

		let fallbackOwner = PI_UI_OWNER_ID;
		let fallbackValue: unknown = undefined;
		for (const [owner, val] of candidates.entries()) {
			fallbackOwner = owner;
			fallbackValue = val;
		}
		return { ownerId: fallbackOwner, value: fallbackValue };
	}

	getAppliedSingletonOwner(slot: SingletonUiSlot): string {
		return this.appliedSingletonOwners[slot] ?? PI_UI_OWNER_ID;
	}

	applySingletonSlot(slot: SingletonUiSlot, force: boolean): void {
		if (this.disposed) return;
		const { ownerId, value } = this.resolveWinnerForSingletonSlot(slot);
		const prevOwner = this.appliedSingletonOwners[slot];
		const prevValue = this.appliedSingletonValues[slot];
		if (!force && prevOwner === ownerId && prevValue === value) {
			return;
		}

		this.appliedSingletonOwners[slot] = ownerId;
		this.appliedSingletonValues[slot] = value;

		if (this.runner.mode === "tui" && this.runner.hasUI?.()) {
			switch (slot) {
				case "footer":
					this.rawSlots.setFooter?.(
						value as Parameters<ExtensionUIContext["setFooter"]>[0],
					);
					break;
				case "header":
					this.rawSlots.setHeader?.(
						value as Parameters<ExtensionUIContext["setHeader"]>[0],
					);
					break;
				case "editor":
					this.rawSlots.setEditorComponent?.(
						value as Parameters<ExtensionUIContext["setEditorComponent"]>[0],
					);
					break;
				case "workingIndicator":
					this.rawSlots.setWorkingIndicator?.(
						value as Parameters<ExtensionUIContext["setWorkingIndicator"]>[0],
					);
					break;
			}
		}

		notifyOwnershipListeners(slot, ownerId);
		if (slot === "header") {
			getActiveHostRuntime()?.tui?.invalidate?.();
		}
		requestRender();
	}

	beginSessionStart(): void {
		this.inSessionStart = true;
		this.syncExtensionsAndWrap();
	}

	endSessionStart(): void {
		this.inSessionStart = false;
		this.sessionStartFinished = true;
		this.syncExtensionsAndWrap();
		for (const slot of SINGLETON_UI_SLOTS) {
			if (this.singletonCandidates[slot].size > 0 || loadPiUiUserConfig().slotOwners[slot]) {
				this.applySingletonSlot(slot, false);
			}
		}
		this.schedulePromptIfUnsettled();
	}

	private getThirdPartyExtensions(): RunnerExtensionRecord[] {
		return this.getExtensions().filter(
			(ext) =>
				!isPiUiExtension(ext) &&
				!isBuiltinExtension(ext) &&
				!isSupersededExtension(ext),
		);
	}

	private collectContendedCommandMap(): Map<string, Map<string, RunnerExtensionRecord>> {
		const out = new Map<string, Map<string, RunnerExtensionRecord>>();
		const piUiExt = this.getPiUiExtension();
		if (!piUiExt?.commands || piUiExt.commands.size === 0) return out;
		const thirdParties = this.getThirdPartyExtensions();
		if (thirdParties.length === 0) return out;

		for (const commandName of piUiExt.commands.keys()) {
			const contenders = new Map<string, RunnerExtensionRecord>();
			for (const ext of thirdParties) {
				if (ext.commands?.has(commandName)) {
					contenders.set(this.getOwnerId(ext), ext);
				}
			}
			if (contenders.size > 0) {
				contenders.set(PI_UI_OWNER_ID, piUiExt);
				out.set(commandName, contenders);
			}
		}
		return out;
	}

	private collectContendedShortcutMap(): Map<string, Map<string, RunnerExtensionRecord>> {
		const out = new Map<string, Map<string, RunnerExtensionRecord>>();
		const piUiExt = this.getPiUiExtension();
		if (!piUiExt?.shortcuts || piUiExt.shortcuts.size === 0) return out;
		const thirdParties = this.getThirdPartyExtensions();
		if (thirdParties.length === 0) return out;

		for (const piUiChord of piUiExt.shortcuts.keys()) {
			const normChord = piUiChord.trim().toLowerCase();
			const contenders = new Map<string, RunnerExtensionRecord>();
			for (const ext of thirdParties) {
				if (findShortcutKeyIgnoreCase(ext.shortcuts, normChord)) {
					contenders.set(this.getOwnerId(ext), ext);
				}
			}
			if (contenders.size > 0) {
				contenders.set(PI_UI_OWNER_ID, piUiExt);
				out.set(normChord, contenders);
			}
		}
		return out;
	}

	private collectContendedRendererMap(
		field: "messageRenderers" | "entryRenderers",
	): Map<string, Map<string, RunnerExtensionRecord>> {
		const out = new Map<string, Map<string, RunnerExtensionRecord>>();
		const piUiExt = this.getPiUiExtension();
		const piUiMap = piUiExt?.[field];
		if (!piUiExt || !(piUiMap instanceof Map) || piUiMap.size === 0) return out;
		const thirdParties = this.getThirdPartyExtensions();
		if (thirdParties.length === 0) return out;

		for (const customType of piUiMap.keys()) {
			const contenders = new Map<string, RunnerExtensionRecord>();
			for (const ext of thirdParties) {
				const extMap = ext[field];
				if (extMap instanceof Map && extMap.has(customType)) {
					contenders.set(this.getOwnerId(ext), ext);
				}
			}
			if (contenders.size > 0) {
				contenders.set(PI_UI_OWNER_ID, piUiExt);
				out.set(customType, contenders);
			}
		}
		return out;
	}

	private collectContendedToolRendererMap(): Map<string, Map<string, RunnerExtensionRecord>> {
		const out = new Map<string, Map<string, RunnerExtensionRecord>>();
		const piUiExt = this.getPiUiExtension();
		if (!piUiExt?.tools || piUiExt.tools.size === 0) return out;
		const thirdParties = this.getThirdPartyExtensions();
		if (thirdParties.length === 0) return out;

		for (const toolName of piUiExt.tools.keys()) {
			if (CORE_TOOL_RENDERER_NAMES.has(toolName)) continue;
			const contenders = new Map<string, RunnerExtensionRecord>();
			for (const ext of thirdParties) {
				if (doesExtensionProvideToolRenderer(ext, toolName)) {
					contenders.set(this.getOwnerId(ext), ext);
				}
			}
			if (contenders.size > 0) {
				contenders.set(PI_UI_OWNER_ID, piUiExt);
				out.set(toolName, contenders);
			}
		}
		return out;
	}

	resolveActiveOwner(slotId: string, candidateOwnerIds?: Iterable<string>): string {
		const saved = normalizeSlotOwnerId(loadPiUiUserConfig().slotOwners[slotId]);
		if (saved) {
			const candidates = candidateOwnerIds ?? (
				isSingletonSlot(slotId) ? this.singletonCandidates[slotId].keys() : []
			);
			for (const id of candidates) {
				if (id === saved) return saved;
			}
		}
		return PI_UI_OWNER_ID;
	}

	getContendedSlots(): ContendedSlotSnapshot[] {
		this.syncExtensionsAndWrap();
		const savedMap = loadPiUiUserConfig().slotOwners;
		const snapshots: ContendedSlotSnapshot[] = [];

		for (const slot of SINGLETON_UI_SLOTS) {
			const map = this.singletonCandidates[slot];
			if (map.size <= 1 || !map.has(PI_UI_OWNER_ID)) continue;
			const ownerIds = [...map.keys()];
			const activeOwnerId = this.resolveActiveOwner(slot, ownerIds);
			snapshots.push({
				slotId: slot,
				kind: slot,
				activeOwnerId,
				savedOwnerId: normalizeSlotOwnerId(savedMap[slot]),
				candidates: sortCandidates(
					ownerIds.map((ownerId) => ({ ownerId, label: ownerId })),
				),
			});
		}

		for (const [cmdName, contenders] of this.collectContendedCommandMap()) {
			const slotId = `command:${cmdName}`;
			const ownerIds = [...contenders.keys()];
			snapshots.push({
				slotId,
				kind: "command",
				target: `/${cmdName}`,
				activeOwnerId: this.resolveActiveOwner(slotId, ownerIds),
				savedOwnerId: normalizeSlotOwnerId(savedMap[slotId]),
				candidates: sortCandidates(
					ownerIds.map((ownerId) => ({ ownerId, label: ownerId })),
				),
			});
		}

		for (const [chord, contenders] of this.collectContendedShortcutMap()) {
			const slotId = `shortcut:${chord}`;
			const ownerIds = [...contenders.keys()];
			snapshots.push({
				slotId,
				kind: "shortcut",
				target: chord,
				activeOwnerId: this.resolveActiveOwner(slotId, ownerIds),
				savedOwnerId: normalizeSlotOwnerId(savedMap[slotId]),
				candidates: sortCandidates(
					ownerIds.map((ownerId) => ({ ownerId, label: ownerId })),
				),
			});
		}

		for (const [customType, contenders] of this.collectContendedRendererMap("messageRenderers")) {
			const slotId = `messageRenderer:${customType}`;
			const ownerIds = [...contenders.keys()];
			snapshots.push({
				slotId,
				kind: "messageRenderer",
				target: customType,
				activeOwnerId: this.resolveActiveOwner(slotId, ownerIds),
				savedOwnerId: normalizeSlotOwnerId(savedMap[slotId]),
				candidates: sortCandidates(
					ownerIds.map((ownerId) => ({ ownerId, label: ownerId })),
				),
			});
		}

		for (const [customType, contenders] of this.collectContendedRendererMap("entryRenderers")) {
			const slotId = `entryRenderer:${customType}`;
			const ownerIds = [...contenders.keys()];
			snapshots.push({
				slotId,
				kind: "entryRenderer",
				target: customType,
				activeOwnerId: this.resolveActiveOwner(slotId, ownerIds),
				savedOwnerId: normalizeSlotOwnerId(savedMap[slotId]),
				candidates: sortCandidates(
					ownerIds.map((ownerId) => ({ ownerId, label: ownerId })),
				),
			});
		}

		for (const [toolName, contenders] of this.collectContendedToolRendererMap()) {
			const slotId = `toolRenderer:${toolName}`;
			const ownerIds = [...contenders.keys()];
			snapshots.push({
				slotId,
				kind: "toolRenderer",
				target: toolName,
				activeOwnerId: this.resolveActiveOwner(slotId, ownerIds),
				savedOwnerId: normalizeSlotOwnerId(savedMap[slotId]),
				candidates: sortCandidates(
					ownerIds.map((ownerId) => ({ ownerId, label: ownerId })),
				),
			});
		}

		return snapshots.sort((a, b) => {
			const diff = slotSortOrder(a) - slotSortOrder(b);
			return diff !== 0 ? diff : a.slotId.localeCompare(b.slotId);
		});
	}

	private getUnsettledCollisions(): ContendedSlotSnapshot[] {
		return this.getContendedSlots().filter((slot) => {
			if (this.promptedSlots.has(slot.slotId)) return false;
			if (!slot.savedOwnerId) return true;
			return !slot.candidates.some((c) => c.ownerId === slot.savedOwnerId);
		});
	}

	private schedulePromptIfUnsettled(delay = 0): void {
		if (this.disposed || this.modalOpen) return;
		if (this.runner.mode !== "tui" || !this.runner.hasUI?.()) return;
		const unsettled = this.getUnsettledCollisions();
		if (unsettled.length === 0) return;

		if (this.pendingPromptTimer) {
			clearTimeout(this.pendingPromptTimer);
		}
		this.pendingPromptTimer = setTimeout(() => {
			this.pendingPromptTimer = undefined;
			void this.openBatchedStartupModal();
		}, delay);
	}

	private async openBatchedStartupModal(): Promise<void> {
		if (this.disposed || this.modalOpen) return;
		if (this.runner.mode !== "tui" || !this.runner.hasUI?.()) return;
		const opener = getGlobalState().modalOpener;
		if (!opener) return;

		const unsettled = this.getUnsettledCollisions();
		if (unsettled.length === 0) return;

		const ctx = this.runner.createContext?.();
		if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
		const tui = getActiveHostRuntime()?.tui;
		if (tui && hasBlockingModalOverlay(tui)) {
			this.schedulePromptIfUnsettled(100);
			return;
		}

		this.modalOpen = true;
		let shown = false;
		try {
			await opener(ctx, unsettled, "startup", () => {
				shown = true;
				for (const slot of unsettled) this.promptedSlots.add(slot.slotId);
			});
		} finally {
			this.modalOpen = false;
		}
		if (!shown) this.schedulePromptIfUnsettled(100);
	}

	resolveCommandsHook(original: () => unknown[]): unknown[] {
		this.syncExtensionsAndWrap();
		const contended = this.collectContendedCommandMap();
		if (contended.size === 0) {
			return original();
		}

		const removed: Array<{
			map: Map<string, any>;
			key: string;
			value: any;
		}> = [];

		try {
			for (const [normName, contenders] of contended.entries()) {
				const winnerOwner = this.resolveActiveOwner(
					`command:${normName}`,
					contenders.keys(),
				);
				for (const [ownerId, ext] of contenders.entries()) {
					if (ownerId === winnerOwner || !ext.commands) continue;
					if (ext.commands.has(normName)) {
						removed.push({ map: ext.commands, key: normName, value: ext.commands.get(normName) });
						ext.commands.delete(normName);
					}
				}
			}
			return original();
		} finally {
			for (let i = removed.length - 1; i >= 0; i -= 1) {
				const item = removed[i]!;
				item.map.set(item.key, item.value);
			}
		}
	}

	async dispatchLocalShortcut(chord: LocallyDispatchedShortcut): Promise<void> {
		const piUiExt = this.getPiUiExtension();
		if (!piUiExt) return;
		const contenders = this.collectContendedShortcutMap().get(chord);
		const active = this.resolveActiveOwner(`shortcut:${chord}`, contenders?.keys());
		const winner = contenders?.get(active) ?? piUiExt;
		const key = findShortcutKeyIgnoreCase(winner.shortcuts, chord);
		const ctx = this.runner.createContext?.();
		if (key && ctx) await winner.shortcuts?.get(key)?.handler(this.wrapContextForExtension(ctx, winner));
	}

	resolveShortcutsHook(
		resolvedKeybindings: unknown,
		original: (kb: unknown) => Map<string, ExtensionShortcut>,
	): Map<string, ExtensionShortcut> {
		this.syncExtensionsAndWrap();
		const contended = this.collectContendedShortcutMap();
		const piUiExt = this.getPiUiExtension();
		/* Локальные обработчики учитывают фокус и состояние вставки; хост не должен вызывать их повторно. */
		const localChords = new Set<string>(LOCALLY_DISPATCHED_SHORTCUTS);
		for (const chord of localChords) {
			if (!contended.has(chord) && piUiExt && findShortcutKeyIgnoreCase(piUiExt.shortcuts, chord)) {
				contended.set(chord, new Map([[PI_UI_OWNER_ID, piUiExt]]));
			}
		}
		const savedEntries: Array<{
			map: Map<string, ExtensionShortcut>;
			key: string;
			value: ExtensionShortcut;
		}> = [];
		const addedTempKeys: Array<{ map: Map<string, ExtensionShortcut>; key: string }> = [];

		try {
			for (const [normChord, contenders] of contended.entries()) {
				const controller = this;
				const piUiKey = piUiExt
					? findShortcutKeyIgnoreCase(piUiExt.shortcuts, normChord)
					: undefined;
				const piUiShortcut = piUiKey ? piUiExt?.shortcuts?.get(piUiKey) : undefined;

				for (const ext of contenders.values()) {
					if (!ext.shortcuts) continue;
					const actualKey = findShortcutKeyIgnoreCase(ext.shortcuts, normChord);
					if (actualKey !== undefined) {
						savedEntries.push({
							map: ext.shortcuts,
							key: actualKey,
							value: ext.shortcuts.get(actualKey)!,
						});
						ext.shortcuts.delete(actualKey);
					}
				}

				if (!localChords.has(normChord) && piUiExt?.shortcuts && piUiShortcut) {
					const dynamicShortcut: ExtensionShortcut = {
						...piUiShortcut,
						handler: async (ctx: ExtensionContext) => {
							const activeOwner = controller.resolveActiveOwner(
								`shortcut:${normChord}`,
								contenders.keys(),
							);
							const winnerExt =
								contenders.get(activeOwner) ??
								contenders.get(PI_UI_OWNER_ID) ??
								piUiExt;
							const winnerKey = findShortcutKeyIgnoreCase(
								winnerExt.shortcuts,
								normChord,
							);
							const winnerShortcut = winnerKey
								? winnerExt.shortcuts?.get(winnerKey)
								: undefined;
							if (!winnerShortcut) return;
							const scopedCtx = controller.wrapContextForExtension(ctx, winnerExt);
							return await winnerShortcut.handler(scopedCtx);
						},
					};
					const targetKey = piUiKey ?? normChord;
					piUiExt.shortcuts.set(targetKey, dynamicShortcut);
					addedTempKeys.push({ map: piUiExt.shortcuts, key: targetKey });
				}
			}

			const result = original(resolvedKeybindings);
			return this.wrapNonContendedShortcuts(result, contended);
		} finally {
			for (const added of addedTempKeys) {
				added.map.delete(added.key);
			}
			for (let i = savedEntries.length - 1; i >= 0; i -= 1) {
				const item = savedEntries[i]!;
				item.map.set(item.key, item.value);
			}
		}
	}

	private wrapNonContendedShortcuts(
		shortcuts: Map<string, ExtensionShortcut>,
		contended?: Map<string, Map<string, RunnerExtensionRecord>>,
	): Map<string, ExtensionShortcut> {
		for (const [key, shortcut] of shortcuts.entries()) {
			const normKey = key.trim().toLowerCase();
			if (contended?.has(normKey)) continue;
			const ownerExt = this.getExtensions().find(
				(ext) => ext.path === shortcut.extensionPath,
			);
			if (!ownerExt || isWrappedFn(shortcut.handler)) continue;
			const origHandler = shortcut.handler;
			shortcut.handler = markWrappedFn((ctx: ExtensionContext) =>
				origHandler(this.wrapContextForExtension(ctx, ownerExt)),
			);
		}
		return shortcuts;
	}

	resolveRendererHook(
		field: "messageRenderers" | "entryRenderers",
		customType: string,
		original: (type: string) => unknown,
	): unknown {
		this.syncExtensionsAndWrap();
		const contended = this.collectContendedRendererMap(field);
		const contenders = contended.get(customType);
		if (!contenders) {
			return original(customType);
		}
		const prefix = field === "messageRenderers" ? "messageRenderer" : "entryRenderer";
		const winnerOwner = this.resolveActiveOwner(`${prefix}:${customType}`, contenders.keys());
		const winnerExt = contenders.get(winnerOwner) ?? contenders.get(PI_UI_OWNER_ID);
		return winnerExt?.[field]?.get(customType) ?? original(customType);
	}

	resolveToolRenderersHook(
		toolName: string,
		base: () => unknown,
		original: (name: string, baseFn: () => unknown) => unknown,
	): unknown {
		this.syncExtensionsAndWrap();

		/* Для базовых инструментов приоритет визуального рендеринга всегда за @conarti/pi-ui без модальных вопросов */
		if (CORE_TOOL_RENDERER_NAMES.has(toolName)) {
			const piUiExt = this.getPiUiExtension();
			const piUiResolvers = piUiExt?.toolRenderers ?? [];
			if (piUiResolvers.length > 0) {
				const otherResolvers = this.getExtensions()
					.filter((ext) => ext !== piUiExt && !isSupersededExtension(ext))
					.flatMap((ext) => ext.toolRenderers ?? []);
				const ordered = [...piUiResolvers, ...otherResolvers];
				const resolveChain = (idx: number): unknown =>
					idx < ordered.length
						? ordered[idx]!(toolName, () => resolveChain(idx + 1))
						: base();
				return resolveChain(0);
			}
			return original(toolName, base);
		}

		const contended = this.collectContendedToolRendererMap();
		const contenders = contended.get(toolName);
		if (!contenders) {
			return original(toolName, base);
		}

		const winnerOwner = this.resolveActiveOwner(`toolRenderer:${toolName}`, contenders.keys());
		const winnerExt = contenders.get(winnerOwner) ?? contenders.get(PI_UI_OWNER_ID);
		if (!winnerExt) return original(toolName, base);

		const winnerResolvers = winnerExt.toolRenderers ?? [];
		if (winnerResolvers.length > 0) {
			const resolveWinner = (idx: number): unknown =>
				idx < winnerResolvers.length
					? winnerResolvers[idx]!(toolName, () => resolveWinner(idx + 1))
					: winnerExt.tools?.get(toolName)?.definition ?? base();
			return resolveWinner(0);
		}

		return winnerExt.tools?.get(toolName)?.definition ?? base();
	}

	applySlotOwnershipUpdates(
		updates: Readonly<Record<string, string>>,
		options?: { readonly replace?: boolean },
	): void {
		const existing = options?.replace ? {} : { ...loadPiUiUserConfig().slotOwners };
		const nextOwners: Record<string, string> = { ...existing };

		for (const [slotId, rawOwner] of Object.entries(updates)) {
			const cleanSlot = slotId.trim();
			const cleanOwner = normalizeSlotOwnerId(rawOwner);
			if (cleanSlot && cleanOwner) {
				nextOwners[cleanSlot] = cleanOwner;
				this.promptedSlots.add(cleanSlot);
			}
		}

		updatePiUiUserConfig({ slotOwners: nextOwners });
		this.reapplyAllActiveSlots(Object.keys(updates));
	}

	clearAllSlotOwners(): void {
		updatePiUiUserConfig({ slotOwners: {} });
		this.reapplyAllActiveSlots([...SINGLETON_UI_SLOTS]);
	}

	private reapplyAllActiveSlots(touchedSlots: readonly string[]): void {
		const touched = new Set(touchedSlots);
		for (const slot of SINGLETON_UI_SLOTS) {
			if (
				touched.size === 0 ||
				touched.has(slot) ||
				this.singletonCandidates[slot].size > 0 ||
				this.appliedSingletonOwners[slot] !== undefined
			) {
				this.applySingletonSlot(slot, true);
			}
		}
		for (const slotId of touched) {
			if (!isSingletonSlot(slotId)) {
				notifyOwnershipListeners(slotId, this.resolveActiveOwner(slotId));
			}
		}
		getActiveHostRuntime()?.tui?.invalidate?.();
		requestRender();
	}

	dispose(): void {
		this.disposed = true;
		if (this.pendingPromptTimer) {
			clearTimeout(this.pendingPromptTimer);
			this.pendingPromptTimer = undefined;
		}
		const state = getGlobalState();
		if (state.activeController === this) {
			state.activeController = undefined;
		}
	}
}

function getOrCreateController(runner: unknown): SessionArbitrationController {
	const state = getGlobalState();
	const key = runner as object;
	let ctrl = state.controllers.get(key);
	if (!ctrl) {
		ctrl = new SessionArbitrationController(runner as RunnerLike);
		state.controllers.set(key, ctrl);
	}
	return ctrl;
}

function notifyOwnershipListeners(slotId: string, ownerId: string): void {
	for (const listener of getGlobalState().ownershipListeners.values()) {
		try {
			listener(slotId, ownerId);
		} catch {
			/* Ошибка одного слушателя не должна срывать переключение слотов */
		}
	}
}

function installExtensionRunnerArbitrationHooks(): void {
	const proto = (ExtensionRunner as unknown as { prototype?: object } | undefined)?.prototype;
	if (!proto) return;

	hookMethod(proto, "setUIContext", "slotArbitration.setUIContext", (self, args, original) => {
		const res = original.apply(self, args);
		const ctrl = getOrCreateController(self);
		const runner = self as RunnerLike;
		getGlobalState().activeController = ctrl;
		ctrl.bindRawUi(runner.getUIContext?.());
		return res;
	});

	hookMethod(proto, "emit", "slotArbitration.emit", (self, args, original) => {
		const ctrl = getOrCreateController(self);
		ctrl.syncExtensionsAndWrap();
		const event = args[0] as { type?: string } | undefined;
		if (event?.type === "session_start") {
			getGlobalState().activeController = ctrl;
			ctrl.beginSessionStart();
			const maybePromise = original.apply(self, args);
			if (maybePromise && typeof (maybePromise as Promise<unknown>).finally === "function") {
				return (maybePromise as Promise<unknown>).finally(() => {
					ctrl.endSessionStart();
				});
			}
			ctrl.endSessionStart();
			return maybePromise;
		}
		if (event?.type === "session_shutdown") {
			const maybePromise = original.apply(self, args);
			if (maybePromise && typeof (maybePromise as Promise<unknown>).finally === "function") {
				return (maybePromise as Promise<unknown>).finally(() => {
					ctrl.dispose();
				});
			}
			ctrl.dispose();
			return maybePromise;
		}
		return original.apply(self, args);
	});

	hookMethod(
		proto,
		"resolveRegisteredCommands",
		"slotArbitration.resolveRegisteredCommands",
		(self, args, original) => {
			const ctrl = getOrCreateController(self);
			return ctrl.resolveCommandsHook(() => original.apply(self, args) as unknown[]);
		},
	);

	hookMethod(proto, "getShortcuts", "slotArbitration.getShortcuts", (self, args, original) => {
		const ctrl = getOrCreateController(self);
		return ctrl.resolveShortcutsHook(
			args[0],
			(kb) => original.apply(self, [kb]) as Map<string, ExtensionShortcut>,
		);
	});

	hookMethod(
		proto,
		"getMessageRenderer",
		"slotArbitration.getMessageRenderer",
		(self, args, original) => {
			const ctrl = getOrCreateController(self);
			return ctrl.resolveRendererHook("messageRenderers", String(args[0] ?? ""), (type) =>
				original.apply(self, [type]),
			);
		},
	);

	hookMethod(
		proto,
		"getEntryRenderer",
		"slotArbitration.getEntryRenderer",
		(self, args, original) => {
			const ctrl = getOrCreateController(self);
			return ctrl.resolveRendererHook("entryRenderers", String(args[0] ?? ""), (type) =>
				original.apply(self, [type]),
			);
		},
	);

	hookMethod(
		proto,
		"resolveToolRenderers",
		"slotArbitration.resolveToolRenderers",
		(self, args, original) => {
			const ctrl = getOrCreateController(self);
			return ctrl.resolveToolRenderersHook(
				String(args[0] ?? ""),
				args[1] as () => unknown,
				(name, baseFn) => original.apply(self, [name, baseFn]),
			);
		},
	);

	hookMethod(proto, "invalidate", "slotArbitration.invalidate", (self, args, original) => {
		const ctrl = getGlobalState().controllers.get(self as object);
		ctrl?.dispose();
		return original.apply(self, args);
	});

	getGlobalState().hooksInstalled = true;
}

/**
 * Помечает обработчик команды `@conarti/pi-ui`, чтобы `ExtensionRunner` однозначно
 * отличал наше расширение от сторонних плагинов независимо от способа загрузки.
 */
export function markPiUiCommandHandler<T extends Function>(handler: T): T {
	(handler as unknown as Record<symbol, boolean>)[PI_UI_EXTENSION_MARKER] = true;
	return handler;
}

/**
 * Устанавливает прототипные хуки `Slot Arbitration` (ADR-0007) на `ExtensionRunner`.
 */
export function installSlotArbitration(_pi: ExtensionAPI): void {
	installExtensionRunnerArbitrationHooks();
}

export async function dispatchLocalShortcut(chord: LocallyDispatchedShortcut): Promise<void> {
	await getGlobalState().activeController?.dispatchLocalShortcut(chord);
}

export function registerSlotArbitrationModalOpener(opener: SlotArbitrationModalOpener): void {
	getGlobalState().modalOpener = opener;
}

export function registerSlotOwnershipChangeListener(
	id: string,
	listener: SlotOwnershipChangeListener,
): () => void {
	const map = getGlobalState().ownershipListeners;
	map.set(id, listener);
	return () => {
		if (map.get(id) === listener) {
			map.delete(id);
		}
	};
}

export function getContendedSlots(): ContendedSlotSnapshot[] {
	return getGlobalState().activeController?.getContendedSlots() ?? [];
}

export function getActiveSlotOwner(slotId: string): string {
	const ctrl = getGlobalState().activeController;
	if (ctrl) {
		if (isSingletonSlot(slotId)) return ctrl.getAppliedSingletonOwner(slotId);
		const slots = ctrl.getContendedSlots();
		const match = slots.find((s) => s.slotId === slotId);
		if (match) return match.activeOwnerId;
		return ctrl.resolveActiveOwner(slotId);
	}
	return PI_UI_OWNER_ID;
}

export function isSlotOwnedByPiUi(slotId: string): boolean {
	return getActiveSlotOwner(slotId) === PI_UI_OWNER_ID;
}

export function applySlotOwners(
	updates: Readonly<Record<string, string>>,
	options?: { readonly replace?: boolean },
): void {
	const ctrl = getGlobalState().activeController;
	if (ctrl) {
		ctrl.applySlotOwnershipUpdates(updates, options);
		return;
	}
	const existing = options?.replace ? {} : { ...loadPiUiUserConfig().slotOwners };
	const next: Record<string, string> = { ...existing };
	for (const [slot, owner] of Object.entries(updates)) {
		const normalized = normalizeSlotOwnerId(owner);
		if (slot.trim() && normalized) {
			next[slot.trim()] = normalized;
		}
	}
	updatePiUiUserConfig({ slotOwners: next });
}

export function clearAllSlotOwners(): void {
	const ctrl = getGlobalState().activeController;
	if (ctrl) {
		ctrl.clearAllSlotOwners();
		return;
	}
	updatePiUiUserConfig({ slotOwners: {} });
}
