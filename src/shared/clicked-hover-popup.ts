import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { installClickedHoverPopupDismissHooks, registerTransientHoverDismisser, unwrapHostTui } from "./host-runtime.ts";
import { hasBlockingModalOverlay } from "./modal-card.ts";

interface AnchoredPopup extends Component {
	computeDimensions(termCols: number, termRows: number): { width: number; height: number };
}

export function createClickedHoverPopup<T extends AnchoredPopup>(
	id: string,
	createPopup: (dismiss: () => void) => T,
	anchorOffset: { x: number; y: number },
) {
	let popup: T | undefined;
	let handle: OverlayHandle | undefined;
	let activeKey: string | undefined;
	let activeTui: TUI | undefined;
	let renderer: TUI | undefined;
	const options: OverlayOptions = {
		nonCapturing: true,
		visible: () => Boolean(activeTui && !hasBlockingModalOverlay(activeTui)),
	};

	const hide = () => {
		const current = handle;
		handle = undefined;
		activeKey = undefined;
		activeTui = undefined;
		renderer = undefined;
		try {
			current?.hide();
		} catch {
			/* Хост мог уже закрыть попап при смене режима. */
		}
	};
	const dismiss = () => {
		const tui = activeTui;
		hide();
		tui?.requestRender();
	};
	registerTransientHoverDismisser(id, hide);
	const markOpened = installClickedHoverPopupDismissHooks(id, () => handle ? popup : undefined, hide);

	return {
		isVisible: () => Boolean(handle),
		hide,
		toggle(tui: TUI | undefined, key: string, x: number, y: number, prepare: (component: T) => void): void {
			if (!tui || hasBlockingModalOverlay(tui)) {
				dismiss();
				return;
			}
			const nextRenderer = unwrapHostTui(tui);
			if (renderer && renderer !== nextRenderer) hide();
			if (handle && activeKey === key) {
				dismiss();
				return;
			}
			popup ??= createPopup(dismiss);
			prepare(popup);
			const cols = Math.max(24, tui.terminal?.columns ?? 80);
			const rows = Math.max(8, tui.terminal?.rows ?? 30);
			const { width, height } = popup.computeDimensions(cols, rows);
			const below = y + anchorOffset.y;
			const above = y - height;
			options.width = width;
			options.col = Math.max(2, Math.min(x - anchorOffset.x, cols - width - 2));
			options.row = below + height <= rows ? below : above >= 1 ? above : Math.max(1, Math.min(below, rows - height));
			activeTui = tui;
			renderer = nextRenderer;
			activeKey = key;
			markOpened();
			if (handle) tui.requestRender();
			else handle = tui.showOverlay(popup, options);
		},
	};
}
