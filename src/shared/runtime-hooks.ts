import { spawn } from "node:child_process";

export type MethodBehavior = (self: any, args: any[], original: (...args: any[]) => any) => any;
export type LegacyHookMarker = string | symbol;

interface HookRecord {
	behavior: MethodBehavior;
}

function isHookRecord(value: unknown): value is HookRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as HookRecord).behavior === "function"
	);
}

/**
 * Reload-safe prototype method hook: wraps `target[method]` once per process
 * and hot-swaps `behavior` across `/reload` calls without stacking wrappers.
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
	const markers: LegacyHookMarker[] = [
		Symbol.for(`pi-compact-tools.hook.${name}`),
		...legacyMarkers,
	];
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

export interface RuntimeClipboardSink {
	writeClipboardText(text: string): boolean;
	writeHostTerminal(sequence: string): boolean;
}

const CLIPBOARD_SINK_KEY = Symbol.for("conarti.pi-ui.runtime-clipboard-sink.v1");

export function registerRuntimeClipboardSink(sink: RuntimeClipboardSink | undefined): void {
	(globalThis as Record<symbol, RuntimeClipboardSink | undefined>)[CLIPBOARD_SINK_KEY] = sink;
}

function getRuntimeClipboardSink(): RuntimeClipboardSink | undefined {
	return (globalThis as Record<symbol, RuntimeClipboardSink | undefined>)[CLIPBOARD_SINK_KEY];
}

export function copyToClipboard(text: string): void {
	if (!text) return;
	const sink = getRuntimeClipboardSink();
	try {
		if (sink?.writeClipboardText(text)) {
			return;
		}
	} catch {
		/* Ошибки пользовательского буфера обмена не должны прерывать рендер */
		return;
	}
	if (process.platform === "darwin") {
		try {
			const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", () => {});
			child.stdin?.end(text, "utf8");
		} catch {
			/* Переходим к резервной отправке OSC 52 */
		}
	}
	try {
		const b64 = Buffer.from(text, "utf8").toString("base64");
		if (b64.length <= 100_000) {
			const osc52 = `\x1b]52;c;${b64}\x07`;
			if (!sink?.writeHostTerminal(osc52)) {
				process.stdout.write(osc52);
			}
		}
	} catch {
		/* Игнорируем сбои записи в поток вывода */
	}
}

interface CopyFeedbackTimerEntry<TTarget extends object> {
	readonly target: TTarget;
	readonly timer: ReturnType<typeof setTimeout>;
}

export interface CopyFeedbackTimerRegistry<TTarget extends object> {
	arm(target: TTarget, onExpire: (target: TTarget) => void, delayMs?: number): void;
	clearAll(): void;
}

/**
 * Общий реестр таймеров сброса бейджа «✓ Copied» с автоматическим `unref()` и очисткой при `session_shutdown`.
 */
export function createCopyFeedbackTimerRegistry<
	TTarget extends { __conartiCopyTimer?: unknown },
>(
	symbolName: string,
	resetTarget: (target: TTarget) => void,
): CopyFeedbackTimerRegistry<TTarget> {
	const key = Symbol.for(symbolName);
	const getSet = (): Set<CopyFeedbackTimerEntry<TTarget>> => {
		const g = globalThis as Record<
			symbol,
			Set<CopyFeedbackTimerEntry<TTarget>> | undefined
		>;
		if (!g[key]) {
			g[key] = new Set();
		}
		return g[key]!;
	};

	return {
		arm(target, onExpire, delayMs = 1300) {
			const timers = getSet();
			const prev = target.__conartiCopyTimer as CopyFeedbackTimerEntry<TTarget> | undefined;
			if (prev) {
				clearTimeout(prev.timer);
				timers.delete(prev);
			}
			const entry: CopyFeedbackTimerEntry<TTarget> = {
				target,
				timer: setTimeout(() => {
					timers.delete(entry);
					if (target.__conartiCopyTimer === entry) {
						target.__conartiCopyTimer = undefined;
					}
					onExpire(target);
				}, delayMs),
			};
			entry.timer.unref?.();
			target.__conartiCopyTimer = entry;
			timers.add(entry);
		},
		clearAll() {
			const timers = getSet();
			for (const entry of timers) {
				clearTimeout(entry.timer);
				if (entry.target) {
					resetTarget(entry.target);
					entry.target.__conartiCopyTimer = undefined;
				}
			}
			timers.clear();
		},
	};
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
