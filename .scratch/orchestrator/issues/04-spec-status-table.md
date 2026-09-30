# 04: Ticket status table in the feature spec

**What to build:** The tracker keeps a generated table in each feature's `spec.md` between `<!-- shiftwork:tickets:start -->` and `<!-- shiftwork:tickets:end -->`. Its columns are `NN · title · status · last route`, and it is rewritten atomically after every status change. When the markers are missing, they're appended at the end. Text outside them is never touched (spec stories 9–10).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Tracker test: setStatus updates the table; bytes outside the markers are unchanged
- [x] Missing markers are appended once, and a missing spec.md is left alone
- [x] The last route column shows the model of the latest shift report
- [x] `shiftwork status` also prints the per-feature table

## Comments

### Shift 1 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 62486 in / 17390 out tokens, $0.5533, 22 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-04 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted: table `NN · title · status · last route` rewritten on every status change, markers appended once when missing, `shiftwork status` prints it
- Fixed: the markers were found with `indexOf`, so this very spec — which mentions them in backticks in its Implementation Decisions — had a prose line replaced by the table. Markers now count only on a line of their own (test added with markers in prose)
