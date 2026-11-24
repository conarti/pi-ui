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
	DISPLAY_STYLES,
	TOOL_DENSITIES,
	type CompactToolsConfig,
	type DisplayStyle,
	type ToolDensity,
} from "./types.ts";
import { loadConfig } from "./config.ts";

type Scope = "global" | "project";
const SCOPES: readonly Scope[] = ["global", "project"];

const DENSITY_HELP =
	"Usage: /density [detailed|diff-focus|compact] [global|project]\n/density status · /density help\nSwitches Tool Density live without reload. Ctrl+O or click expands rows; /silent toggles quiet mode.";

const COMPACT_HELP =
	"Usage: /compact-tools [detailed|diff-focus|compact|claude|codex|off] [global|project]\nWithout a scope the preset applies live (and updates active settings when configured).\n/compact-tools status · /compact-tools help\nCtrl+O expands rows; /silent toggles quiet mode.";

const BUSY = "Wait for the current response to finish before changing tool styles.";

const DENSITY_CHOICES: Record<ToolDensity, string> = {
	detailed: "Detailed - inline edit/write diffs + command 2 head + 3 tail previews (default)",
	"diff-focus": "Diff Focus - inline edit/write diffs, completed commands collapsed to 1 row",
	compact: "Compact - completed edit, command, and tool runs folded into summary rows",
};

const STYLE_CHOICES: Record<Exclude<DisplayStyle, "density">, string> = {
	detailed: DENSITY_CHOICES.detailed,
	"diff-focus": DENSITY_CHOICES["diff-focus"],
	compact: DENSITY_CHOICES.compact,
	claude: "Claude - legacy grouped exploration rows",
	codex: "Codex - legacy explored groups and output tails",
	off: "Off - restore Pi's native UI",
};

export interface SessionStyleOverride {
	style: DisplayStyle;
	density?: ToolDensity;
}

const SESSION_OVERRIDE_KEY = Symbol.for("conarti.pi-ui.tool-style-override.v1");

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
	if (override.style === "detailed" || override.style === "diff-focus" || override.style === "compact") {
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
	const payload: Record<string, unknown> =
		style === "detailed" || style === "diff-focus" || style === "compact"
			? { ...data, style, density: style }
			: style === "density"
				? { ...data, style: "density", density: "detailed" }
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
	return `${path} (${existsSync(path) ? "exists" : "not created"})`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatStatus(config: CompactToolsConfig, ctx: ExtensionContext): string {
	const activePreset = config.style === "density" ? config.density : config.style;
	return [
		`Density: ${config.density} · active style: ${activePreset} · mode: ${config.mode} · preview: ${config.previewLines} lines`,
		`Thinking styling: ${config.thinking} · working override: ${config.working}`,
		`Global: ${describePath(configPath(ctx.cwd, "global"))}`,
		`Project: ${describePath(configPath(ctx.cwd, "project"))} (${ctx.isProjectTrusted() ? "trusted; overrides global" : "untrusted; ignored"})`,
		"/density switches Detailed, Diff Focus, and Compact; /silent toggles quiet mode; Ctrl+O expands rows.",
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
		ctx.ui.notify("Project settings require a trusted project. No file was changed.", "warning");
		return;
	}

	const reloads = !applyStyle;
	if (reloads && !ctx.isIdle()) {
		ctx.ui.notify(BUSY, "warning");
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
			ctx.ui.notify(`Could not save ${path}: ${errorMessage(error)}. No settings were replaced.`, "error");
			return;
		}
		setSessionStyleOverride(undefined);
		const effectiveConfig = loadConfig(ctx.cwd, trusted);
		const effectiveLabel =
			effectiveConfig.style === "density" ? effectiveConfig.density : effectiveConfig.style;
		const requestedLabel = selection === "density" ? "detailed" : selection;
		const where = targetScope === "project" ? "this project" : "global settings";

		if (targetScope === "global" && effectiveLabel !== requestedLabel) {
			ctx.ui.notify(
				`Saved ${requestedLabel} to global settings, but this project keeps its own ${effectiveLabel} setting. Run /${commandName} ${requestedLabel} project to switch it here.`,
				"warning",
			);
			return;
		}
		if (!reloads && applyStyle!(ctx.cwd, trusted, ctx)) {
			ctx.ui.notify(`Switched to ${requestedLabel} (saved to ${where}).`, "info");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify(
				`Saved ${requestedLabel} to ${where}. It applies once the response finishes; run /reload then.`,
				"warning",
			);
			return;
		}
		if (typeof ctx.reload !== "function") {
			ctx.ui.notify(`Saved ${requestedLabel} to ${where}. Run /reload to apply it.`, "info");
			return;
		}
		const ui = ctx.ui;
		return Promise.resolve(ctx.reload()).catch((error) => {
			ui.notify(
				`Setting was saved, but reload failed: ${errorMessage(error)}. Run /reload to apply it.`,
				"error",
			);
		});
	}

	/* Без явного scope и без существующего файла настроек переключаем плотность только в памяти сессии. */
	if (selection === "detailed" || selection === "diff-focus" || selection === "compact") {
		setSessionStyleOverride({ style: "density", density: selection });
	} else if (selection === "density") {
		setSessionStyleOverride({ style: "density", density: "detailed" });
	} else {
		setSessionStyleOverride({ style: selection });
	}

	const label = selection === "density" ? "detailed" : selection;
	if (!reloads && applyStyle!(ctx.cwd, trusted, ctx)) {
		ctx.ui.notify(`Switched to ${label}.`, "info");
	}
}

