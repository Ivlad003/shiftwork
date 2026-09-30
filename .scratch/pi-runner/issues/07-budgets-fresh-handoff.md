# 07: Budgets and fresh handoff with a runner-written note

**What to build:** Budgets cap each shift (tokens, cost, turns, time, context %), merged model → tier → default, plus a total per ticket and per-ticket `Budget:` overrides. At the hard limit the runner aborts the shift, writes a handoff note into Comments (from the log tail, `git diff --stat` and the last verify failure; mechanical if no model is available), and starts a fresh shift on the target model chosen by `onExceed`. When the ticket budget is exhausted, the status is `needs-info` (spec: Meter, Handoff notes; RESEARCH.md §6b).

**Blocked by:** 03, 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Meter table tests for each budget kind, including context %
- [ ] With the fake backend: a turns budget of 2 causes a fresh handoff, a `### Handoff` note in Comments and a new shift on the planned target
- [ ] The ticket budget ceiling ends in `needs-info` with the reason
- [ ] `maxHandoffs` is respected
