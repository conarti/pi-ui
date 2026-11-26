import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveConfigWritePath, writeConfigJsonAtomically } from "./atomic-config-file.ts";

const PI_UI_CONFIG_FILE = "pi-ui.json";
const LEGACY_TOOL_DISPLAY_FILE = "tool-display.json";

export const TOOL_DENSITY_PRESETS = [
	"balanced",
	"compact",
	"grouped",
	"diff-focus",
	"detailed",
] as const;
export type ToolDensityPreset = (typeof TOOL_DENSITY_PRESETS)[number];

export const TIMESTAMP_DISPLAY_MODES = ["datetime", "time", "off"] as const;
export type TimestampDisplayMode = (typeof TIMESTAMP_DISPLAY_MODES)[number];

export const MID_TURN_ENTER_BEHAVIORS = ["queue", "steer"] as const;
export type MidTurnEnterBehavior = (typeof MID_TURN_ENTER_BEHAVIORS)[number];

export const CANONICAL_SESSION_MODES = ["always-approve", "plan", "auto"] as const;
export type CanonicalSessionMode = (typeof CANONICAL_SESSION_MODES)[number];

export interface PiUiUserConfig {
	readonly toolDensity: ToolDensityPreset;
	readonly responseMetrics: boolean;
	readonly timestamps: TimestampDisplayMode;
	readonly outlineTimestamps: boolean;
	readonly copyOnSelect: boolean;
	readonly showShortcutsBar: boolean;
	readonly midTurnEnter: MidTurnEnterBehavior;
	readonly promptSuggestions: boolean;
	readonly aiWorkingStatus: boolean;
	readonly slotOwners: Readonly<Record<string, string>>;
}

export const DEFAULT_PI_UI_USER_CONFIG: PiUiUserConfig = {
	toolDensity: "balanced",
	responseMetrics: true,
	timestamps: "datetime",
	outlineTimestamps: true,
	copyOnSelect: false,
	showShortcutsBar: true,
	midTurnEnter: "queue",
	promptSuggestions: false,
	aiWorkingStatus: false,
	slotOwners: {},
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChoice<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
	return typeof value === "string" && (choices as readonly string[]).includes(value)
		? (value as T)
		: undefined;
}

function parseLegacyToolDensityPreset(value: unknown): ToolDensityPreset | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "diff_focus" || normalized === "difffocus") return "diff-focus";
	if (normalized === "claude" || normalized === "codex") return "grouped";
	return parseChoice(normalized, TOOL_DENSITY_PRESETS);
}

function parseSlotOwners(value: unknown): Record<string, string> {
	if (!isJsonObject(value)) return {};
	const out: Record<string, string> = {};
	for (const [slot, owner] of Object.entries(value)) {
		const trimmedSlot = slot.trim();
		if (trimmedSlot && typeof owner === "string" && owner.trim().length > 0) {
			out[trimmedSlot] = owner.trim();
		}
	}
	return out;
}

/**
 * Вычисляет путь к пользовательскому конфигу `pi-ui.json` динамически через `getAgentDir()`,
 * чтобы переопределение `PI_CODING_AGENT_DIR` в тестах и при перезапусках применялось без кеширования.
 */
export function getPiUiConfigPath(): string {
	return join(getAgentDir(), PI_UI_CONFIG_FILE);
}

/**
 * Возвращает путь к устаревшему конфигу `tool-display.json` для однократной прозрачной миграции.
 */
export function getLegacyToolDisplayConfigPath(): string {
	return join(getAgentDir(), LEGACY_TOOL_DISPLAY_FILE);
}

