# 09: In-place handoff and `auto` mode

**What to build:** When `onExceed` says `same-process` (or `auto` picks it: cost, token or turn reasons, and the target model's context window is at least the current usage), the runner swaps the model in the live session, compacting first if the target window is smaller, and continues the shift. Backends without `capabilities.inPlaceHandoff` get a fresh handoff instead (spec: story 27, 30).

**Blocked by:** 08

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Planner tests for the `auto` decision table
- [x] With the fake backend: an in-place swap continues the same shift and records the handoff note
- [x] The pi integration test proves `set_model` mid-shift works; the finding goes in Comments

## Comments

### Notes
- `chooseHandoffMode` (planner): `auto` keeps the live session for `maxCostUsd` / `maxTokens` / `maxTurns` when the target window can hold current usage; context fill, stall and wall time are always fresh. Explicit `same-process` still in-places when the window is smaller, but compacting first. No `capabilities.inPlaceHandoff` → always fresh.
- Runner: on a hard limit, capable backends `compact` (if needed) then `swapModel` and keep the same `startShift`; a `### Handoff` note is still written. Fake backend without the capability still does a new process.
- pi adapter: `swapModel` is RPC `set_model` + optional `set_thinking_level` + `follow_up`. The process is no longer stopped on the first `agent_settled`, so a mid-shift swap can continue; `close()` stops it.
- **Finding (`set_model` mid-shift):** confirmed against a real pi RPC process with the scripted provider. After the first assistant turn (a `write` tool call), `set_model` from `scripted/s1` to `scripted/s2` succeeds; a later turn and/or `get_state` reports `s2`. No extra stub RPC process was needed. Test: `packages/cli/test/pi-backend.test.js` (`set_model mid-shift switches the live session`).

### Shift 1 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 227281 in / 44187 out tokens, $2.5138, 46 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-09 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- Done by Shiftwork: 46 turns on xai/grok-4.6 (OpenCode Go was over its usage limit), landed as 37bd384; the agent followed the new worker-prompt rule and wrote "### Notes"
- Accepted as is: pure `chooseHandoffMode` (auto: cost/tokens/turns stay in place when the target window fits; context, stall, time go fresh), in-place swap through `set_model` + `follow_up` with an optional `compact`, stale `end` events filtered by epoch, `close()` in `finally` (checked: no leaked pi RPC processes)
- Finding confirmed: `set_model` mid-shift works on a real pi process
- Known approximation: without a context event, auto mode estimates context from summed turn tokens, which overestimates and leans towards fresh handoffs — the safe side
