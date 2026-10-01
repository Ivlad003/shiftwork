# 01: `tracker.frontier()` keeps the number-then-feature order

**What to build:** As the spec describes: `tracker.frontier()` in `packages/core/src/tracker.js` returns the frontier sorted the way `frontier()` in `packages/core/src/index.js` sorts it (ticket number, then feature name), instead of the load order (`tickets.filter((t) => ready.has(t.path))` keeps the alphabetical feature order). Orphaned claims still come back as frontier tickets. Do the same in the OpenSpec tracker (`packages/core/src/openspec.js`). Mention the order in `docs/guide.md` + `docs/guide.uk.md` where the frontier is explained, and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/tracker.test.js packages/core/test/runner.test.js packages/core/test/openspec.test.js` · `npm test`

- [ ] Tracker test: features `a-feat` (tickets 03, 04 ready) and `b-feat` (01, 02 ready) → frontier order `b-feat/01, b-feat/02, a-feat/03, a-feat/04`; equal numbers sort by feature name
- [ ] An orphaned claim still appears in the sorted frontier
- [ ] Runner test: the serial runner works the tickets in that order
- [ ] OpenSpec tracker test with the same shape
- [ ] Guides (en + uk) state the order
