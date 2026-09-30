# 08: Soft limit: the agent writes its own handoff note

**What to build:** At `softLimitPct` of any budget, the runner steers the agent to finish its step, append `### Handoff` to the ticket and stop, allowing up to 2 more turns. If a compliant note appears, it's used; otherwise the runner falls back to its own note at the hard limit (RESEARCH.md §6b).

**Blocked by:** 07

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] With the fake backend: a compliant shift's note is kept and no runner note is added
- [x] A non-compliant shift gets a runner note after the hard limit
- [x] The steer text is fixed and documented in the worker prompt

## Comments

### Shift 1 — manual, claude-opus-4-5
- Implemented soft-limit handoff path in `packages/core/src/runner.js`.
- Moved the soft-limit steer text to `packages/core/src/prompt.js` as `SOFT_LIMIT_STEER`, documented it in `WORKER_PROMPT`, and imported it in the runner.
- `runShift` now records a snapshot of the ticket at the first soft-limit event, steers the agent once, and allows up to 2 more turns.
- If the agent appends a new `### Handoff` to the ticket within the grace window, the runner treats it as the handoff note and does not add its own mechanical note.
- If the agent does not comply, the runner falls back to its own note at the hard limit (or when the grace window expires).
- `workTicket` skips `buildHandoffNote` when `shift.handoff.agentNote` is true.
- Updated the fake backend to support async `steer` callbacks with side effects.
- Added runner tests for compliant agent handoff, non-compliant fallback, and prompt documentation.
- Verify: `npm test` passed (103 tests).

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: error, error: 429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}
- Usage: 73769 in / 30145 out tokens, $0.3816, 26 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-08 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- Done by Shiftwork: 26 turns on opencode-go/kimi-k2.7-code, landed as 830da93. The shift ended on `429 GoUsageLimitError` (OpenCode Go usage limit) after the work was done; the verify gate still passed, so the ticket resolved — exactly what ADR-0003 is for
- Accepted: steer text in `SOFT_LIMIT_STEER` and documented in the worker prompt, 2-turn grace, agent note detection by comparing the ticket before/after, runner note as fallback
- Fixed (serious): after the agent wrote its handoff note the runner stopped reading but did **not abort** the shift, so the old agent kept working in the same worktree as the next shift
- Fixed: a handoff skipped the verify gate; now the gate runs after every shift, a passing gate resolves the ticket, and a failing gate after a handoff doesn't count as an attempt
- Fixed: the agent wrote its own "### Shift 1 — manual, claude-opus-4-5" heading (wrong model, same format as runner reports). Numbering now only counts real runner reports, and the worker prompt forbids "### Shift" headings (agents write "### Notes")
