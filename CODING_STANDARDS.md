# Coding Standards

Review-stage conventions for `@conarti/pi-ui`. Mechanical invariants (peer isolation, file naming, single-line comment checks, real-host anti-mock test rules, commit trailers, and TypeScript types) are enforced automatically by `npm run check`.

## Domain Naming

- Name internal files, classes, types, state properties, and configuration presets after canonical terms in [GLOSSARY.md](GLOSSARY.md) (`Session Mode`, `Plan`, `Shell Effect`, `Turn`, `Sticky Prompt`, `Outline Rail`, `Prompt Chip`, `Tool Density`, `Modal Card`, `Hover Popup`).
- Keep external product names out of internal module filenames and canonical union types even when an issue or spec references an external TUI for visual comparison. Preserve legacy serialized config keys only inside narrow migration parsers when backward compatibility requires it.

## Comments

- Write comments in Russian using block syntax (`/* ... */` or `/** ... */`).
- Reserve comments for non-obvious invariants, host-runtime quirks, and protocol edge cases ("why"). Let clear function, variable, and test names express "what" without step-by-step narration comments inside test bodies.

## Overlays & Modal Guards

- Guard every transient `nonCapturing: true` `Hover Popup` (`Outline Rail` preview, composer and sent-card `Prompt Chip` previews, mouse-selection quote popup) with `hasBlockingModalOverlay(tui)` from `src/shared/modal-card.ts` so both overlay `Modal Card` dialogs and non-overlay blocking views (`ask_user` questionnaires) suppress hover popups consistently.
- Dismiss transient `Hover Popup` overlays immediately on `Esc`, viewport scroll (`scrollTo`, `scrollBy`, `scrollToStart`, `scrollToEnd`, wheel), pointer leave, and session shutdown.

## Module Boundaries & Theme Discipline

- Expose explicit public methods on custom TUI components (such as coordinate or hit-test helpers on `PiUiComposerEditor`) rather than reading inherited private `Editor` fields from feature modules.
- Derive surface, border, pill, and animation colors from adaptive light/dark blue-slate theme tokens and RGB helpers, supporting both `truecolor` and `256color` terminals without purple or magenta accents.

## Real-Host Integration Testing (`ADR-0006`)

- Boot Pi's real `InteractiveMode`, `createAgentSessionRuntime`, real package themes (`midnight-cobalt` / `one-blue-light`), and `registerFauxProvider` via `tests/harness/interactive-harness.ts` for all UI and extension integration suites, substituting only process-edge ports (`VirtualTerminal`, `fauxProvider` streams, per-test temp `cwd`/`agentDir`, and `HostClipboardProvider`).
- Drive UI interactions through outer terminal/session inputs (keyboard sequences, bracketed pastes, SGR mouse sequences, slash commands) and assert on parsed `TerminalScreen` snapshots (`harness.screen()`) and public session/disk state. Reserve direct unit tests (`loadPackageThemes()` when a `Theme` is needed) strictly for pure combinatorial modules.
- Never introduce hand-rolled host doubles, `as unknown as TUI` / `.asTui()` casts, private `.overlayStack` inspection, direct component `.handleMouse(...)` calls in integration suites, or production test-adapter backdoors (`setHostRuntimeAdapter`). `scripts/check-standards.mjs` fails `npm run lint` automatically on any violation.
