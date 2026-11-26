import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	TOOL_DENSITIES,
	type CompactToolsConfig,
	type DisplayStyle,
	type ToolDensity,
} from "./types.ts";
import {
	TOOL_DENSITY_PRESETS,
	updatePiUiUserConfig,
	type ToolDensityPreset,
} from "../../shared/pi-ui-config.ts";
import { t } from "../../shared/i18n.ts";
import { loadConfig } from "./config.ts";

type Scope = "global" | "project";
const SCOPES: readonly Scope[] = ["global", "project"];

const DENSITY_HELP = t("density.help");
const COMPACT_HELP = t("density.compatHelp");

const DENSITY_CHOICES: Record<ToolDensity, string> = {
	balanced: t("density.choice.balanced"),
	compact: t("density.choice.compact"),
	grouped: t("density.choice.grouped"),
	"diff-focus": t("density.choice.diff-focus"),
	detailed: t("density.choice.detailed"),
};

type SelectableStyle = ToolDensity | "off";
const STYLE_CHOICES: Record<SelectableStyle, string> = {
	balanced: DENSITY_CHOICES.balanced,
	compact: DENSITY_CHOICES.compact,
	grouped: DENSITY_CHOICES.grouped,
	"diff-focus": DENSITY_CHOICES["diff-focus"],
	detailed: DENSITY_CHOICES.detailed,
	off: t("density.choice.off"),
};

function isToolDensityValue(value: DisplayStyle): value is ToolDensity {
	return (TOOL_DENSITIES as readonly string[]).includes(value);
}

export interface SessionStyleOverride {
	style: DisplayStyle;
	density?: ToolDensity;
}

const SESSION_OVERRIDE_KEY = Symbol.for("conarti.pi-ui.tool-style-override.v1");
const LIVE_DENSITY_LISTENER_KEY = Symbol.for("conarti.pi-ui.live-density-listener.v1");

type LiveDensityListener = (preset: ToolDensity) => void;

export function setLiveToolDensityListener(listener: LiveDensityListener | undefined): void {
	(globalThis as Record<symbol, LiveDensityListener | undefined>)[LIVE_DENSITY_LISTENER_KEY] = listener;
}

/**
 * Применяет пресет `Tool Density` на лету (например, при переключении из Command Palette)
 * поверх активного `ToolRuntime` без перезагрузки сессии.
 */
export function notifyLiveToolDensityChange(preset: ToolDensity): void {
	const listener = (globalThis as Record<symbol, LiveDensityListener | undefined>)[LIVE_DENSITY_LISTENER_KEY];
	listener?.(preset);
}

export function getSessionStyleOverride(): SessionStyleOverride | undefined {
	return (globalThis as Record<symbol, SessionStyleOverride | undefined>)[SESSION_OVERRIDE_KEY];
}

export function setSessionStyleOverride(override: SessionStyleOverride | undefined): void {
	(globalThis as Record<symbol, SessionStyleOverride | undefined>)[SESSION_OVERRIDE_KEY] = override;
}

export function loadEffectiveConfig(cwd?: string, projectTrusted = false): CompactToolsConfig {
	const base = loadConfig(cwd, projectTrusted);
	const override = getSessionStyleOverride();
	if (!override) return base;
	if (isToolDensityValue(override.style)) {
		return { ...base, style: "density", density: override.style };
	}
	return {
		...base,
		style: override.style,
		...(override.density ? { density: override.density } : {}),
	};
}

export function configPath(cwd: string, scope: Scope): string {
	return scope === "global"
		? join(getAgentDir(), "compact-tools.json")
		: join(cwd, CONFIG_DIR_NAME, "compact-tools.json");
}

function fileDefinesStyleOrDensity(path: string): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return (
			!!parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			("style" in parsed || "density" in parsed)
		);
	} catch {
		return false;
	}
}

