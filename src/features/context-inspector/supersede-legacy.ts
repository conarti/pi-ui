import {
	matchesExtensionSourcePath,
	registerSupersededExtensionPredicate,
	registerSupersededWidgetPredicate,
} from "../../shared/extension-superseder.ts";
import { LEGACY_STAMP_ENTRY_TYPE, METRICS_ENTRY_TYPE } from "./telemetry.ts";

const CONARTI_METRICS_OWNED_MARKER = Symbol.for("conarti.pi-ui.metrics-renderer-owned.v1");

const LEGACY_RESPONSE_METRICS_PATH_RE =
	/(?:^|[/\\])(?:pi-)?(?:response-metrics|pi-stamp)\.[cm]?[jt]s$/i;
const LEGACY_WORKING_STATUS_PATH_RE =
	/(?:^|[/\\])(?:pi-)?embed-working-status\.[cm]?[jt]s$/i;
const LEGACY_METRICS_RENDERERS = new Set([METRICS_ENTRY_TYPE, LEGACY_STAMP_ENTRY_TYPE, "pi-stamp:turn-metrics"]);
const LEGACY_METRICS_COMMANDS = new Set(["metrics", "stats"]);
const LEGACY_METRICS_EVENTS = new Set([
	"session_start", "session_shutdown", "turn_start", "turn_end",
	"message_start", "message_update", "message_end", "agent_end",
]);

export function markOwnedEntryRenderer<T extends (...args: never[]) => unknown>(fn: T): T {
	(fn as unknown as Record<symbol, boolean>)[CONARTI_METRICS_OWNED_MARKER] = true;
	return fn;
}

function isOwnedRenderer(fn: unknown): boolean {
	return (
		typeof fn === "function" &&
		(fn as unknown as Record<symbol, unknown>)[CONARTI_METRICS_OWNED_MARKER] === true
	);
}

export function isSupersededLegacyTelemetryExtension(ext: unknown): boolean {
	if (!ext || typeof ext !== "object") return false;
	const rec = ext as {
		entryRenderers?: Map<string, unknown>;
		commands?: Map<string, unknown>;
		handlers?: Map<string, unknown[]>;
		shortcuts?: Map<string, unknown>;
		tools?: Map<string, unknown>;
		messageRenderers?: Map<string, unknown>;
		toolRenderers?: unknown[];
	};
	/* Совпадение ключа рендера не доказывает происхождение скрипта; плагины с другими возможностями не отключаем целиком. */
	if (rec.shortcuts?.size || rec.tools?.size || rec.messageRenderers?.size || rec.toolRenderers?.length) return false;
	if (matchesExtensionSourcePath(ext, LEGACY_RESPONSE_METRICS_PATH_RE)) {
		const entries = [...(rec.entryRenderers ?? [])];
		const commands = [...(rec.commands?.keys() ?? [])];
		return entries.length > 0 && commands.length > 0 &&
			entries.every(([key, render]) => LEGACY_METRICS_RENDERERS.has(key) && !isOwnedRenderer(render)) &&
			commands.every((key) => LEGACY_METRICS_COMMANDS.has(key)) &&
			[...(rec.handlers?.keys() ?? [])].every((key) => LEGACY_METRICS_EVENTS.has(key));
	}
	return false;
}

/**
 * Тихо нейтрализует внешние standalone-скрипты `response-metrics` (`pi-stamp`)
 * и `embed-working-status`, не затрагивая встроенные рендереры `@conarti/pi-ui`.
 */
export function installLegacyMetricsAndWorkingSuperseder(): void {
	registerSupersededExtensionPredicate(
		"contextInspector.legacyTelemetry",
		isSupersededLegacyTelemetryExtension,
	);
	/* Имя файла само по себе не подтверждает, что обработчик рисует старый статус. */
	registerSupersededWidgetPredicate("contextInspector.legacyWorkingStatus", (ext, key) =>
		key === "embed-working-status" && matchesExtensionSourcePath(ext, LEGACY_WORKING_STATUS_PATH_RE),
	);
}
