# 11: Stall detection and escalation on repeated verify failures

**What to build:** `stallTurns` turns without a change in `git diff --stat` (or with the same failing output) trigger a fresh handoff. Repeated verify failures escalate to the next tier. A model left because of a stall isn't chosen again for that ticket (spec: stories 37–39).

**Blocked by:** 07

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Meter tests for stall detection from diff snapshots
- [ ] With the fake backend: a stall leads to a fresh handoff to an escalated tier
- [ ] No return to the stalled model within the ticket

## Comments

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: error, error: 429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}
- Usage: 0 in / 0 out tokens, $0.0000, 1 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-11 into main

### Review — Claude Code (claude-opus-5-5): false resolve, reopened
- Shift 1 failed instantly on `429 GoUsageLimitError` (0 tokens); the provider was cooled correctly (opencode-go until 14:40 UTC)
- But the runner then ran the verify gate, `npm test` passed because nothing of this ticket exists yet, and the ticket was "resolved" with no work. Reopened; the runner now refuses to resolve a ticket whose shifts changed nothing
