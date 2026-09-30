# 03: Per-model profiles: context window, budget, thinking

**What to build:** A `models` config section maps a model ref to `{ contextWindow?, thinking?, budget? }`. The planner merges budgets `budgets.default` → tier → `budgets.models[ref]` (legacy, still supported) → `models[ref].budget`, capped by the ticket budget. The profile's `thinking` wins over the tier's. The profile's `contextWindow` is used for context fill (`percent = tokens / contextWindow`) instead of the backend's window (spec stories 5–8).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Planner tests for the merge order, including the legacy `budgets.models`
- [ ] Context percent uses the profile window when set: fake backend context events carrying tokens are rescaled
- [ ] Config validation names the field path for bad profiles
- [ ] `shiftwork run --dry-run` shows the effective budget per ticket
