import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { createDarkTheme, createLightTheme } from "./fake-theme.ts";
import { FakeTui } from "./fake-tui.ts";

export interface RegisteredCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
	getArgumentCompletions?: (prefix: string) => unknown;
}

export interface RegisteredShortcut {
	key: string;
	description?: string;
	handler: (ctx: ExtensionContext) => unknown | Promise<unknown>;
}

export interface RegisteredFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: unknown;
}

export interface HarnessToolInfo {
	name: string;
	description?: string;
	annotations?: {
		destructiveHint?: boolean;
		readOnlyHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
		[key: string]: unknown;
	};
	destructiveHint?: boolean;
	[key: string]: unknown;
}

export interface ExtensionHarnessOptions {
	theme?: "dark" | "light" | Theme;
	mode?: "tui" | "print";
	hasUI?: boolean;
	width?: number;
	height?: number;
	cwd?: string;
	flags?: Record<string, unknown>;
	activeTools?: string[];
	allTools?: HarnessToolInfo[];
	entries?: unknown[];
	branch?: unknown[];
	sessionId?: string;
	projectTrusted?: boolean;
}

export interface ActiveCustomModal {
	component: Component;
	handle?: OverlayHandle;
	done: (result?: unknown) => void;
}

export interface ExtensionHarness {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly tui: FakeTui;
	readonly keybindings: KeybindingsManager;

	readonly handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
	readonly commands: Map<string, RegisteredCommand>;
	readonly shortcuts: Map<string, RegisteredShortcut>;
	readonly flags: Map<string, RegisteredFlag>;
	readonly tools: Map<string, ToolDefinition>;
	readonly widgets: Map<string, unknown>;
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly appendedEntries: Array<{ customType: string; data: unknown }>;
	readonly sentUserMessages: Array<{ content: unknown; options?: unknown }>;
	readonly terminalInputListeners: Set<(data: string) => unknown>;
	readonly markdownTransformers: Array<(markdown: string, context: any) => string>;
	readonly workingMessages: Array<string | undefined>;
	readonly hiddenThinkingLabels: Array<string | undefined>;
	readonly statuses: Map<string, string>;

	header: Component | undefined;
	editor: Component | undefined;
	editorText: string;
	activeCustomModal: ActiveCustomModal | undefined;
	confirmHandler: ((title: string, message: string) => boolean | Promise<boolean>) | undefined;
	selectHandler: ((title: string, items: unknown[]) => unknown | Promise<unknown>) | undefined;

	mount(extensionFn: (pi: ExtensionAPI) => void): void;
	emit(eventName: string, event?: unknown): Promise<unknown[]>;
	startSession(): Promise<void>;
	shutdownSession(): Promise<void>;
	runCommand(name: string, args?: string): Promise<unknown>;
	triggerShortcut(key: string): Promise<unknown>;
	setTheme(theme: "dark" | "light" | Theme): void;
	setEntries(entries: unknown[], branch?: unknown[]): void;
	getActiveTools(): string[];
}

function resolveTheme(input: "dark" | "light" | Theme | undefined): Theme {
	if (!input || input === "dark") return createDarkTheme();
	if (input === "light") return createLightTheme();
	return input;
}

function createEditorTheme(getTheme: () => Theme): EditorTheme {
	return {
		borderColor: (text: string) => getTheme().fg("border", text),
		selectList: {
			selectedPrefix: (text: string) => getTheme().fg("accent", text),
			selectedText: (text: string) => getTheme().fg("accent", text),
			description: (text: string) => getTheme().fg("muted", text),
			scrollInfo: (text: string) => getTheme().fg("dim", text),
			noMatch: (text: string) => getTheme().fg("muted", text),
		},
	};
}

function createFakeKeybindings(): KeybindingsManager {
	const kb = {
		matches: (_data: string, _action: string) => false,
		getKeys: (_action: string) => [],
		getDisplayString: (action: string) => action,
		getUserBindings: () => ({}),
	};
	return kb as unknown as KeybindingsManager;
}

