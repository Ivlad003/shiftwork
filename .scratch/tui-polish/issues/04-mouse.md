# 04: Mouse clicks and wheel in the interactive TUI

**What to build:** Make the interactive TUI react to the mouse (GitHub #5). pi-tui's `TuiAltScreen` already enables SGR mouse reporting and dispatches normalized `TuiMouseEvent`s (`type` click/wheel, zero-based `x`/`y`, `wheelDelta`) to the layout root's `handleMouse`; today the root is a plain `Text` so they are lost. (1) `renderSized` in `packages/cli/src/dashboard.js` also returns a hit map — expose it through a pure `dashboardLayout(state, { width, height })` → `{ lines, rows: [{ y, index }], tabs: [{ tab, x0, x1 }] }` so `renderDashboard` keeps its return type. (2) The reducer in `packages/cli/src/tui-controls.js` takes mouse actions: `{ type: "click", tab }` switches tabs; `{ type: "click", row }` moves the current tab's cursor to that row, and a click on the row already under the cursor acts as `enter`; `{ type: "wheel", delta }` moves the cursor by `delta` rows (clamped). (3) `interactive()` in `packages/cli/src/tui.js` sets as layout root a small component `{ render(width), handleMouse(event) }` around the `Text` that maps the event through the last layout to an action, feeds it to the controls and returns `{ handled: true }`. Update guides (en + uk) section 7 and run `npm run llms`.

**Blocked by:** 03

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] `dashboardLayout` tests: the `y` of each list row and the column span of each tab label match the rendered lines, including when the list is scrolled
- [ ] Reducer tests: click on a tab label switches tab; click on a row moves the cursor; a second click on the same ticket row opens details; wheel down/up moves and clamps the cursor
- [ ] Stub-terminal test in `packages/cli/test/tui.test.js`: a click event delivered to the layout root's `handleMouse` changes the view (cursor or tab)
- [ ] Guides (en + uk) mention mouse support
