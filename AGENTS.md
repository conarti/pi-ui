# `@conarti/pi-ui`

## Non-obvious invariants

- **Host-provided packages**: keep `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` in `peerDependencies` (`"*"`) only. Physical copies in `dependencies` bypass Pi's runtime module mapping and duplicate component classes.
- **Package resource isolation**: `package.json` declares explicit `pi.extensions` and `pi.themes` paths. Keep `pi.skills` unset so project-scoped engineering skills in `.agents/skills/` apply only when working inside this repository.
- **Fullscreen viewport coexistence**: `StickyPromptBar`, `ScrollView` (`scrollbar: "auto"`), and `OutlineRail` compose through `VStack` + `HStack` in `src/shared/fullscreen-layout.ts`. Keep `ScrollView`'s native scrollbar active rather than hiding or patching its gutter.
- **Overlays**: mount `nonCapturing: true` hover popups lazily while hovered and remove them via `handle.hide()` on leave. Check `tui.getTopmostVisibleOverlay()` (not `tui.hasOverlayEntries`) when guarding modal dialogs or questionnaires.
- **Design posture**: blue-toned palettes without purple accents; keyboard + mouse friendly without Vim mode.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues on `conarti/pi-ui` via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` at repo root and `docs/adr/`, created lazily). See `docs/agents/domain.md`.
