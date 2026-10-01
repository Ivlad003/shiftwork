# Spec: review shifts on by default, for every ticket

**Status:** ready-for-agent

Source: operator request, 2026-10-01. Vocabulary: `CONTEXT.md`. Builds on review shifts (`.scratch/local-and-skills/issues/02-review-shifts.md`).

## Problem Statement

Reviews are off unless `.pi/shiftwork.json` has `"review": { "enabled": true, "tier": … }`, and a `features` list easily leaves new features out. In this repo nine landed tickets went unreviewed because their features weren't listed. A ticket that passes its Verify gate can still be wrong; the operator wants every ticket reviewed unless they say otherwise.

## Solution

- **On by default.** Without a `review` block, every resolved ticket gets a review shift. `features` and `types` stay optional filters; without them, every ticket is reviewed.
- **Default tier: the strongest one configured.** When `review.tier` is not set: `premium` if it exists, else `standard`, else `quick` (`TIER_ORDER`, strongest first), else the first tier declared in `tiers`. With no tiers at all, reviews stay off and the runner says so once at start (`review: on by default but no tier to review on; set review.tier`).
- **Opt out.** `"review": false` or `"review": { "enabled": false }` in the config; `shiftwork run --no-review` for one run.
- **Visible.** The runner prints at start `review: <tier> for every ticket` (or the filters), and `--dry-run` shows the `review=` column, as today when reviews are on.

## Implementation Decisions

- `DEFAULTS.review` in `packages/core/src/config.js` becomes `{ enabled: true, when: "resolve" }`; `checkReview` fills `tier` from the tiers when it is missing, and no longer fails "tier required when enabled" — it fails only when `review.tier` names an unknown tier. `review: false` normalizes to `{ enabled: false, when: "resolve" }`.
- `run --no-review` sets `config.review.enabled = false` for that run (like `--no-budget` overrides `unlimited`).
- Tests that assumed reviews off by default set `review: false` explicitly (or the fixtures do), so no test starts a review shift by accident.
- Docs: `docs/guide.md` + `docs/guide.uk.md` ("Reviews after each ticket": on by default, cost note — reviews run on the strongest tier, often a paid model — and how to turn them off), `skills/shiftwork/references/config.md` (then `npm run sync-skills`), `shiftwork run --help`, `npm run llms`. `shiftwork init` mentions reviews in what it prints.

## Out of Scope

- Reviewing tickets that already landed (the operator reviews those by hand).
