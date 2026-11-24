import {
	Container,
	ScrollView,
	TuiAltScreen,
	VStack,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";

export interface FakeOverlayEntry {
	component: Component;
	options?: OverlayOptions;
	hidden: boolean;
	focusOrder?: number;
}

export interface FakeTerminal {
	columns: number;
	rows: number;
	writes: string[];
	write(seq: string): void;
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	hideCursor(): void;
	showCursor(): void;
}

interface AltScreenRuntimeBase {
	layoutRoot: Component;
	readonly overlayStack: FakeOverlayEntry[];
	readonly children: Container[];
	readonly terminal: FakeTerminal;
	setLayoutRoot(root: Component): void;
	getFocusedComponent(): Component | null;
	setFocus(component: Component | null): void;
	isOverlayVisible(entry: FakeOverlayEntry): boolean;
	getTopmostVisibleOverlay(): FakeOverlayEntry | undefined;
	readonly hasOverlayEntries: boolean;
	hasActiveSelection(): boolean;
	getActiveSelectionText(): string | undefined;
	clearTextSelection(): void;
	resetTextSelection(): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	getScreenLines(): string[];
	requestRender(force?: boolean): void;
	requestViewRender(): void;
	requestImmediateRender(): void;
}

const BaseAltScreen = TuiAltScreen as unknown as {
	new (
		terminal: FakeTerminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options?: { copyOnSelect?: boolean },
	): AltScreenRuntimeBase;
};

function buttonBaseCode(button: "left" | "middle" | "right"): number {
	if (button === "middle") return 1;
	if (button === "right") return 2;
	return 0;
}

export class FakeTui extends BaseAltScreen {
	readonly chatContainer: Container;
	readonly scroll: ScrollView;
	readonly dock: Container;

	renderCount = 0;

	constructor(options?: { width?: number; height?: number }) {
		const columns = options?.width ?? 120;
		const rows = options?.height ?? 32;
		const terminal: FakeTerminal = {
			columns,
			rows,
			writes: [],
			write: (seq: string) => {
				terminal.writes.push(seq);
			},
			start: () => {},
			stop: () => {},
			hideCursor: () => {},
			showCursor: () => {},
		};

		super(terminal, false, undefined, { copyOnSelect: false });
		(this as any).altScreenActive = true;

		this.chatContainer = new Container();
		this.scroll = new ScrollView(this.chatContainer, {
			primary: true,
			scrollbar: "auto",
			follow: "end",
		});
		this.dock = new Container();

		this.children.push(
			this.chatContainer,
			new Container(),
			new Container(),
			new Container(),
			new Container(),
			new Container(),
			new Container(),
		);

		this.layoutRoot = new VStack([
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: this.dock, basis: "auto", grow: 0, shrink: 0 },
		]);
	}

	get focusComponent(): Component | undefined {
		return this.getFocusedComponent() ?? undefined;
	}

	set focusComponent(component: Component | undefined) {
		this.setFocus(component ?? null);
	}

	override requestRender(_force = false): void {
		(this as any).contentChanged = true;
		this.renderCount += 1;
	}

	override requestViewRender(): void {
		this.renderCount += 1;
	}

	override requestImmediateRender(): void {
		(this as any).contentChanged = true;
		this.renderCount += 1;
	}

	sendSgrMouse(code: number, x: number, y: number, release: boolean): void {
		const suffix = release ? "m" : "M";
		(this as any).handleViewportInput(`\x1b[<${code};${Math.max(1, x + 1)};${Math.max(1, y + 1)}${suffix}`);
	}

	moveMouse(x: number, y: number, modifiers = 0): void {
		this.sendSgrMouse(35 | modifiers, x, y, false);
	}

	pressMouse(x: number, y: number, button: "left" | "middle" | "right" = "left", modifiers = 0): void {
		this.sendSgrMouse(buttonBaseCode(button) | modifiers, x, y, false);
	}

	dragMouse(x: number, y: number, button: "left" | "middle" | "right" = "left", modifiers = 0): void {
		this.sendSgrMouse(buttonBaseCode(button) | 32 | modifiers, x, y, false);
	}

	releaseMouse(x: number, y: number, button: "left" | "middle" | "right" = "left", modifiers = 0): void {
		this.sendSgrMouse(buttonBaseCode(button) | modifiers, x, y, true);
	}

	clickMouse(x: number, y: number, button: "left" | "middle" | "right" = "left", modifiers = 0): void {
		this.pressMouse(x, y, button, modifiers);
		this.releaseMouse(x, y, button, modifiers);
	}

	wheelMouse(x: number, y: number, direction: "up" | "down", modifiers = 0): void {
		this.sendSgrMouse((direction === "up" ? 64 : 65) | modifiers, x, y, false);
	}

	disposeTimers(): void {
		(this.scroll as any).hideTransientScrollbar?.();
		(this as any).stopScrollbarHover?.();
		(this as any).stopScrollbarDrag?.();
		(this as any).stopSelectionAutoScroll?.();
		(this as any).flashes?.dispose?.();
	}

	renderViewport(width = this.terminal.columns, height = this.terminal.rows): string[] {
		this.terminal.columns = width;
		this.terminal.rows = height;
		(this as any).altScreenActive = true;
		(this as any).contentChanged = true;
		(this as any).doRender();
		return this.getScreenLines();
	}

	renderViewFrame(): string[] {
		(this as any).altScreenActive = true;
		(this as any).doRender();
		return this.getScreenLines();
	}

	asTui(): TUI {
		return this as unknown as TUI;
	}
}
