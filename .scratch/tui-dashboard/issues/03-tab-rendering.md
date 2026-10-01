# 03: Tabbed, height-aware dashboard rendering

**What to build:** `renderDashboard(state, { width, height })` in `packages/cli/src/dashboard.js` renders the tab of the spec: a header (tabs, version, time, notice), the tab body, a footer with the tab's keys. **Queue**: features as folders (`▾ parallel 3/4` / `▸` when collapsed) with ticket rows (number, title, status, blockers, `● <model ref>` when a worker has it), the cursor row marked. **Details**: Type, Model, Budget, Verify, Blocked by, What to build, the dry-run route when known, the latest `### Shift` report from Comments. **Agents**: one row per worker (ticket, model ref, tier, shift/attempt, tokens, cost, turns, context fill, budget, elapsed) plus the runner line. **Cooldowns** and **Log** (the selected worker's log, else the first). Lists scroll so the cursor stays visible; no line exceeds `width`. Without `height` (`--once`, plain-text fallback) the Queue and Agents tabs are printed one after the other, unbounded. `collectDashboardState` reads the selected worker's log and, when details are open, that ticket's body (spec stories 1–3, 6).

**Blocked by:** 02

**Status:** resolved
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [x] Table tests: line count ≤ `height` and width ≤ `width` for each tab; with 40 tickets and the cursor on the last, its row is rendered
- [x] A ticket a worker holds shows `● claude:sonnet` (the model ref, prefix included)
- [x] Details render the ticket's fields and its latest shift report; a ticket without Comments renders without one
- [x] `tui --once` still prints one frame and exits; the existing dashboard tests are updated, not deleted

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: error, error: 402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}
- Usage: 64554 in / 33200 out tokens, $0.4155, 26 turns
- Time: 10m 29s
- Verify: not run
- Outcome: new attempt
- Provider limit: server on opencode-go, cooling until 2026-10-01T08:58:59.290Z; continuing without counting an attempt

### Notes
`renderDashboard(state, { width, height })` is tabbed and sized: header (tabs, version, time, notice), scrolled body, footer keys. Without `height`, Queue then Agents (then Cooldowns, Log, dry-run) print unbounded for `--once`. `collectDashboardState` tails the selected worker's log and, when details are open, that ticket's What-to-build line and latest `### Shift` report. Verify: `npm test` (455 pass) and `tui --once` print one frame.

### Shift 2 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 87380 in / 15800 out tokens, $0.7174, 19 turns
- Time: 4m 4s (ticket total 14m 33s)
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-dashboard-03 into main
