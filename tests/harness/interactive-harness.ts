import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	contentText,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
	type AssistantMessage,
	type FauxContentBlock,
	type FauxModelDefinition,
	type FauxProviderHandle,
	type FauxProviderState,
	type FauxResponseFactory,
	type FauxResponseStep,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	registerApiProvider,
	registerFauxProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionFactory,
	type InteractiveModeOptions,
	type ToolDefinition,
	type TuiMode,
} from "@earendil-works/pi-coding-agent";
import type { ProgramStatus, Terminal, TUI } from "@earendil-works/pi-tui";
import {
	setHostClipboardProvider,
	type ClipboardImagePayload,
	type HostClipboardProvider,
} from "../../src/shared/host-runtime.ts";
import { captureTerminalScreen, type TerminalScreenSnapshot } from "./terminal-screen.ts";

export {
	contentText,
	createAgentSession,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	registerFauxProvider,
	type AssistantMessage,
	type FauxContentBlock,
	type FauxModelDefinition,
	type FauxProviderHandle,
	type FauxProviderState,
	type FauxResponseFactory,
	type FauxResponseStep,
	type SimpleStreamOptions,
	type TranscriptContext,
};

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HARNESS_DIR, "../..");
export const DEFAULT_EXTENSION_ENTRY = resolve(REPO_ROOT, "src/index.ts");
export const DEFAULT_THEMES_DIR = resolve(REPO_ROOT, "themes");

export interface MouseModifiers {
	readonly shift?: boolean;
	readonly alt?: boolean;
	readonly ctrl?: boolean;
}

export type MouseButtonName = "left" | "middle" | "right";

function encodeButtonCode(button: MouseButtonName, modifiers?: MouseModifiers): number {
	const base = button === "middle" ? 1 : button === "right" ? 2 : 0;
	const modBits =
		(modifiers?.shift ? 4 : 0) |
		(modifiers?.alt ? 8 : 0) |
		(modifiers?.ctrl ? 16 : 0);
	return base | modBits;
}

/**
 * Формирует SGR-последовательность мыши (`\x1b[<button;col;rowM/m`) из 0-индексированных координат экрана.
 */
export function formatSgrMouse(
	buttonCode: number,
	col: number,
	row: number,
	release: boolean,
): string {
	const x1 = Math.max(1, Math.floor(col) + 1);
	const y1 = Math.max(1, Math.floor(row) + 1);
	return `\x1b[<${buttonCode};${x1};${y1}${release ? "m" : "M"}`;
}

export interface VirtualTerminalOptions {
	columns?: number;
	rows?: number;
	kittyProtocolActive?: boolean;
	terminalColors?: {
		foreground?: string;
		background?: string;
	};
	cellSizePx?: {
		widthPx: number;
		heightPx: number;
	};
}

/**
 * Виртуальный терминал в памяти (порт 1 ADR-0006), реализующий интерфейс `Terminal` из `@earendil-works/pi-tui`.
 * Отвечает на запросы цветов/DA1 (`\x1b[c`) и размеров ячейки (`\x1b[16t`) без сетевых или 100мс тайм-аутов.
 */
export class VirtualTerminal implements Terminal {
	columns: number;
	rows: number;
	kittyProtocolActive: boolean;
	readonly writes: string[] = [];
	readonly titles: string[] = [];
	readonly programStatuses: ProgramStatus[] = [];
	cursorVisible = false;
	progressActive = false;
	started = false;

	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;
	private readonly terminalColors: { foreground?: string; background?: string } | undefined;
	private readonly cellSizePx: { widthPx: number; heightPx: number };