export function registerDensityCommand(
	pi: ExtensionAPI,
	getConfig: () => CompactToolsConfig,
	applyStyle?: ApplyStyle,
): void {
	pi.registerCommand("density", {
		description: "Switch Tool Density live (detailed, diff-focus, compact)",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const parts = typed.split(/\s+/);
			const scoped = parts.length === 2 && TOOL_DENSITIES.includes(parts[0] as ToolDensity);
			const values = scoped
				? SCOPES.map((scope) => `${parts[0]} ${scope}`)
				: [...TOOL_DENSITIES, "status", "help"];
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
				ctx.ui.notify(DENSITY_HELP, "info");
				return;
			}
			if (parts.length === 1 && parts[0] === "status") {
				ctx.ui.notify(formatStatus(getConfig(), ctx), "info");
				return;
			}
			if (
				parts.length > 2 ||
				(parts.length > 0 && !TOOL_DENSITIES.includes(parts[0] as ToolDensity)) ||
				(parts[1] !== undefined && !SCOPES.includes(parts[1] as Scope))
			) {
				ctx.ui.notify(DENSITY_HELP, "warning");
				return;
			}

			let preset = parts[0] as ToolDensity | undefined;
			const explicitScope = parts[1] as Scope | undefined;
			if (!preset) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(DENSITY_HELP, "info");
					return;
				}
				const current = getConfig();
				const selected = await ctx.ui.select(
					`Tool Density (current: ${current.density})`,
					Object.values(DENSITY_CHOICES),
				);
				preset = TOOL_DENSITIES.find((value) => DENSITY_CHOICES[value] === selected);
				if (!preset) return;
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
	const selectableStyles = Object.keys(STYLE_CHOICES) as Array<Exclude<DisplayStyle, "density">>;
	pi.registerCommand("compact-tools", {
		description: "Choose Tool Density preset or legacy/native tool rendering",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const parts = typed.split(/\s+/);
			const scoped = parts.length === 2 && DISPLAY_STYLES.includes(parts[0] as DisplayStyle);
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
				(parts.length > 0 && !DISPLAY_STYLES.includes(parts[0] as DisplayStyle)) ||
				(parts[1] !== undefined && !SCOPES.includes(parts[1] as Scope))
			) {
				ctx.ui.notify(COMPACT_HELP, "warning");
				return;
			}

			let style = parts[0] as DisplayStyle | undefined;
			let explicitScope = parts[1] as Scope | undefined;
			if (!style) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(COMPACT_HELP, "info");
					return;
				}
				const current = getConfig();
				const activeLabel = current.style === "density" ? current.density : current.style;
				const selected = await ctx.ui.select(
					`Tool density / style (current: ${activeLabel})`,
					Object.values(STYLE_CHOICES),
				);
				style = selectableStyles.find((value) => STYLE_CHOICES[value] === selected);
				if (!style) return;
				const projectDecides = projectSetsStyle(ctx.cwd, ctx.isProjectTrusted());
				const scopes = projectDecides
					? [
							"Project - this trusted project only",
							"Global - all projects (this project keeps its own setting)",
						]
					: [
							"Global - all projects",
							...(ctx.isProjectTrusted() ? ["Project - this trusted project only"] : []),
						];
				const selectedScope = await ctx.ui.select("Save setting where?", scopes);
				if (!selectedScope) return;
				explicitScope = selectedScope.startsWith("Project") ? "project" : "global";
			}

			await applySelection(style, explicitScope, ctx, applyStyle, "compact-tools");
		},
	});
}