export function parsePiUiUserConfig(raw: unknown): PiUiUserConfig {
	if (!isJsonObject(raw)) {
		return { ...DEFAULT_PI_UI_USER_CONFIG, slotOwners: {} };
	}
	return {
		toolDensity:
			parseChoice(raw.toolDensity, TOOL_DENSITY_PRESETS) ??
			DEFAULT_PI_UI_USER_CONFIG.toolDensity,
		responseMetrics:
			typeof raw.responseMetrics === "boolean"
				? raw.responseMetrics
				: DEFAULT_PI_UI_USER_CONFIG.responseMetrics,
		timestamps:
			parseChoice(raw.timestamps, TIMESTAMP_DISPLAY_MODES) ??
			DEFAULT_PI_UI_USER_CONFIG.timestamps,
		outlineTimestamps:
			typeof raw.outlineTimestamps === "boolean"
				? raw.outlineTimestamps
				: DEFAULT_PI_UI_USER_CONFIG.outlineTimestamps,
		copyOnSelect:
			typeof raw.copyOnSelect === "boolean"
				? raw.copyOnSelect
				: DEFAULT_PI_UI_USER_CONFIG.copyOnSelect,
		showShortcutsBar:
			typeof raw.showShortcutsBar === "boolean"
				? raw.showShortcutsBar
				: DEFAULT_PI_UI_USER_CONFIG.showShortcutsBar,
		midTurnEnter:
			parseChoice(raw.midTurnEnter, MID_TURN_ENTER_BEHAVIORS) ??
			DEFAULT_PI_UI_USER_CONFIG.midTurnEnter,
		promptSuggestions:
			typeof raw.promptSuggestions === "boolean"
				? raw.promptSuggestions
				: DEFAULT_PI_UI_USER_CONFIG.promptSuggestions,
		aiWorkingStatus:
			typeof raw.aiWorkingStatus === "boolean"
				? raw.aiWorkingStatus
				: DEFAULT_PI_UI_USER_CONFIG.aiWorkingStatus,
		slotOwners: parseSlotOwners(raw.slotOwners),
	};
}

interface FileStatSnapshot {
	readonly exists: boolean;
	readonly ino: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
}

const MISSING_STAT: FileStatSnapshot = {
	exists: false,
	ino: 0n,
	size: 0n,
	mtimeNs: 0n,
};

/* Окно 50 мс защищает от грубого шага mtime (4 мс на tmpfs/ext4 в CI) при синхронной перезаписи в тестах */
const COARSE_MTIME_GUARD_NS = 50_000_000n;

let cachedConfigPath = "";
let cachedLegacyPath = "";
let cachedPrimaryStat: FileStatSnapshot = MISSING_STAT;
let cachedLegacyStat: FileStatSnapshot = MISSING_STAT;
let cachedHasExplicitToolDensity = false;
let cachedConfig: PiUiUserConfig | undefined;
let configVersion = 1;
let renderPassDepth = 0;
let renderPassId = 0;
let renderPassValidated = false;

function readStatSnapshot(filePath: string): FileStatSnapshot {
	try {
		const st = statSync(filePath, { bigint: true });
		return {
			exists: true,
			ino: st.ino,
			size: st.size,
			mtimeNs: st.mtimeNs,
		};
	} catch {
		return MISSING_STAT;
	}
}

function isStatFreshAndUnchanged(prev: FileStatSnapshot, next: FileStatSnapshot, nowNs: bigint): boolean {
	if (!prev.exists && !next.exists) return true;
	if (prev.exists !== next.exists) return false;
	if (prev.ino !== next.ino || prev.size !== next.size || prev.mtimeNs !== next.mtimeNs) {
		return false;
	}
	return nowNs - next.mtimeNs > COARSE_MTIME_GUARD_NS;
}

function areSlotOwnersEqual(
	a: Readonly<Record<string, string>>,
	b: Readonly<Record<string, string>>,
): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}

function arePiUiConfigsEqual(a: PiUiUserConfig | undefined, b: PiUiUserConfig): boolean {
	if (!a) return false;
	return (
		a.toolDensity === b.toolDensity &&
		a.responseMetrics === b.responseMetrics &&
		a.timestamps === b.timestamps &&
		a.outlineTimestamps === b.outlineTimestamps &&
		a.copyOnSelect === b.copyOnSelect &&
		a.showShortcutsBar === b.showShortcutsBar &&
		a.midTurnEnter === b.midTurnEnter &&
		a.promptSuggestions === b.promptSuggestions &&
		a.aiWorkingStatus === b.aiWorkingStatus &&
		areSlotOwnersEqual(a.slotOwners, b.slotOwners)
	);
}

