# Host TUI Runtime Contracts

Verified runtime behaviors in `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` that govern `InteractiveMode` renderer resolution, mode switches, viewport compositing, mouse selection, inline images, custom editors, and keyboard input.

## `InteractiveMode` Proxy Reference & Mode-Switch / `/reload` Lifecycle

1. **Proxy vs underlying renderer (`this.ui !== this.renderer`)**:
   - `InteractiveMode` wraps its active renderer (`this.renderer`: `TuiAltScreen` in `fullscreen` mode or `TuiMainScreen` in `regular` mode) inside `this.ui = createInteractiveTuiReference(() => this.renderer)`.
   - Extension UI callbacks (`ctx.ui.custom`, `ctx.ui.setEditorComponent`, `ctx.ui.setHeader`, `ctx.ui.setFooter`) always receive `this.ui` (`Proxy`), whereas `TuiAltScreen.prototype` methods (`compositeScrollToEndIndicator`, `getSelectionColumns`, `applySelection`, `dispatchMouseToLayout`, `handleMouseEvent`) execute with `this === this.renderer` via `Reflect.apply`.
   - Never key `WeakMap` / `WeakSet` registries on `tui` directly or compare `runtime.tui === self` by strict reference. Unwrap `tui` dynamically via `unwrapHostTui(tui)` (`tui.valueOf()`) when indexing renderer-scoped maps or tracking active overlay renderers, and compare TUI identities via `isSameHostTui(a, b)`.
   - `createInteractiveTuiReference` traps `get`, `set`, `has`, and `getPrototypeOf`, and omits `defineProperty` / `getOwnPropertyDescriptor`. Only call `Object.defineProperty` on an unwrapped renderer (`self` inside prototype hooks or `unwrapHostTui(tui)`), never on `this.ui`.

2. **Live `fullscreen` <-> `regular` mode transitions (`InteractiveMode.switchTuiMode`)**:
   - Switching TUI mode replaces `this.renderer` in-place (`TuiAltScreen` <-> `TuiMainScreen`) without emitting `session_shutdown` or `session_start`, and switching back to `fullscreen` constructs a brand-new `TuiAltScreen` instance while reusing `this.ui` and `this.fullscreenLayoutRoot`.
   - `InteractiveMode.switchTuiMode` checks `previousUi.hasOverlayEntries` (`overlayStack.length > 0`) before swapping renderers. Dismiss registered transient `nonCapturing: true` `Hover Popup` overlays (when no blocking `Modal Card` is open) before `switchTuiMode` evaluates `hasOverlayEntries` so hover popups never block TUI mode toggles while blocking `Modal Card` dialogs still guard the switch.
   - `HostRuntimeHandle` evaluates `isFullscreen`, `scroll`, `chatContainer`, and `viewportSlots` dynamically against `unwrapHostTui(tui)`: detaching `ViewportChromeCompositor` (restoring `scroll.getContentWidth` and disposing `Sticky Prompt` / `Outline Rail`) on `fullscreen` -> `regular`, and rebinding a fresh `ViewportChromeCompositor` + `1003h` pointer-motion sequence onto the new `TuiAltScreen` on `regular` -> `fullscreen`.

3. **Hot `/reload` lifecycle**:
   - `/reload` emits `session_shutdown({ reason: "reload" })`, reloads extensions, and emits `session_start({ reason: "reload" })` while keeping `this.renderer`, `this.ui`, `this.transcriptScrollView`, and `this.fullscreenLayoutRoot` intact.
   - Prototype patches installed through `hookMethod` hot-swap their handler functions in place without stacking wrappers, and `disposeActiveHostRuntime()` detaches the prior `ViewportChromeCompositor` before the reloaded extension mounts a fresh one.

## Viewport Compositing & Selection Render Order

1. **`TuiAltScreen.doRender()` order**:
   - `renderLayoutFrame()` builds the layout tree (`{ root, width, height, lines, primaryScrollView, renderCache }`), where each box node holds `{ component, rect, clip, children, scrollView?, scrollContentLines?, layer }`. Walk `root.children` recursively to locate `node.scrollView === scroll`.
   - `compositeScrollToEndIndicator` and `compositeOverlays` execute **before** `applySelection(screen, nextLayout)`.
   - Mask selection cells across composited `Sticky Prompt` rows, `Outline Rail` columns (`width - 3 .. width - 2`), and visible `renderedOverlayLayouts` rects so underlying transcript selections never invert-highlight chrome or `Hover Popup` surfaces.