	constructor(options?: VirtualTerminalOptions) {
		this.columns = options?.columns ?? 120;
		this.rows = options?.rows ?? 36;
		this.kittyProtocolActive = options?.kittyProtocolActive ?? true;
		this.terminalColors = options?.terminalColors;
		this.cellSizePx = options?.cellSizePx ?? { widthPx: 10, heightPx: 20 };
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.started = true;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.started = false;
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	restoreOnExit(before: string, after: string): void {
		if (before) this.writes.push(before);
		if (after) this.writes.push(after);
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		this.writes.push(data);
		if (!this.started) return;

		/* Авто-ответ на запрос цветов терминала + DA1, чтобы queryTerminalColors завершался мгновенно без висящих таймеров */
		if (data.includes("\x1b[c")) {
			const fgReply = this.terminalColors?.foreground
				? `\x1b]10;${this.terminalColors.foreground}\x07`
				: "";
			const bgReply = this.terminalColors?.background
				? `\x1b]11;${this.terminalColors.background}\x07`
				: "";
			const reply = `${fgReply}${bgReply}\x1b[?1;2c`;
			queueMicrotask(() => {
				if (this.started) {
					this.inputHandler?.(reply);
				}
			});
		}

		/* Авто-ответ на запрос размера ячейки для inline-изображений Kitty */
		if (data.includes("\x1b[16t")) {
			const { heightPx, widthPx } = this.cellSizePx;
			queueMicrotask(() => {
				if (this.started) {
					this.inputHandler?.(`\x1b[6;${heightPx};${widthPx}t`);
				}
			});
		}
	}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {
		this.cursorVisible = false;
	}

	showCursor(): void {
		this.cursorVisible = true;
	}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(title: string): void {
		this.titles.push(title);
	}

	setProgress(active: boolean): void {
		this.progressActive = active;
	}

	setProgramStatus(status: ProgramStatus): void {
		this.programStatuses.push(status);
	}
}

export interface RecordedFauxCall {
	readonly index: number;
	readonly context: TranscriptContext;
	readonly messages: readonly Message[];
	readonly systemPrompt: string | undefined;
	readonly tools: ReturnType<typeof getCurrentTools>;
	readonly options: SimpleStreamOptions | undefined;
	readonly signal: AbortSignal | undefined;
	readonly model: Model<string>;
	aborted: boolean;
}

export interface MutableClipboardState {
	text?: string | null;
	image?: ClipboardImagePayload | null;
	filePaths?: readonly string[] | null;
}

export interface InteractiveHarnessOptions {
	width?: number;
	height?: number;
	kittyProtocolActive?: boolean;
	terminalColors?: {
		foreground?: string;
		background?: string;
	};
	tuiMode?: TuiMode;
	theme?: "dark" | "light" | string;
	cwd?: string;
	agentDir?: string;
	persistSession?: boolean;
	persistSettings?: boolean;
	projectTrusted?: boolean;
	settings?: Record<string, unknown>;
	flags?: Record<string, boolean | string>;
	loadDefaultExtension?: boolean;
	additionalExtensionPaths?: string[];
	extensionFactories?: ExtensionFactory[];
	additionalThemePaths?: string[];
	customTools?: ToolDefinition[];
	models?: FauxModelDefinition[];
	responses?: FauxResponseStep[];
	suggestionResponses?: FauxResponseStep[];
	tokensPerSecond?: number;
	tokenSize?: { min?: number; max?: number };
	thinkingLevel?: ThinkingLevel;
	clipboard?: HostClipboardProvider | MutableClipboardState;
	interactiveOptions?: Omit<InteractiveModeOptions, "terminal" | "tuiMode" | "initialThemeSetting">;
}

interface InteractiveModeInternals {
	readonly ui: TUI;
	readonly renderer: TUI;
	isInitialized: boolean;
	pendingUserInputs: string[];
	onInputCallback?: (text: string) => void;
	defaultEditor: {
		onSubmit?: (text: string) => unknown;
		getText(): string;
		setText(text: string): void;
	};
	editor: {
		getText(): string;
		setText(text: string): void;
	};
	themeController?: {
		dispose?: () => void;
		setThemeSetting?: (setting: string) => void;
	};
	handleReloadCommand(): Promise<void>;
	switchTuiMode(mode: TuiMode, restoreProgress?: boolean, startRenderer?: boolean): boolean;
}

let cachedManagedBinaries: { fd?: string; rg?: string } | undefined;

function resolveSystemBinary(name: string): string | undefined {
	const whichCmd = process.platform === "win32" ? "where" : "which";
	try {
		return execFileSync(whichCmd, [name], { encoding: "utf8" })
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0 && existsSync(line));
	} catch {
		return undefined;
	}
}