export function saveStyle(path: string, style: DisplayStyle): void {
	let linked = false;
	try {
		linked = lstatSync(path).isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (linked) path = realpathSync(path);
	let data: Record<string, unknown> = {};
	let mode = 0o600;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		data = parsed as Record<string, unknown>;
		mode = statSync(path).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(dirname(path), { recursive: true });
	const payload: Record<string, unknown> = isToolDensityValue(style)
		? { ...data, style, density: style }
		: style === "density"
			? { ...data, style: "density", density: "balanced" }
			: { ...data, style };
	const temporary = join(dirname(path), `.compact-tools-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		chmodSync(temporary, mode);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function projectSetsStyle(cwd: string, trusted: boolean): boolean {
	if (!trusted) return false;
	return fileDefinesStyleOrDensity(configPath(cwd, "project"));
}

function globalSetsStyle(cwd: string): boolean {
	return fileDefinesStyleOrDensity(configPath(cwd, "global"));
}

function describePath(path: string): string {
	return t(existsSync(path) ? "density.fileExists" : "density.fileMissing", { path });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatStatus(config: CompactToolsConfig, ctx: ExtensionContext): string {
	const activePreset = config.style === "density" ? config.density : config.style;
	return [
		t("density.status.main", { density: config.density, active: activePreset, mode: config.mode, lines: config.previewLines }),
		t("density.status.thinking", { thinking: String(config.thinking), working: String(config.working) }),
		t("density.status.global", { path: describePath(configPath(ctx.cwd, "global")) }),
		t(ctx.isProjectTrusted() ? "density.status.projectTrusted" : "density.status.projectUntrusted", {
			path: describePath(configPath(ctx.cwd, "project")),
		}),
		t("density.status.hint"),
	].join("\n");
}

export type ApplyStyle = (cwd: string, trusted: boolean, ctx: ExtensionContext) => boolean;

function applySelection(
	selection: DisplayStyle,
	explicitScope: Scope | undefined,
	ctx: ExtensionCommandContext,
	applyStyle: ApplyStyle | undefined,
	commandName: "density" | "compact-tools",
): Promise<void> | void {
	const trusted = ctx.isProjectTrusted();
	if (explicitScope === "project" && !trusted) {
		ctx.ui.notify(t("density.projectUntrusted"), "warning");
		return;
	}

	const reloads = !applyStyle;
	if (reloads && !ctx.isIdle()) {
		ctx.ui.notify(t("density.busy"), "warning");
		return;
	}

	const hasProjectFile = projectSetsStyle(ctx.cwd, trusted);
	const hasGlobalFile = globalSetsStyle(ctx.cwd);
	const targetScope: Scope | undefined =
		explicitScope ?? (hasProjectFile ? "project" : hasGlobalFile ? "global" : undefined);

	if (targetScope) {
		const path = configPath(ctx.cwd, targetScope);
		try {
			saveStyle(path, selection);
		} catch (error) {
			ctx.ui.notify(t("density.saveFailed", { path, error: errorMessage(error) }), "error");
			return;
		}
		setSessionStyleOverride(undefined);
		const effectiveConfig = loadConfig(ctx.cwd, trusted);
		const effectiveLabel =
			effectiveConfig.style === "density" ? effectiveConfig.density : effectiveConfig.style;
		const requestedLabel = selection === "density" ? "balanced" : selection;
		const where = t(targetScope === "project" ? "density.scope.project" : "density.scope.global");

		if (targetScope === "global" && effectiveLabel !== requestedLabel) {
			ctx.ui.notify(
				t("density.savedOverridden", { preset: requestedLabel, effective: effectiveLabel, command: commandName }),
				"warning",
			);
			return;
		}
		if (!reloads && applyStyle!(ctx.cwd, trusted, ctx)) {
			ctx.ui.notify(t("density.switchedAndSaved", { preset: requestedLabel, where }), "info");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify(
				t("density.savedPending", { preset: requestedLabel, where }),
				"warning",
			);
			return;
		}
		if (typeof ctx.reload !== "function") {
			ctx.ui.notify(t("density.savedReload", { preset: requestedLabel, where }), "info");
			return;
		}
		const ui = ctx.ui;
		return Promise.resolve(ctx.reload()).catch((error) => {
			ui.notify(
				t("density.reloadFailed", { error: errorMessage(error) }),
				"error",
			);
		});
	}

	/* Без явного scope и без существующего файла настроек переключаем плотность на лету в сессии. */
	if (isToolDensityValue(selection)) {
		setSessionStyleOverride({ style: "density", density: selection });
	} else if (selection === "density") {
		setSessionStyleOverride({ style: "density", density: "balanced" });
	} else {
		setSessionStyleOverride({ style: selection });
	}

	const label = selection === "density" ? "balanced" : selection;
	if (!reloads && applyStyle!(ctx.cwd, trusted, ctx)) {
		ctx.ui.notify(t("density.switched", { preset: label }), "info");
	}
}

export function registerDensityCommand(
	pi: ExtensionAPI,
	getConfig: () => CompactToolsConfig,
	applyStyle?: ApplyStyle,
): void {
	pi.registerCommand("density", {
		description: t("density.command"),
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const parts = typed.split(/\s+/);
			const scoped = parts.length === 2 && TOOL_DENSITY_PRESETS.some((preset) => preset === parts[0]);
			const values = scoped
				? SCOPES.map((scope) => `${parts[0]} ${scope}`)
				: [...TOOL_DENSITY_PRESETS, "status", "help"];
			const items = values
				.filter((value) => value.startsWith(typed) && value !== typed.trimEnd())
				.map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim() ? args.trim().toLowerCase().split(/\s+/) : [];
			const parsedPreset = TOOL_DENSITY_PRESETS.find((preset) => preset === parts[0]);

			if (parts.length === 1 && parts[0] === "help") {
				ctx.ui.notify(DENSITY_HELP, "info");
				return;
			}
			if (parts.length === 1 && parts[0] === "status") {
				ctx.ui.notify(formatStatus(getConfig(), ctx), "info");
				return;
			}
			if (
				parts.length > 2 ||
				(parts.length > 0 && !parsedPreset) ||
				(parts[1] !== undefined && !SCOPES.includes(parts[1] as Scope))
			) {
				ctx.ui.notify(DENSITY_HELP, "warning");
				return;
			}

			let preset: ToolDensityPreset | undefined = parsedPreset;
			const explicitScope = parts[1] as Scope | undefined;
			if (!preset) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(DENSITY_HELP, "info");
					return;
				}
				const current = getConfig();
				const selected = await ctx.ui.select(
					t("density.select", { preset: current.density }),
					Object.values(DENSITY_CHOICES),
				);
				preset = TOOL_DENSITIES.find((value) => DENSITY_CHOICES[value] === selected);
				if (!preset) return;
			}

			if (explicitScope !== "project") {
				updatePiUiUserConfig({ toolDensity: preset });
			}
			await applySelection(preset, explicitScope, ctx, applyStyle, "density");
		},
	});
}

export function registerCompactToolsCommand(
	pi: ExtensionAPI,
	getConfig: () => CompactToolsConfig,
	applyStyle?: ApplyStyle,
): void {
	const selectableStyles = Object.keys(STYLE_CHOICES) as SelectableStyle[];
	pi.registerCommand("compact-tools", {
		description: t("density.compatCommand"),
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const parts = typed.split(/\s+/);
			const scoped = parts.length === 2 && selectableStyles.includes(parts[0] as SelectableStyle);
			const values = scoped
				? SCOPES.map((scope) => `${parts[0]} ${scope}`)
				: [...selectableStyles, "status", "help"];
			const items = values
				.filter((value) => value.startsWith(typed) && value !== typed.trimEnd())
				.map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const rawParts = args.trim() ? args.trim().toLowerCase().split(/\s+/) : [];
			const normalizedFirst =
				rawParts[0] === "diff_focus" || rawParts[0] === "difffocus" ? "diff-focus" : rawParts[0];
			const parts = normalizedFirst !== undefined ? [normalizedFirst, ...rawParts.slice(1)] : [];

			if (parts.length === 1 && parts[0] === "help") {
				ctx.ui.notify(COMPACT_HELP, "info");
				return;
			}
			if (parts.length === 1 && parts[0] === "status") {
				ctx.ui.notify(formatStatus(getConfig(), ctx), "info");
				return;
			}
			if (
				parts.length > 2 ||
				(parts.length > 0 && !selectableStyles.includes(parts[0] as SelectableStyle)) ||
				(parts[1] !== undefined && !SCOPES.includes(parts[1] as Scope))
			) {
				ctx.ui.notify(COMPACT_HELP, "warning");
				return;
			}

			let style = parts[0] as SelectableStyle | undefined;
			let explicitScope = parts[1] as Scope | undefined;
			if (!style) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(COMPACT_HELP, "info");
					return;
				}
				const current = getConfig();
				const activeLabel = current.style === "density" ? current.density : current.style;
				const selected = await ctx.ui.select(
					t("density.selectStyle", { preset: activeLabel }),
					Object.values(STYLE_CHOICES),
				);
				style = selectableStyles.find((value) => STYLE_CHOICES[value] === selected);
				if (!style) return;
				const projectDecides = projectSetsStyle(ctx.cwd, ctx.isProjectTrusted());
				const project = t("density.scope.projectChoice");
				const global = t(projectDecides ? "density.scope.globalOverriddenChoice" : "density.scope.globalChoice");
				const scopes = projectDecides ? [project, global] : ctx.isProjectTrusted() ? [global, project] : [global];
				const selectedScope = await ctx.ui.select(t("density.selectScope"), scopes);
				if (!selectedScope) return;
				explicitScope = selectedScope === project ? "project" : "global";
			}

			await applySelection(style, explicitScope, ctx, applyStyle, "compact-tools");
		},
	});
}
