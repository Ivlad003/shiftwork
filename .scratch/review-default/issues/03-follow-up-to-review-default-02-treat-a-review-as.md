# 03: Follow-up to review-default/02: Treat a review as unfinished only when the last…

**What to build:** Treat a review as unfinished only when the last review section's own status line is `- Review: not finished` and it has no verdict, so a quoted not-finished line in findings does not re-review the ticket forever. Filed by the review of review-default/02 — see its "### Review" block in .scratch/review-default/issues/02-review-must-give-a-verdict.md.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/runner.test.js packages/core/test/config.test.js` · `npm test`

- [x] It works

### Notes
- Attempt 1: nothing to change — the tightened `reviewUnfinished` (packages/core/src/runner.js) already landed in main as part of ticket 02's rework (commit bb78109: "`reviewUnfinished` is tightened to the follow-up finding (filed as ticket 03, which this makes moot)"). The worktree branch is identical to main (`git diff main HEAD` empty). It treats a review as unfinished only when the last `### Review` section's own status line starts with `- Review: not finished` (line-anchored, so a blockquoted `> - Review: not finished` in findings is not a status line) and the section carries no `- Verdict:` line. Covered by the `reviewUnfinished` unit test (own status line, later verdict, quoted line, Not run) and the runner test "a quoted not-finished line in findings does not re-review the ticket forever" (0 review shifts on the next run). Verify gate passed on this worktree: `node --test packages/core/test/runner.test.js packages/core/test/config.test.js` — 128 pass; `npm test` — 662 pass, 10 skipped, 0 fail.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 19754 in / 3945 out tokens, $0.0728, 9 turns
- Time: 1m 28s
- Verify: passed
- Outcome: needs-info: verify gate passed but no shift changed anything: the gate doesn't test this ticket
- Branch kept: shiftwork/review-default-03

### Review — operator (by hand)
- Verdict: accept — already done in bb78109 (review-default/02): `reviewUnfinished` (packages/core/src/runner.js) reads only the last `### Review` section and needs its own line-anchored `- Review: not finished` with no `- Verdict:`; findings are blockquoted, so a quoted line never matches. Covered by the `reviewUnfinished` unit test and "a review that quotes the not-finished line in its findings is finished: no re-review" — both pass on main. The kept branch had no commits beyond main and was removed.
