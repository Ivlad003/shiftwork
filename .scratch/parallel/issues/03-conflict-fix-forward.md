# 03: Rebase or redo tickets that conflict with a parallel landing

**What to build:** When a ticket's branch no longer lands because another parallel ticket landed first, the workspace rebases the branch onto the new target in its worktree, runs the ticket's Verify gate again and lands. If the rebase conflicts, abort it and give the ticket one more shift in a fresh worktree from the new target, with `- Landing conflict with <files>; redone on top of <commit>` in its Comments. A second landing failure goes to needs-info as today (spec story 4).

**Blocked by:** 01

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Git test with two real worktrees editing different lines of one file: the second is rebased, re-verified and lands
- [ ] Git test with the same lines edited: the rebase aborts, a fix-forward shift runs from the new target, the Comments note the conflict
- [ ] A second failure sets needs-info with the conflict files in the reason
- [ ] Live check on a demo repo: `shiftwork run --parallel 2` with two tickets touching one file ends with both resolved
