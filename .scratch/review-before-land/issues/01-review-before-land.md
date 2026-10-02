# 01: Review on the branch before it lands (new default)

**What to build:** As the spec describes. `review.when` accepts `"before-land"` (new default), `"after-land"`, and `"resolve"` as an alias of `"after-land"` (`packages/core/src/config.js`, `index.d.ts`); `review.maxRounds` (positive integer, default 2). In `packages/core/src/runner.js`, with `before-land`: once the verify gate passes in the worktree, run the review shift there (`cwd` = the worktree, prompt from `buildReviewPrompt` pointing at `git diff <target>...HEAD` and `git log <target>..HEAD`); accept → land (landing retries re-run Verify only); follow-up → land and file the follow-up; reopen → don't land, set `ready-for-agent`, keep the worktree, and the next shift of the ticket runs on the same branch with the review findings in its prompt; after `maxRounds` reopens → `needs-info` (`review rejected it <n> times; branch <b> kept`); no verdict → `needs-info`, branch kept, nothing lands. A landing conflict that redoes the work gets a fresh review. Same for the parallel landing path. `after-land` keeps today's code path unchanged. `run --dry-run` shows `review=<tier> (before land)` / `(after land)`. Update `packages/core/src/prompt.js` (reviewer prompt wording for a branch), the guides (en + uk, the reviews section), `CONTEXT.md`, `skills/shiftwork/SKILL.md` and `references/config.md` (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** None (can start immediately; build on `review-default/02` and `landing-race/01` if they have landed)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/runner.test.js packages/core/test/config.test.js packages/cli/test/run.e2e.test.js packages/cli/test/init-dry-run.test.js` · `npm test`

- [x] Runner test (fake backend + fake workspace): with no `review.when`, the review shift runs before `land`; accept → `land` called once, ticket resolved
- [x] Runner test: reopen → `land` never called, ticket `ready-for-agent`, the next shift reuses the same branch/worktree and gets the findings in its prompt; a second accept then lands
- [x] Runner test: `maxRounds` reopens → `needs-info` with the reason, branch kept, nothing landed
- [x] Runner test: follow-up → lands and files the follow-up; no verdict → nothing lands, `needs-info`
- [x] Runner test: `when: "after-land"` and `"resolve"` keep today's order (land, then review)
- [x] Parallel-path test: a before-land reopen doesn't land while another slot's ticket lands
- [x] e2e test (scripted backend, like the existing review e2e): the reviewer sees an unlanded branch; `main` gets the commit only after accept
- [x] Dry-run shows `(before land)`; guides (en + uk), `CONTEXT.md`, the skill and `references/config.md` describe the order

### Notes

- `review.when` now takes `"before-land"` (new default), `"after-land"` and `"resolve"` (normalized to `after-land` in `checkReview`), plus `review.maxRounds` (positive integer, default 2). `shouldReview` no longer filters on `when` — both orders review; the new exported `reviewWhen(config)` decides where. `review: false` and `{ enabled: false }` now share one shape.
- In `workTicket`, the before-land review runs in the resolve branch, after the shift report is appended and before `workspace.land`; the landing-retries loop was extracted into `landResolvedBranch`, shared by both orders, so the retries after an accepted review re-run Verify only. A landing conflict after an accept redoes the work and the redone work is reviewed again (fresh review). Without a workspace, before-land behaves exactly as before (review after resolve — there is nothing to land).
- A reopen counts the ticket's `- Verdict: reopen` lines: the `maxRounds`-th reopen goes to `needs-info` (`review rejected it N times; branch <b> kept`). A `stopped` review (STOP file/signal) lands nothing: the ticket goes back to `ready-for-agent` with its branch, and the run stops. On a normal reopen the worktree is kept and reused (`prepare` reuses it), and the next shift's prompt points at the `### Review` findings (`reopenedByReview`).
- The git workspace gained `target()` (the landing-target branch name); `buildReviewPrompt` gained `target` (branch diff `git diff <target>...HEAD` / `git log <target>..HEAD`, absolute paths in the worktree); the reviewer system prompt and the SKILL's "Review work" section are now branch/land neutral; `--dry-run` prints `review=<tier> (before land)` / `(after land)`; guides (en + uk), CONTEXT.md, the skill, `references/config.md`, README and cli README updated, then `npm run sync-skills` and `npm run llms`.

Both Verify gates pass: the named files 139/139, `npm test` 652 pass / 0 fail (10 pre-existing live-backend skips).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 182845 in / 93400 out tokens, $3.5472, 94 turns
- Time: 29m 22s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/review-before-land-01 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: reopen — Commit the worktree before a before-land review so git diff target...HEAD shows the shift's change; that diff is empty because the only commit is inside land().
- Time: 6m 41s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, spec, and the landed diff.
> The ticket landed in `9a1fa94`. I'll inspect that diff against the spec and run the verify gate.
> The runner change is large. I'll read the resolve/review path and the tests next, and check whether docs and `llms` output were updated.
> The review prompt points at `git diff <target>...HEAD`, which only sees commits. I'll check whether the branch is committed before that review runs.
> The named gate passed. I'll run the full suite and double-check the commit-before-review path against the real git workspace.
> The named verify gate passed (139/139) and `npm test` passed (652, 10 pre-existing skips). The order of review versus land is implemented, but a before-land review cannot see the change the spec says it judges.
> 
> The review shift runs in the worktree before `workspace.land`. The only commit of the shift's files is `commitAll` inside `land()` (`packages/cli/src/git.js`). Workers are not told to commit, and nothing else commits. `buildReviewPrompt` tells the reviewer to judge `git diff <target>...HEAD` and `git log <target>..HEAD`. On a branch that was created from the target and never committed, both are empty. New files are untracked, so a plain `git diff` misses them too. The after-land prompt still mentions `git status` and `git diff` for uncommitted work; the before-land prompt dropped that and assumes commits that do not exist yet.
> 
> A reopen does not call `keep()` either, so the next review on the same branch has the same empty range. `keep()` only runs for `needs-info` and `maxRounds`, and it would commit a WIP message that must not become the landed commit. The snapshot has to be the same commit `land()` would make (tracker and setup paths excluded) so an accept still merges `shiftwork: <feature>/<NN> …`.
> 
> The e2e only checks that `main` lacks the merge commit while the reviewer is running. It replays one script and never asserts that the branch diff contains `hello.txt`. The runner tests assert the prompt text and that `land` is called after accept, with a fake workspace that has no commits.
> 
> Two smaller gaps in the same path:
> 
> - A `follow-up` is filed inside `runReviewShift` before `land`. If that landing fails or is redone, the follow-up is already `ready-for-agent` for work that is not on the target. File it only after a successful land.
> - A skipped review (`verdict: "skip"`, cooling or concurrency cap) still lands. The new guide says the branch lands only after accept. Either hold the branch or correct the guide.
> 
> Config, dry-run `(before land)` / `(after land)`, `resolve` as an alias, reopen reuse, `maxRounds`, the parallel reopen case, and the en/uk guides plus synced skills match the ticket. Rebase-after-accept re-runs Verify only, and a landing conflict `continue`s into a fresh review; that code looks right and is untested on the before-land path. The shift report still says `Outcome: resolved` before the verdict, so a reopen leaves a resolved line above the review.

### Notes

- Operator fix (2026-10-02) for the review's reopen: `workspace.commit(t)` (packages/cli/src/git.js) commits the shift's work on the branch with the landing's own message before the before-land review, so `git diff <target>...HEAD` shows it; `land` then has nothing left to commit. A follow-up is filed only after the branch lands (`deferFollowUp`), and `- Follow-up: not filed — the branch did not land` otherwise. The shift report says `verify passed; review before landing` instead of `resolved`. The guides say a review that cannot run does not hold the branch.
- Tests: real-git `commit` test (diff shows the new file; one commit lands); runner tests for commit-before-review order, the outcome line and the deferred follow-up. `npm test`: 655 pass, 0 fail.

### Review — independent agent (before commit)
- Verdict: accept — reopen rounds, rebase/fast-forward landing, redo, keep() and the parallel path all hold; the follow-up line appears once. Minor issue 1 (a review round could leave unreviewed changes that land) is ticket 02; the doc wording and the lost-follow-up note were fixed before committing.
