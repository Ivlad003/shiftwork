# 11: `shiftwork tui`: read-only dashboard

**What to build:** `shiftwork tui` shows features with their ticket tables, the frontier, the live runner from `.pi/shiftwork-run.json` (ticket, shift, model, budget use, context fill), cooldowns with time left, and the tail of the current shift log. It refreshes every second. It's built on `@earendil-works/pi-tui`, resolved from the user's pi install, and has a plain-text fallback when that isn't available (spec stories 25–27).

**Blocked by:** 04

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A pure `renderDashboard(state) → lines` is tested with table cases: idle, running, waiting on cooldowns
- [ ] A missing run state or log doesn't crash it
- [ ] `shiftwork tui --once` prints one frame and exits (used by the tests)
