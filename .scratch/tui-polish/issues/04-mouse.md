# 04: Mouse clicks and wheel in the interactive TUI

**What to build:** Make the interactive TUI react to the mouse (GitHub #5). pi-tui's `TuiAltScreen` already enables SGR mouse reporting and dispatches normalized `TuiMouseEvent`s (`type` click/wheel, zero-based `x`/`y`, `wheelDelta`) to the layout root's `handleMouse`; today the root is a plain `Text` so they are lost. (1) `renderSized` in `packages/cli/src/dashboard.js` also returns a hit map — expose it through a pure `dashboardLayout(state, { width, height })` → `{ lines, rows: [{ y, index }], tabs: [{ tab, x0, x1 }] }` so `renderDashboard` keeps its return type. (2) The reducer in `packages/cli/src/tui-controls.js` takes mouse actions: `{ type: "click", tab }` switches tabs; `{ type: "click", row }` moves the current tab's cursor to that row, and a click on the row already under the cursor acts as `enter`; `{ type: "wheel", delta }` moves the cursor by `delta` rows (clamped). (3) `interactive()` in `packages/cli/src/tui.js` sets as layout root a small component `{ render(width), handleMouse(event) }` around the `Text` that maps the event through the last layout to an action, feeds it to the controls and returns `{ handled: true }`. Update guides (en + uk) section 7 and run `npm run llms`.

**Blocked by:** 03

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] `dashboardLayout` tests: the `y` of each list row and the column span of each tab label match the rendered lines, including when the list is scrolled
- [x] Reducer tests: click on a tab label switches tab; click on a row moves the cursor; a second click on the same ticket row opens details; wheel down/up moves and clamps the cursor
- [x] Stub-terminal test in `packages/cli/test/tui.test.js`: a click event delivered to the layout root's `handleMouse` changes the view (cursor or tab)
- [x] Guides (en + uk) mention mouse support

### Notes

- `dashboardLayout(state, { width, height, color })` in `packages/cli/src/dashboard.js` returns `{ lines, rows, tabs }`; `renderDashboard` is now just its `lines`, so its return type is unchanged. `renderSized`/`tabBody` gained the hit map (`scrolled` now also reports the window's `start`, so a scrolled list's `index` counts from the top of the tab's rows); the spans are clipped like the lines (a label past the width is not a hit).
- `reduceMouse` and `mouseAction` in `packages/cli/src/tui-controls.js` (pure, exported); `createTuiControls` gained `handleMouse`, sharing one `apply` merge with `handleKey`.
- `interactive()` in `packages/cli/src/tui.js` paints through `dashboardLayout`, keeps the last hit map, and sets a small layout root `{ render(width), handleMouse(event) }` around the `Text`: it maps the event to an action, queues it on the key chain and returns `{ handled: true }`.
- Docs: `shiftwork tui --help` and guides (en + uk) section 7 mention the mouse; `npm run llms` re-ran.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 110760 in / 38369 out tokens, $1.4699, 60 turns
- Time: 12m 44s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-04 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: reopen — The interactive layout root does not implement pi-tui's required invalidate(), so shiftwork tui throws on iTerm2 at start and on Kitty, Ghostty, WezTerm and Warp when the cell-size reply arrives, and dashboardLayout also throws when the terminal is shorter than the header plus footer.
- Time: 4m 24s
- Verify: passed
- Findings:

> I'll review the landed TUI mouse ticket against its acceptance criteria and the spec, starting with the ticket, spec, and the landed diff.
> The ticket landed in `a6af399`. I'll read that diff against the spec and the repo's standards next.
> The diff is in. I'll check the hit-map, reducer, and mouse wiring against the acceptance criteria, including whether `llms` was regenerated.
> The layout root may not satisfy pi-tui's component contract. I'll reproduce that against the real `TuiAltScreen` and run the verify gate.
> The mouse work matches the ticket's tests, but the new layout root crashes the real interactive TUI. `npm test` passes (615 pass, 0 fail).
> 
> Acceptance criteria are met in the stubbed suite. `dashboardLayout` hit maps match rendered rows and tab spans, including a scrolled list. `reduceMouse` and `mouseAction` switch tabs, move the cursor, treat a second click on the cursor row as `enter`, and clamp the wheel. The stub-terminal test delivers a click to `handleMouse` and the view changes. Guides (en and uk) and `shiftwork tui --help` mention the mouse.
> 
> The landed layout root is only `{ render, handleMouse }`. pi-tui's `Component` requires `invalidate()`, and `TuiAltScreen` calls it with no optional chaining (`getMountedRoots()` → `root.invalidate()`). The previous root was a `Text`, which implements it. Reproduced against the installed pi-tui:
> 
> - iTerm2: `ui.start()` throws `TypeError: root.invalidate is not a function` (image capability forces `invalidate()` in `beforeTerminalStart`).
> - Kitty, Ghostty, WezTerm, and Warp: start succeeds, then the CSI 16 t cell-size reply (`consumeCellSizeResponse`) throws the same error.
> 
> `tabBody` returns no `rows` when the body height is 0, and `renderSized` then calls `body.rows.filter`. `dashboardLayout` throws at height 1–3 (height 4 if a notice is showing). A short resize hits that path with no catch.

### Notes

- Operator fix (2026-10-02) for the review's reopen: the layout root now implements `invalidate()` (delegating to the Text), so `TuiAltScreen` no longer throws `root.invalidate is not a function` — at start on iTerm2, or on the CSI 16 t cell-size reply on Kitty/Ghostty/WezTerm/Warp. `tabBody` returns `rows: []` when the body has no room, so `dashboardLayout` no longer throws on a terminal shorter than header + footer.
- Tests: the stub `TuiAltScreen` now calls `invalidate()` on its roots at `start()`, like the real one (4 tests fail without the fix); a new test renders heights 1–6 with and without a notice. Checked against the installed pi-tui with a stub terminal: TERM_PROGRAM=iTerm.app crashed before the fix and runs after it; TERM_PROGRAM=kitty survives the cell-size reply, a click and a 3-row terminal. `npm test`: 653 pass, 0 fail.
