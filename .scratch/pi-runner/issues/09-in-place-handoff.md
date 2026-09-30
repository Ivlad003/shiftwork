# 09: In-place handoff and `auto` mode

**What to build:** When `onExceed` says `same-process` (or `auto` picks it: cost, token or turn reasons, and the target model's context window is at least the current usage), the runner swaps the model in the live session, compacting first if the target window is smaller, and continues the shift. Backends without `capabilities.inPlaceHandoff` get a fresh handoff instead (spec: story 27, 30).

**Blocked by:** 08

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Planner tests for the `auto` decision table
- [ ] With the fake backend: an in-place swap continues the same shift and records the handoff note
- [ ] The pi integration test proves `set_model` mid-shift works; the finding goes in Comments
