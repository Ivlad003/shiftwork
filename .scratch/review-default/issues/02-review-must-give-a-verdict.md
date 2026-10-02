# 02: A review must give a verdict — no silent accept, its own budget, no handoff prompt, no network

**What to build:** Operator decision 2026-10-01, after the review of `github-watch/10` ran 52 minutes on `xai/grok-4.7` ($1.97) and ended with no verdict: the reviewer spent 39 minutes in one `gh api "repos/cli/cli/issues?state=all&per_page=5" --paginate` call against real GitHub, then at the soft limit (85% of `maxWallMin` 60) got the worker's "append a handoff note" prompt, which contradicts "change no files"; with no marker the runner recorded **accept**. In `runReviewShift` (`packages/core/src/runner.js`) and `packages/core/src/prompt.js`:

1. **No verdict is not accept.** When the review ends without a valid marker (or the shift fails), run it once more on the next model of the review tier's chain (a fresh context); when that one also gives none, record `- Verdict: none — <why>` and set the ticket to `needs-info` with `<shiftwork:needs-info reason="review gave no verdict twice; review it by hand"/>` in the comment. An unknown verdict word counts as no verdict. The ticket's landed commit stays.
2. **No handoff prompt in a review.** A review shift gets no worker soft-limit/handoff prompt. At the soft limit it gets instead: "Time is almost up: stop investigating and give your verdict now from what you have checked, with the marker." (`REVIEW_WRAP_UP_PROMPT` in `prompt.js`.)
3. **Its own budget.** `review.budget` (same fields as other budgets) is the review shift's whole budget; default `{ maxWallMin: 20, maxTurns: 60 }`. Ticket, tier and model budgets do not apply to reviews; `unlimited` lists do not lift it (only `review.budget` itself does).
4. **Local only.** `REVIEWER_PROMPT` adds: "Work locally: read the code, run the verify gate and the repo's tests. Do not call network services or live APIs (no `gh api`, `curl` or package installs); judge external calls by the code and the tests' stubs."
5. **`reason` is not a config field.** Ticket 01 added `reason` to `REVIEW_FIELDS`, so `"review": { "reason": "hi" }` in the config is silently accepted. Keep `reason` as an output of `checkReview` only: an operator-written `review.reason` fails as an unknown review field (operator review of ticket 01, 2026-10-01).
6. Update `packages/core/src/index.d.ts` (`review.budget`), `docs/guide.md` + `docs/guide.uk.md` ("Reviews after each ticket": retry, needs-info, the budget, local-only), `skills/shiftwork/references/config.md` (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/runner.test.js packages/core/test/config.test.js` · `npm test`

- [x] Runner test (fake backend): a review with no marker is retried once on the next chain model; a second miss records `Verdict: none` and sets the ticket to `needs-info`; a valid marker on the retry is recorded normally
- [x] Runner test: an unknown verdict word is retried like a missing marker, not accepted
- [x] Runner test: at the soft limit a review shift receives `REVIEW_WRAP_UP_PROMPT`, never the handoff prompt
- [x] Planner/runner test: the review route's budget is `review.budget` (default 20 min / 60 turns), independent of ticket, tier and model budgets
- [x] `REVIEWER_PROMPT` contains the local-only rule (prompt test)
- [x] Config test: `review: { reason: "x" }` fails as an unknown review field; the no-tier case still reports its reason
- [x] Guides (en + uk) and `references/config.md` describe retry, needs-info, `review.budget` and local-only

### Notes

- `reason` is no longer an accepted operator field, but `run` re-validates the already-validated config, and `checkReview` writes `review.reason` itself when there is no tier — so `checkReview` lets exactly that one value (`REVIEW_NO_TIER_REASON`) round-trip; any other `reason` fails as an unknown field. Without this, every config with no tiers broke at `run`'s second validation.
- The retry route is the next model of the review tier's chain after the used one (the chain's first model when the used one is the last or not in the chain), so a single-model chain retries on its only model in a fresh context. Cooldowns are not consulted for the retry: a cooling retry model fails and lands in `Verdict: none` + `needs-info`, which is the safe outcome.
- `review.budget` is filled only when reviews can run (enabled with a tier); disabled forms stay as before. In the runner the review route's budget is `review.budget` outright, so ticket/tier/model budgets and every `unlimited` list (including `run --no-budget`) are inert for reviews by construction.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 136192 in / 63519 out tokens, $2.4728, 86 turns
- Time: 21m 34s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/review-default-02 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: reopen — A null lift of review.budget does not survive shiftwork run's second validateConfig, so a lifted maxWallMin is restored to the 20-minute default.
- Time: 8m 36s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, spec, and recent commits.
> The landed commit is `82407e8`. I'll read the diff and the domain docs, then run the verify gate.
> The commit touches runner, config, and prompts. I'll read those paths and check whether `npm run llms` was supposed to regenerate docs.
> The null-lift of `review.budget` looks like it does not survive `run`'s second validation. I'll confirm that against the tests and the verify gate.
> The verify gate is green (`node --test packages/core/test/runner.test.js packages/core/test/config.test.js`, then `npm test`: 586 pass, 10 skipped). The no-verdict retry, wrap-up prompt, local-only rule, and `reason` rejection all match the ticket. One budget path does not.
> 
> `review.budget` is supposed to be the only way to lift a review limit. `reviewBudget` treats `null` as that lift and then deletes the field:
> 
> ```335:342:packages/core/src/config.js
> function reviewBudget(budget) {
> 	const out = { ...DEFAULT_REVIEW_BUDGET };
> 	for (const [key, limit] of Object.entries(budget ?? {})) {
> 		if (limit === undefined || limit === null) delete out[key];
> 		else out[key] = limit;
> 	}
> 	return out;
> }
> ```
> 
> `loadConfig` therefore turns `{ maxTurns: 40, maxWallMin: null }` into `{ maxTurns: 40 }`, which the new config test checks. `shiftwork run` validates again (`packages/cli/bin/shiftwork.js` spreads the already-validated config into `validateConfig`). The second pass no longer sees `null`, so it refills the default: `{ maxWallMin: 20, maxTurns: 40 }`. Lifting both defaults yields `{}` once and `{ maxWallMin: 20, maxTurns: 60 }` on the run path. The same change special-cased `reason` for this re-validation and did not do it for a lifted review budget, so a lifted wall-clock cap silently comes back as 20 minutes.
> 
> Everything else in the ticket holds: a missing or unknown marker is retried once on the next chain model (same model when the chain has one), a second miss records `Verdict: none` and `needs-info` with the landed commit left in place, the soft limit sends `REVIEW_WRAP_UP_PROMPT` and not the handoff steer, the review route's budget ignores ticket, tier, model, and `unlimited`, `review.reason` other than the no-tier string is rejected, and the guides plus synced `references/config.md` describe the new rules.
> 
> 
> 
> The landed review behavior matches the ticket and the verify gate is green, but lifting a review-budget field with null is undone on the actual run path.

### Notes

- Operator (2026-10-01): a review stopped by STOP or SIGTERM is not "no verdict". When the runner is stopping, do not spend the retry on the next model and do not set `needs-info`: leave the ticket as it is with `- Review: not finished (stopped)`, so the next run reviews it again. Seen on queue-order/01: SIGTERM cut grok-4.7, the retry on claude-opus-5 ran 11 s into the same stop, and the ticket went to needs-info.
- Attempt 1 (reopen fix): `reviewBudget` now keeps a lifted field as `null` in its output instead of deleting it (`{ ...DEFAULT_REVIEW_BUDGET, ...budget }`), so `run`'s second `validateConfig` — which spreads the already-validated config — round-trips the lift instead of refilling the 20-minute default. The meter already skips a `null` limit, so a lifted field means no limit at all, as in every other budget. The config test asserts the round-trip (`validateConfig(loadConfig(...))`).
- Attempt 1 (stopped review): `runReviewShift` detects a shift ended by the runner stopping (`handoff.kind === "stop"` — set by the STOP-file grace and by a signal, since `installSignalStop` writes STOP — or `stopReason === "STOP file"`): no retry is spent, the ticket is not set to `needs-info`, and the comment records `- Review: not finished (stopped)` on the model(s) used. A stop that lands mid-retry is recorded on the retried model. A stopped shift that still gave a valid marker is recorded normally — a verdict is a verdict. Two runner tests cover the stop-before-retry and stop-mid-retry paths; the guides (en + uk) and `references/config.md` describe it, and `npm run sync-skills` + `npm run llms` were run.
- Attempt 1 (second reopen — the next run never re-reviews): a resolved ticket whose last `### Review` never gave a verdict (`reviewUnfinished` in `runner.js`: the last review section carries a `- Review: not finished` line) is re-reviewed at the start of every run, before any new work (`reviewUnfinishedReviews` in `runFrontier`). A reopen puts the ticket back on the frontier and the same run fixes it forward; `none` goes to needs-info as ever; accept and follow-up only complete the review, so the ticket stays resolved and nothing is re-worked; a stop again — or a re-review with no reviewer free (`- Review: not finished (no reviewer free this run)` appended after the `Not run` note, which alone would end the obligation) — leaves the verdict owed to the next run. `--ticket` runs re-review nothing (they name one frontier ticket); `--feature` narrows the re-reviews like the frontier. The re-review's prompt says its earlier review never finished and points at the ticket's last `- Landed:` line (`resumed` + `landed` in `buildReviewPrompt`), since `git log -3` no longer has to reach the landed commit. Five runner tests cover accept-and-cleared, reopen-fix-forward, stopped-again, `--ticket`, and no-reviewer-free; the guides (en + uk) and `references/config.md` describe it, and `npm run sync-skills` + `npm run llms` were run.
- Attempt 1 (this attempt — the shift-3 work lost in the landing conflict, redone): the branch was clean at 6502e4d, so the re-review-at-start path was rebuilt on top of it. `reviewUnfinished` is tightened to the follow-up finding (filed as ticket 03, which this makes moot): a review is unfinished only when the last `### Review` section's **own status line** is `- Review: not finished` and it carries no `- Verdict:` line — a quoted not-finished line in findings (blockquoted, `> `-prefixed) is not a status line, so a re-review that quotes the note while giving its verdict never re-reviews again. A `reviewUnfinished` unit test covers own-status-line, later-verdict, quoted-line and Not-run cases, and a runner test proves a quoted line triggers no shift. The pi test race that failed the last review (`/shift run finds the shiftwork CLI and logs its output to a file`) is fixed: it now waits for `frontier is empty` in the log instead of reading it at its first line (`review off: …` lands first since review-default/01). Verify: `node --test packages/core/test/runner.test.js packages/core/test/config.test.js` 128 pass; `npm test` 662 pass, 10 skipped, 0 fail. `npm run sync-skills` + `npm run llms` were run.

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 62613 in / 22748 out tokens, $0.6229, 44 turns
- Time: 10m 52s (ticket total 10m 52s)
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/review-default-02 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: reopen — A review stopped by STOP or a signal is left resolved with “not finished (stopped)”, but the next run never reviews it: reviews only start after a landing in that run, and a resolved ticket is not on the frontier.
- Time: 7m 8s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, spec, and domain docs.
> The ticket landed in two commits after a reopen. I'll read those diffs and the domain docs next.
> The stop path and the budget round-trip are the reopen fixes. I'll trace how reviews are scheduled and how a stop is detected.
> The verify gate is green (`node --test packages/core/test/runner.test.js packages/core/test/config.test.js`: 110 pass; `npm test`: 601 pass, 10 skipped). The original acceptance criteria hold, and the previous reopen is fixed. The operator's stop rule is not.
> 
> A missing or unknown marker is retried once on the next chain model (the same model when the chain has one). A second miss records `Verdict: none` and `needs-info` with `<shiftwork:needs-info reason="review gave no verdict twice; review it by hand"/>`, and the landed commit stays. The soft limit sends `REVIEW_WRAP_UP_PROMPT`, not the handoff steer. The review route's budget is `review.budget` (default 20 min / 60 turns) and ignores ticket, tier, model, and `unlimited`. `review.reason` other than the no-tier string is rejected. A `null` lift now stays `null` through `run`'s second `validateConfig`, which the config test round-trips.
> 
> The stop path only does half of the operator note. `runReviewShift` skips the retry and does not set `needs-info` when the shift itself ended with `handoff.kind === "stop"` or `stopReason === "STOP file"`, and it writes `- Review: not finished (stopped)`. The ticket is already `resolved` before the review starts, and a stopped review returns `resolve`. The frontier is only `ready-for-agent`, and reviews run only after a landing in that same `workTicket`. Nothing scans for an unfinished review, and `run --ticket` refuses a resolved ticket. The next run does not review it. `docs/guide.md`, `docs/guide.uk.md`, and `references/config.md` say that it does.
> 
> 
> 
> The landed review rules match the ticket and the verify gate is green, but a stopped review is dropped instead of being reviewed again on the next run.

### Shift 3 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 82593 in / 36128 out tokens, $1.1181, 65 turns
- Time: 14m 3s (ticket total 14m 3s)
- Verify: passed
- Outcome: resolved

### Review — pi xai/grok-4.7 (high)
- Verdict: follow-up — Treat a review as unfinished only when the last review section's own status line is `- Review: not finished` and it has no verdict, so a quoted not-finished line in findings does not re-review the ticket forever.
- Time: 11m 55s
- Verify: failed at `npm test` (exit 1)

```
y how long the shift took, and the ticket total from the second shift on (26.389952ms)
✔ formatDuration renders seconds, minutes and hours (0.42703ms)
✔ parallel: 2 fills both slots with the current feature's ready tickets first (134.959218ms)
✔ parallel: 2 works two independent tickets at once (64.865868ms)
✔ a ticket blocked by a running parallel ticket starts only after it resolves (111.621619ms)
✔ a provider at its concurrency cap is skipped for the next model, and no cooldown is written (101.757152ms)
✔ parallel landings go through one queue: one landing at a time (116.099395ms)
✔ a parallel run keeps re-verifying and landing while the target keeps moving (65.610542ms)
✔ parallel: 2 lists both workers in the run state while they run (105.342271ms)
✔ a STOP file hands off both parallel workers (98.895854ms)
✔ a failed worker lets the others settle before the error propagates (192.350242ms)
✔ a review whose verify re-run fails records the failing output, like a shift report (17.970708ms)
✔ claim returns a claim for a free frontier ticket and marks it claimed (98.776348ms)
✔ a ticket claimed by a live process can't be claimed again (56.24106ms)
✔ a claim left by a dead process is taken over (190.279192ms)
✔ setStatus changes only the Status line (28.932694ms)
✔ appendComment creates the Comments section when it's missing (13.41934ms)
✔ appendComment appends after existing comments (21.195276ms)
✔ release lets the ticket be claimed again (51.39505ms)
✔ a failed write leaves the ticket intact and no temp files behind (12.965938ms)
✔ orderFrontier: started features before not started, then feature name, then number (32.90647ms)
✔ orderFrontier: the current feature goes before every other (0.927105ms)
✔ orderFrontier: among not started features, feature name then ticket number (0.615321ms)
✔ frontier() returns the feature-by-feature order, an orphaned claim included (146.994292ms)
✔ setStatus updates the spec table and leaves bytes outside the markers unchanged (32.126679ms)
✔ missing spec markers are appended once, and a missing spec.md is left alone (61.709719ms)
✔ the last route column shows the model of the latest shift report (43.94627ms)
✔ the spec table ignores markers mentioned in prose and fills the block on its own lines (53.834523ms)
✔ VERSION matches shiftwork-core's package.json, so `shiftwork --version` never drifts (3.423116ms)
✔ a real pi lists the shift command with its subcommands (1648.626482ms)
✔ /shift answers with the frontier of ready tickets (1815.009169ms)
✔ /shift stop writes the STOP file (1437.860065ms)
✔ /shift run starts a detached runner, returns at once and shows a status widget (3486.197421ms)
✖ /shift run finds the shiftwork CLI and logs its output to a file (848.886919ms)
✔ /shift run refuses to start a second runner (1293.032206ms)
✔ loading the pi-shiftwork package advertises the shiftwork skill (2119.719763ms)
✔ switching the model changes the advertised skills (1147.863758ms)
✔ a model without a tier leaves skills untouched (822.090295ms)
ℹ tests 667
ℹ suites 0
ℹ pass 656
ℹ fail 1
ℹ cancelled 0
ℹ skipped 10
ℹ todo 0
ℹ duration_ms 41201.178244

✖ failing tests:

test at packages/pi/test/shift-command.test.js:122:1
✖ /shift run finds the shiftwork CLI and logs its output to a file (848.886919ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /frontier is empty/. Input:
  
  'shiftwork: review off: no tier to review on; set review.tier\n'
  
      at TestContext.<anonymous> (file:///home/kosmodev/.cache/shiftwork/worktrees/shiftwork-3b035128/review-default-02/packages/pi/test/shift-command.test.js:132:9)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'shiftwork: review off: no tier to review on; set review.tier\n',
    expected: /frontier is empty/,
    operator: 'match',
    diff: 'simple'
  }
```

- Findings:

> I'll review the unlanded change against the ticket and spec, starting with the ticket, spec, and the review skill.
> The ticket history includes two reopens. I'll read the rest of the ticket and the unlanded diff against main.
> `main...HEAD` is empty, but the worktree has uncommitted edits. I'll inspect those and how this branch relates to main.
> The committed range against main is empty; the ticket work is uncommitted. I'll read that diff and how a pre-land review is supposed to see it.
> The reopen fix is the uncommitted re-review path. I'll trace how a stopped review is picked up and how verdicts are applied.
> The file read doesn't match the diff. I'll confirm which copy of the runner the worktree actually has.
> `npm test` failed in the pi shift command. I'll see whether that failure comes from this change.
> The reopen is fixed for resolved tickets, and the original review rules still hold. One detection hole can re-review a ticket that already has a verdict.
> 
> The uncommitted worktree diff is the change under review (`main...HEAD` is empty; landing commits the worktree). The targeted gate passed (`node --test packages/core/test/runner.test.js packages/core/test/config.test.js`, 125 pass). `npm test` was 656 pass, 10 skipped, 1 fail: `packages/pi/test/shift-command.test.js` read the dry-run log as soon as it contained `review off: no tier to review on`, before `frontier is empty`. That path is not in this diff.
> 
> What holds:
> 
> - A missing or unknown marker is still retried once; a second miss is `Verdict: none` and `needs-info`, and the landed commit stays.
> - The soft limit still sends `REVIEW_WRAP_UP_PROMPT`, not the handoff steer. `REVIEWER_PROMPT` still has the local-only rule. `review.budget` is still the review route's whole budget, and a `null` lift still round-trips through `validateConfig`. `review.reason` other than the no-tier string is still rejected.
> - A resolved ticket whose last `### Review` carries `- Review: not finished` is re-reviewed at the start of the next run, before new work. Accept leaves it resolved and a later run does not review it again. Reopen puts it back on the frontier and the same run fixes it forward. A stop again, or no reviewer free, keeps the obligation (`- Review: not finished (no reviewer free this run)` after the `Not run` note). `--ticket` skips the pass. The resumed prompt points at the last `- Landed:` line. Guides (en + uk) and the synced `references/config.md` copies describe that.
> 
> The hole is `reviewUnfinished` in `packages/core/src/runner.js`. It treats the ticket as unfinished when `- Review: not finished` appears anywhere after the last `### Review` heading, not only as that section's own status line. Findings are stored as blockquotes, so a re-review that quotes the note — the resumed prompt tells the reviewer that line is not a verdict — still matches after `- Verdict: accept`. The next run reviews it again. The accept test never quotes the line, so it stays green.
- Follow-up: review-default/03 — Follow-up to review-default/02: Treat a review as unfinished only when the last…

- Landed: merge conflict in packages/core/src/runner.js with the landed 6502e4d; branch shiftwork/review-default-02 kept
- Landing conflict with packages/core/src/runner.js; redone on top of 6502e4d

### Shift 4 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 88784 in / 36857 out tokens, $0.9573, 49 turns
- Time: 11m 0s (ticket total 25m 2s)
- Verify: passed
- Outcome: resolved

### Review — pi xai/grok-4.7 (high)
- Verdict: follow-up — Resume a stopped before-land review in its worktree at the start of the next run instead of starting a new worker shift.
- Time: 11m 42s
- Verify: passed
- Findings:

> I'll review the unlanded change against the ticket and spec, starting with the ticket, spec, and the branch diff.
> The committed range against main is empty; the ticket work is uncommitted. I'll read that diff and the domain docs next.
> The reopen fix is the uncommitted re-review path. I'll trace how a stopped review is picked up and how verdicts are applied.
> The default is now before-land, so a stopped review may land back on the frontier instead of resolved. I'll check whether the next run actually reviews it.
> The verify gate is green: `node --test packages/core/test/runner.test.js packages/core/test/config.test.js` (128 pass) and `npm test` (662 pass, 10 skipped). The uncommitted worktree diff is the change under review (`main...HEAD` is empty).
> 
> What holds:
> 
> - A missing or unknown marker is still retried once; a second miss is `Verdict: none` and `needs-info`, and the landed commit stays.
> - The soft limit still sends `REVIEW_WRAP_UP_PROMPT`, not the handoff steer. `REVIEWER_PROMPT` still has the local-only rule. `review.budget` is still the review route’s whole budget, and a `null` lift still round-trips. `review.reason` other than the no-tier string is still rejected.
> - A resolved ticket whose last `### Review` has its own `- Review: not finished` line and no `- Verdict:` is re-reviewed before new work. Accept leaves it resolved and a later run does not review it again. Reopen puts it back on the frontier and the same run fixes it forward. A stop again, or no reviewer free, keeps the obligation. `--ticket` skips the pass. A blockquoted not-finished line no longer matches. Guides (en + uk) and the synced `references/config.md` copies describe that. The pi dry-run log test now waits for `frontier is empty`.
> 
> The default path is still not a review. `review.when` defaults to `before-land`. A review stopped by STOP sets the ticket back to `ready-for-agent` and returns. `reviewUnfinishedReviews` only scans `resolved` tickets, so the next run starts a worker shift on that branch instead of judging it. That worker can change the commit, or send the ticket to `needs-info`, before any review runs. `references/config.md` says every stopped review is re-reviewed at the start; the guide’s “back on the frontier” clause is what the code does.
> 
> Two smaller holes in the new scan: it reads the whole `ticket.path`, so an OpenSpec `.shiftwork.md` (one file, many tasks) re-reviews every resolved task or none of them based on the file’s last `### Review`; and it does not skip `featurePaused`, so `run` still spends a review shift on a paused feature.
- Follow-up: review-default/04 — Follow-up to review-default/02: Resume a stopped before-land review in its work…

- Target moved to b6eb123: branch rebased onto it, verify gate re-run: passed
- Landed: merged shiftwork/review-default-02 into main
