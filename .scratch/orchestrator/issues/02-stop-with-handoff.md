# 02: STOP asks the agent for a handoff note

**What to build:** When a STOP file appears during a shift, the runner uses the soft-limit path: it steers with a fixed STOP handoff text, allows up to 2 turns, aborts, and writes a runner note if the agent didn't. The ticket goes back to ready-for-agent with the note in Comments, the claim is released, and the exit code is 3 (spec stories 3–4).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] With the fake backend, STOP created mid-shift gets the agent's `### Handoff` note in the ticket and no runner note
- [ ] A non-compliant agent gets a runner note after the grace turns
- [ ] The ticket ends `ready-for-agent`, no claim is left and the exit code is 3; a STOP present before the run still works no ticket
