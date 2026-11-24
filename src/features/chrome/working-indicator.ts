import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import {
	activateAnimationSurface,
	deactivateAnimationSurface,
	renderComposerWorkingFrame,
	stopAllAnimations,
	type WaveSampleOptions,
} from "../../shared/animation-scheduler.ts";

const COMPOSER_SURFACE_KEY = "composer.working-indicator";
const WORKING_CONTROLLER_KEY = Symbol.for("conarti.pi-ui.composer-working-controller.v1");

interface ComposerWorkingState {
	ctx?: ExtensionContext;
}

function getWorkingState(): ComposerWorkingState {
	const g = globalThis as Record<symbol, ComposerWorkingState | undefined>;
	if (!g[WORKING_CONTROLLER_KEY]) {
		g[WORKING_CONTROLLER_KEY] = {};
	}
	return g[WORKING_CONTROLLER_KEY]!;
}

export function buildWaveIndicator(options?: WaveSampleOptions): WorkingIndicatorOptions {
	return {
		frames: [renderComposerWorkingFrame(options)],
	};
}

export function bindComposerWorkingIndicator(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const state = getWorkingState();
	state.ctx = ctx;
	deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
	ctx.ui.setWorkingIndicator(buildWaveIndicator({ theme: ctx.ui.theme }));
	if (ctx.isIdle?.() === false) {
		startComposerWorkingWave();
	}
}

export function startComposerWorkingWave(): void {
	const state = getWorkingState();
	const ctx = state.ctx;
	if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
	activateAnimationSurface(COMPOSER_SURFACE_KEY, () => {
		const activeCtx = getWorkingState().ctx;
		if (!activeCtx || activeCtx.mode !== "tui" || !activeCtx.hasUI) {
			deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
			return;
		}
		activeCtx.ui.setWorkingIndicator(buildWaveIndicator({ theme: activeCtx.ui.theme }));
	});
}

export function stopComposerWorkingWave(clearContext = false): void {
	deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
	if (clearContext) {
		getWorkingState().ctx = undefined;
	}
}

export function registerComposerWorkingAnimation(pi: ExtensionAPI): void {
	pi.on("agent_start", () => {
		startComposerWorkingWave();
	});
	pi.on("turn_start", () => {
		startComposerWorkingWave();
	});
	pi.on("agent_end", () => {
		stopComposerWorkingWave(false);
		stopAllAnimations();
	});
	pi.on("agent_settled", () => {
		stopComposerWorkingWave(false);
		stopAllAnimations();
	});
	pi.on("session_shutdown", () => {
		stopComposerWorkingWave(true);
		stopAllAnimations();
	});
}
