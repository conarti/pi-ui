# `@conarti/pi-ui`

## Non-obvious invariants

- **Host-provided packages**: keep `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` in `peerDependencies` (`"*"`) only. Physical copies in `dependencies` bypass Pi's runtime module mapping and duplicate component classes.
- **Package resource isolation**: `package.json` declares explicit `pi.extensions` and `pi.themes` paths. Keep `pi.skills` unset so project-scoped engineering skills in `.agents/skills/` apply only when working inside this repository.
- **Fullscreen viewport coexistence**: primary `ScrollView` (`scrollbar: "auto"`) and transcript content span the full viewport width and height so cards align flush with the composer and the native scrollbar stays in the rightmost terminal column (`width - 1`). `Sticky Prompt` and the compact `Outline Rail` block (`[upY .. downY]` at `width - 3 .. width - 2`, inheriting underlying card background colors) composite directly over the viewport frame in `src/shared/fullscreen-layout.ts` without shrinking `scroll.getContentWidth` or wrapping `layoutRoot` in auxiliary stacks (see `docs/adr/0002-composited-viewport-chrome.md`).
- **Overlays**: mount `nonCapturing: true` hover popups lazily while hovered and remove them via `handle.hide()` on leave. Check `hasBlockingModalOverlay(tui)` (`src/shared/modal-card.ts`, which inspects both `tui.getTopmostVisibleOverlay()` and registered blocking dialogs, never `tui.hasOverlayEntries`) when guarding modal dialogs or questionnaires.
- **Host TUI runtime contracts**: when modifying viewport compositing, mouse text selection, inline image cropping, `CustomEditor` frames, or multi-layout key normalization, read `docs/host-tui-contracts.md`.
- **Design posture**: blue-toned palettes without purple accents; keyboard + mouse friendly without Vim mode.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues on `conarti/pi-ui` via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` at repo root and `docs/adr/`, created lazily). See `docs/agents/domain.md`.
