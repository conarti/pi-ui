export type RenderRequester = () => void;
export type AppActionRunner = (actionId: string) => boolean;

interface UiActionBridgeState {
	requestRender?: RenderRequester;
	runAppAction?: AppActionRunner;
}

const BRIDGE_KEY = Symbol.for("conarti.pi-ui.ui-action-bridge.v1");

function getBridgeState(): UiActionBridgeState {
	const g = globalThis as Record<symbol, UiActionBridgeState | undefined>;
	if (!g[BRIDGE_KEY]) {
		g[BRIDGE_KEY] = {};
	}
	return g[BRIDGE_KEY]!;
}

export function setRequestRender(fn: RenderRequester | undefined): void {
	getBridgeState().requestRender = fn;
}

export function requestRender(): void {
	getBridgeState().requestRender?.();
}

export function setAppActionRunner(fn: AppActionRunner | undefined): void {
	getBridgeState().runAppAction = fn;
}

export function runAppAction(actionId: string): boolean {
	return getBridgeState().runAppAction?.(actionId) ?? false;
}

export function resetUiActionBridge(): void {
	const state = getBridgeState();
	state.requestRender = undefined;
	state.runAppAction = undefined;
}