function seedManagedToolBinaries(agentDir: string): void {
	if (!cachedManagedBinaries) {
		cachedManagedBinaries = {
			fd: resolveSystemBinary("fd"),
			rg: resolveSystemBinary("rg"),
		};
	}
	const binDir = join(agentDir, "bin");
	mkdirSync(binDir, { recursive: true });

	for (const toolName of ["fd", "rg"] as const) {
		const target = join(binDir, process.platform === "win32" ? `${toolName}.cmd` : toolName);
		if (existsSync(target)) continue;
		const existing = cachedManagedBinaries[toolName];
		if (existing && process.platform !== "win32") {
			try {
				symlinkSync(existing, target);
				continue;
			} catch {
				/* Если симлинк недоступен, создаём лёгкую заглушку */
			}
		}
		if (process.platform === "win32") {
			writeFileSync(target, "@echo off\r\nexit /b 0\r\n", "utf8");
		} else {
			writeFileSync(target, "#!/bin/sh\nexit 0\n", "utf8");
			chmodSync(target, 0o755);
		}
	}
}

async function flushMicrotasksAndTicks(cycles = 3): Promise<void> {
	for (let i = 0; i < cycles; i += 1) {
		await Promise.resolve();
		await new Promise<void>((resolveTick) => process.nextTick(resolveTick));
	}
}

function isHostClipboardProvider(
	value: HostClipboardProvider | MutableClipboardState | undefined,
): value is HostClipboardProvider {
	if (!value) return false;
	return (
		typeof (value as HostClipboardProvider).readText === "function" ||
		typeof (value as HostClipboardProvider).readImage === "function" ||
		typeof (value as HostClipboardProvider).readFilePaths === "function"
	);
}

let fauxHarnessSeq = 0;

export interface InteractiveHarness {
	readonly mode: InteractiveMode;
	readonly runtimeHost: AgentSessionRuntime;
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	readonly modelRegistry: ModelRegistry;
	readonly terminal: VirtualTerminal;
	readonly tui: TUI;
	readonly faux: FauxProviderHandle;
	readonly calls: readonly RecordedFauxCall[];
	readonly suggestionCalls: readonly RecordedFauxCall[];
	readonly cwd: string;
	readonly agentDir: string;
	readonly width: number;
	readonly height: number;
	setResponses(steps: FauxResponseStep[]): void;
	appendResponses(steps: FauxResponseStep[]): void;
	setSuggestionResponses(steps: FauxResponseStep[]): void;
	appendSuggestionResponses(steps: FauxResponseStep[]): void;
	setClipboard(next: MutableClipboardState): void;
	sendInput(data: string): Promise<void>;
	pressKey(sequence: string): Promise<void>;
	typeText(text: string): Promise<void>;
	paste(text: string, bracketed?: boolean): Promise<void>;
	submitInput(text: string): Promise<void>;
	prompt(text: string): Promise<void>;
	reload(): Promise<void>;
	setTuiMode(mode: TuiMode): Promise<boolean>;
	mouseMove(col: number, row: number, modifiers?: MouseModifiers): Promise<void>;
	mouseDown(
		col: number,
		row: number,
		button?: MouseButtonName,
		modifiers?: MouseModifiers,
	): Promise<void>;
	mouseUp(
		col: number,
		row: number,
		button?: MouseButtonName,
		modifiers?: MouseModifiers,
	): Promise<void>;
	mouseClick(
		col: number,
		row: number,
		button?: MouseButtonName,
		modifiers?: MouseModifiers,
	): Promise<void>;
	mouseDrag(
		fromCol: number,
		fromRow: number,
		toCol: number,
		toRow: number,
		options?: { steps?: number; button?: MouseButtonName; modifiers?: MouseModifiers },
	): Promise<void>;
	mouseWheel(
		direction: "up" | "down",
		col: number,
		row: number,
		count?: number,
		modifiers?: MouseModifiers,
	): Promise<void>;
	resize(columns: number, rows: number): Promise<void>;
	flushFrame(force?: boolean): void;
	renderFrame(width?: number, height?: number): string[];
	screen(width?: number, height?: number): TerminalScreenSnapshot;
	dispose(): Promise<void>;
}

