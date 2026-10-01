# 01: Review shifts on by default, on the strongest configured tier

**What to build:** As the spec describes. In `packages/core/src/config.js`: `DEFAULTS.review` = `{ enabled: true, when: "resolve" }`; `checkReview` accepts `false` (→ `{ enabled: false, when: "resolve" }`); when enabled and `tier` is missing it picks the strongest configured tier (`premium` → `standard` → `quick`, using `TIER_ORDER` from the planner or a shared constant, else the first key of `tiers`); with no tiers it sets `enabled: false` and `reason: "no tier to review on; set review.tier"`; an unknown `review.tier` still fails. In `packages/cli/bin/shiftwork.js`: `run --no-review` turns reviews off for the run; at start the runner prints `shiftwork: review · <tier> for every ticket` (or `· features a, b` / `· types code` when filtered), `shiftwork: review off (--no-review)` / `(config)`, or the no-tier reason. Update every test or fixture that relied on reviews being off by default to set `review: false`. Update `packages/core/src/index.d.ts`, `docs/guide.md` + `docs/guide.uk.md` ("Reviews after each ticket" and the full example), `skills/shiftwork/references/config.md` (then `npm run sync-skills`), `shiftwork run --help`, and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/config.test.js packages/core/test/runner.test.js packages/cli/test/init-dry-run.test.js` · `npm test`

- [x] Config tests: no `review` block → enabled on `premium` when it exists; only `standard`+`quick` → `standard`; tiers `{ local }` only → `local`; no tiers → disabled with the reason; `review: false` and `{ enabled: false }` → disabled; `{ tier: "nope" }` fails; explicit `tier` wins
- [x] Runner/e2e test: with no `review` block a resolved ticket gets a review shift (stub backend); with `--no-review` it doesn't
- [x] Dry-run test: without a `review` block the lines show `review=premium`; `--no-review` shows no review column
- [x] The start line names the tier or says why reviews are off
- [x] Guides (en + uk), `references/config.md` and `run --help` say reviews are on by default, on which tier, what that may cost, and how to turn them off

### Notes

- `checkReview` now accepts `false` (and `true`) besides the object form; the strongest-tier default uses `TIER_ORDER` imported from `planner.js` (planner has no imports, so no cycle). `reason` is a `checkReview`-set field, but it is in `REVIEW_FIELDS` so the CLI's second `validateConfig` of an already-normalized config keeps passing.
- The review start line prints from `bin/shiftwork.js` `run()` before the dry-run branch, so dry runs, normal runs and dark-factory runs all say it once at start.
- Core tests that resolve tickets through a `validateConfig`-built config set `review: false` (the five backend-availability tests and the shift-report test); plain-object configs are untouched because `shouldReview` only looks at `config.review`.
- New e2e test in `run.e2e.test.js`: one script replayed per shift — the implement shift ends with the marker text (harmless there), the review shift replays it as its verdict.
- `init` prints one line mentioning reviews; `npm run sync-skills` and `npm run llms` re-run.
- Attempt 2: no code changes needed — the previous attempt's implementation was already complete and correct. The Shift 1 failure (`pi-backend.test.js` "context fill is reported for maxContextPct budgets") was environment flakiness in the real-pi test, not a regression: that file now passes 3/3 standalone runs. Full gate green: targeted `node --test` 107/107 pass, `npm test` 578 pass / 0 fail (10 skipped), twice in a row; `npm run sync-skills` and `npm run llms` re-run with no further diffs.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 79172 in / 30863 out tokens, $1.3439, 84 turns
- Time: 11m 3s
- Verify: failed at `npm test` (exit 1)

```
 new ready ticket in the feature (38.744426ms)
