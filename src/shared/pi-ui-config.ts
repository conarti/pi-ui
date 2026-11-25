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

export interface PiUiUserConfig {
	readonly promptSuggestions: boolean;
}

export const DEFAULT_PI_UI_USER_CONFIG: PiUiUserConfig = {
	promptSuggestions: true,
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Вычисляет путь к пользовательскому конфигу `pi-ui.json` динамически через `getAgentDir()`,
 * чтобы переопределение `PI_CODING_AGENT_DIR` в тестах и при перезапусках применялось без кеширования.
 */
export function getPiUiConfigPath(): string {
	return join(getAgentDir(), PI_UI_CONFIG_FILE);
}

export function parsePiUiUserConfig(raw: unknown): PiUiUserConfig {
	if (!isJsonObject(raw)) {
		return { ...DEFAULT_PI_UI_USER_CONFIG };
	}
	return {
		promptSuggestions:
			typeof raw.promptSuggestions === "boolean"
				? raw.promptSuggestions
				: DEFAULT_PI_UI_USER_CONFIG.promptSuggestions,
	};
}

export function loadPiUiUserConfig(): PiUiUserConfig {
	const path = getPiUiConfigPath();
	if (!existsSync(path)) {
		return { ...DEFAULT_PI_UI_USER_CONFIG };
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsePiUiUserConfig(parsed);
	} catch {
		return { ...DEFAULT_PI_UI_USER_CONFIG };
	}
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

	const payload: Record<string, unknown> = {
		...existing,
		...(patch.promptSuggestions !== undefined
			? { promptSuggestions: Boolean(patch.promptSuggestions) }
			: {}),
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