/**
 * Поднимает реальный `InteractiveMode` хоста Pi поверх четырёх граничных портов (ADR-0006):
 * виртуального `Terminal`, детерминированного `fauxProvider`, изолированных `cwd`/`agentDir` и буфера обмена.
 */
export async function createInteractiveHarness(
	options?: InteractiveHarnessOptions,
): Promise<InteractiveHarness> {
	const ownsCwd = !options?.cwd;
	const ownsAgentDir = !options?.agentDir;
	const cwd = options?.cwd ?? mkdtempSync(join(tmpdir(), "pi-ui-it-cwd-"));
	const agentDir = options?.agentDir ?? mkdtempSync(join(tmpdir(), "pi-ui-it-agent-"));
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	seedManagedToolBinaries(agentDir);

	const prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	const prevOfflineEnv = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";

	const resolvedThemeName =
		options?.theme === "light"
			? "one-blue-light"
			: options?.theme === "dark" || options?.theme === undefined
				? "midnight-cobalt"
				: options.theme;

	const tuiMode: TuiMode = options?.tuiMode ?? "fullscreen";
	const projectTrusted = options?.projectTrusted ?? true;

	const baseSettings: Record<string, unknown> = {
		tuiMode,
		theme: resolvedThemeName,
		quietStartup: true,
		cacheWarming: "off",
		compaction: { enabled: false },
		showHardwareCursor: false,
		fullscreenCopyOnSelect: false,
		enableInstallTelemetry: false,
		...options?.settings,
	};

	const settingsManager = options?.persistSettings
		? (() => {
				writeFileSync(
					join(agentDir, "settings.json"),
					`${JSON.stringify(baseSettings, null, 2)}\n`,
					"utf8",
				);
				return SettingsManager.create(cwd, agentDir, { projectTrusted });
			})()
		: SettingsManager.inMemory(baseSettings as never, { projectTrusted });

	const recordedCalls: RecordedFauxCall[] = [];
	const recordedSuggestionCalls: RecordedFauxCall[] = [];
	let hasExplicitSuggestionResponses = options?.suggestionResponses !== undefined;
	const harnessId = ++fauxHarnessSeq;
	const compatSourceId = `pi-ui-interactive-harness-${harnessId}`;
	const modelDefs: FauxModelDefinition[] = options?.models ?? [
		{
			id: "faux-1",
			name: "Faux Reasoning",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 16384,
		},
	];

	const rawFaux = fauxProvider({
		provider: "faux",
		api: `faux-api-${harnessId}`,
		models: modelDefs,
		tokensPerSecond: options?.tokensPerSecond,
		tokenSize: options?.tokenSize,
	});

	/* Отдельный поток fauxProvider для фоновых Prompt Suggestion, чтобы не расходовать очередь основных ответов responses */
	const suggestionFaux = fauxProvider({
		provider: "faux",
		api: `faux-api-${harnessId}`,
		models: modelDefs,
	});

	const makeStepWrapper = (targetList: RecordedFauxCall[]) => {
		return (step: FauxResponseStep): FauxResponseFactory => {
			return async (context, streamOptions, state, model) => {
				const record: RecordedFauxCall = {
					index: targetList.length,
					context,
					messages: [...context.messages],
					systemPrompt: getCurrentSystemPrompt(context.messages),
					tools: getCurrentTools(context.messages),
					options: streamOptions,
					signal: streamOptions?.signal,
					model,
					aborted: Boolean(streamOptions?.signal?.aborted),
				};
				if (streamOptions?.signal && !streamOptions.signal.aborted) {
					streamOptions.signal.addEventListener(
						"abort",
						() => {
							record.aborted = true;
						},
						{ once: true },
					);
				}
				targetList.push(record);
				return typeof step === "function"
					? await step(context, streamOptions, state, model)
					: step;
			};
		};
	};

	const wrapStep = makeStepWrapper(recordedCalls);
	const wrapSuggestionStep = makeStepWrapper(recordedSuggestionCalls);

	const isPromptSuggestionRequest = (context: { messages?: readonly unknown[] }): boolean => {
		const trailing = context.messages?.at(-1);
		if (!trailing || typeof trailing !== "object") return false;
		const serialized = JSON.stringify(trailing);
		return (
			serialized.includes("[Prompt suggestion]") ||
			serialized.includes("[Suggestion mode]")
		);
	};

	const faux: FauxProviderHandle = {
		...rawFaux,
		setResponses(steps: FauxResponseStep[]) {
			rawFaux.setResponses(steps.map(wrapStep));
		},
		appendResponses(steps: FauxResponseStep[]) {
			rawFaux.appendResponses(steps.map(wrapStep));
		},
	};

	const setSuggestionResponses = (steps: FauxResponseStep[]) => {
		hasExplicitSuggestionResponses = true;
		suggestionFaux.setResponses(steps.map(wrapSuggestionStep));
	};

	const appendSuggestionResponses = (steps: FauxResponseStep[]) => {
		hasExplicitSuggestionResponses = true;
		suggestionFaux.appendResponses(steps.map(wrapSuggestionStep));
	};

	if (options?.responses) {
		faux.setResponses(options.responses);
	}
	if (options?.suggestionResponses) {
		setSuggestionResponses(options.suggestionResponses);
	}

	const routedNativeProvider = {
		...rawFaux.provider,
		stream: (
			model: Parameters<typeof rawFaux.provider.stream>[0],
			context: Parameters<typeof rawFaux.provider.stream>[1],
			streamOptions?: Parameters<typeof rawFaux.provider.stream>[2],
		) => {
			if (isPromptSuggestionRequest(context)) {
				if (!hasExplicitSuggestionResponses) {
					suggestionFaux.appendResponses([wrapSuggestionStep(fauxAssistantMessage(""))]);
				}
				return suggestionFaux.provider.stream(model, context, streamOptions as never);
			}
			return rawFaux.provider.stream(model, context, streamOptions as never);
		},
		streamSimple: (
			model: Parameters<typeof rawFaux.provider.streamSimple>[0],
			context: Parameters<typeof rawFaux.provider.streamSimple>[1],
			streamOptions?: Parameters<typeof rawFaux.provider.streamSimple>[2],
		) => {
			if (isPromptSuggestionRequest(context)) {
				if (!hasExplicitSuggestionResponses) {
					suggestionFaux.appendResponses([wrapSuggestionStep(fauxAssistantMessage(""))]);
				}
				return suggestionFaux.provider.streamSimple(model, context, streamOptions);
			}
			return rawFaux.provider.streamSimple(model, context, streamOptions);
		},
	};

	const credentials = new InMemoryCredentialStore();
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerNativeProvider(routedNativeProvider);
	await modelRuntime.refresh({ allowNetwork: false });
	const modelRegistry = new ModelRegistry(modelRuntime);

	registerApiProvider(
		{
			api: rawFaux.api,
			stream: (model, context, streamOptions) =>
				routedNativeProvider.stream(model, context, streamOptions as never),
			streamSimple: (model, context, streamOptions) =>
				routedNativeProvider.streamSimple(model, context, streamOptions),
		},
		compatSourceId,
	);

	const clipboardState: MutableClipboardState = isHostClipboardProvider(options?.clipboard)
		? {}
		: { ...(options?.clipboard ?? {}) };

	const activeClipboard: HostClipboardProvider = isHostClipboardProvider(options?.clipboard)
		? options.clipboard
		: {
				async readText() {
					return clipboardState.text ?? null;
				},
				async readImage() {
					return clipboardState.image ?? null;
				},
				async readFilePaths() {
					return clipboardState.filePaths ?? null;
				},
			};

	setHostClipboardProvider(activeClipboard);

	const extensionPaths: string[] = [];
	if (options?.loadDefaultExtension !== false) {
		extensionPaths.push(DEFAULT_EXTENSION_ENTRY);
	}
	if (options?.additionalExtensionPaths) {
		for (const extPath of options.additionalExtensionPaths) {
			extensionPaths.push(resolve(cwd, extPath));
		}
	}

	const themePaths = [
		DEFAULT_THEMES_DIR,
		...(options?.additionalThemePaths?.map((tp) => resolve(cwd, tp)) ?? []),
	];

	const extensionFlagValues = options?.flags
		? new Map<string, boolean | string>(Object.entries(options.flags))
		: undefined;

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: targetCwd,
		agentDir: targetAgentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: targetCwd,
			agentDir: targetAgentDir,
			modelRuntime,
			settingsManager,
			extensionFlagValues,
			resourceLoaderOptions: {
				noExtensions: true,
				additionalExtensionPaths: extensionPaths,
				extensionFactories: options?.extensionFactories,
				noThemes: true,
				additionalThemePaths: themePaths,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: faux.getModel(),
			thinkingLevel: options?.thinkingLevel ?? "off",
			customTools: options?.customTools,
		});
		return {
			...result,
			services,
			diagnostics: services.diagnostics,
		};
	};

	const initialSessionManager = options?.persistSession
		? SessionManager.create(cwd, join(agentDir, "sessions"))
		: SessionManager.inMemory(cwd);

	const runtimeHost = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: initialSessionManager,
	});

	const terminal = new VirtualTerminal({
		columns: options?.width ?? 120,
		rows: options?.height ?? 36,
		kittyProtocolActive: options?.kittyProtocolActive ?? true,
		terminalColors: options?.terminalColors,
	});

	const mode = new InteractiveMode(runtimeHost, {
		...options?.interactiveOptions,
		terminal,
		tuiMode,
		initialThemeSetting: resolvedThemeName,
	});
	const internals = mode as unknown as InteractiveModeInternals;

	await mode.init();
	await flushMicrotasksAndTicks(4);

	/* Подключаем перехват onSubmit и фоновый цикл обработки пользовательского ввода (без бесконечного mode.run()) */
	let stopped = false;
	let cancelInputWait: (() => void) | undefined;
	let cancelTurnWait: (() => void) | undefined;
	let activeSubmitPromise: Promise<unknown> | undefined;
	let activePromptTurnPromise: Promise<unknown> | undefined;
	const pumpIdleWaiters = new Set<() => void>();

	const notifyPumpIdle = () => {
		if (!activeSubmitPromise && !activePromptTurnPromise && internals.pendingUserInputs.length === 0) {
			for (const waiter of [...pumpIdleWaiters]) {
				pumpIdleWaiters.delete(waiter);
				waiter();
			}
		}
	};

	const origOnSubmit = internals.defaultEditor.onSubmit;
	if (typeof origOnSubmit === "function") {
		internals.defaultEditor.onSubmit = (submittedText: string) => {
			const outcome = origOnSubmit.call(internals.defaultEditor, submittedText);
			if (outcome && typeof (outcome as PromiseLike<unknown>).then === "function") {
				const tracked = Promise.resolve(outcome).finally(() => {
					if (activeSubmitPromise === tracked) {
						activeSubmitPromise = undefined;
					}
					notifyPumpIdle();
				});
				activeSubmitPromise = tracked;
				return tracked;
			}
			notifyPumpIdle();
			return outcome;
		};
	}

	const pumpLoop = (async () => {
		while (!stopped) {
			const nextText =
				internals.pendingUserInputs.length > 0
					? internals.pendingUserInputs.shift()
					: await new Promise<string | undefined>((resolveNext) => {
							notifyPumpIdle();
							cancelInputWait = () => {
								internals.onInputCallback = undefined;
								resolveNext(undefined);
							};
							internals.onInputCallback = (text: string) => {
								internals.onInputCallback = undefined;
								cancelInputWait = undefined;
								resolveNext(text);
							};
						});
			if (stopped || nextText === undefined) break;
			const turnPromise = runtimeHost.session.prompt(nextText).finally(() => {
				if (activePromptTurnPromise === turnPromise) {
					activePromptTurnPromise = undefined;
				}
				notifyPumpIdle();
			});
			activePromptTurnPromise = turnPromise;
			await Promise.race([
				turnPromise,
				new Promise<void>((resolveAbort) => {
					cancelTurnWait = () => {
						cancelTurnWait = undefined;
						resolveAbort();
					};
				}),
			]);
			cancelTurnWait = undefined;
		}
	})();

	const waitForIdlePump = async (): Promise<void> => {
		await flushMicrotasksAndTicks(2);
		while (activeSubmitPromise || activePromptTurnPromise || internals.pendingUserInputs.length > 0) {
			if (activeSubmitPromise) {
				await activeSubmitPromise;
			}
			if (activePromptTurnPromise) {
				await activePromptTurnPromise;
			}
			if (internals.pendingUserInputs.length > 0) {
				await new Promise<void>((resolveWait) => {
					pumpIdleWaiters.add(resolveWait);
				});
			}
			await flushMicrotasksAndTicks(2);
		}
	};

	/* Сбрасываем стартовый отложенный рендер (включая loadAllHighlightLanguages), чтобы init() завершался с 0 таймеров */
	const flushFrame = (force = false) => {
		const renderable = internals.ui as TUI & { renderNow?: (force?: boolean) => void };
		renderable.renderNow?.(force);
	};
	flushFrame();

	let disposed = false;

	const harness: InteractiveHarness = {
		mode,
		runtimeHost,
		get session() {
			return runtimeHost.session;
		},
		get sessionManager() {
			return runtimeHost.session.sessionManager;
		},
		settingsManager,
		modelRuntime,
		modelRegistry,
		terminal,
		get tui() {
			return internals.ui;
		},
		faux,
		calls: recordedCalls,
		suggestionCalls: recordedSuggestionCalls,
		cwd,
		agentDir,
		get width() {
			return terminal.columns;
		},
		get height() {
			return terminal.rows;
		},
		setResponses(steps: FauxResponseStep[]) {
			faux.setResponses(steps);
		},
		appendResponses(steps: FauxResponseStep[]) {
			faux.appendResponses(steps);
		},
		setSuggestionResponses,
		appendSuggestionResponses,
		setClipboard(next: MutableClipboardState) {
			if ("text" in next) clipboardState.text = next.text;
			if ("image" in next) clipboardState.image = next.image;
			if ("filePaths" in next) clipboardState.filePaths = next.filePaths;
		},
		async sendInput(data: string): Promise<void> {
			terminal.sendInput(data);
			await flushMicrotasksAndTicks(2);
			flushFrame();
		},
		async pressKey(sequence: string): Promise<void> {
			await harness.sendInput(sequence);
		},
		async typeText(text: string): Promise<void> {
			for (const ch of text) {
				terminal.sendInput(ch);
			}
			await flushMicrotasksAndTicks(2);
			flushFrame();
		},
		async paste(text: string, bracketed = true): Promise<void> {
			const payload = bracketed ? `\x1b[200~${text}\x1b[201~` : text;
			await harness.sendInput(payload);
		},
		async submitInput(text: string): Promise<void> {
			await harness.paste(text, true);
			terminal.sendInput("\r");
			await waitForIdlePump();
			flushFrame();
		},
		async prompt(text: string): Promise<void> {
			await runtimeHost.session.prompt(text);
			await flushMicrotasksAndTicks(2);
			flushFrame();
		},
		async reload(): Promise<void> {
			await harness.submitInput("/reload");
		},
		async setTuiMode(nextMode: TuiMode): Promise<boolean> {
			const switched = internals.switchTuiMode(nextMode);
			if (switched) {
				settingsManager.setTuiMode(nextMode);
			}
			await flushMicrotasksAndTicks(2);
			flushFrame();
			return switched;
		},
		async mouseMove(col: number, row: number, modifiers?: MouseModifiers): Promise<void> {
			const modBits =
				(modifiers?.shift ? 4 : 0) |
				(modifiers?.alt ? 8 : 0) |
				(modifiers?.ctrl ? 16 : 0);
			await harness.sendInput(formatSgrMouse(35 | modBits, col, row, false));
		},
		async mouseDown(
			col: number,
			row: number,
			button: MouseButtonName = "left",
			modifiers?: MouseModifiers,
		): Promise<void> {
			await harness.sendInput(formatSgrMouse(encodeButtonCode(button, modifiers), col, row, false));
		},
		async mouseUp(
			col: number,
			row: number,
			button: MouseButtonName = "left",
			modifiers?: MouseModifiers,
		): Promise<void> {
			await harness.sendInput(formatSgrMouse(encodeButtonCode(button, modifiers), col, row, true));
		},
		async mouseClick(
			col: number,
			row: number,
			button: MouseButtonName = "left",
			modifiers?: MouseModifiers,
		): Promise<void> {
			const code = encodeButtonCode(button, modifiers);
			terminal.sendInput(formatSgrMouse(code, col, row, false));
			terminal.sendInput(formatSgrMouse(code, col, row, true));
			await flushMicrotasksAndTicks(2);
			flushFrame();
		},
		async mouseDrag(
			fromCol: number,
			fromRow: number,
			toCol: number,
			toRow: number,
			dragOptions?: { steps?: number; button?: MouseButtonName; modifiers?: MouseModifiers },
		): Promise<void> {
			const code = encodeButtonCode(dragOptions?.button ?? "left", dragOptions?.modifiers);
			const dragCode = code | 32;
			const steps = Math.max(1, dragOptions?.steps ?? 2);
			terminal.sendInput(formatSgrMouse(code, fromCol, fromRow, false));
			for (let s = 1; s <= steps; s += 1) {
				const interpCol = Math.round(fromCol + ((toCol - fromCol) * s) / steps);
				const interpRow = Math.round(fromRow + ((toRow - fromRow) * s) / steps);
				terminal.sendInput(formatSgrMouse(dragCode, interpCol, interpRow, false));
			}
			terminal.sendInput(formatSgrMouse(code, toCol, toRow, true));
			await flushMicrotasksAndTicks(2);
			flushFrame();
		},
		async mouseWheel(
			direction: "up" | "down",
			col: number,
			row: number,
			count = 1,
			modifiers?: MouseModifiers,
		): Promise<void> {
			const modBits =
				(modifiers?.shift ? 4 : 0) |
				(modifiers?.alt ? 8 : 0) |
				(modifiers?.ctrl ? 16 : 0);
			const wheelBase = direction === "up" ? 64 : 65;
			for (let i = 0; i < Math.max(1, count); i += 1) {
				terminal.sendInput(formatSgrMouse(wheelBase | modBits, col, row, false));
			}
			await flushMicrotasksAndTicks(2);
			flushFrame();
		},
		async resize(columns: number, rows: number): Promise<void> {
			terminal.resize(columns, rows);
			await flushMicrotasksAndTicks(2);
			flushFrame();
		},
		flushFrame,
		renderFrame(width = terminal.columns, height = terminal.rows): string[] {
			if (width !== terminal.columns || height !== terminal.rows) {
				terminal.resize(width, height);
			}
			flushFrame();
			const tui = internals.ui as TUI & {
				mode?: string;
				getScreenLines?: () => string[];
			};
			if (tui.mode !== "regular" && typeof tui.getScreenLines === "function") {
				return [...tui.getScreenLines()];
			}
			const rawRenderer = internals.renderer as unknown as { previousLines?: string[] };
			const prev = Array.isArray(rawRenderer.previousLines) ? rawRenderer.previousLines : [];
			return prev.slice(-height);
		},
		screen(width?: number, height?: number): TerminalScreenSnapshot {
			return captureTerminalScreen(harness, width, height);
		},
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;

			stopped = true;
			cancelInputWait?.();
			cancelTurnWait?.();
			for (const waiter of [...pumpIdleWaiters]) {
				pumpIdleWaiters.delete(waiter);
				waiter();
			}
			await pumpLoop;

			internals.themeController?.dispose?.();
			mode.stop("resume-hint");
			await runtimeHost.dispose();

			unregisterApiProviders(compatSourceId);
			setHostClipboardProvider(undefined);

			if (prevAgentDirEnv === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = prevAgentDirEnv;
			}

			if (prevOfflineEnv === undefined) {
				delete process.env.PI_OFFLINE;
			} else {
				process.env.PI_OFFLINE = prevOfflineEnv;
			}

			if (ownsCwd) {
				rmSync(cwd, { recursive: true, force: true });
			}
			if (ownsAgentDir) {
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
	};

	return harness;
}
