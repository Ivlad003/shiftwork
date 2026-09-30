# 01: Fresh handoffs only by default (ADR-0005)

**What to build:** Every model change starts a fresh context with a handoff note, whatever the exceeded budget. `chooseHandoffMode` returns fresh unless the config sets `allowInPlace: true`, which restores the phase-1 in-place behaviour. See ADR-0005 and spec stories 1–2.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Planner table tests: every kind and mode resolves to fresh without `allowInPlace`, and to the old decision with it
- [x] Runner test with a backend that supports in-place: a cost/turns limit still starts a new shift and writes a handoff note
- [x] `allowInPlace` is validated and documented in `shiftwork init` output

## Comments

### Shift 1 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 85399 in / 11494 out tokens, $0.5299, 17 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-01 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted as is: `chooseHandoffMode` returns fresh unless `allowInPlace: true` (and the backend supports it); the runner passes the flag from config; planner and runner tests cover both sides. 17 turns on xai/grok-4.6