✔ a review without the marker is treated as accept with a warning (33.515249ms)
✔ an unknown review verdict is treated as accept with a warning (38.598032ms)
✔ a config with no review block reviews every resolved ticket, on the strongest configured tier (16.006189ms)
✔ a config with `review: false` resolves without a review shift (65.935907ms)
✔ the review features filter is respected per ticket (106.433378ms)
✔ the review types filter matches the ticket's effective type (48.521346ms)
✔ with a workspace, the review runs in the main repo with the landed message in its prompt (26.445322ms)
✔ a review whose tier is all cooling is recorded as not run (48.971935ms)
✔ shift reports say how long the shift took, and the ticket total from the second shift on (21.617614ms)
✔ formatDuration renders seconds, minutes and hours (0.16356ms)
✔ parallel: 2 works two independent tickets at once (52.22887ms)
✔ a ticket blocked by a running parallel ticket starts only after it resolves (106.085516ms)
✔ a provider at its concurrency cap is skipped for the next model, and no cooldown is written (60.51031ms)
✔ parallel landings go through one queue: one landing at a time (80.76404ms)
✔ parallel: 2 lists both workers in the run state while they run (54.105754ms)
✔ a STOP file hands off both parallel workers (84.062866ms)
✔ a failed worker lets the others settle before the error propagates (173.016665ms)
✔ a review whose verify re-run fails records the failing output, like a shift report (7.733257ms)
✔ claim returns a claim for a free frontier ticket and marks it claimed (14.030608ms)
✔ a ticket claimed by a live process can't be claimed again (7.214267ms)
✔ a claim left by a dead process is taken over (47.499263ms)
✔ setStatus changes only the Status line (3.142969ms)
✔ appendComment creates the Comments section when it's missing (3.712343ms)
✔ appendComment appends after existing comments (5.422492ms)
✔ release lets the ticket be claimed again (10.885766ms)
✔ a failed write leaves the ticket intact and no temp files behind (5.302779ms)
✔ setStatus updates the spec table and leaves bytes outside the markers unchanged (11.202761ms)
✔ missing spec markers are appended once, and a missing spec.md is left alone (25.456084ms)
✔ the last route column shows the model of the latest shift report (6.564223ms)
✔ the spec table ignores markers mentioned in prose and fills the block on its own lines (3.323366ms)
✔ VERSION matches shiftwork-core's package.json, so `shiftwork --version` never drifts (0.951495ms)
✔ a real pi lists the shift command with its subcommands (469.233867ms)
✔ /shift answers with the frontier of ready tickets (419.568579ms)
✔ /shift stop writes the STOP file (343.680055ms)
✔ /shift run starts a detached runner, returns at once and shows a status widget (2322.4826ms)
✔ /shift run finds the shiftwork CLI and logs its output to a file (378.974539ms)
✔ /shift run refuses to start a second runner (373.241876ms)
✔ loading the pi-shiftwork package advertises the shiftwork skill (539.699746ms)
✔ switching the model changes the advertised skills (478.902745ms)
✔ a model without a tier leaves skills untouched (419.656842ms)
ℹ tests 588
ℹ suites 0
ℹ pass 577
ℹ fail 1
ℹ cancelled 0
ℹ skipped 10
ℹ todo 0
ℹ duration_ms 10286.088194

✖ failing tests:

test at packages/cli/test/pi-backend.test.js:34:1
✖ a real pi shift runs tools and maps events to turns, text and end (1559.095536ms)
  AssertionError [ERR_ASSERTION]: context fill is reported for maxContextPct budgets
      at TestContext.<anonymous> (file:///home/kosmodev/.cache/shiftwork/worktrees/shiftwork-3b035128/review-default-01/packages/cli/test/pi-backend.test.js:45:9)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

- Outcome: new attempt

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 11631 in / 1990 out tokens, $0.0448, 10 turns
- Time: 1m 22s (ticket total 12m 26s)
- Verify: passed
- Outcome: needs-info: verify gate passed but landing failed: the target moved to 463da77: branch shiftwork/review-default-01 rebased onto it; re-verify and land again
- Target moved to 51970a8: branch rebased onto it, verify gate re-run: passed
- Landed: the target moved to 463da77: branch shiftwork/review-default-01 rebased onto it; re-verify and land again

### Notes

Landed by the operator (2026-10-01): the verify gate had passed but landing stopped because main moved; merged shiftwork/review-default-01 onto main by hand after `npm test` passed (581 pass, 0 fail). No review shift ran for it.
