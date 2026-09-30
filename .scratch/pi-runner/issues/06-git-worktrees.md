# 06: Git worktree per ticket and landing

**What to build:** Each ticket runs in a worktree on branch `shiftwork/<feature>-<NN>`, created from the target branch. A resolved ticket's branch is merged into the target (fast-forward if possible, else a merge commit) and the worktree is removed. A ticket that ends in `needs-info` keeps its branch. The ticket file is always edited in the main checkout (spec: Git module).

**Blocked by:** 02

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Tested on a temp git repo: the resolve path lands the commit on the target branch
- [ ] The needs-info path keeps the branch and removes nothing
- [ ] A re-run of a ticket reuses its existing branch
- [ ] A dirty main checkout doesn't block the run (worktrees isolate it)
