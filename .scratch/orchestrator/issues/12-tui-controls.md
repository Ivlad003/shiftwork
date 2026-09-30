# 12: `shiftwork tui`: run, stop with handoff, dry-run

**What to build:** Keys in the TUI: `r` starts a detached runner (like `/shift run`), `s` writes STOP (the runner hands off, ticket 02), `d` shows a dry-run, `f` cycles the feature filter, `q` quits. A second `r` while a runner is live is refused (spec story 28).

**Blocked by:** 11, 02

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Key handling is tested through a pure reducer (state, key) → state + effects
- [ ] The start effect is tested with a stub runner (as in pi-shiftwork's tests)
- [ ] A second runner is refused
