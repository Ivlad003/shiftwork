# 02: Land only the work the review saw

**What to build:** From the review of the operator's fix to ticket 01 (2026-10-02). After `workspace.commit(t)`, the before-land review shift runs in the worktree and `runReviewShift` re-runs Verify there. If the reviewer edits files (it must not, but nothing enforces it) or Verify leaves untracked, non-ignored files, `land()`'s `commitAll` (`packages/cli/src/git.js`) commits them as a second `shiftwork: <feature>/<NN> …` commit that was never in the reviewed range. After an accepted before-land review, before `land`: discard what the review round left in the worktree — `git checkout -- .` plus `git clean -fd` for untracked files, keeping ignored files (no `-x`), the tracker copy and the setup paths — and if anything was discarded, add `- Discarded after review: <files>` to the landing notes. Reset only in the before-land path; after-land and no-review landings keep today's behaviour.

**Blocked by:** 01

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/git.test.js packages/core/test/runner.test.js` · `npm test`

- [ ] git test (real repo): commit, then a stray edit and an untracked file in the worktree; the discard step removes both, keeps an ignored file and the setup paths; `land` merges exactly the committed work
- [ ] Runner test (fake workspace): an accepted before-land review calls the discard step before `land`; its file list appears as `- Discarded after review: …`; nothing is discarded on the after-land path
