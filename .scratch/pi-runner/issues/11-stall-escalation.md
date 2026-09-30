# 11: Stall detection and escalation on repeated verify failures

**What to build:** `stallTurns` turns without a change in `git diff --stat` (or with the same failing output) trigger a fresh handoff. Repeated verify failures escalate to the next tier. A model left because of a stall isn't chosen again for that ticket (spec: stories 37–39).

**Blocked by:** 07

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Meter tests for stall detection from diff snapshots
- [x] With the fake backend: a stall leads to a fresh handoff to an escalated tier
- [x] No return to the stalled model within the ticket

## Comments

### Notes
- Meter: unchanged `diffStat` / `failingOutput` snapshots increment `stallTurns`; a change resets the counter. Stall is hard-only (no soft steer).
- `onExceed.stallTurns` and `onExceed.verifyFailed` default to `{ to: "escalate", mode: "new-process" }` in `shiftwork init`. `history.blockedModels` keeps models left for those kinds off the ticket for later `planShift` calls; if none remain, the ticket goes to `needs-info`.

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: error, error: 429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}
- Usage: 0 in / 0 out tokens, $0.0000, 1 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-11 into main

### Review — Claude Code (claude-opus-5-5): false resolve, reopened
- Shift 1 failed instantly on `429 GoUsageLimitError` (0 tokens); the provider was cooled correctly (opencode-go until 14:40 UTC)
- But the runner then ran the verify gate, `npm test` passed because nothing of this ticket exists yet, and the ticket was "resolved" with no work. Reopened; the runner now refuses to resolve a ticket whose shifts changed nothing

### Shift 2 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 123782 in / 33840 out tokens, $1.2044, 26 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-11 into main

### Review — Claude Code (claude-opus-5-5), after the second shift
- Done by Shiftwork on xai/grok-4.6 (OpenCode Go cooling down), 26 turns, landed as 2c3640d; the no-change guard didn't get in the way of real work
- Accepted: stall from diff snapshots (no soft steer, a clean fresh handoff), `onExceed.verifyFailed` escalation that still counts the attempt, models left for a stall or failed gate are blocked for the ticket, and running out of models ends in needs-info
- Note: the meter also accepts `failingOutput` events, but no backend emits them yet; stalls are detected from the diff only
