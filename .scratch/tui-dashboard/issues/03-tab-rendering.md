# 03: Tabbed, height-aware dashboard rendering

**What to build:** `renderDashboard(state, { width, height })` in `packages/cli/src/dashboard.js` renders the tab of the spec: a header (tabs, version, time, notice), the tab body, a footer with the tab's keys. **Queue**: features as folders (`▾ parallel 3/4` / `▸` when collapsed) with ticket rows (number, title, status, blockers, `● <model ref>` when a worker has it), the cursor row marked. **Details**: Type, Model, Budget, Verify, Blocked by, What to build, the dry-run route when known, the latest `### Shift` report from Comments. **Agents**: one row per worker (ticket, model ref, tier, shift/attempt, tokens, cost, turns, context fill, budget, elapsed) plus the runner line. **Cooldowns** and **Log** (the selected worker's log, else the first). Lists scroll so the cursor stays visible; no line exceeds `width`. Without `height` (`--once`, plain-text fallback) the Queue and Agents tabs are printed one after the other, unbounded. `collectDashboardState` reads the selected worker's log and, when details are open, that ticket's body (spec stories 1–3, 6).

**Blocked by:** 02

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [ ] Table tests: line count ≤ `height` and width ≤ `width` for each tab; with 40 tickets and the cursor on the last, its row is rendered
- [ ] A ticket a worker holds shows `● claude:sonnet` (the model ref, prefix included)
- [ ] Details render the ticket's fields and its latest shift report; a ticket without Comments renders without one
- [ ] `tui --once` still prints one frame and exits; the existing dashboard tests are updated, not deleted
