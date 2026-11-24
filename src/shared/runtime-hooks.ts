import { spawn } from "node:child_process";

export type MethodBehavior = (self: any, args: any[], original: (...args: any[]) => any) => any;

interface HookRecord {
	behavior: MethodBehavior;
}

/**
 * Reload-safe prototype method hook: wraps `target[method]` once per process
 * and hot-swaps `behavior` across `/reload` calls without stacking wrappers.
 * Also migrates over earlier `pi.grok-ui.hook.*` keys if present in a live session.
 */
export function hookMethod(
	target: object,
	method: string,
	name: string,
	behavior: MethodBehavior,
	legacyNames: readonly string[] = [],
): boolean {
	const holder = target as Record<PropertyKey, any>;
	const key = Symbol.for(`conarti.pi-ui.hook.${name}`);

	if (Object.hasOwn(holder, key)) {
		(holder[key] as HookRecord).behavior = behavior;
		return true;
	}

	// Reuse legacy grok-ui hook slot if reloading inside an already-running Pi process
	for (const leg of legacyNames) {
		const legKey = Symbol.for(leg);
		if (Object.hasOwn(holder, legKey) && holder[legKey] && typeof holder[legKey] === "object") {
			const record = holder[legKey] as HookRecord;
			record.behavior = behavior;
			Object.defineProperty(holder, key, { value: record });
			return true;
		}
	}

	if (typeof holder[method] !== "function") {
		const record: HookRecord = { behavior };
		holder[method] = function (this: unknown, ...args: any[]) {
			return record.behavior(this, args, () => undefined);
		};
		Object.defineProperty(holder, key, { value: record });
		return true;
	}

	const original: (...args: any[]) => any = holder[method];
	const record: HookRecord = { behavior };
	holder[method] = function (this: unknown, ...args: any[]) {
		return record.behavior(this, args, original);
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
