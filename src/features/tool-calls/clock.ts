import { BREATHING_TICK_MS, subscribeAnimationTicks } from "../../shared/animation-scheduler.ts";

export const TICK_MS = BREATHING_TICK_MS;

export function onTick(listener: () => void, period = TICK_MS): () => void {
	if (!Number.isFinite(period) || period <= 0) {
		throw new RangeError("Animation period must be positive and finite");
	}
	if (period <= BREATHING_TICK_MS) {
		return subscribeAnimationTicks(() => {
			listener();
		});
	}
	let elapsed = 0;
	return subscribeAnimationTicks(() => {
		elapsed += BREATHING_TICK_MS;
		if (elapsed < period) return;
		elapsed %= period;
		listener();
	});
}
