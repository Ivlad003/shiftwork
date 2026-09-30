# 11: `shiftwork tui`: read-only dashboard

**What to build:** `shiftwork tui` shows features with their ticket tables, the frontier, the live runner from `.pi/shiftwork-run.json` (ticket, shift, model, budget use, context fill), cooldowns with time left, and the tail of the current shift log. It refreshes every second. It's built on `@earendil-works/pi-tui`, resolved from the user's pi install, and has a plain-text fallback when that isn't available (spec stories 25–27).

**Blocked by:** 04

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] A pure `renderDashboard(state) → lines` is tested with table cases: idle, running, waiting on cooldowns
- [x] A missing run state or log doesn't crash it
- [x] `shiftwork tui --once` prints one frame and exits (used by the tests)

### Notes

- `packages/cli/src/dashboard.js`: `renderDashboard(state) → string[]` is the pure frame (runner / frontier + per-feature ticket tables via `formatTicketsTable` / cooldowns with time left / log tail). `collectDashboardState(root)` reads the tracker, `.pi/shiftwork-run.json` (`openRunState`), cooldowns and the last 8 events of `logs/<feature>/<NN>/attempt-<n>.jsonl`; a missing run state or log yields null/empty, never a throw.
- Runner section cases: idle (no state) · working (ticket, shift, attempt, model, thinking, usage with tokens/$/turns/context fill, budget line, age) · waiting on cooldowns (running but no ticket published) · not running (stoppedReason + summary + finished age).
- `packages/cli/src/tui.js`: `shiftwork tui [--once] [--dir]`. Interactive mode resolves `@earendil-works/pi-tui` from the pi install with `locatePi` + `createRequire` (like `RpcClient`) and shows a `TuiMainScreen` + `Text` refreshed every 1 s; `q`/Ctrl-C quits. Plain-text fallback prints a frame per second when pi-tui can't be resolved. `--once` (or non-TTY stdout) prints one frame and exits.
- pi-tui API usage (TuiMainScreen/Text/input listener) verified against a stub Terminal; interactive mode itself isn't covered by tests per the spec's testing decisions (render function + fake runner only). Key handling for run/stop/dry-run is ticket 12.
- `npm test` green: 339 pass, 9 skipped (live-backend checks), 0 fail.

## Comments

### Shift 1 — pi opencode-go/kimi-k3 (medium)
- Ended: stop
- Usage: 167901 in / 27148 out tokens, $1.3260, 43 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-11 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted as is: `shiftwork tui` renders runner state, frontier, per-feature tables with the last route, cooldowns and the log tail; `--once` prints a frame (checked on this repo: 11/12 and 14/14 shown correctly). 43 turns on opencode-go/kimi-k3
