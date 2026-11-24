# `@conarti/pi-ui`

Interactive terminal UI package for Pi: structured transcript cards, turn navigation, session execution modes, line-commentable plan review, modal dialogs, and blue-toned themes.

## Language

### Modes & Planning

**Session Mode**:
The active tool-governance posture of a session: `Always-approve` (default, runs tool calls without interactive prompts unless blocked by a deny rule), `Plan` (allows writing only the session `Plan` file while blocking other file edits until `Plan Approval`), or `Auto` (automatically runs safe local edits and reviewed commands while surfacing risky or protected calls in a `Permission Prompt`).
_Avoid_: Code mode, Auto-Safe, Ask mode, sandbox state

**Permission Prompt**:
The interactive approval surface raised when `Auto` mode or a permission rule holds a tool call, offering one-off approval, scoped per-project `Always allow` / `Never allow` grants, inline rejection notes back to the model, or switching to `Always-approve`.
_Avoid_: Auto-Safe confirmation, alert dialog

**Plan**:
The session-scoped Markdown proposal authored during `Plan` mode before implementation begins, capturing context, recommended approach, critical files, reusable utilities, and verification steps.
_Avoid_: Chat checklist, todo list, step widget

**Plan Approval**:
The interactive review view opened when the agent proposes exiting `Plan` mode, where the user reads the `Plan`, attaches line or range comments, writes revision notes, approves implementation, or abandons planning.
_Avoid_: Plan Studio, plan editor, comment popup

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
A framed, focus-capturing dialog centered over the viewport (Command Palette, `Settings Modal`, Context Inspector, permission prompt) that blocks other modal dialogs until closed.
_Avoid_: Popup, toast, inline widget

**Settings Modal**:
The categorized, type-to-filter `Modal Card` for inspecting, live-previewing, toggling, and resetting host and interface preferences in one place.
_Avoid_: Config file editor, raw selector

**Hover Popup**:
A transient, non-capturing overlay anchored near a hovered element or text selection (such as the `Outline Rail` preview, `Prompt Chip` preview, or selection quote action) that never steals input focus or blocks a `Modal Card`.
_Avoid_: Modal, dialog

### Chrome & Appearance

**Status Bar**:
The bottom session strip showing workspace path, git branch, active turn timer, context window usage, model, thinking level, and filtered extension badges.
_Avoid_: Powerline widget, statusline plugin

**Appearance Mode**:
Whether the interface follows the operating system's light and dark appearance automatically using a configured theme pair (`Auto`) or stays pinned to a single theme.
_Avoid_: Terminal palette sync, dark-mode hack
