# 07: Budgets and fresh handoff with a runner-written note

**What to build:** Budgets cap each shift (tokens, cost, turns, time, context %), merged model → tier → default, plus a total per ticket and per-ticket `Budget:` overrides. At the hard limit the runner aborts the shift, writes a handoff note into Comments (from the log tail, `git diff --stat` and the last verify failure; mechanical if no model is available), and starts a fresh shift on the target model chosen by `onExceed`. When the ticket budget is exhausted, the status is `needs-info` (spec: Meter, Handoff notes; RESEARCH.md §6b).

**Blocked by:** 03, 05

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Meter table tests for each budget kind, including context %
- [x] With the fake backend: a turns budget of 2 causes a fresh handoff, a `### Handoff` note in Comments and a new shift on the planned target
- [x] The ticket budget ceiling ends in `needs-info` with the reason
- [x] `maxHandoffs` is respected

## Comments

### Shift summary — 07
- Added `packages/core/src/meter.js`: pure meter for tokens, cost, turns, wall time, context % and stall turns, with soft and hard limits.
- Extended `config.js` to validate `budgets`, `softLimitPct`, `onExceed` and `maxHandoffs`.
- Extended `planner.js` to merge budgets (model → tier → default), cap by the ticket `Budget:` line / `budgets.ticket`, and choose handoff targets via `onExceed`.
- Extended `runner.js` to observe events through the meter, steer on soft limits, abort and write a mechanical `### Handoff` note on hard limits, then start a fresh shift on the planned target; ticket-budget exhaustion ends in `needs-info`.
- Updated `fake-backend.js` to support scripted event sequences, `steer` and `abort`.
- Added `meter.test.js` and runner budget/handoff tests.
- Seeded budget defaults in `shiftwork init`.
- `npm test`: 99 passed.

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: stop
- Usage: 109446 in / 41448 out tokens, $1.1701, 70 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-07 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- Done by Shiftwork: 70 turns on opencode-go/kimi-k2.7-code, landed as e49055b
- Accepted: pure meter (tokens, cost, turns, wall time, context %, stall turns; soft and hard levels), budgets merged default → tier → model and capped by the ticket, `onExceed` targets, hard limit → abort + mechanical `### Handoff` note + fresh shift, `maxHandoffs`, ticket budget exhaustion → needs-info
- Fixed: after a handoff the remaining ticket budget *replaced* the shift budget (merge) instead of capping it, so a shift could get more room than its tier allows; now `capBudget` (test added)
- Fixed: `maxContextPct` could never fire — no backend emitted context events; the pi adapter now reports `contextUsage.percent` from `get_session_stats` after each assistant message
- Fixed: ticket-level `maxWallMin` was never accumulated; shifts now report their wall time
