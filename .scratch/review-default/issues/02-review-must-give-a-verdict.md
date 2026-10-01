# 02: A review must give a verdict — no silent accept, its own budget, no handoff prompt, no network

**What to build:** Operator decision 2026-10-01, after the review of `github-watch/10` ran 52 minutes on `xai/grok-4.7` ($1.97) and ended with no verdict: the reviewer spent 39 minutes in one `gh api "repos/cli/cli/issues?state=all&per_page=5" --paginate` call against real GitHub, then at the soft limit (85% of `maxWallMin` 60) got the worker's "append a handoff note" prompt, which contradicts "change no files"; with no marker the runner recorded **accept**. In `runReviewShift` (`packages/core/src/runner.js`) and `packages/core/src/prompt.js`:

1. **No verdict is not accept.** When the review ends without a valid marker (or the shift fails), run it once more on the next model of the review tier's chain (a fresh context); when that one also gives none, record `- Verdict: none — <why>` and set the ticket to `needs-info` with `<shiftwork:needs-info reason="review gave no verdict twice; review it by hand"/>` in the comment. An unknown verdict word counts as no verdict. The ticket's landed commit stays.
2. **No handoff prompt in a review.** A review shift gets no worker soft-limit/handoff prompt. At the soft limit it gets instead: "Time is almost up: stop investigating and give your verdict now from what you have checked, with the marker." (`REVIEW_WRAP_UP_PROMPT` in `prompt.js`.)
3. **Its own budget.** `review.budget` (same fields as other budgets) is the review shift's whole budget; default `{ maxWallMin: 20, maxTurns: 60 }`. Ticket, tier and model budgets do not apply to reviews; `unlimited` lists do not lift it (only `review.budget` itself does).
4. **Local only.** `REVIEWER_PROMPT` adds: "Work locally: read the code, run the verify gate and the repo's tests. Do not call network services or live APIs (no `gh api`, `curl` or package installs); judge external calls by the code and the tests' stubs."
5. **`reason` is not a config field.** Ticket 01 added `reason` to `REVIEW_FIELDS`, so `"review": { "reason": "hi" }` in the config is silently accepted. Keep `reason` as an output of `checkReview` only: an operator-written `review.reason` fails as an unknown review field (operator review of ticket 01, 2026-10-01).
6. Update `packages/core/src/index.d.ts` (`review.budget`), `docs/guide.md` + `docs/guide.uk.md` ("Reviews after each ticket": retry, needs-info, the budget, local-only), `skills/shiftwork/references/config.md` (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** 01

**Status:** ready-for-agent
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
