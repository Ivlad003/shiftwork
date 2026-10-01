# 04: Interactive full-screen TUI with tabs and run-this-ticket

**What to build:** Wire tickets 01–03 into `packages/cli/src/tui.js`: the interactive view uses pi-tui's `TuiAltScreen` (not `TuiMainScreen`), reads the terminal size, re-renders on resize, feeds input through `decodeKeys` → `handleKey`, and runs the `start-runner` effect with `--ticket` for `n`. The plain-text fallback keeps working with the new keys where they make sense. Update the `tui` help text, `docs/guide.md` and `docs/guide.uk.md` (section 7, "What the TUI does": tabs and keys) and run `npm run llms` (spec stories 4, 6, 7).

**Blocked by:** 01, 03

**Status:** needs-info
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [ ] The pi-tui wiring is tested against a stub terminal (size, one resize, a key chunk reaching `handleKey`), as ticket orchestrator/11 did
- [ ] `n` on a ready ticket starts a detached runner with `--ticket` (stub runner); on a blocked ticket it shows the refusal notice
- [ ] Live check in a real terminal on a demo repo: tabs, cursor, collapse, details, `n`, resize; written in the ticket's Notes
- [ ] Guides (en + uk) and `tui --help` describe the tabs and keys

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: error, error: 402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}
- Usage: 0 in / 0 out tokens, $0.0000, 4 turns
- Time: 17s
- Verify: passed
- Outcome: needs-info: verify gate passed but no shift changed anything: the gate doesn't test this ticket
- Branch kept: shiftwork/tui-dashboard-04
