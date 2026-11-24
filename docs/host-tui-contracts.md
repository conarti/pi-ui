# Host TUI Runtime Contracts

Verified runtime behaviors in `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` that govern viewport compositing, mouse selection, inline images, custom editors, and keyboard input.

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
