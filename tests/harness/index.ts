export { createDarkTheme, createLightTheme, createThemeFromFile } from "./fake-theme.ts";
export { FakeTui, type FakeOverlayEntry, type FakeTerminal } from "./fake-tui.ts";
export {
	createExtensionHarness,
	type ActiveCustomModal,
	type ExtensionHarness,
	type ExtensionHarnessOptions,
	type RegisteredCommand,
	type RegisteredFlag,
	type RegisteredShortcut,
} from "./extension-harness.ts";
export {
	captureTerminalScreen,
	parseTerminalFrame,
	type InlineImagePlacement,
	type TerminalCell,
	type TerminalColor,
	type TerminalScreenSnapshot,
} from "./terminal-screen.ts";
