# 03: Per-model profiles: context window, budget, thinking

**What to build:** A `models` config section maps a model ref to `{ contextWindow?, thinking?, budget? }`. The planner merges budgets `budgets.default` → tier → `budgets.models[ref]` (legacy, still supported) → `models[ref].budget`, capped by the ticket budget. The profile's `thinking` wins over the tier's. The profile's `contextWindow` is used for context fill (`percent = tokens / contextWindow`) instead of the backend's window (spec stories 5–8).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Planner tests for the merge order, including the legacy `budgets.models`
- [x] Context percent uses the profile window when set: fake backend context events carrying tokens are rescaled
- [x] Config validation names the field path for bad profiles
- [x] `shiftwork run --dry-run` shows the effective budget per ticket

## Comments

### Shift 1 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 82410 in / 21028 out tokens, $0.8070, 22 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-03 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted: `models[ref]` profiles (budget merged after legacy `budgets.models`, capped by the ticket), context events rescaled to the profile window, effective budget in `--dry-run`. 22 turns on xai/grok-4.6
- Changed: thinking precedence. The shift let a model profile override even the ticket type's thinking (a git ticket asking for "low" would run "high"); the order is now routing[type] → model profile → tier → global, and the test that encoded the old order was replaced
