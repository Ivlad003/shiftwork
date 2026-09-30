# 06: Git worktree per ticket and landing

**What to build:** Each ticket runs in a worktree on branch `shiftwork/<feature>-<NN>`, created from the target branch. A resolved ticket's branch is merged into the target (fast-forward if possible, else a merge commit) and the worktree is removed. A ticket that ends in `needs-info` keeps its branch. The ticket file is always edited in the main checkout (spec: Git module).

**Blocked by:** 02

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Tested on a temp git repo: the resolve path lands the commit on the target branch
- [x] The needs-info path keeps the branch and removes nothing
- [x] A re-run of a ticket reuses its existing branch
- [x] A dirty main checkout doesn't block the run (worktrees isolate it)

## Comments

### Shift 1 — Claude Code (claude-opus-5-5), manual (pre-runner)
- Verify: `npm test` → 65 passed
- Git workspace (CLI adapter): `prepare` (worktree on `shiftwork/<feature>-<NN>` from the target branch, reused on re-run; runs `worktree.setup` commands), `land` (commits everything except `.scratch/` and setup output, `--ff-only` else a merge commit, conflict → `merge --abort` + branch kept), `keep` (WIP commit, branch kept), `diffStat` (for stall detection in 11)
- Worktrees live outside the repo (`~/.cache/shiftwork/worktrees/<repo>-<hash>/`, configurable `worktree.dir`) so nothing that walks up from the worktree finds the main checkout
- Runner: shift and verify run in the worktree; the ticket file stays in the main checkout and the prompt gives absolute paths plus a warning about the worktree copy; resolve → land (a failed landing becomes needs-info with the reason); needs-info → keep
- CLI: on by default in git repos, `worktree.enabled: false` or `--no-worktree` to turn off
- **Found and fixed:** `land` would have committed setup output (e.g. `node_modules` in repos that don't ignore it); setup-created paths are now recorded in the worktree's git dir and excluded from every commit
- **Gotcha for this repo:** worktrees have no `node_modules`; dogfooding needs `worktree.setup: ["npm install --prefer-offline --no-audit --no-fund --ignore-scripts"]`