function commitCachedConfig(
	path: string,
	legacyPath: string,
	primaryStat: FileStatSnapshot,
	legacyStat: FileStatSnapshot,
	hasExplicitToolDensity: boolean,
	nextConfig: PiUiUserConfig,
): PiUiUserConfig {
	if (!arePiUiConfigsEqual(cachedConfig, nextConfig)) {
		configVersion += 1;
	}
	cachedConfigPath = path;
	cachedLegacyPath = legacyPath;
	cachedPrimaryStat = primaryStat;
	cachedLegacyStat = legacyStat;
	cachedHasExplicitToolDensity = hasExplicitToolDensity;
	cachedConfig = nextConfig;
	if (renderPassDepth > 0) {
		renderPassValidated = true;
	}
	return nextConfig;
}

/**
 * Оборачивает синхронный проход рендера кадра TUI, чтобы сотни вызовов `loadPiUiUserConfig()`
 * и `getPiUiConfigVersion()` внутри одного кадра проверяли `statSync` не более одного раза.
 */
export function withPiUiConfigRenderPass<T>(fn: () => T): T {
	if (renderPassDepth === 0) {
		renderPassId += 1;
		renderPassValidated = false;
	}
	renderPassDepth += 1;
	try {
		return fn();
	} finally {
		renderPassDepth -= 1;
		if (renderPassDepth === 0) {
			renderPassValidated = false;
		}
	}
}

export function getPiUiRenderPassId(): number {
	return renderPassId;
}

export function getPiUiConfigVersion(): number {
	loadPiUiUserConfig();
	return configVersion;
}

function readLegacyToolDensity(legacyPath: string): ToolDensityPreset | undefined {
	if (!existsSync(legacyPath)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
		if (!isJsonObject(parsed)) return undefined;
		return (
			parseLegacyToolDensityPreset(parsed.toolDensity) ??
			parseLegacyToolDensityPreset(parsed.density) ??
			parseLegacyToolDensityPreset(parsed.style)
		);
	} catch {
		return undefined;
	}
}

export function loadPiUiUserConfig(): PiUiUserConfig {
	const path = getPiUiConfigPath();
	if (renderPassDepth > 0 && renderPassValidated && cachedConfig && cachedConfigPath === path) {
		return cachedConfig;
	}

	const legacyPath = getLegacyToolDisplayConfigPath();
	const primaryStat = readStatSnapshot(path);
	const nowNs = BigInt(Date.now()) * 1_000_000n;

	if (
		cachedConfig &&
		cachedConfigPath === path &&
		cachedLegacyPath === legacyPath &&
		isStatFreshAndUnchanged(cachedPrimaryStat, primaryStat, nowNs)
	) {
		const legacyUnchanged =
			cachedHasExplicitToolDensity ||
			isStatFreshAndUnchanged(cachedLegacyStat, readStatSnapshot(legacyPath), nowNs);
		if (legacyUnchanged) {
			if (renderPassDepth > 0) {
				renderPassValidated = true;
			}
			return cachedConfig;
		}
	}

	let rawObject: Record<string, unknown> | undefined;
	let parsedValidJson = false;

	if (primaryStat.exists) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isJsonObject(parsed)) {
				rawObject = parsed;
				parsedValidJson = true;
			}
		} catch {
			const fallback = { ...DEFAULT_PI_UI_USER_CONFIG, slotOwners: {} };
			return commitCachedConfig(path, legacyPath, primaryStat, MISSING_STAT, false, fallback);
		}
	}

	/* Однократная прозрачная миграция tool-display.json, пока в pi-ui.json ещё нет toolDensity */
	const hasExplicitToolDensity =
		parsedValidJson && rawObject !== undefined && "toolDensity" in rawObject;
	const legacyStat = hasExplicitToolDensity ? MISSING_STAT : readStatSnapshot(legacyPath);
	if (!hasExplicitToolDensity && legacyStat.exists) {
		const migratedDensity = readLegacyToolDensity(legacyPath);
		if (migratedDensity) {
			try {
				return updatePiUiUserConfig({ toolDensity: migratedDensity });
			} catch {
				const migrated = parsePiUiUserConfig({ ...(rawObject ?? {}), toolDensity: migratedDensity });
				return commitCachedConfig(path, legacyPath, primaryStat, legacyStat, false, migrated);
			}
		}
	}

	const resolved = parsePiUiUserConfig(rawObject);
	return commitCachedConfig(
		path,
		legacyPath,
		primaryStat,
		legacyStat,
		hasExplicitToolDensity,
		resolved,
	);
}

