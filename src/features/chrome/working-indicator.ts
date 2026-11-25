import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import {
	activateAnimationSurface,
	deactivateAnimationSurface,
	renderComposerWorkingFrame,
	stopAllAnimations,
	type WaveSampleOptions,
} from "../../shared/animation-scheduler.ts";
import {
	buildLiveWorkingPresentation,
	isPrototypeActive,
	samplePrototypeRunningGlyph,
} from "../transcript/prototype-state.ts";

const COMPOSER_SURFACE_KEY = "composer.working-indicator";
const WORKING_CONTROLLER_KEY = Symbol.for("conarti.pi-ui.composer-working-controller.v1");

interface ComposerWorkingState {
	ctx?: ExtensionContext;
	suppressed?: boolean;
}

function getWorkingState(): ComposerWorkingState {
	const g = globalThis as Record<symbol, ComposerWorkingState | undefined>;
	if (!g[WORKING_CONTROLLER_KEY]) {
		g[WORKING_CONTROLLER_KEY] = {};
	}
	return g[WORKING_CONTROLLER_KEY]!;
}

export function buildWaveIndicator(options?: WaveSampleOptions): WorkingIndicatorOptions {
	if (isPrototypeActive()) {
		return {
			frames: [samplePrototypeRunningGlyph(0, options)],
		};
	}
	return {
		frames: [renderComposerWorkingFrame(options)],
	};
}

function applyWorkingIndicatorFrame(ctx: ExtensionContext): void {
	if (!isPrototypeActive()) {
		ctx.ui.setWorkingIndicator(buildWaveIndicator({ theme: ctx.ui.theme }));
		return;
	}
	const pres = buildLiveWorkingPresentation({ theme: ctx.ui.theme });
	ctx.ui.setWorkingIndicator({ frames: [pres.indicatorFrame] });
	ctx.ui.setWorkingMessage(pres.borderMessage);
}

export function bindComposerWorkingIndicator(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const state = getWorkingState();
	state.ctx = ctx;
	deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
	if (state.suppressed) return;
	ctx.ui.setWorkingIndicator(buildWaveIndicator({ theme: ctx.ui.theme }));
	if (ctx.isIdle?.() === false) {
		startComposerWorkingWave();
	}
}

export function setComposerWorkingSuppressed(suppressed: boolean, ctx?: ExtensionContext): void {
	const state = getWorkingState();
	state.suppressed = suppressed;
	if (suppressed) {
		deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
		return;
	}
	const targetCtx = ctx ?? state.ctx;
	if (targetCtx && targetCtx.mode === "tui" && targetCtx.hasUI) {
		targetCtx.ui.setWorkingIndicator(buildWaveIndicator({ theme: targetCtx.ui.theme }));
		if (targetCtx.isIdle?.() === false) {
			startComposerWorkingWave();
		}
	}
}

export function restoreDefaultWorkingIndicator(ctx?: ExtensionContext): void {
	const state = getWorkingState();
	if (state.ctx && (!ctx || state.ctx === ctx)) {
		setComposerWorkingSuppressed(false, ctx ?? state.ctx);
		return;
	}
	state.suppressed = false;
	ctx?.ui.setWorkingIndicator();
}

export function startComposerWorkingWave(): void {
	const state = getWorkingState();
	const ctx = state.ctx;
	if (state.suppressed || !ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
	activateAnimationSurface(COMPOSER_SURFACE_KEY, () => {
		const current = getWorkingState();
		const activeCtx = current.ctx;
		if ( current.suppressed || !activeCtx || activeCtx.mode !== "tui" || !activeCtx.hasUI) {
			deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
			return;
		}
		applyWorkingIndicatorFrame(activeCtx);
	});
}

export function stopComposerWorkingWave(clearContext = false): void {
	deactivateAnimationSurface(COMPOSER_SURFACE_KEY);
	const state = getWorkingState();
	if (state.ctx && state.ctx.mode === "tui" && state.ctx.hasUI && isPrototypeActive()) {
		state.ctx.ui.setWorkingMessage(undefined);
	}
	if (clearContext) {
		state.ctx = undefined;
		state.suppressed = false;
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
