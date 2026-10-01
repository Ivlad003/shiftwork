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

- [ ] Runner test (fake backend): a review with no marker is retried once on the next chain model; a second miss records `Verdict: none` and sets the ticket to `needs-info`; a valid marker on the retry is recorded normally
- [ ] Runner test: an unknown verdict word is retried like a missing marker, not accepted
- [ ] Runner test: at the soft limit a review shift receives `REVIEW_WRAP_UP_PROMPT`, never the handoff prompt
- [ ] Planner/runner test: the review route's budget is `review.budget` (default 20 min / 60 turns), independent of ticket, tier and model budgets
- [ ] `REVIEWER_PROMPT` contains the local-only rule (prompt test)
- [ ] Config test: `review: { reason: "x" }` fails as an unknown review field; the no-tier case still reports its reason
- [ ] Guides (en + uk) and `references/config.md` describe retry, needs-info, `review.budget` and local-only
