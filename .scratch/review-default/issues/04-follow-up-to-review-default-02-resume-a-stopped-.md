# 04: Follow-up to review-default/02: Resume a stopped before-land review in its work…

**What to build:** Resume a stopped before-land review in its worktree at the start of the next run instead of starting a new worker shift. Filed by the review of review-default/02 — see its "### Review" block in .scratch/review-default/issues/02-review-must-give-a-verdict.md.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/runner.test.js packages/core/test/config.test.js` · `npm test`

- [x] It works

### Notes

- `reviewUnfinishedReviews` now scans ready-for-agent tickets too (with a workspace): a stopped before-land review leaves the ticket back on the frontier with its branch committed in the worktree, so the next run resumes the review there — `workspace.prepare` reuses the worktree, the resumed review runs with `cwd` + `target` (the branch-diff prompt) and `deferFollowUp` — instead of starting a new worker shift on it. Status tells the two owed cases apart: resolved owes an after-land review, ready owes a before-land one, whatever `review.when` says now.
- The resumed before-land review's verdict is handled like the worker's own before-land one: accept/follow-up land the branch through `landResolvedBranch` (a follow-up is filed only once it lands; a failed or conflicting landing is not reworked by the scan — the branch is kept, needs-info, a human lands it); a reopen is bounded by `review.maxRounds` (branch kept after that, else back on the frontier and the same run fixes it forward); `none` twice is needs-info with the branch kept.
- A ticket that still owes a verdict is never worked by a worker shift in between: on `skip` (no reviewer free) or `stopped`, the scan adds it to `seen`, so the frontier skips it for the rest of the run and the verdict stays owed to the next run.
- Six runner tests cover the resume (accept lands, no worker shift), reopen fix-forward, stopped-again (STOP lands in the repo root, not the worktree, mid-review), no reviewer free, `none` twice, and the maxRounds reopen. Guides (en + uk) and `references/config.md` describe it; `npm run sync-skills` + `npm run llms` were run. Verify: `node --test packages/core/test/runner.test.js packages/core/test/config.test.js` 134 pass; `npm test` 668 pass, 10 skipped, 0 fail.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 98635 in / 40594 out tokens, $1.1448, 52 turns
- Time: 12m 31s
- Verify: passed
- Outcome: resolved

### Review — pi xai/grok-4.7 (high)
- Verdict: reopen — The new ready-ticket scan does not skip paused features and reads the whole ticket file, so a stopped before-land review lands a paused feature's branch and an unworked OpenSpec sibling.
- Time: 10m 59s
- Verify: passed
- Findings:

> I'll review the unlanded change against the ticket, spec, and verify gate. First I'm reading the ticket, spec, and the review skill.
> The ticket is a follow-up from the review of 02. I'll read that review block and the unlanded diff next.
> The committed range against main is empty; the ticket work is uncommitted. I'll review that worktree diff and the review-path code.
> The resume path is in `reviewUnfinishedReviews`. I'll read that against the worker's before-land landing path and the stop handling.
> The resume path looks complete on the scratch tracker. I'll run the verify gate and probe the pause and OpenSpec cases the last review flagged.
> The verify gate's unit tests passed. `npm test` failed on one pi skill-filter timeout, and the probes showed the new scan landing the wrong branches. I'll re-run that test and confirm whether it's related.
> The scratch happy path works, and the verify gate is green. The new scan still lands branches it must not touch.
> 
> `node --test packages/core/test/runner.test.js packages/core/test/config.test.js` passed (134). `npm test` hit one unrelated timeout in `packages/pi/test/skill-filter.test.js` (pi idle, 60s); that test passed on re-run in 271ms. It is not part of this diff.
> 
> What holds: a ready ticket whose last review is `- Review: not finished` is resumed in its worktree (`cwd`, `target`, `deferFollowUp`) instead of a worker shift. Accept lands through `landResolvedBranch`. Reopen under `maxRounds` goes back to the frontier and the same run fixes forward; at the cap, and on `none`, the branch is kept and the ticket goes to `needs-info`. `skip` and `stopped` are added to `seen`, so no worker runs in between. The six new runner tests cover those paths. Guides and the synced `references/config.md` copies match that scratch path.
> 
> What does not:
> 
> The scan in `reviewUnfinishedReviews` takes every ready ticket with a workspace and `shouldReview`, and decides "unfinished" from `readFile(t.path)` — the whole file. It never checks `featurePaused`.
> 
> A paused feature is not on the frontier (`docs/guide.md`: `run` skips it; the runner takes no further ticket of it). A probe with feature `a` paused, ticket `a/01` ready and `- Review: not finished (stopped)`, and a normal `b/01`, still resumed `a/01`, landed it, and set it `resolved`, then worked `b/01`. Pause after a STOP is how you freeze a feature whose review was cut off. This change undoes that.
> 
> OpenSpec shares one `.shiftwork.md` across tasks. With the unfinished review only on task `1.2`, task `1.1` (ready, never worked, no review of its own) was given a before-land resume and landed, and its checkbox was ticked. The same whole-file read also re-reviews an already-accepted resolved sibling when a later task's review is the last `### Review` in the file. `countReopenVerdicts` and `lastLandedLine` in this path read that same file, so another task's reopens count toward `maxRounds`.
> 
> A conflicting landing of a resumed accept is not reworked (status `needs-info`), but `landResolvedBranch` still writes `- Landing conflict with README.md; redone on top of abc123`, and `landing.reason` is missing, so the summary reason is the generic fallback. The note says the work was redone; nothing was. `keep()` is also skipped because those notes are already non-empty.

### Notes

- Operator (2026-10-02): rebased the agent's uncommitted work onto main and fixed the review's three findings — paused features are skipped, tickets sharing one file (OpenSpec) are never resumed, a conflicting resumed landing is a failed landing (reason + one "Branch kept"), not "redone"; plus the resumed accept now discards review leftovers before landing (review-before-land/02). Three new tests, each checked to fail without its fix. `npm test`: 676 pass, 0 fail. Landed as 9c73deb.

### Review — independent agent (before landing)
- Verdict: accept — all three findings fixed (the OpenSpec filter covers the after-land scan too); no regressions in the worker before-land path, discards or landing retries; skip/stopped/reopen/none handled without double work. Minor items fixed before landing: no double "Branch kept", indentation, guide wording for resolved OpenSpec tasks. Left as known limits: the resumed path neither claims the ticket nor checks blockers (another runner could pick it up meanwhile).
