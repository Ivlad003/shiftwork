# 02: Per-model/tier `unlimited` lifts the ticket budget too; `unlimited` per backend

**What to build:** Operator decision (GitHub #6, 2026-10-01): budgets stay global, but chosen agents (backends) and models run with **no** limits at all — including the ticket's own budget. Ticket 01 lifted tier/model `unlimited` from the shift budget only; change that: (1) In `buildRoute` (`packages/core/src/planner.js`) the union of the top-level, tier, model-profile and backend lists is lifted from the shift budget **and** from the ticket budget that caps it. (2) Add a `backends` config section: `"backends": { "claude": { "unlimited": true }, "codex": { "unlimited": ["time"] } }`, keys being the backend names `parseModelRef` returns (`pi`, `claude`, `codex`, `opencode`, `grok`, `cursor`); validate in `packages/core/src/config.js` with `normalizeUnlimited(value, "backends.<name>.unlimited")`, unknown backend names fail. (3) The runner's whole-ticket exhaustion check (`packages/core/src/runner.js`, the `resolveTicketBudget` call near line 876) must not end a ticket on a limit that the route about to run lifts — export a helper from the planner (e.g. `liftedFor(route, config)`) and use it there. `resolveTicketBudget(ticket, config)` keeps its meaning for callers without a route (top-level list only). Update `packages/core/src/index.d.ts`, the "No limits" section of `docs/guide.md` + `docs/guide.uk.md`, `skills/shiftwork/references/config.md` (then `npm run sync-skills`) and run `npm run llms`.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/config.test.js packages/core/test/planner.test.js packages/core/test/runner.test.js` · `npm test`

- [x] Planner test: a ticket with `**Budget:** 50 turns` on a tier with `unlimited: ["turns"]` gets a route without `maxTurns`; on another tier it keeps `maxTurns: 50`
- [x] Planner test: `backends.claude.unlimited: true` lifts every limit for `claude:sonnet` and for no `pi` model
- [x] Config tests: `backends.claude.unlimited` normalizes; `backends.nope` fails with its path; a bad limit name fails with `backends.claude.unlimited`
- [x] Runner test: a ticket whose usage passed its `maxTurns` is not ended when the next route lifts `maxTurns`, and is ended when it doesn't
- [x] Guides (en + uk) and `references/config.md` describe tier, model and backend `unlimited` and that they also lift the ticket budget

### Notes

- `liftedFor(route, config)` in `planner.js` unions the top-level, tier, model-profile and backend `unlimited` lists and normalizes short names (`turns` → `maxTurns`) itself, so it also works with the raw configs the runner tests pass (the runner does not `validateConfig` its input). The short-name map now lives in `planner.js` as `LIMIT_SHORT_NAMES`; `config.js` imports it and still exports it as `LIMIT_NAMES` (single source, no import cycle: `planner.js` stays import-free).
- `buildRoute` lifts the union from both the merged shift budget and the ticket budget that caps it; `remainingTicketBudget` takes the next route and skips limits that route lifts, so the pre-handoff exhaustion check no longer ends tickets whose next route is unlimited.
- `npm run sync-skills` and `npm run llms` ran; both verify gates pass (`node --test` on the three core test files: 217/217; full `npm test`: 560 pass, 10 skipped, 0 fail).
- Redone on top of 9e2dc38 after the landing conflict (attempt 1, this shift): same design as the notes above, re-applied from scratch to `packages/core/src/{planner,config,runner,index}.js`, `packages/core/src/index.d.ts`, the three core test files (234/234 now), `docs/guide.md` + `docs/guide.uk.md` "No limits" sections, `skills/shiftwork/references/config.md` (then `npm run sync-skills`), `npm run llms` regenerated. Verify: three core test files 234 pass / 0 fail; full `npm test` 604 pass, 10 skipped, 0 fail.

### Handoff

Stop requested before any code was written; research complete, nothing implemented yet. Plan:

- **`packages/core/src/planner.js`**: in `buildRoute` (~lines 59–86) the ticket budget that caps the shift budget must itself be lifted by the same union. Export a helper `liftedFor(route, config)` (near `resolveTicketBudget`): returns the union of `config.unlimited`, `config.tiers?.[route.tier ?? tierForModel(model)].unlimited`, `config.models?.[route.ref ?? route.model]?.unlimited` and `config.backends?.[parseModelRef(model).backend]?.unlimited`; when the route has no model (wait/stop objects), return only `config.unlimited`. Note: in `buildRoute` the local `model` is the **full ref string** (e.g. `claude:sonnet`) and profile lookup is `config.models?.[model]`, so call it as `liftedFor({ model, tier }, config)`. Also export `BACKENDS = ["pi", ...CLI_BACKENDS]` (`CLI_BACKENDS` already exists, private). Update the module docstring (~lines 7–8) and the comment above the `capBudget` call.
- **`packages/core/src/config.js`**: add `backends: {}` to `DEFAULTS`; add a `checkBackends(value, "backends")` — keys must be one of `BACKENDS` (import from planner.js — planner has no imports, no cycle), only allowed field `unlimited`, normalized via `normalizeUnlimited(backend.unlimited, "backends.<name>.unlimited")`; call it in `validateConfig` next to the `config.unlimited` line (~line 69).
- **`packages/core/src/runner.js`**: import `liftedFor`; give `remainingTicketBudget` (~line 874) a 4th param `route` and `continue` on any key in `new Set(liftedFor(route, config))`; pass `nextRoute` at the single call site (~line 650, the "Handoff blocked" check — `nextRoute` is already in scope there). `resolveTicketBudget` keeps its meaning.
- **Tests**: rewrite the existing planner test "tier unlimited does not lift the ticket's Budget line…" (~planner.test.js line 737) to assert the *new opposite* behavior (route has no `maxTurns` on the unlimited tier, keeps `maxTurns: 50` on the other). Backends planner test needs a config with both `claude:sonnet` and a pi model. Runner test: `tiers.standard` chain `[fake/m1, fake/m2]`, `budget: { maxTurns: 2 }`, `onExceed: { maxTurns: { to: "next", mode: "new-process" } }`, `models: { "fake/m2": { unlimited: ["turns"] } }`, ticket `**Budget:** 2 turns` — first shift hands off, the check must NOT end the ticket; the existing test "the ticket budget ceiling ends in needs-info with the reason" (~runner.test.js line 478) already covers the negative case. Use the `limitedConfig`/`validateConfig` patterns already in the test files.
- **Docs**: `docs/guide.md` "No limits" section (lines 232–250) currently says tier/model lift "shift limits only" — rewrite to say tier, model and backend `unlimited` lift every limit for that route, the ticket budget included, and document the new `backends` section; same for `docs/guide.uk.md` (~lines 245–252, Ukrainian) and `skills/shiftwork/references/config.md` (line 10, add a `backends.<name>` key entry). Then `npm run sync-skills` and `npm run llms`.
- **Types**: `packages/core/src/index.d.ts` — declare `liftedFor`, update the `Unlimited` doc comment to mention `backends.<name>.unlimited`.
- **Verify** (not run, nothing implemented): `node --test packages/core/test/config.test.js packages/core/test/planner.test.js packages/core/test/runner.test.js` · `npm test`.

Files touched: only this ticket file. No source, test or doc files were modified.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: STOP file
- Usage: 39178 in / 10535 out tokens, $0.1758, 15 turns
- Time: 3m 14s
- Verify: not run
- Outcome: stopped: STOP file

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: stop, error: Stream ended without finish_reason
- Usage: 49645 in / 21168 out tokens, $0.5231, 44 turns
- Time: 9m 8s (ticket total 9m 8s)
- Verify: passed
- Outcome: redo on the new target (landing conflict)
- Landed: merge conflict in packages/core/src/config.js, packages/core/src/runner.js with the landed 9e2dc38; branch shiftwork/tier-unlimited-02 kept
- Landing conflict with packages/core/src/config.js, packages/core/src/runner.js; redone on top of 9e2dc38

### Shift 3 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 62837 in / 24524 out tokens, $0.7730, 57 turns
- Time: 8m 46s (ticket total 17m 54s)
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tier-unlimited-02 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — Tier, model, and backend unlimited lift the ticket budget as well as the shift budget, and the exhaustion check follows the next route.
- Time: 5m 37s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and spec, starting with the ticket, spec, and the landed diff.
> The landed commit is `9957cf4`. Next I’ll read the diff and the surrounding planner, config, and runner code.
> The diff matches the ticket’s shape. I’ll check call sites, docs sync, and whether the exhaustion check actually uses the next route.
> The implementation matches the ticket’s shape. I’ll run the verify gate and check a couple of budget-lift edge cases the tests might not cover.
> The landed change in `9957cf4` meets the ticket. A tier, model, or backend `unlimited` list is lifted from both the shift budget and the ticket budget that caps it, and the pre-handoff exhaustion check skips any limit the next route lifts.
> 
> - `buildRoute` lifts that union from the merged shift budget and from the ticket cap, including the remaining cap after a handoff. `resolveTicketBudget` still applies only the top-level list.
> - `backends.<name>.unlimited` is validated with `normalizeUnlimited`. Unknown backend names and bad limit names fail on their paths. `pi`, `claude`, `codex`, `opencode`, `grok`, and `cursor` are the allowed keys.
> - `remainingTicketBudget` takes the next route and ignores limits in `liftedFor`. A route with no model still gets only the top-level list. The review shift still uses `review.budget` only.
> - The required planner, config, and runner tests are in place. Guides in English and Ukrainian, plus the synced skill copies, describe the new behavior.
> - Verify: the three core files passed 234/234, and `npm test` passed 604 with 10 skipped and 0 failed.
> 
> A partial list still caps every other ticket limit. A handoff onto `claude` with only `turns` lifted drops `maxTurns` and leaves an exhausted cost or time cap at 0.