export function createExtensionHarness(options: ExtensionHarnessOptions = {}): ExtensionHarness {
	const tui = new FakeTui({ width: options.width ?? 120, height: options.height ?? 32 });
	const keybindings = createFakeKeybindings();

	let currentTheme = resolveTheme(options.theme);
	let activeTools = [...(options.activeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"])];
	const configuredTools: HarnessToolInfo[] = options.allTools
		? options.allTools.map((t) => ({ ...t }))
		: [...new Set([...activeTools, "read", "bash", "powershell", "edit", "write", "grep", "find", "ls"])].map(
				(name) => ({ name }),
			);
	let sessionEntries = [...(options.entries ?? [])];
	let sessionBranch = [...(options.branch ?? sessionEntries)];
	let thinkingLevel = "medium";

	const flagValues = new Map<string, unknown>(Object.entries(options.flags ?? {}));
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const commands = new Map<string, RegisteredCommand>();
	const shortcuts = new Map<string, RegisteredShortcut>();
	const flags = new Map<string, RegisteredFlag>();
	const tools = new Map<string, ToolDefinition>();
	const widgets = new Map<string, unknown>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
	const terminalInputListeners = new Set<(data: string) => unknown>();
	const markdownTransformers: Array<(markdown: string, context: any) => string> = [];
	const workingMessages: Array<string | undefined> = [];
	const hiddenThinkingLabels: Array<string | undefined> = [];
	const statuses = new Map<string, string>();

	const setGlobalTheme = (theme: Theme) => {
		(globalThis as Record<PropertyKey, unknown>)[
			Symbol.for("@earendil-works/pi-coding-agent:theme")
		] = theme;
	};
	setGlobalTheme(currentTheme);

	let headerComponent: Component | undefined;
	let editorFactory:
		| ((t: unknown, editorTheme: EditorTheme, kb: KeybindingsManager) => Component)
		| undefined;
	let editorComponent: Component | undefined;
	let editorText = "";
	let activeCustomModal: ActiveCustomModal | undefined;
	let confirmHandler: ((title: string, message: string) => boolean | Promise<boolean>) | undefined;
	let selectHandler: ((title: string, items: unknown[]) => unknown | Promise<unknown>) | undefined;

	const ui = {
		get theme() {
			return currentTheme;
		},
		setTheme: (next: string | Theme) => {
			if (typeof next === "string") {
				currentTheme = next.toLowerCase().includes("light")
					? createLightTheme()
					: createDarkTheme();
			} else {
				currentTheme = next;
			}
			setGlobalTheme(currentTheme);
			tui.requestRender();
			return { success: true };
		},
		notify: (message: string, level?: string) => {
			notifications.push({ message, level });
		},
		setWidget: (key: string, content: unknown) => {
			if (content === undefined) {
				widgets.delete(key);
			} else {
				widgets.set(key, content);
			}
			tui.requestRender();
		},
		setHeader: (factory: ((t: unknown, theme: Theme) => Component) | undefined) => {
			headerComponent = factory ? factory(tui.asTui(), currentTheme) : undefined;
			tui.requestRender();
		},
		setEditorComponent: (
			factory: ((t: unknown, editorTheme: EditorTheme, kb: KeybindingsManager) => Component) | undefined,
		) => {
			editorFactory = factory;
			editorComponent = factory
				? factory(tui.asTui(), createEditorTheme(() => currentTheme), keybindings)
				: undefined;
			tui.requestRender();
		},
		getEditorComponent: () => editorFactory,
		setEditorText: (text: string) => {
			editorText = text;
		},
		setWorkingIndicator: () => {},
		setWorkingVisible: () => {},
		setWorkingMessage: (message?: string) => {
			workingMessages.push(message);
			tui.requestRender();
		},
		setHiddenThinkingLabel: (label?: string) => {
			hiddenThinkingLabels.push(label);
			tui.requestRender();
		},
		setStatus: (key: string, value?: string) => {
			if (value === undefined) statuses.delete(key);
			else statuses.set(key, value);
			tui.requestRender();
		},
		onTerminalInput: (listener: (data: string) => unknown) => {
			terminalInputListeners.add(listener);
			return () => {
				terminalInputListeners.delete(listener);
			};
		},
		confirm: async (title: string, message: string) => {
			if (confirmHandler) return Boolean(await confirmHandler(title, message));
			return false;
		},
		select: async (title: string, items: unknown[]) => {
			if (selectHandler) return await selectHandler(title, items);
			return undefined;
		},
		custom: async <T>(
			factory: (
				t: unknown,
				theme: Theme,
				kb: KeybindingsManager,
				done: (result?: T) => void,
			) => Component,
			customOptions?: {
				overlay?: boolean;
				overlayOptions?: OverlayOptions;
				onHandle?: (handle: OverlayHandle) => void;
			},
		): Promise<T | undefined> => {
			return new Promise<T | undefined>((resolvePromise) => {
				let settled = false;
				let overlayHandle: OverlayHandle | undefined;
				let modalRef: ActiveCustomModal | undefined;

				const done = (result?: T) => {
					if (settled) return;
					settled = true;
					overlayHandle?.hide();
					if (activeCustomModal === modalRef) {
						activeCustomModal = undefined;
					}
					resolvePromise(result);
				};

				const component = factory(tui.asTui(), currentTheme, keybindings, done);
				if (!settled && customOptions?.overlay) {
					overlayHandle = tui.showOverlay(component, customOptions.overlayOptions);
				}

				if (!settled) {
					modalRef = {
						component,
						handle: overlayHandle,
						done: (res?: unknown) => done(res as T),
					};
					if (!customOptions?.overlayOptions?.nonCapturing) {
						activeCustomModal = modalRef;
					}
				}

				if (overlayHandle && customOptions?.onHandle) {
					customOptions.onHandle(overlayHandle);
				}
			});
		},
	};

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? process.cwd(),
		thinkingLevel,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => options.projectTrusted ?? true,
		ui,
		sessionManager: {
			getEntries: () => sessionEntries,
			getBranch: () => sessionBranch,
			getSessionId: () => options.sessionId ?? "test-session",
			buildSessionProjection: () => ({ messages: [] }),
		},
		getContextUsage: () => ({
			tokens: 1200,
			contextWindow: 128000,
			percent: 0.94,
		}),
	} as unknown as ExtensionContext;

	const pi = {
		on: (eventName: string, handler: (...args: unknown[]) => unknown) => {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
		},
		registerCommand: (
			name: string,
			spec: Omit<RegisteredCommand, "name">,
		) => {
			commands.set(name, { name, ...spec });
		},
		getCommands: () =>
			[...commands.values()].map((c) => ({
				name: c.name,
				description: c.description ?? "",
				source: "extension",
			})),
		registerShortcut: (
			key: string,
			spec: Omit<RegisteredShortcut, "key">,
		) => {
			shortcuts.set(key, { key, ...spec });
		},
		registerFlag: (
			name: string,
			spec: Omit<RegisteredFlag, "name">,
		) => {
			flags.set(name, { name, ...spec });
			if (!flagValues.has(name) && spec.default !== undefined) {
				flagValues.set(name, spec.default);
			}
		},
		getFlag: (name: string) => flagValues.get(name),
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		getAllTools: () => {
			const byName = new Map<string, HarnessToolInfo>();
			for (const tool of configuredTools) {
				byName.set(tool.name, tool);
			}
			for (const tool of tools.values()) {
				if (!byName.has(tool.name)) {
					byName.set(tool.name, tool as unknown as HarnessToolInfo);
				}
			}
			return [...byName.values()];
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
		appendEntry: (customType: string, data: unknown) => {
			appendedEntries.push({ customType, data });
			const entry = { type: "custom", customType, data };
			sessionEntries.push(entry);
			sessionBranch.push(entry);
		},
		sendUserMessage: (content: unknown, msgOptions?: unknown) => {
			sentUserMessages.push({ content, options: msgOptions });
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level: string) => {
			thinkingLevel = level;
		},
		getSettings: () => ({}),
		compact: () => {},
		registerMarkdownTransformer: (transformer: (markdown: string, context: any) => string) => {
			markdownTransformers.push(transformer);
		},
	} as unknown as ExtensionAPI;

	const harness: ExtensionHarness = {
		pi,
		ctx,
		tui,
		keybindings,
		handlers,
		commands,
		shortcuts,
		flags,
		tools,
		widgets,
		notifications,
		appendedEntries,
		sentUserMessages,
		terminalInputListeners,
		markdownTransformers,
		workingMessages,
		hiddenThinkingLabels,
		statuses,

		get header() {
			return headerComponent;
		},
		set header(value: Component | undefined) {
			headerComponent = value;
		},
		get editor() {
			return editorComponent;
		},
		set editor(value: Component | undefined) {
			editorComponent = value;
		},
		get editorText() {
			return editorText;
		},
		set editorText(value: string) {
			editorText = value;
		},
		get activeCustomModal() {
			return activeCustomModal;
		},
		set activeCustomModal(value: ActiveCustomModal | undefined) {
			activeCustomModal = value;
		},
		get confirmHandler() {
			return confirmHandler;
		},
		set confirmHandler(value) {
			confirmHandler = value;
		},
		get selectHandler() {
			return selectHandler;
		},
		set selectHandler(value) {
			selectHandler = value;
		},

		mount(extensionFn) {
			extensionFn(pi);
		},
		async emit(eventName, event = {}) {
			const list = handlers.get(eventName) ?? [];
			const results: unknown[] = [];
			for (const fn of list) {
				results.push(await fn(event, ctx));
			}
			return results;
		},
		async startSession() {
			await harness.emit("session_start", {});
		},
		async shutdownSession() {
			await harness.emit("session_shutdown", {});
			tui.disposeTimers();
		},
		async runCommand(name, args = "") {
			const cmd = commands.get(name);
			if (!cmd) throw new Error(`Command not registered: ${name}`);
			return await cmd.handler(args, ctx);
		},
		async triggerShortcut(key) {
			const sc = shortcuts.get(key);
			if (!sc) throw new Error(`Shortcut not registered: ${key}`);
			return await sc.handler(ctx);
		},
		setTheme(theme) {
			currentTheme = resolveTheme(theme);
			setGlobalTheme(currentTheme);
			tui.requestRender();
		},
		setEntries(entries, branch) {
			sessionEntries = [...entries];
			sessionBranch = [...(branch ?? entries)];
		},
		getActiveTools() {
			return [...activeTools];
		},
	};

	return harness;
}
