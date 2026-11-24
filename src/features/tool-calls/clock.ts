import { BREATHING_TICK_MS, subscribeAnimationTicks } from "../../shared/animation-scheduler.ts";

export const TICK_MS = 80;

export function onTick(listener: () => void, period = TICK_MS, onStop?: () => void): () => void {
	if (!Number.isFinite(period) || period <= 0) {
		throw new RangeError("Animation period must be positive and finite");
	}
	if (period <= BREATHING_TICK_MS) {
		return subscribeAnimationTicks(() => {
			listener();
		}, onStop);
	}
	let elapsed = 0;
	return subscribeAnimationTicks((_elapsedMs, deltaMs) => {
		elapsed += deltaMs;
		if (elapsed < period) return;
		elapsed %= period;
		listener();
	}, onStop);
}
