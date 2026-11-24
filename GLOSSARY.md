# `@conarti/pi-ui`

Interactive terminal UI package for Pi: structured transcript cards, turn navigation, session execution modes, line-commentable plan review, modal dialogs, and blue-toned themes.

## Language

### Modes & Planning

**Session Mode**:
The active execution posture of a session: `Code` (unrestricted tool access), `Plan` (read-only exploration that produces a `Plan`), or `Auto-Safe` (read-only calls run immediately while mutating calls require confirmation).
_Avoid_: Permission level, agent profile, sandbox state

**Plan**:
The structured, numbered engineering proposal captured in `Plan` mode, holding optional line-pinned review comments before approval and per-step completion state during execution.
_Avoid_: Draft, todo list, checklist

**Plan Studio**:
The interactive `Modal Card` where the user inspects a `Plan` line by line, attaches inline comments, requests a revision, or approves execution.
_Avoid_: Plan editor, comment popup, plan widget

**Shell Effect**:
The classification of a shell command as strictly read-only versus potentially mutating (accounting for redirections, opaque subshells, mutating flags, package scripts, and code interpreters), shared between execution guards and tool-call summaries.
_Avoid_: Destructive regex, command whitelist

### Transcript & Viewport

**Turn**:
A single user prompt in the active session branch together with the response exchange that follows it, indexed sequentially even when older prompts are compacted out of the live transcript.
_Avoid_: Step, entry, message row

**Sticky Prompt**:
The top viewport bar that pins the active `Turn`'s user prompt once its transcript card scrolls past the top edge.
_Avoid_: Pinned header, prompt banner

**Outline Rail**:
The narrow right-hand navigation strip beside the native transcript scrollbar displaying `Turn` ticks, scroll-jump arrows, and a `Hover Popup` preview.
_Avoid_: Timeline gutter, minimap, custom scrollbar

### Overlays

**Modal Card**:
A framed, focus-capturing dialog centered over the viewport (Command Palette, `Plan Studio`, Context Inspector, `Auto-Safe` confirmation) that blocks other modal dialogs until closed.
_Avoid_: Popup, toast, inline widget

**Hover Popup**:
A transient, non-capturing overlay anchored near a hovered element (such as the `Outline Rail` preview) that never steals input focus or blocks a `Modal Card`.
_Avoid_: Modal, dialog
