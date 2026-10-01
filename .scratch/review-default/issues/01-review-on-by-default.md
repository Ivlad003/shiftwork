# 01: Review shifts on by default, on the strongest configured tier

**What to build:** As the spec describes. In `packages/core/src/config.js`: `DEFAULTS.review` = `{ enabled: true, when: "resolve" }`; `checkReview` accepts `false` (→ `{ enabled: false, when: "resolve" }`); when enabled and `tier` is missing it picks the strongest configured tier (`premium` → `standard` → `quick`, using `TIER_ORDER` from the planner or a shared constant, else the first key of `tiers`); with no tiers it sets `enabled: false` and `reason: "no tier to review on; set review.tier"`; an unknown `review.tier` still fails. In `packages/cli/bin/shiftwork.js`: `run --no-review` turns reviews off for the run; at start the runner prints `shiftwork: review · <tier> for every ticket` (or `· features a, b` / `· types code` when filtered), `shiftwork: review off (--no-review)` / `(config)`, or the no-tier reason. Update every test or fixture that relied on reviews being off by default to set `review: false`. Update `packages/core/src/index.d.ts`, `docs/guide.md` + `docs/guide.uk.md` ("Reviews after each ticket" and the full example), `skills/shiftwork/references/config.md` (then `npm run sync-skills`), `shiftwork run --help`, and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/config.test.js packages/core/test/runner.test.js packages/cli/test/init-dry-run.test.js` · `npm test`

- [ ] Config tests: no `review` block → enabled on `premium` when it exists; only `standard`+`quick` → `standard`; tiers `{ local }` only → `local`; no tiers → disabled with the reason; `review: false` and `{ enabled: false }` → disabled; `{ tier: "nope" }` fails; explicit `tier` wins
- [ ] Runner/e2e test: with no `review` block a resolved ticket gets a review shift (stub backend); with `--no-review` it doesn't
- [ ] Dry-run test: without a `review` block the lines show `review=premium`; `--no-review` shows no review column
- [ ] The start line names the tier or says why reviews are off
- [ ] Guides (en + uk), `references/config.md` and `run --help` say reviews are on by default, on which tier, what that may cost, and how to turn them off
