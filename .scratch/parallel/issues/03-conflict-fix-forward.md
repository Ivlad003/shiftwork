# 03: Rebase or redo tickets that conflict with a parallel landing

**What to build:** When a ticket's branch no longer lands because another parallel ticket landed first, the workspace rebases the branch onto the new target in its worktree, runs the ticket's Verify gate again and lands. If the rebase conflicts, abort it and give the ticket one more shift in a fresh worktree from the new target, with `- Landing conflict with <files>; redone on top of <commit>` in its Comments. A second landing failure goes to needs-info as today (spec story 4).

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Git test with two real worktrees editing different lines of one file: the second is rebased, re-verified and lands
- [x] Git test with the same lines edited: the rebase aborts, a fix-forward shift runs from the new target, the Comments note the conflict
- [x] A second failure sets needs-info with the conflict files in the reason
- [x] Live check on a demo repo: `shiftwork run --parallel 2` with two tickets touching one file ends with both resolved

### Notes

- `git.js` `land`: when the branch no longer contains the target (a parallel landing moved it), the branch is **rebased onto the new target in its worktree** and `land` returns `{ ok: false, rebase: <commit> }` — the caller re-runs the ticket's Verify gate on that integrated state (both tickets' work in the worktree) and lands again, which now fast-forwards. If the rebase conflicts, it is aborted and `land` returns `{ ok: false, conflict: { files, commit } }`; the branch and the worktree are untouched. A rebase that cannot run at all falls through to the old `--no-ff` merge as before.
- `runner.js` `workTicket`: on `rebase` the gate is re-run in the worktree (`- Target moved to <commit>: branch rebased onto it, verify gate re-run: passed/failed`); on `conflict` the ticket gets **one** fix-forward shift — `- Landing conflict with <files>; redone on top of <commit>` in Comments, then `workspace.redo` drops the worktree and branch, `prepare` starts fresh from the new target, and the loop continues (same attempt: the gate had passed; the conflict is not the agent's fault). A second conflict, or a gate failure on the rebased branch, goes to needs-info as before, with the conflict files in the reason.
- Behaviour change, deliberate: a diverged target (parallel or operator commit) now lands as a **fast-forward after a rebase**, not a `--no-ff` merge commit — the gate must pass on the integrated state either way. The old git test pinning the merge commit was rewritten to pin the new flow.
- Tests: git-level (different lines → rebased, re-verified state in the worktree, second land fast-forwards; same line → conflict files + commit, abort leaves both trees clean, `redo` + `prepare` starts from the new target), runner-level (rebase-reverify-reland; gate failing on the rebased branch → needs-info; fix-forward shift sequence `prepare → land → redo → prepare → land` with Shift 2 in a fresh worktree; second conflict → needs-info with files in the reason), and a new e2e: real CLI `run --parallel 2`, two tickets both writing `hello.txt` — the second landing conflicts, is redone on top of the first, both resolve.
- Live check, demo repo (`/tmp/sw-live-03`, `parallel: 2`, two tickets appending different lines to the end of `greetings.txt`, `opencode-go/glm-5.3`): 02 landed first (`e36a9d1`); 01's landing conflicted, Comments got `- Landing conflict with greetings.txt; redone on top of e36a9d1`, Shift 2 re-applied `first: alpha` in the fresh worktree, gate passed, landed (`8d56103`). Both resolved; final `greetings.txt` holds both lines; no worktrees or branches left. A scripted-provider demo run (`/tmp/sw-demo-03`) shows the same flow, and a third e2e-style check is now part of the suite.
- CONTEXT.md: added **Landing conflict**. Guides (`docs/guide.md`, `docs/guide.uk.md`): the parallel paragraph now describes the rebase/redo-on-conflict flow, and the "not there yet" bullet about parallel landings is gone (02 and 03 closed both halves).
- Verify: `npm test` green — 433 tests, 423 pass, 10 pre-existing skips, 0 fail. New tests stress-run: git ×5, runner ×6, e2e ×3 — no flakes.
- Attempt 2: the Shift 1 failure was a flaky timeout in `packages/pi/test/skill-filter.test.js` ("switching the model changes the advertised skills"), unrelated to this ticket's changes. Re-ran the full `npm test` twice in the worktree: green both times (433 tests, 423 pass, 10 skips, 0 fail), including that test (~0.5 s vs the 60 s timeout). Git tests ×3, runner tests ×3, e2e ×3 — no flakes.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop, error: Stream ended without finish_reason
- Usage: 123900 in / 78015 out tokens, $2.2208, 79 turns
- Time: 33m 11s
- Verify: failed at `npm test` (exit 1)

```
ckend (26.758861ms)
✔ an unavailable cursor-agent (missing or not logged in) is skipped like a cooling provider (97.822028ms)
✔ a 429 on a free model cools that model only, and the next free model of the same provider runs (38.58242ms)
✔ shouldReview is off by default and respects the when/features/types filters (0.660444ms)
✔ an accepted review runs on the review tier and records ### Review (19.97427ms)
✔ a reopen verdict sends the ticket back to ready-for-agent with the reason (10.065846ms)
✔ a follow-up verdict files a new ready ticket in the feature (25.839468ms)
✔ a review without the marker is treated as accept with a warning (37.980525ms)
✔ an unknown review verdict is treated as accept with a warning (28.824272ms)
✔ reviews are off by default (6.464362ms)
✔ the review features filter is respected per ticket (43.614364ms)
✔ the review types filter matches the ticket's effective type (11.131735ms)
✔ with a workspace, the review runs in the main repo with the landed message in its prompt (21.728262ms)
✔ a review whose tier is all cooling is recorded as not run (23.511227ms)
✔ shift reports say how long the shift took, and the ticket total from the second shift on (13.989471ms)
✔ formatDuration renders seconds, minutes and hours (0.181714ms)
✔ parallel: 2 works two independent tickets at once (49.437852ms)
✔ a ticket blocked by a running parallel ticket starts only after it resolves (108.187754ms)
✔ a provider at its concurrency cap is skipped for the next model, and no cooldown is written (48.427262ms)
✔ parallel landings go through one queue: one landing at a time (78.133413ms)
✔ parallel: 2 lists both workers in the run state while they run (68.685707ms)
✔ a STOP file hands off both parallel workers (62.270804ms)
✔ a failed worker lets the others settle before the error propagates (174.296548ms)
✔ claim returns a claim for a free frontier ticket and marks it claimed (11.889974ms)
✔ a ticket claimed by a live process can't be claimed again (7.753915ms)
✔ a claim left by a dead process is taken over (40.379909ms)
✔ setStatus changes only the Status line (3.644656ms)
✔ appendComment creates the Comments section when it's missing (2.567936ms)
✔ appendComment appends after existing comments (3.450213ms)
✔ release lets the ticket be claimed again (9.704164ms)
✔ a failed write leaves the ticket intact and no temp files behind (2.206781ms)
✔ setStatus updates the spec table and leaves bytes outside the markers unchanged (2.776638ms)
✔ missing spec markers are appended once, and a missing spec.md is left alone (9.284566ms)
✔ the last route column shows the model of the latest shift report (3.305211ms)
✔ the spec table ignores markers mentioned in prose and fills the block on its own lines (3.269302ms)
✔ a real pi lists the shift command with its subcommands (420.124572ms)
✔ /shift answers with the frontier of ready tickets (396.91779ms)
✔ /shift stop writes the STOP file (414.066258ms)
✔ /shift run starts a detached runner, returns at once and shows a status widget (2482.348946ms)
✔ /shift run finds the shiftwork CLI and logs its output to a file (354.897846ms)
✔ /shift run refuses to start a second runner (345.866879ms)
✔ loading the pi-shiftwork package advertises the shiftwork skill (421.527222ms)
✖ switching the model changes the advertised skills (60397.994253ms)
✔ a model without a tier leaves skills untouched (267.839145ms)
ℹ tests 433
ℹ suites 0
ℹ pass 422
ℹ fail 1
ℹ cancelled 0
ℹ skipped 10
ℹ todo 0
ℹ duration_ms 66705.177769

✖ failing tests:

test at packages/pi/test/skill-filter.test.js:73:1
✖ switching the model changes the advertised skills (60397.994253ms)
  Error: Timeout waiting for agent to become idle. Stderr: 
      at Timeout._onTimeout (file:///home/kosmodev/.cache/shiftwork/worktrees/shiftwork-3b035128/parallel-03/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js:370:24)
      at listOnTimeout (node:internal/timers:685:17)
      at process.processTimers (node:internal/timers:618:7)
```

- Outcome: new attempt

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 13367 in / 2543 out tokens, $0.0545, 11 turns
- Time: 1m 47s (ticket total 34m 58s)
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/parallel-03 into main

### Review — pi opencode-go/glm-5.3 (medium)
- Verdict: accept — All four acceptance criteria are implemented and tested (git, runner and e2e levels), the verify gate is green, and the docs/CONTEXT updates match the deliberate behaviour change documented in the ticket.
- Time: 1m 32s
- Verify: failed at `npm test` (exit 1)
- Findings:

> The diff matches the ticket's claims. Now let me run the verify gate myself.
> The gate is green. Let me inspect the loop structure in `runner.js` to confirm the fix-forward `continue` re-enters a fresh shift and can't loop unboundedly, plus the full `land` in `git.js`.
> Everything checks out. Summary of the review:
> 
> **Verify gate:** `npm test` green — 433 tests, 423 pass, 10 pre-existing skips, 0 fail. The flaky `skill-filter` timeout from Shift 1's report (unrelated to this ticket) passes here in ~0.6 s, consistent with the ticket's flake diagnosis.
> 
> **Ticket criteria vs landed commit `b082792`:**
> - *Different lines, one file:* `git.test.js` — two worktrees, second `land` returns `{ ok: false, rebase: <sha> }` with the worktree holding the integrated state, second `land` fast-forwards and the worktree is cleaned up. ✔
> - *Same lines:* `git.test.js` — `land` returns `conflict: { files, commit }`, rebase aborted with both trees clean, `redo` drops the worktree and branch, `prepare` starts fresh from the new target (`rev-list --count main..HEAD` = 0). ✔
> - *Second failure → needs-info:* runner test with a persistent conflict asserts needs-info with the conflict files in the reason. ✔
> - *Live/e2e check:* a real-CLI e2e (`run --parallel 2`, two tickets both writing `hello.txt`) asserts both resolve, one ticket notes `- Landing conflict with hello.txt; redone on top of <sha>` and gets a Shift 2 in a fresh worktree. ✔ Plus the live demo runs recorded in the ticket notes.
> 
> **Implementation quality:** `git.js` rebase-in-worktree with abort-on-conflict and fall-through-to-merge when the rebase can't run is sound; landings stay serialized through the queue from ticket 02 (the rebase itself only touches the ticket's own worktree). `runner.js` re-runs the gate on the rebased worktree before re-landing, gives exactly one fix-forward (`conflictRedone` guard prevents unbounded redo), and keeps the attempt count on the redo (the gate had passed). The deliberate behaviour change (rebase-then-fast-forward instead of `--no-ff` merge) is pinned by the rewritten old test and documented in the ticket. `CONTEXT.md` gains **Landing conflict**; both guides describe the flow and drop the now-closed "not there yet" bullet.
> 
> **Working tree:** the uncommitted `.scratch` changes are the runner's own post-landing bookkeeping (shift reports, spec table) plus the `idea.md` deletion tracked as ticket 04 — not part of this diff.
> 
> No deviations from the spec, ticket, or repo standards found.

### Review — operator (Claude Code), 2026-09-30
- Live check on my own demo repo (`parallel: 2`; two tickets that insert different lines at **the same spot** of `app.conf`): 01 landed first; 02's landing conflicted in `app.conf`, got `- Landing conflict with app.conf; redone on top of d78e5ea`, a fresh shift on the new target added its line, and it landed. Final `app.conf` has both lines; no worktrees or `shiftwork/*` branches left.
- **Fixed:** the conflicted shift's report said `- Outcome: resolved` right above `- Landed: merge conflict…`. It now says `- Outcome: redo on the new target (landing conflict)` (test extended).
- **Fixed:** the runner's verify re-run after a review failed here (and after parallel/02's review) with only `failed at \`npm test\``, so there was nothing to act on. The `### Review` comment now carries the failing output tail, like a shift report. I couldn't reproduce the failure: 6 idle runs, 3 runs through `runVerify` without a TTY, and 2 runs with a simulated live runner were all green. Shift 1's failure here was a timeout in `packages/pi/test/skill-filter.test.js` (real pi RPC); the next red review will show which test it is.
- Verdict: accept. Phase 4 complete.
