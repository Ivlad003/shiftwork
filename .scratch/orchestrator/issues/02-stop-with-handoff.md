# 02: STOP asks the agent for a handoff note

**What to build:** When a STOP file appears during a shift, the runner uses the soft-limit path: it steers with a fixed STOP handoff text, allows up to 2 turns, aborts, and writes a runner note if the agent didn't. The ticket goes back to ready-for-agent with the note in Comments, the claim is released, and the exit code is 3 (spec stories 3–4).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] With the fake backend, STOP created mid-shift gets the agent's `### Handoff` note in the ticket and no runner note
- [x] A non-compliant agent gets a runner note after the grace turns
- [x] The ticket ends `ready-for-agent`, no claim is left and the exit code is 3; a STOP present before the run still works no ticket

## Comments

### Shift 1 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 66967 in / 21566 out tokens, $0.5583, 17 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-02 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted as is: STOP mid-shift reuses the soft-limit grace (`STOP_STEER`, 2 turns), then aborts; the agent's note is kept, else a runner note; the ticket goes back to ready-for-agent and the worktree stays for the next run. 17 turns on xai/grok-4.6
