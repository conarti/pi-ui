# `@conarti/pi-ui`

## Non-obvious invariants

- **Host-provided packages**: keep `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` in `peerDependencies` (`"*"`) only. Physical copies in `dependencies` bypass Pi's runtime module mapping and duplicate component classes.
- **Package resource isolation**: `package.json` declares explicit `pi.extensions` and `pi.themes` paths. Keep `pi.skills` unset so project-scoped engineering skills in `.agents/skills/` apply only when working inside this repository.
- **Fullscreen viewport coexistence**: a fixed 3-row session header mounts statically at index `0` above the primary `ScrollView`, while `ScrollView` and transcript content span 100% of viewport width over symmetric 2-column canvas margins (`x = 2 .. width - 3`, inner dialogue axis `x = 4`) with the native blocky scrollbar and host jump banner suppressed. `Sticky Prompt` (`y = 3`), centered `▲`/`▼` scroll indicators, and the compact `Outline Rail` block (`[upY .. downY]` in the right margin `width - 2 .. width - 1`, inheriting underlying surface backgrounds) composite directly over the `ScrollView` frame in `src/shared/fullscreen-layout.ts` without shrinking `scroll.getContentWidth` or changing `viewportHeight` mid-scroll (see `docs/adr/0002-composited-viewport-chrome.md`).
- **Overlays**: mount `nonCapturing: true` hover popups lazily while hovered and remove them via `handle.hide()` on leave (computing `popupSurfaceBg` from elevated theme surfaces rather than recessed code/pending tokens). Check `hasBlockingModalOverlay(tui)` (`src/shared/modal-card.ts`, which inspects both `tui.getTopmostVisibleOverlay()` and registered blocking dialogs, never `tui.hasOverlayEntries`) when guarding modal dialogs or questionnaires.
- **Host TUI runtime contracts**: when modifying viewport compositing, wheel routing (`overscroll = "contain"`), mouse text selection, inline image cropping, `CustomEditor` frames, `Slot Arbitration`, or multi-layout key normalization, read `docs/host-tui-contracts.md`.
- **Design posture**: English-first (`en`) UI via `src/shared/i18n.ts`; blue-toned palettes without purple or turquoise accents; zero background token spend without explicit user opt-in; keyboard + mouse friendly without Vim mode.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues on `conarti/pi-ui` via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` at repo root and `docs/adr/`, created lazily). See `docs/agents/domain.md`.

### Prototyping

UI prototypes target Pi's terminal TUI rather than web routes. Before running `/prototype` for UI changes, read `docs/agents/prototyping.md`.
