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
The active `Turn`'s user prompt card pinned at the top edge of the transcript viewport while its exchange is in view, displaced upward when the next `Turn`'s prompt reaches it.
_Avoid_: Pinned header, prompt banner, sticky toolbar

**Outline Rail**:
The narrow navigation strip immediately to the left of the rightmost transcript scrollbar displaying `Turn` ticks, scroll-jump arrows, and a `Hover Popup` preview.
_Avoid_: Timeline gutter, minimap, custom scrollbar

**Prompt Chip**:
An atomic inline pill representing an attached image, pasted text block, or quoted passage inside the composer draft and the submitted user prompt card.
_Avoid_: Attachment path, paste marker, quote widget

**Tool Density**:
The transcript verbosity preset (`Detailed`, `Diff Focus`, or `Compact`) governing whether completed file diffs and command output previews stay visible inline or fold into summary rows alongside grouped read/search explorations.
_Avoid_: Tool theme, compact mode, vendor style

### Overlays

**Modal Card**:
A framed, focus-capturing dialog centered over the viewport (Command Palette, `Plan Studio`, Context Inspector, `Auto-Safe` confirmation) that blocks other modal dialogs until closed.
_Avoid_: Popup, toast, inline widget

**Hover Popup**:
A transient, non-capturing overlay anchored near a hovered element or text selection (such as the `Outline Rail` preview, `Prompt Chip` preview, or selection quote action) that never steals input focus or blocks a `Modal Card`.
_Avoid_: Modal, dialog