export function loadExplicitToolDensity(): ToolDensityPreset | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(getPiUiConfigPath(), "utf8"));
		return isJsonObject(raw) ? parseChoice(raw.toolDensity, TOOL_DENSITY_PRESETS) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Атомарно обновляет поля `pi-ui.json`, сохраняя симлинки дотфайлов, права доступа
 * и соседние ключи будущей `Settings Modal`.
 */
export function updatePiUiUserConfig(patch: Partial<PiUiUserConfig>): PiUiUserConfig {
	const targetPath = resolveConfigWritePath(getPiUiConfigPath());

	let existing: Record<string, unknown> = {};
	let mode = 0o600;
	try {
		const rawText = readFileSync(targetPath, "utf8");
		mode = statSync(targetPath).mode & 0o777;
		const parsed: unknown = JSON.parse(rawText);
		if (isJsonObject(parsed)) {
			existing = parsed;
		}
	} catch (error) {
		if (
			error instanceof SyntaxError ||
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			/* Повреждённый или отсутствующий файл безопасно пересоздаётся с валидным объектом */
		} else {
			throw error;
		}
	}

	const nextPatch: Record<string, unknown> = {};
	if (patch.toolDensity !== undefined) {
		const valid = parseChoice(patch.toolDensity, TOOL_DENSITY_PRESETS);
		if (valid) nextPatch.toolDensity = valid;
	}
	if (patch.responseMetrics !== undefined) {
		nextPatch.responseMetrics = Boolean(patch.responseMetrics);
	}
	if (patch.timestamps !== undefined) {
		const valid = parseChoice(patch.timestamps, TIMESTAMP_DISPLAY_MODES);
		if (valid) nextPatch.timestamps = valid;
	}
	if (patch.outlineTimestamps !== undefined) {
		nextPatch.outlineTimestamps = Boolean(patch.outlineTimestamps);
	}
	if (patch.copyOnSelect !== undefined) {
		nextPatch.copyOnSelect = Boolean(patch.copyOnSelect);
	}
	if (patch.showShortcutsBar !== undefined) {
		nextPatch.showShortcutsBar = Boolean(patch.showShortcutsBar);
	}
	if (patch.midTurnEnter !== undefined) {
		const valid = parseChoice(patch.midTurnEnter, MID_TURN_ENTER_BEHAVIORS);
		if (valid) nextPatch.midTurnEnter = valid;
	}
	if (patch.promptSuggestions !== undefined) {
		nextPatch.promptSuggestions = Boolean(patch.promptSuggestions);
	}
	if (patch.aiWorkingStatus !== undefined) {
		nextPatch.aiWorkingStatus = Boolean(patch.aiWorkingStatus);
	}
	if (patch.slotOwners !== undefined) {
		nextPatch.slotOwners = parseSlotOwners(patch.slotOwners);
	}

	const payload: Record<string, unknown> = {
		...existing,
		...nextPatch,
	};

	writeConfigJsonAtomically(targetPath, payload, mode);

	const configPath = getPiUiConfigPath();
	const legacyPath = getLegacyToolDisplayConfigPath();
	const nextConfig = parsePiUiUserConfig(payload);
	renderPassValidated = false;
	return commitCachedConfig(
		configPath,
		legacyPath,
		readStatSnapshot(configPath),
		MISSING_STAT,
		"toolDensity" in payload,
		nextConfig,
	);
}
