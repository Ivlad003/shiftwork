# 11: Stall detection and escalation on repeated verify failures

**What to build:** `stallTurns` turns without a change in `git diff --stat` (or with the same failing output) trigger a fresh handoff. Repeated verify failures escalate to the next tier. A model left because of a stall isn't chosen again for that ticket (spec: stories 37–39).

**Blocked by:** 07

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Meter tests for stall detection from diff snapshots
- [ ] With the fake backend: a stall leads to a fresh handoff to an escalated tier
- [ ] No return to the stalled model within the ticket
