# 01: `unlimited` on tiers and model profiles

**What to build:** Accept `unlimited` (`true` or a list of limit names, like the top-level key) on `tiers.<name>` and on `models.<ref>` profiles in `.pi/shiftwork.json`, as the spec describes. `validateConfig` in `packages/core/src/config.js` normalizes it with `normalizeUnlimited(value, "tiers.<name>.unlimited")` / `"models.<ref>.unlimited"` (add `unlimited` to `PROFILE_FIELDS` handling); `buildRoute` in `packages/core/src/planner.js` lifts the union of `config.unlimited`, the route's tier's and the model profile's lists from the shift budget. Tier/model `unlimited` does **not** lift the ticket budget (`resolveTicketBudget` keeps using only the top-level list), so a ticket's `**Budget:**` line still caps the shift. Update `packages/core/src/index.d.ts`, `docs/guide.md` + `docs/guide.uk.md` ("No limits" section), `skills/shiftwork/references/config.md` (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/config.test.js packages/core/test/planner.test.js` · `npm test`

- [ ] Config tests: `tiers.quick.unlimited: ["turns", "time"]` and `models["x/y"].unlimited: true` validate and normalize to field names; an unknown limit name fails with the `tiers.quick.unlimited` path
- [ ] Planner tests: a route on the unlimited tier has no `maxTurns`/`maxWallMin`; a route on another tier keeps them; a model profile's `unlimited: true` lifts every shift limit for that model only
- [ ] Planner test: a ticket `**Budget:** 50 turns` still caps a shift on a tier with `unlimited: ["turns"]`; top-level `unlimited` still lifts it (today's behaviour)
- [ ] Guides (en + uk) and `references/config.md` document the per-tier and per-model key
