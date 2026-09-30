# 04: Ticket status table in the feature spec

**What to build:** The tracker keeps a generated table in each feature's `spec.md` between `<!-- shiftwork:tickets:start -->` and `<!-- shiftwork:tickets:end -->`. Its columns are `NN · title · status · last route`, and it is rewritten atomically after every status change. When the markers are missing, they're appended at the end. Text outside them is never touched (spec stories 9–10).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Tracker test: setStatus updates the table; bytes outside the markers are unchanged
- [ ] Missing markers are appended once, and a missing spec.md is left alone
- [ ] The last route column shows the model of the latest shift report
- [ ] `shiftwork status` also prints the per-feature table
