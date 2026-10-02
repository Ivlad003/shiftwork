# 01: `unlimited` on tiers and model profiles

**What to build:** Accept `unlimited` (`true` or a list of limit names, like the top-level key) on `tiers.<name>` and on `models.<ref>` profiles in `.pi/shiftwork.json`, as the spec describes. `validateConfig` in `packages/core/src/config.js` normalizes it with `normalizeUnlimited(value, "tiers.<name>.unlimited")` / `"models.<ref>.unlimited"` (add `unlimited` to `PROFILE_FIELDS` handling); `buildRoute` in `packages/core/src/planner.js` lifts the union of `config.unlimited`, the route's tier's and the model profile's lists from the shift budget. Tier/model `unlimited` does **not** lift the ticket budget (`resolveTicketBudget` keeps using only the top-level list), so a ticket's `**Budget:**` line still caps the shift. Update `packages/core/src/index.d.ts`, `docs/guide.md` + `docs/guide.uk.md` ("No limits" section), `skills/shiftwork/references/config.md` (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/config.test.js packages/core/test/planner.test.js` · `npm test`

- [x] Config tests: `tiers.quick.unlimited: ["turns", "time"]` and `models["x/y"].unlimited: true` validate and normalize to field names; an unknown limit name fails with the `tiers.quick.unlimited` path
- [x] Planner tests: a route on the unlimited tier has no `maxTurns`/`maxWallMin`; a route on another tier keeps them; a model profile's `unlimited: true` lifts every shift limit for that model only
- [x] Planner test: a ticket `**Budget:** 50 turns` still caps a shift on a tier with `unlimited: ["turns"]`; top-level `unlimited` still lifts it (today's behaviour)
- [x] Guides (en + uk) and `references/config.md` document the per-tier and per-model key

### Notes

- `buildRoute` now lifts the union **before** capping by the ticket budget (was: cap, then lift). With the old order, a tier's `unlimited` would have deleted limits the ticket's `Budget:` line had just re-imposed through `capBudget`; lifting first keeps the ticket budget as the final cap, as the spec requires. Existing top-level tests produce identical results in both orders.
- `normalizeUnlimited` is set on the tier/profile only when the key is present, so configs without it keep deep-equal shapes in existing tests.
- `liftLimits` now takes the lifted list (top-level, tier, profile union) instead of the whole config; `resolveTicketBudget` passes only `config.unlimited`, so ticket budgets stay capped by tier/model settings.
- Verify: `node --test packages/core/test/config.test.js packages/core/test/planner.test.js` (129 pass) and `npm test` (482 pass, 10 pre-existing skips) both green. `npm run sync-skills` + `npm run llms` run after doc edits.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 35705 in / 13554 out tokens, $0.3067, 33 turns
- Time: 4m 17s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tier-unlimited-01 into main
