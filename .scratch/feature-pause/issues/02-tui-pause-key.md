# 02: Pause and resume a feature from the TUI

**What to build:** In the TUI (`packages/cli/src/tui-controls.js`, `packages/cli/src/dashboard.js`, `packages/cli/src/tui.js`): the Queue's feature row shows `⏸` for a paused feature (from ticket 01's `featurePaused`); `p` on a feature row (or on a ticket row: its feature) emits a `{ type: "toggle-pause", feature }` effect that runs ticket 01's pause/resume function and sets the notice `⏸ <f> paused` / `▶ <f> resumed`; the frame refreshes so the frontier line updates. `n` on a ticket of a paused feature is refused with `feature <f> is paused (p resumes it)`. Footer key hints on the Queue tab include `p pause`. Update `tui --help`, guides (en + uk) section 7 ("What the TUI does") and run `npm run llms`.

**Blocked by:** 01

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/tui-controls.test.js packages/cli/test/tui.test.js` · `npm test`

- [ ] Reducer tests: `p` on a feature row and on a ticket row emits `toggle-pause` for that feature; `n` on a paused feature's ticket is refused with the notice
- [ ] Controls test with a stub pause function: the effect runs it and sets the paused/resumed notice
- [ ] Render test: a paused feature's row shows `⏸`; the Queue footer lists `p pause`
- [ ] Guides (en + uk) and `tui --help` describe `p`
