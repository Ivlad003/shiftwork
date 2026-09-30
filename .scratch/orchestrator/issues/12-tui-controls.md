# 12: `shiftwork tui`: run, stop with handoff, dry-run

**What to build:** Keys in the TUI: `r` starts a detached runner (like `/shift run`), `s` writes STOP (the runner hands off, ticket 02), `d` shows a dry-run, `f` cycles the feature filter, `q` quits. A second `r` while a runner is live is refused (spec story 28).

**Blocked by:** 11, 02

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Key handling is tested through a pure reducer (state, key) → state + effects
- [x] The start effect is tested with a stub runner (as in pi-shiftwork's tests)
- [x] A second runner is refused

### Notes

- `packages/cli/src/tui-controls.js` (new): the pure reducer `reduceKey(state, key) → { state, effects }` (r/s/d/f/q/Ctrl-C), `createTuiControls` (holds the dashboard state, runs effects, exposes `view` = featureFilter/notice/dryRun for rendering), `startDetachedRunner` (like `/shift run`: removes a stale STOP, spawns `node <bin> run [--feature f]` detached, logs to `logs/runner-<ts>.log`, claims the run state at once; refuses while a runner is live) and `writeStopFile` (the runner hands off per ticket 02).
- `dry-run.js`: new `collectDryRunLines(root, { feature, config, agentDir })`; the `run --dry-run` branch of the bin now reuses it (same output), and the TUI's `d` renders the lines in a Dry-run panel.
- `dashboard.js`: `renderDashboard` also reads `featureFilter` (scopes the frontier and ticket tables, header shows `filter: <slug>`), `notice` (a `» …` line) and `dryRun` (pending/lines panel). Header now lists all keys.
- `tui.js`: both the pi-tui view and the plain-text fallback feed keys through `createTuiControls`; unknown keys pass through unhandled.
- Effects are injectable, so tests spawn `test/fixtures/stub-runner.js` (same pattern as pi-shiftwork's tests): r starts it detached with the feature filter, a second r is refused with a warning notice (reducer-level and `startDetachedRunner`-level), s writes STOP and the stub exits with `stoppedReason: "STOP file"`.
- `npm test`: 363 tests, 354 pass, 9 skipped (opt-in live-backend checks), 0 fail.

## Comments

### Shift 1 — pi opencode-go/kimi-k3 (medium)
- Ended: stop
- Usage: 111196 in / 32928 out tokens, $1.2875, 42 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-12 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted: key reducer (r run, s stop with handoff, d dry-run, f feature filter, q quit) with effects, second runner refused. 42 turns on opencode-go/kimi-k3. Phase 2 (orchestrator) complete: 12/12
