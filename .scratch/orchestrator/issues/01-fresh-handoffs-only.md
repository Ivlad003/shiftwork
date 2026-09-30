# 01: Fresh handoffs only by default (ADR-0005)

**What to build:** Every model change starts a fresh context with a handoff note, whatever the exceeded budget. `chooseHandoffMode` returns fresh unless the config sets `allowInPlace: true`, which restores the phase-1 in-place behaviour. See ADR-0005 and spec stories 1–2.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Planner table tests: every kind and mode resolves to fresh without `allowInPlace`, and to the old decision with it
- [ ] Runner test with a backend that supports in-place: a cost/turns limit still starts a new shift and writes a handoff note
- [ ] `allowInPlace` is validated and documented in `shiftwork init` output
