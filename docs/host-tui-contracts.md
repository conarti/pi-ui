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
   - `HostRuntimeHandle` evaluates `isFullscreen`, `scroll`, `chatContainer`, and `viewportSlots` dynamically against `unwrapHostTui(tui)`: detaching `ViewportChromeCompositor` (disposing `Sticky Prompt` / `Outline Rail`) on `fullscreen` -> `regular`, and rebinding a fresh `ViewportChromeCompositor` + `1003h` pointer-motion sequence onto the new `TuiAltScreen` on `regular` -> `fullscreen`.

3. **Hot `/reload` lifecycle**:
   - `/reload` emits `session_shutdown({ reason: "reload" })`, reloads extensions, and emits `session_start({ reason: "reload" })` while keeping `this.renderer`, `this.ui`, `this.transcriptScrollView`, and `this.fullscreenLayoutRoot` intact.
   - Prototype patches installed through `hookMethod` hot-swap their handler functions in place without stacking wrappers, and `disposeActiveHostRuntime()` detaches the prior `ViewportChromeCompositor` before the reloaded extension mounts a fresh one.

## Viewport Compositing, Wheel Routing & Selection Render Order

1. **`TuiAltScreen.doRender()` order & symmetric margin grid**:
   - A fixed 3-row session header (`[blank, content, blank]`) mounts statically at `fullscreenLayoutRoot` index `0` outside `ScrollView` (suppressing the inner `headerContainer` inside `ScrollView.documentContainer`) so `viewportHeight` remains constant during scrolling and `Sticky Prompt` anchors cleanly at `y = 3`.
   - `renderLayoutFrame()` builds the layout tree (`{ root, width, height, lines, primaryScrollView, renderCache }`), where each box node holds `{ component, rect, clip, children, scrollView?, scrollContentLines?, layer }`. Walk `root.children` recursively to locate `node.scrollView === scroll`.
   - Suppress the host's native blocky scrollbar and `Jump to latest message` banner (`over-scrollbar`) so full-bleed cards stay aligned across `x = 2 .. width - 3` (dialogue content axis `x = 4`) without a 1-column jump when scrollback overflows; composite `Outline Rail` inside the right 2-column margin (`width - 2 .. width - 1`) alongside centered `▲`/`▼` scroll indicators.
   - `compositeScrollToEndIndicator` and `compositeOverlays` execute **before** `applySelection(screen, nextLayout)`.
   - Mask selection cells across composited `Sticky Prompt` rows, the active `Outline Rail` block (`[upY .. downY]` at `width - 2 .. width - 1`), and visible `renderedOverlayLayouts` rects so underlying transcript selections never invert-highlight chrome or `Hover Popup` surfaces.

2. **Wheel routing (`TuiAltScreen.prototype.routeWheel` & `overscroll = "contain"`)**:
   - Dispatch `wheel` events (`event.wheelDelta`) to topmost visible `Modal Card` / scrollable `Hover Popup` overlays, 6-row streaming `Thinking` windows, and overflowed `Composer` drafts before scrolling the primary `ScrollView`.
   - Enforce `overscroll = "contain"` on locally scrollable surfaces: wheel events inside an open scrollable `Hover Popup` scroll the popup without dismissing it or moving the transcript underneath; wheel events outside dismiss transient `Hover Popup`s and scroll the underlying target.

3. **Selection mouse lifecycle & clean copy (`TuiAltScreen.handleMouseEvent`)**:
   - Default `copyOnSelect` to `false`: releasing a drag or multi-click highlights the selection without overwriting the system clipboard and mounts a `[Copy]  [Quote · Alt+Q]` `Hover Popup` (or `✓ Copied · [Quote · Alt+Q]` when `copyOnSelect = true`).
   - Left-button `press` calls `clearTextSelection()` before component `click` handlers fire on release. Consume `press` inside the selection popup (`{ handled: true, render: false }`) and read the snapshotted clean selection text on `click`.
   - Clean selection extraction skips collapsed `✦ Thought for …`, collapsed `Tool Calls`, and `Response Metrics` (`Worked for …`) rows during multi-block drags, preserves `` `inline code` `` backticks, and unwraps soft terminal line wraps without frame borders or left margin spaces while keeping paragraph breaks and code-block line breaks intact.
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

## Session queue, renderer ownership, and summary indexing

- Pi's `app.message.dequeue` normally joins both queues' texts and drops image attachments. The queue strip intercepts `InteractiveMode.handleDequeue` to restore the first visible item using the same attachment-aware path as its `Edit` action.
- Pi stores the renderer callback on each custom message or entry component. Return a dispatching callback for a contended renderer so an existing component resolves its new owner on rebuild. Do not reinstall singleton factories whose owner and factory are unchanged; Pi's editor setter reconstructs the editor and resets the caret.
- `SessionManager.getEntries()` filters and copies all entries, even if only one was appended. Seed the step-summary index once, then update it after a successful `appendCustomEntry` without fetching the history again.

## Real `InteractiveMode` Test Harness & Banned Host Fakes (`ADR-0006`)

- **Real-host acquisition & test seam**:
  - `acquireHostRuntime(ctx)` acquires the live host TUI exclusively through Pi's `ctx.ui.custom` contract (no `setHostRuntimeAdapter` test-adapter seam in production code).
  - UI and extension integration tests boot real `InteractiveMode` + `createAgentSessionRuntime` + `registerFauxProvider` + `VirtualTerminal` (`tests/harness/interactive-harness.ts`) so `this.ui` `Proxy` wrapping, `createChatViewport` hierarchy, `ExtensionRunner` reserved-shortcut filtering, `switchTuiMode`, and `/reload` execute identically to live Pi.
- **Mechanically banned patterns (`scripts/check-standards.mjs`)**:
  - `npm run lint` rejects `as unknown as TUI` / `.asTui()` casts, private `.overlayStack` reads, direct `.handleMouse(` / `.handleMouse?.(` calls in integration suites, and any reintroduction of deleted fake-host modules (`fake-tui`, `fake-theme`, `extension-harness`) or `setHostRuntimeAdapter` / `HostRuntimeAdapter`.
