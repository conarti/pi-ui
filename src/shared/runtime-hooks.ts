import { spawn } from "node:child_process";

export type MethodBehavior = (self: any, args: any[], original: (...args: any[]) => any) => any;
export type LegacyHookMarker = string | symbol;

interface HookRecord {
	behavior: MethodBehavior;
}

function isHookRecord(value: unknown): value is HookRecord {
	return typeof value === "object" && value !== null && typeof (value as HookRecord).behavior === "function";
}

/**
 * Reload-safe prototype method hook: wraps `target[method]` once per process
 * and hot-swaps `behavior` across `/reload` calls without stacking wrappers.
 * Migrates both legacy HookRecord slots (e.g. `pi.grok-ui.hook.*`, `pi-compact-tools.hook.*`)
 * and legacy unwrapped-original function symbols when reloading inside a live Pi process.
 */
export function hookMethod(
	target: object,
	method: string,
	name: string,
	behavior: MethodBehavior,
	legacyMarkers: readonly LegacyHookMarker[] = [],
): boolean {
	const holder = target as Record<PropertyKey, any>;
	const key = Symbol.for(`conarti.pi-ui.hook.${name}`);

	if (Object.hasOwn(holder, key) && isHookRecord(holder[key])) {
		holder[key].behavior = behavior;
		return true;
	}

	let original: ((...args: any[]) => any) | undefined;
	const markers: LegacyHookMarker[] = [Symbol.for(`pi-compact-tools.hook.${name}`), ...legacyMarkers];
	for (const marker of markers) {
		const markerKey = typeof marker === "symbol" ? marker : Symbol.for(marker);
		if (!Object.hasOwn(holder, markerKey)) continue;
		const existing = holder[markerKey];
		if (isHookRecord(existing)) {
			existing.behavior = behavior;
			Object.defineProperty(holder, key, { value: existing });
			return true;
		}
		if (typeof existing === "function" && !original) {
			original = existing as (...args: any[]) => any;
		}
	}

	if (!original) {
		if (typeof holder[method] !== "function") {
			const record: HookRecord = { behavior };
			holder[method] = function (this: unknown, ...args: any[]) {
				return record.behavior(this, args, () => undefined);
			};
			Object.defineProperty(holder, key, { value: record });
			return true;
		}
		original = holder[method];
	}

	const unwrapped = original!;
	const record: HookRecord = { behavior };
	holder[method] = function (this: unknown, ...args: any[]) {
		return record.behavior(this, args, unwrapped);
	};
	Object.defineProperty(holder, key, { value: record });
	return true;
}

export function copyToClipboard(text: string): void {
	if (!text) return;
	if (process.platform === "darwin") {
		try {
			const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", () => {});
			child.stdin?.end(text, "utf8");
		} catch {
			// Fall back to OSC 52
		}
	}
	try {
		const b64 = Buffer.from(text, "utf8").toString("base64");
		if (b64.length <= 100_000) {
			process.stdout.write(`\x1b]52;c;${b64}\x07`);
		}
	} catch {
		// Best-effort
	}
}

interface HoverTracker {
	owner: unknown;
	clear?: () => void;
	claimedThisMove?: boolean;
}

const HOVER_KEY = Symbol.for("conarti.pi-ui.hover-tracker.v1");

function getHoverTracker(): HoverTracker {
	const g = globalThis as Record<symbol, HoverTracker | undefined>;
	if (!g[HOVER_KEY]) {
		g[HOVER_KEY] = { owner: null };
	}
	return g[HOVER_KEY]!;
}

export function claimHover(owner: unknown, onClear: () => void): void {
	const tracker = getHoverTracker();
	tracker.claimedThisMove = true;
	if (tracker.owner && tracker.owner !== owner) {
		tracker.clear?.();
	}
	tracker.owner = owner;
	tracker.clear = onClear;
}

export function clearHoverExcept(owner?: unknown): boolean {
	const tracker = getHoverTracker();
	if (!tracker.owner || tracker.owner === owner) return false;
	const clearFn = tracker.clear;
	tracker.owner = null;
	tracker.clear = undefined;
	clearFn?.();
	return true;
}

export function beginHoverMovePass(): void {
	getHoverTracker().claimedThisMove = false;
}

export function finishHoverMovePass(): boolean {
	const tracker = getHoverTracker();
	if (!tracker.claimedThisMove && tracker.owner) {
		return clearHoverExcept(undefined);
	}
	return false;
}
