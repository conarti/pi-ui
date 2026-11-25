# Prototyping in `@conarti/pi-ui`

This repository is a terminal TUI extension for Pi, not a web app. Apply the `/prototype` skill rules (throwaway, fast, no tests, captured on a `prototype/<name>` branch) using the terminal shapes below.

## UI prototypes (adapting `UI.md`)

Generate 3 structurally different terminal layouts (different hierarchy, density, or primary interaction, not just color tweaks).

### Sub-shape A: live variants inside `pi` (preferred)

When prototyping changes to an existing surface (transcript cards, tool calls, `Sticky Prompt`, `Outline Rail`, composer, overlays), mount the variants inside the real `pi` session so they sit against real transcript output, scrolling, themes, and terminal width:

- Gate rendering behind a single switcher controlled by an env var (e.g. `PI_UI_PROTO_VARIANT=A|B|C`) and a live toggle (a `/proto A|B|C` command or cycling hotkey) so switching requires no restart.
- Show a clearly marked status indicator with the active variant key, name, and switch control (e.g. `PROTO: B (Compact rail) | /proto A|B|C`).
- Keep existing session wiring and data flow intact; swap only the rendered presentation or stub mutating actions.

### Sub-shape B: standalone terminal script (isolated widgets)

When the surface has no existing host in `pi` yet, create a single runnable script under `scripts/prototype-<name>.mjs` (started with `node scripts/prototype-<name>.mjs`):

- Render 3 structurally different variants from realistic in-memory mock data (short/long lines, multi-line tool outputs, narrow/wide content).
- Switch variants with `←` / `→` (and `q` / `Ctrl+C` to exit), showing the active variant label in a bottom status line.
- Re-render on terminal resize (`SIGWINCH`) or provide a width toggle (`80` / `120` / `160` cols) so layout pressure is visible immediately.

### TUI guardrails

- Keep variants grounded in this repo's blue-toned palette posture and real `pi-tui` viewport constraints (see `docs/host-tui-contracts.md` when touching viewport compositing, scrollbar column, or overlays).
- Follow neutral domain naming from `GLOSSARY.md` if touching files under `src/` or `tests/` (the standards check enforces this).

## Logic and state prototypes (`LOGIC.md`)

Use `LOGIC.md` as-is: a single self-contained HTML file opened by double-click works directly for TUI state models (focus and overlay precedence, scroll/sticky transitions, `Plan Studio` comment lifecycles) without terminal wiring.

## Cleanup

Fold only the validated decision into `main` (never leave `/proto` switchers or losing variants in `main`), and commit the full multi-variant prototype to a `prototype/<name>` branch referenced from the implementation issue.
