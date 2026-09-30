# 05: `shiftwork status`, STOP file and run summary

**What to build:** `shiftwork status` shows tickets, the frontier, active claims (with owner pid and age) and cooldowns. A `STOP` file in the repo root makes the runner finish the current shift cleanly, release the claim and exit with code 3. The runner prints a summary at the end, and per-shift NDJSON logs sit under `logs/<feature>/<NN>/` (spec: stories 40, 48, 49, 53).

**Blocked by:** 02

**Status:** resolved
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js status`

- [x] `status` works with no tickets, no config and no state file
- [x] A STOP file created mid-run stops after the current shift with exit code 3 and no leftover claim
- [x] The summary lists resolved and needs-info tickets with a reason each

## Comments

### Note from the real-model smoke test (2026-09-30)
- After a re-run of a needs-info ticket, shift numbering restarts at "Shift 1" next to the earlier Shift 1–3. Continue numbering from the reports already in the ticket (count existing `### Shift N — ` headings), so the Comments read as one history.

### Shift summary — 05
- Implemented `shiftwork status` with `--dir` support; it now lists tickets, marks the frontier, shows active claims with pid/age and shows active cooldowns.
- Added a `STOP` file check in `runFrontier`: the current shift finishes cleanly, the claim is released, the ticket is reset to `ready-for-agent`, and the runner exits with code 3.
- The run summary now includes a reason for every resolved and needs-info ticket, and prints a "Stopped" line when a STOP file halts the run.
- Added `packages/core/src/cooldowns.js`, `tracker.activeClaims()`, and tests for status and STOP behavior.

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: stop
- Usage: 81741 in / 31494 out tokens, $0.6379, 47 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-05 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- Done by Shiftwork: 47 turns on opencode-go/kimi-k2.7-code, landed as 120e457
- Accepted: `status` with claims (pid, age) and cooldowns, `openCooldowns` (shared state for ticket 10), `tracker.activeClaims`, STOP handling with exit 3 and the ticket reset to ready-for-agent, reasons in the run summary
- Fixed: a STOP file that existed before the run still let one ticket run (and the shift's test encoded that); STOP is now checked before every ticket, and the test creates STOP mid-shift
- Fixed: shift numbers now continue from the reports already in the ticket (the note above was not picked up by the shift)
