import {
	Container,
	ScrollView,
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
	focused: boolean;
}

export interface FakeTerminal {
	columns: number;
	rows: number;
	writes: string[];
	write(seq: string): void;
}

export class FakeTui {
	readonly chatContainer: Container;
	readonly scroll: ScrollView;
	readonly dock: Container;
	readonly children: Container[];
	readonly overlayStack: FakeOverlayEntry[] = [];
	readonly terminal: FakeTerminal;

	layoutRoot: Component;
	renderCount = 0;
	focusComponent: Component | undefined;

	constructor(options?: { width?: number; height?: number }) {
		const columns = options?.width ?? 120;
		const rows = options?.height ?? 32;

		this.terminal = {
			columns,
			rows,
			writes: [],
			write: (seq: string) => {
				this.terminal.writes.push(seq);
			},
		};

		this.chatContainer = new Container();
		this.scroll = new ScrollView(this.chatContainer, {
			primary: true,
			scrollbar: "auto",
			follow: "end",
		});
		this.dock = new Container();

		// Matches Pi's 7-child structure:
		// [transcript, pending, status, widgetsAbove, editor, widgetsBelow, footer]
		this.children = [
			this.chatContainer,
			new Container(),
			new Container(),
			new Container(),
			new Container(),
			new Container(),
			new Container(),
		];

		this.layoutRoot = new VStack([
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: this.dock, basis: "auto", grow: 0, shrink: 0 },
		]);
	}

	setLayoutRoot(root: Component): void {
		this.layoutRoot = root;
		this.requestRender();
	}

	requestRender(): void {
		this.renderCount += 1;
	}

	setFocus(component: Component | undefined): void {
		this.focusComponent = component;
	}

	isOverlayVisible(entry: FakeOverlayEntry): boolean {
		if (entry.hidden) return false;
		const vis = entry.options?.visible;
		if (typeof vis === "function") {
			return Boolean(vis(this.terminal.columns, this.terminal.rows));
		}
		return true;
	}

	getTopmostVisibleOverlay(): FakeOverlayEntry | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			const entry = this.overlayStack[i];
			if (entry && !entry.options?.nonCapturing && this.isOverlayVisible(entry)) {
				return entry;
			}
		}
		return undefined;
	}

	hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}

	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: FakeOverlayEntry = {
			component,
			options,
			hidden: false,
			focused: !options?.nonCapturing,
		};
		this.overlayStack.push(entry);
		this.requestRender();

		const handle: OverlayHandle = {
			hide: () => {
				const idx = this.overlayStack.indexOf(entry);
				if (idx !== -1) this.overlayStack.splice(idx, 1);
				entry.hidden = true;
				entry.focused = false;
				this.requestRender();
			},
			setHidden: (hidden: boolean) => {
				entry.hidden = hidden;
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				entry.focused = true;
				this.focusComponent = component;
				this.requestRender();
			},
			unfocus: () => {
				entry.focused = false;
				if (this.focusComponent === component) this.focusComponent = undefined;
				this.requestRender();
			},
			isFocused: () => entry.focused,
			getBounds: () => undefined,
		};
		return handle;
	}

	renderViewport(width = this.terminal.columns, height = this.terminal.rows): string[] {
		this.terminal.columns = width;
		this.terminal.rows = height;
		const root = this.layoutRoot as Component & {
			renderViewport?: (w: number, h: number) => readonly string[];
		};
		if (typeof root.renderViewport === "function") {
			return [...root.renderViewport(width, height)];
		}
		return [...this.layoutRoot.render(width)];
	}

	asTui(): TUI {
		return this as unknown as TUI;
	}
}
