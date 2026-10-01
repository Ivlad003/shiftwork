# 01: Work the frontier feature by feature

**What to build:** As the spec describes. Add a pure `orderFrontier(frontier, tickets, { current })` to `packages/core/src/index.js` (export it, type it in `packages/core/src/index.d.ts`): sort key (1) `feature === current` first, (2) started features (any ticket `resolved` or `claimed`) before not started, (3) feature name, (4) ticket number. `tracker.frontier()` in `packages/core/src/tracker.js` stops returning the load order (`tickets.filter((t) => ready.has(t.path))`) and returns `orderFrontier(…, { current: null })`, orphaned claims included; same for the OpenSpec tracker (`packages/core/src/openspec.js`). In `packages/core/src/runner.js` the runner remembers the feature of the ticket it last worked and `frontierPage` re-orders with it as `current`, so it stays on a feature while that feature has a ready ticket; with `parallel` above 1 the free slots are filled in the same order. Update `docs/agents/issue-tracker.md` ("first by number wins" → the feature-by-feature rule). The operator already described this order in `docs/guide.md` / `docs/guide.uk.md` (section 7, "How the runner picks the next ticket"); make the code match it and fix the guides only where the code had to differ. Run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/tracker.test.js packages/core/test/runner.test.js packages/core/test/openspec.test.js` · `npm test`

- [ ] `orderFrontier` table tests: current feature first; started before not started; then name; then number (`b/02` started, `a/01` not started, `c/01` started → `b/02, c/01, a/01`)
- [ ] Tracker test: `tracker.frontier()` returns that order (not the alphabetical load order); an orphaned claim is still in it
- [ ] Runner test (fake backend): features `a` (01 → 02 blocked by 01) and `b` (01) all ready-for-agent: the runner works `a/01`, `a/02`, then `b/01` — it doesn't jump to `b/01` after `a/01`
- [ ] Runner test: with `parallel: 2`, both slots take the current feature's ready tickets before another feature's
- [ ] OpenSpec tracker test with the same shape
- [ ] `docs/agents/issue-tracker.md` states the feature-by-feature rule
