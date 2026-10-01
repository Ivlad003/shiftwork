# 02: Per-model/tier `unlimited` lifts the ticket budget too; `unlimited` per backend

**What to build:** Operator decision (GitHub #6, 2026-10-01): budgets stay global, but chosen agents (backends) and models run with **no** limits at all — including the ticket's own budget. Ticket 01 lifted tier/model `unlimited` from the shift budget only; change that: (1) In `buildRoute` (`packages/core/src/planner.js`) the union of the top-level, tier, model-profile and backend lists is lifted from the shift budget **and** from the ticket budget that caps it. (2) Add a `backends` config section: `"backends": { "claude": { "unlimited": true }, "codex": { "unlimited": ["time"] } }`, keys being the backend names `parseModelRef` returns (`pi`, `claude`, `codex`, `opencode`, `grok`, `cursor`); validate in `packages/core/src/config.js` with `normalizeUnlimited(value, "backends.<name>.unlimited")`, unknown backend names fail. (3) The runner's whole-ticket exhaustion check (`packages/core/src/runner.js`, the `resolveTicketBudget` call near line 876) must not end a ticket on a limit that the route about to run lifts — export a helper from the planner (e.g. `liftedFor(route, config)`) and use it there. `resolveTicketBudget(ticket, config)` keeps its meaning for callers without a route (top-level list only). Update `packages/core/src/index.d.ts`, the "No limits" section of `docs/guide.md` + `docs/guide.uk.md`, `skills/shiftwork/references/config.md` (then `npm run sync-skills`) and run `npm run llms`.

**Blocked by:** 01

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/config.test.js packages/core/test/planner.test.js packages/core/test/runner.test.js` · `npm test`

- [ ] Planner test: a ticket with `**Budget:** 50 turns` on a tier with `unlimited: ["turns"]` gets a route without `maxTurns`; on another tier it keeps `maxTurns: 50`
- [ ] Planner test: `backends.claude.unlimited: true` lifts every limit for `claude:sonnet` and for no `pi` model
- [ ] Config tests: `backends.claude.unlimited` normalizes; `backends.nope` fails with its path; a bad limit name fails with `backends.claude.unlimited`
- [ ] Runner test: a ticket whose usage passed its `maxTurns` is not ended when the next route lifts `maxTurns`, and is ended when it doesn't
- [ ] Guides (en + uk) and `references/config.md` describe tier, model and backend `unlimited` and that they also lift the ticket budget
