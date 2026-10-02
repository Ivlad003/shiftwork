# 02: Land only the work the review saw

**What to build:** From the review of the operator's fix to ticket 01 (2026-10-02). After `workspace.commit(t)`, the before-land review shift runs in the worktree and `runReviewShift` re-runs Verify there. If the reviewer edits files (it must not, but nothing enforces it) or Verify leaves untracked, non-ignored files, `land()`'s `commitAll` (`packages/cli/src/git.js`) commits them as a second `shiftwork: <feature>/<NN> …` commit that was never in the reviewed range. After an accepted before-land review, before `land`: discard what the review round left in the worktree — `git checkout -- .` plus `git clean -fd` for untracked files, keeping ignored files (no `-x`), the tracker copy and the setup paths — and if anything was discarded, add `- Discarded after review: <files>` to the landing notes. Reset only in the before-land path; after-land and no-review landings keep today's behaviour.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/git.test.js packages/core/test/runner.test.js` · `npm test`

- [x] git test (real repo): commit, then a stray edit and an untracked file in the worktree; the discard step removes both, keeps an ignored file and the setup paths; `land` merges exactly the committed work
- [x] Runner test (fake workspace): an accepted before-land review calls the discard step before `land`; its file list appears as `- Discarded after review: …`; nothing is discarded on the after-land path

### Notes

- `packages/cli/src/git.js`: new workspace method `discardAfterReview(t)` — `git checkout -- .` + `git clean -fd` (no `-x`) with the tracker copy and setup paths excluded via pathspecs; returns the discarded paths, empty when the review left nothing (the git calls are skipped then).
- `packages/core/src/runner.js`: in the before-land path only (after an accept/follow-up/skip verdict, before `landResolvedBranch`), the discard runs and `land`'s notes get `- Discarded after review: <files>`; after-land and no-review landings are untouched.
- `packages/core/test/runner.test.js`: `fakeWorkspace` records `discardAfterReview` (configurable `discarded` list); the two exact before-land call-log assertions now include the discard step; new test covers both the before-land discard (note + ordering before `land`) and the after-land non-discard.
- `packages/cli/test/git.test.js`: real-repo test — `commit`, then a stray edit, an untracked file, an ignored file, tracker-copy and setup edits; the discard removes the first two, keeps the rest, and `land` merges exactly the committed work (one landing commit, stray never lands).
- Both verify gates pass: targeted `node --test` (132 tests) and full `npm test` (674 tests, 0 fail).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 39960 in / 14962 out tokens, $0.3243, 31 turns
- Time: 4m 39s
- Verify: passed
- Outcome: resolved

### Review — pi xai/grok-4.7 (high)
- Verdict: follow-up — Discard worktree leftovers again after each rebase re-verify in landResolvedBranch, before the next land, so a moved target cannot commit files the review never saw.
- Time: 10m 44s
- Verify: passed
- Findings:

> I'll review the unlanded ticket against its acceptance criteria and the repo's standards, starting with the ticket, spec, and the branch diff.
> The ticket and spec are loaded. Next I’ll inspect the branch diff, related docs, and the landing path the change touches.
> `main` and `HEAD` are the same commit, so the reviewed change is not on that range. I’ll check the worktree and branches before judging the diff.
> The branch has no commits past `main`; the ticket’s work is uncommitted. I’ll review that working-tree diff against the acceptance criteria.
> The change is small. I’ll read the landing and git helpers around it so the discard path can be checked against the ticket, not just the diff.
> The implementation matches the ticket’s shape. I’ll run the verify gate and probe discard edge cases the tests may not cover.
> The targeted tests passed. I’ll probe staged leftovers, tracker files, and the rebase re-verify path, which the tests don’t cover.
> The before-land discard matches the ticket. Both verify gates pass. One landing-retry hole remains.
> 
> `discardAfterReview` does what the ticket asked: `git checkout -- .` and `git clean -fd` (no `-x`), with the tracker copy and setup paths excluded. It returns the discarded paths and skips the git calls when the review left nothing. The runner calls it only on the before-land accept, follow-up, and skip path, before `landResolvedBranch`, and writes `- Discarded after review: <files>` only when that list is non-empty. Reopen, no verdict, after-land, and no-review landings do not discard. An unstaged edit, an untracked file, and a nested untracked directory are removed. An ignored file, a tracker edit, an untracked file under `.scratch`, and setup output stay. `land` then merges the reviewed commit.
> 
> `node --test packages/cli/test/git.test.js packages/core/test/runner.test.js` passed (132). `npm test` passed (674, 0 fail).
> 
> `git checkout -- .` restores from the index, which is the command the ticket specified. A staged edit or a staged new file is reported as discarded, left in the worktree, and committed by the next `land` as a second `shiftwork:` commit. Ordinary reviewer writes and verify strays are unstaged or untracked, and those are removed.
> 
> The remaining hole is automatic. After an accepted review, if the target has moved, `landResolvedBranch` re-runs Verify and the next `land()` commits whatever that gate left. A real worktree check showed a tracked-file mutation and an untracked file both landing in a second `shiftwork: f/01` commit that was not in the reviewed range. Ignored files, the tracker copy, and setup paths are still excluded. Non-ignored leftovers are not.
- Follow-up: review-before-land/03 — Follow-up to review-before-land/02: Discard worktree leftovers again after each…

- Landed: merged shiftwork/review-before-land-02 into main