2. **Selection mouse lifecycle (`TuiAltScreen.handleMouseEvent`)**:
   - Left-button `press` calls `clearTextSelection()` before component `click` handlers fire on release.
   - When mounting a selection action `Hover Popup`, snapshot `getActiveSelectionText()` on left-button release (after letting native `copyOnSelect` run), consume `press` inside the popup (`{ handled: true, render: false }`), and read the snapshotted text on `click`.
   - While `selectionPressActive === true`, pass `drag` and `release` events through `ViewportChromeCompositor` so dragging across `Sticky Prompt` or `Outline Rail` continues auto-scrolling and releases cleanly.

## Inline Terminal Images Under Composited Chrome

- **Kitty (`\x1b_G...\x1b\\`) and iTerm2 (`\x1b]1337;File=...\x07`)**:
  - Strip inline image sequences on rows fully covered by `Sticky Prompt` before compositing text over them.
  - For multi-row Kitty placements partially covered by `Sticky Prompt`, relocate the placement anchor to the first uncovered row (`stickyBottom`) with adjusted `y` / `h` / `r` crop parameters so uncovered bottom rows remain visible during scrolling.

## Custom Composer Frame (`CustomEditor`)

- **Padding and border ownership**:
  - Pin `paddingX = 0` on `CustomEditor` subclasses that draw custom left and right frame borders so `Editor` wrap math matches the inner content width (`width - leftMargin - rightMargin`).
  - Guard minimum wrap width at narrow terminal columns (`maxWidth >= 2`) so wide graphemes never recurse in `Editor.wordWrapLine`.
  - Paint top, side, and bottom borders via internal state rather than relying on `this.borderColor`, because `InteractiveMode.updateEditorBorderColor()` overwrites `editor.borderColor` on thinking-level and mode transitions.

## Multi-Layout Keyboard Input

- **Dispatch order**:
  - `ctx.ui.onTerminalInput` listeners run inside `TuiBase.handleTerminalInput` before `CustomEditor.handleInput` (`onExtensionShortcut` -> editor keybindings). Returning `{ data }` rewrites the sequence for all downstream shortcut matchers.
- **Normalization precedence**:
  - Track bracketed paste state (`\x1b[200~` .. `\x1b[201~`) statefully across split chunks and pass paste payloads through untouched.
  - When Kitty CSI-u includes `:baseLayoutKey` (`\x1b[codepoint:shifted:base;modu`), trust `:baseLayoutKey` before consulting macOS `Option`-composed character tables so non-US physical layouts (`Russian`, `RussianWin`, `QWERTZ`) never misroute chords.
  - Rewrite Cyrillic codepoints and `Option`-composed symbols only when modifier bits (`Alt`, `Ctrl`, `Super`), `ESC` prefixes, or registered `alt+<letter>` Option chords apply, preserving plain printable text entry.

## Real `InteractiveMode` Test Harness & Banned Host Fakes (`ADR-0006`)

- **Real-host acquisition & test seam**:
  - `acquireHostRuntime(ctx)` acquires the live host TUI exclusively through Pi's `ctx.ui.custom` contract (no `setHostRuntimeAdapter` test-adapter seam in production code).
  - UI and extension integration tests boot real `InteractiveMode` + `createAgentSessionRuntime` + `registerFauxProvider` + `VirtualTerminal` (`tests/harness/interactive-harness.ts`) so `this.ui` `Proxy` wrapping, `createChatViewport` hierarchy, `ExtensionRunner` reserved-shortcut filtering, `switchTuiMode`, and `/reload` execute identically to live Pi.
- **Mechanically banned patterns (`scripts/check-standards.mjs`)**:
  - `npm run lint` rejects `as unknown as TUI` / `.asTui()` casts, private `.overlayStack` reads, direct `.handleMouse(` / `.handleMouse?.(` calls in integration suites, and any reintroduction of deleted fake-host modules (`fake-tui`, `fake-theme`, `extension-harness`) or `setHostRuntimeAdapter` / `HostRuntimeAdapter`.
