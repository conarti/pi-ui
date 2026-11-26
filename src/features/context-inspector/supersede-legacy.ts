import {
	matchesExtensionSourcePath,
	registerSupersededExtensionPredicate,
} from "../../shared/extension-superseder.ts";
import { LEGACY_STAMP_ENTRY_TYPE, METRICS_ENTRY_TYPE } from "./telemetry.ts";

const CONARTI_METRICS_OWNED_MARKER = Symbol.for("conarti.pi-ui.metrics-renderer-owned.v1");

const LEGACY_RESPONSE_METRICS_PATH_RE =
	/(?:^|[/\\]|npm:)(?:pi-)?(?:response-metrics|pi-stamp)(?:$|[/\\]|\.[cm]?[jt]s$)/i;
const LEGACY_WORKING_STATUS_PATH_RE =
	/(?:^|[/\\]|npm:)(?:pi-)?embed-working-status(?:$|[/\\]|\.[cm]?[jt]s$)/i;

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
	if (
		matchesExtensionSourcePath(ext, LEGACY_RESPONSE_METRICS_PATH_RE) ||
		matchesExtensionSourcePath(ext, LEGACY_WORKING_STATUS_PATH_RE)
	) {
		return true;
	}

	const rec = ext as {
		entryRenderers?: Map<unknown, unknown>;
	};
	if (rec.entryRenderers instanceof Map) {
		const metricsRenderer = rec.entryRenderers.get(METRICS_ENTRY_TYPE);
		const stampRenderer = rec.entryRenderers.get(LEGACY_STAMP_ENTRY_TYPE);
		if (
			(metricsRenderer !== undefined && !isOwnedRenderer(metricsRenderer)) ||
			(stampRenderer !== undefined && !isOwnedRenderer(stampRenderer))
		) {
			return true;
		}
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
}
