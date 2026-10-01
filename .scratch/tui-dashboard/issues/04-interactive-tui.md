# 04: Interactive full-screen TUI with tabs and run-this-ticket

**What to build:** Wire tickets 01–03 into `packages/cli/src/tui.js`: the interactive view uses pi-tui's `TuiAltScreen` (not `TuiMainScreen`), reads the terminal size, re-renders on resize, feeds input through `decodeKeys` → `handleKey`, and runs the `start-runner` effect with `--ticket` for `n`. The plain-text fallback keeps working with the new keys where they make sense. Update the `tui` help text, `docs/guide.md` and `docs/guide.uk.md` (section 7, "What the TUI does": tabs and keys) and run `npm run llms` (spec stories 4, 6, 7).

**Blocked by:** 01, 03

**Status:** resolved
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [x] The pi-tui wiring is tested against a stub terminal (size, one resize, a key chunk reaching `handleKey`), as ticket orchestrator/11 did
- [x] `n` on a ready ticket starts a detached runner with `--ticket` (stub runner); on a blocked ticket it shows the refusal notice
- [x] Live check in a real terminal on a demo repo: tabs, cursor, collapse, details, `n`, resize; written in the ticket's Notes
- [x] Guides (en + uk) and `tui --help` describe the tabs and keys

### Notes

- `packages/cli/src/tui.js`: interactive mode uses `TuiAltScreen` (`setLayoutRoot` when present), sizes `renderDashboard` to `terminal.columns`/`rows`, rebuilds the frame on resize, and feeds input through `decodeKeys` → `handleKey`. The plain-text fallback stays unbounded and uses the same decoder. `tui --help` lists tabs and keys.
- Stub-terminal test: 80×24 first frame, one resize to 40×10 (line count ≤ height, width ≤ width), chunk `\x1b[B\x1b[B2` reaches `handleKey` as `down, down, 2`.
- `n` with argv-runner stub: ready `demo/07` spawns `run --ticket demo/07`; blocked `demo/08` is refused (`blocked by 07`) and nothing is spawned.
- Live pty check on a two-ticket demo repo: `[1 Queue]` / `2` → Agents; `j` moves onto `01 First`; left collapses to `▸ demo`; enter opens details (`Type: git`); `n` on `02` shows `» demo/02 is not on the frontier: blocked by 01`; SIGWINCH resize did not crash; `q` quit. `tui --once` still prints one unbounded frame.
- Guides (en + uk, section 7) describe the four tabs and keys. `npm run llms` regenerated `llms-full.txt`.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: error, error: 402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}
- Usage: 0 in / 0 out tokens, $0.0000, 4 turns
- Time: 17s
- Verify: passed
- Outcome: needs-info: verify gate passed but no shift changed anything: the gate doesn't test this ticket
- Branch kept: shiftwork/tui-dashboard-04

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: error, error: 402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}
- Usage: 0 in / 0 out tokens, $0.0000, 4 turns
- Time: 16s (ticket total 16s)
- Verify: not run
- Outcome: new attempt
- Provider limit: quota on opencode-go, cooling until 2026-10-02T09:02:36.280Z; continuing without counting an attempt

### Shift 3 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 128337 in / 27067 out tokens, $1.7202, 41 turns
- Time: 7m 13s (ticket total 7m 29s)
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-dashboard-04 into main
