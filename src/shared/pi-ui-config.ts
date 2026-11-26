import { randomUUID } from "node:crypto";
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
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

export function parseToolDensityPreset(value: unknown): ToolDensityPreset | undefined {
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

function readLegacyToolDensity(legacyPath: string): ToolDensityPreset | undefined {
	if (!existsSync(legacyPath)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
		if (!isJsonObject(parsed)) return undefined;
		return (
			parseToolDensityPreset(parsed.toolDensity) ??
			parseToolDensityPreset(parsed.density) ??
			parseToolDensityPreset(parsed.style)
		);
	} catch {
		return undefined;
	}
}

export function loadPiUiUserConfig(): PiUiUserConfig {
	const path = getPiUiConfigPath();
	let rawObject: Record<string, unknown> | undefined;
	let parsedValidJson = false;

	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isJsonObject(parsed)) {
				rawObject = parsed;
				parsedValidJson = true;
			}
		} catch {
			return { ...DEFAULT_PI_UI_USER_CONFIG, slotOwners: {} };
		}
	}

	/* Однократная прозрачная миграция tool-display.json, пока в pi-ui.json ещё нет toolDensity */
	const hasExplicitToolDensity =
		parsedValidJson && rawObject !== undefined && "toolDensity" in rawObject;
	if (!hasExplicitToolDensity) {
		const migratedDensity = readLegacyToolDensity(getLegacyToolDisplayConfigPath());
		if (migratedDensity) {
			try {
				return updatePiUiUserConfig({ toolDensity: migratedDensity });
			} catch {
				return parsePiUiUserConfig({ ...(rawObject ?? {}), toolDensity: migratedDensity });
			}
		}
	}

	return parsePiUiUserConfig(rawObject);
}

/**
 * Атомарно обновляет поля `pi-ui.json`, сохраняя симлинки дотфайлов, права доступа
 * и соседние ключи будущей `Settings Modal`.
 */
export function updatePiUiUserConfig(patch: Partial<PiUiUserConfig>): PiUiUserConfig {
	let targetPath = getPiUiConfigPath();
	let linked = false;
	try {
		linked = lstatSync(targetPath).isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (linked) {
		try {
			targetPath = realpathSync(targetPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

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

	mkdirSync(dirname(targetPath), { recursive: true });
	const temporary = join(dirname(targetPath), `.pi-ui-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		chmodSync(temporary, mode);
		renameSync(temporary, targetPath);
	} finally {
		rmSync(temporary, { force: true });
	}

	return parsePiUiUserConfig(payload);
}
