# Spec: lift budget limits per tier and per model

**Status:** ready-for-agent

Source: GitHub issue #6 (Ivlad003/shiftwork, 2026-10-01). Vocabulary: `CONTEXT.md`. Builds on `run --no-budget` / `--no-limit` (commit 7920170).

## Problem Statement

`"unlimited"` in `.pi/shiftwork.json` (and `run --no-budget` / `--no-limit`) lifts limits for every shift of the run. An operator who wants a free or local tier, or one trusted model, to run without turn/time limits while paid models stay capped has no way to say so.

## Solution

`unlimited` is also accepted on a tier and on a model profile, with the same values as the top-level key (`true` or a list of limit names: `tokens`, `cost`, `turns`, `time`, `context`, `stall`):

```json
"tiers":  { "quick": { "chain": ["…"], "unlimited": ["turns", "time"] } },
"models": { "ollama/qwen3": { "unlimited": true } }
```

A shift on that tier or model runs with the union of the top-level, tier and model lists lifted.

## Implementation Decisions

- Validation in `packages/core/src/config.js` uses `normalizeUnlimited` with the right path (`tiers.quick.unlimited`, `models.<ref>.unlimited`) and stores the normalized field list.
- `buildRoute` in `packages/core/src/planner.js` lifts the union when computing the shift budget.
- **Tier, model and backend `unlimited` lift every limit for that route, the ticket budget included** (operator decision 2026-10-01, ticket 02; ticket 01 first lifted shift limits only). Budgets stay global; the per-route lists are how chosen agents and models run without limits. A `backends.<name>.unlimited` key covers whole agents (`claude`, `codex`, …).
- `run --dry-run` already prints `budget=-` when nothing is left; it shows the lifted budget per route with no extra work.
- Types in `packages/core/src/index.d.ts`; docs in `docs/guide.md` + `docs/guide.uk.md` ("No limits"), `skills/shiftwork/references/config.md` (then `npm run sync-skills`), then `npm run llms`.

## Out of Scope

- Per-tier CLI flags.

<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | `unlimited` on tiers and model profiles | resolved | opencode-go/glm-5.3 |
<!-- shiftwork:tickets:end -->
