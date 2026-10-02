# 03: Follow-up to review-before-land/02: Discard worktree leftovers again after each…

**What to build:** Discard worktree leftovers again after each rebase re-verify in landResolvedBranch, before the next land, so a moved target cannot commit files the review never saw. Filed by the review of review-before-land/02 — see its "### Review" block in .scratch/review-before-land/issues/02-land-only-reviewed-work.md.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/git.test.js packages/core/test/runner.test.js` · `npm test`

- [x] It works

### Notes

- `packages/core/src/runner.js`: `landResolvedBranch` takes a `discardAfterReview` flag; on the before-land call site only, after each rebase re-verify that passes (before the next `land`), the worktree leftovers are discarded again via `workspace.discardAfterReview`, and any discarded paths are noted as `- Discarded after re-verify: <files>` in the landing notes. The after-land and no-review landing paths keep today's behaviour (flag off, nothing discarded in the rebase round).
- `packages/core/test/runner.test.js`: new before-land test — the first `land` reports a moved target, the re-verify's stray is discarded again before the second `land` (call order asserted), and the `- Discarded after re-verify` note sits between `- Target moved …` and `- Landed …`; new after-land rebase test asserting nothing is discarded across the round; the no-review rebase test now also asserts no discard.
- `packages/cli/test/git.test.js`: real-repo test — after a reviewed commit and a rebase (parallel landing moved the target), the re-verify's edit/untracked stray are discarded again (ignored files kept), and the next `land` merges exactly the reviewed commit: one `shiftwork: f/01` landing commit, the stray never lands.
- Both verify gates pass: targeted `node --test` (135 tests) and full `npm test` (677 tests, 0 fail).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop, error: Request timed out.
- Usage: 70046 in / 12941 out tokens, $0.2800, 24 turns
- Time: 9m 4s
- Verify: passed
- Outcome: resolved

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — Before-land rebase re-verify leftovers are discarded again before the next land, and the other landing paths are unchanged.
- Time: 7m 26s
- Verify: failed at `npm test` (exit 1)

```
d review with no verdict lands nothing: needs-info, branch kept (8.087256ms)
✔ the second before-land reopen (maxRounds) goes to needs-info: nothing lands, the branch is kept (22.193868ms)
✔ parallel: a before-land reopen lands nothing while another slot's ticket lands (39.125605ms)
✔ a review whose tier is all cooling is recorded as not run (13.192562ms)
✔ shift reports say how long the shift took, and the ticket total from the second shift on (9.200218ms)
✔ formatDuration renders seconds, minutes and hours (0.184807ms)
✔ parallel: 2 fills both slots with the current feature's ready tickets first (96.093282ms)
✔ parallel: 2 works two independent tickets at once (75.934069ms)
✔ a ticket blocked by a running parallel ticket starts only after it resolves (79.847665ms)
✔ a provider at its concurrency cap is skipped for the next model, and no cooldown is written (39.819342ms)
✔ parallel landings go through one queue: one landing at a time (77.958377ms)
✔ a parallel run keeps re-verifying and landing while the target keeps moving (43.096009ms)
✔ parallel: 2 lists both workers in the run state while they run (53.18829ms)
✔ a STOP file hands off both parallel workers (72.110017ms)
✔ a failed worker lets the others settle before the error propagates (173.784612ms)
✔ a review whose verify re-run fails records the failing output, like a shift report (6.2801ms)
✔ claim returns a claim for a free frontier ticket and marks it claimed (13.551999ms)
✔ a ticket claimed by a live process can't be claimed again (12.63232ms)
✔ a claim left by a dead process is taken over (35.425274ms)
✔ setStatus changes only the Status line (3.59433ms)
✔ appendComment creates the Comments section when it's missing (1.685645ms)
✔ appendComment appends after existing comments (1.8946ms)
✔ release lets the ticket be claimed again (4.658113ms)
✔ a failed write leaves the ticket intact and no temp files behind (2.395348ms)
✔ orderFrontier: started features before not started, then feature name, then number (9.582342ms)
✔ orderFrontier: the current feature goes before every other (0.333375ms)
✔ orderFrontier: among not started features, feature name then ticket number (0.177347ms)
✔ frontier() returns the feature-by-feature order, an orphaned claim included (31.986368ms)
✔ setStatus updates the spec table and leaves bytes outside the markers unchanged (3.94387ms)
✔ missing spec markers are appended once, and a missing spec.md is left alone (6.565323ms)
✔ the last route column shows the model of the latest shift report (4.706162ms)
✔ the spec table ignores markers mentioned in prose and fills the block on its own lines (3.163429ms)
✔ VERSION matches shiftwork-core's package.json, so `shiftwork --version` never drifts (1.324331ms)
✔ a real pi lists the shift command with its subcommands (489.865752ms)
✔ /shift answers with the frontier of ready tickets (412.183347ms)
✔ /shift stop writes the STOP file (360.565269ms)
✔ /shift run starts a detached runner, returns at once and shows a status widget (2332.620467ms)
✔ /shift run finds the shiftwork CLI and logs its output to a file (385.227857ms)
✔ /shift run refuses to start a second runner (384.367062ms)
✔ loading the pi-shiftwork package advertises the shiftwork skill (572.182859ms)
✖ switching the model changes the advertised skills (60522.755406ms)
✔ a model without a tier leaves skills untouched (302.100786ms)
ℹ tests 677
ℹ suites 0
ℹ pass 666
ℹ fail 1
ℹ cancelled 0
ℹ skipped 10
ℹ todo 0
ℹ duration_ms 67899.428626

✖ failing tests:

test at packages/pi/test/skill-filter.test.js:73:1
✖ switching the model changes the advertised skills (60522.755406ms)
  Error: Timeout waiting for agent to become idle. Stderr: 
      at Timeout._onTimeout (file:///home/kosmodev/.cache/shiftwork/worktrees/shiftwork-3b035128/review-before-land-03/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js:370:24)
      at listOnTimeout (node:internal/timers:685:17)
      at process.processTimers (node:internal/timers:618:7)
```

- Findings:

> I'll review ticket 03 against its spec and the unlanded branch, starting with the ticket, comments, and the change itself.
> The branch has no commits ahead of `main`; the work looks uncommitted. I'll inspect the diff and the prior ticket before judging.
> The ticket’s work is still uncommitted. I’ll read that diff and the landing path it changes.
> The change matches the ticket’s shape. I’ll run the verify gate and check the rebase path for leftover commits.
> The before-land rebase hole is closed. After an accepted review, `landResolvedBranch` still re-runs Verify when the target moves, and on that path only it now discards worktree leftovers again before the next `land`.
> 
> `discardAfterReview` is passed only from the before-land call site. Inside the rebase loop, after a passing re-verify and before the next `land`, it calls `workspace.discardAfterReview` and notes any paths as `- Discarded after re-verify: <files>`. After-land and no-review landings leave the flag off. Reopen, no-verdict, and a failed re-verify still do not land, so they do not need this discard.
> 
> The tests match that split. The runner test asserts call order `land`, `discardAfterReview`, `land`, and that the note sits between `- Target moved …` and `- Landed …`. The after-land rebase test and the no-review rebase test assert nothing is discarded. The real-repo test rebases onto a moved target, drops the re-verify edit and the untracked stray, keeps the ignored file, and merges one `shiftwork: f/01` commit.
> 
> `node --test packages/cli/test/git.test.js packages/core/test/runner.test.js` passed (135). `npm test` passed (677, 0 fail).

- Target moved to 57df775: branch rebased onto it, verify gate re-run: passed
- Landed: merged shiftwork/review-before-land-03 into main
