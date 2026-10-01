# 02: TUI view state and key decoding

**What to build:** Extend the pure key reducer in `packages/cli/src/tui-controls.js` to the tabbed view of the spec: state `{ tab, cursor: { queue, agents, … }, collapsed, details, selectedWorker, notice, dryRun, featureFilter }`. Keys: `1`–`4` and `tab` switch tabs; `up`/`down`/`k`/`j` move the cursor within bounds; `left`/`right` collapse/expand the feature under the cursor (Queue); `enter` opens details of the selected ticket (Queue) or selects a worker and switches to Log (Agents); `esc`/`backspace` close details; `n` emits `start-runner` with the selected ticket, refused with a notice when it isn't a ready frontier ticket or a runner is live; `r`, `s`, `d`, `f`, `q`, Ctrl-C keep today's behaviour. Add `decodeKeys(data) → string[]` for raw terminal input (arrow sequences `\x1b[A`…, `\r`, `\x1b`, `\t`, `\x7f`, printable characters, several keys in one chunk). The visible rows the cursor moves over come from one pure helper (`queueRows(dashboard, view)`) shared with rendering (spec stories 1, 2, 4, 7).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Table tests for `reduceKey`: tab switching, cursor clamped at both ends, collapse hides a feature's tickets from `queueRows`, details open/close, `n` allowed and refused (blocked ticket, live runner)
- [x] Table tests for `decodeKeys`: each arrow, enter, esc, tab, backspace, and `"\x1b[B\x1b[Bn"` → `["down", "down", "n"]`
- [x] Today's `tui-controls` tests for `r`/`s`/`d`/`f`/`q` still pass

### Notes

All in `packages/cli/src/tui-controls.js` (+ tests in `packages/cli/test/tui-controls.test.js`); `npm test` at the root passes (449 pass, 0 fail).

- `reduceKey(state, key, dashboard)` now takes the latest frame as a third argument (optional, so today's two-argument calls keep working). Recognized keys return a normalized view state — `tab` (one of `TABS` = `queue`/`agents`/`cooldowns`/`log`), `cursor` with one cursor per tab clamped to that tab's rows, `collapsed`, `details` (`"<feature>/<NN>"` or null), `selectedWorker` — plus today's `run`/`features`/`featureFilter`/`notice`/`dryRun`. An unrecognized key returns the state untouched, so today's "any other key is ignored" deepEqual test still holds.
- `queueRows(dashboard, view)` is the one pure helper for the Queue tab's visible rows, exported for ticket 03's renderer: `{ kind: "feature", feature, collapsed, resolved, ready, total }` folder rows, then `{ kind: "ticket", feature, number, title, status, blockedBy, frontier, worker }` ticket rows (worker = the live run-state worker on that ticket, for the `● model` marker). It honours `view.collapsed` and `view.featureFilter`.
- `decodeKeys(data)` (Buffer or string) → key names: `up`/`down`/`left`/`right` (`\x1b[A`–`D` and `\x1bOA`–`D`), `enter` (`\r`/`\n`), `esc` (lone `\x1b`), `tab` (`\t`), `backspace` (`\x7f`/`\x08`), `"\x03"` for Ctrl-C (today's name), printable characters (whole UTF-8 code points), several keys in one chunk. Unknown CSI sequences are consumed, not decoded into garbage.
- `n` emits `{ type: "start-runner", feature: null, ticket: "<feature>/<NN>" }` (ticket 01's `startDetachedRunner` already passes `--ticket` through). Refusal notices reuse `run --ticket`'s wording: `claimed by pid N`, `blocked by NN`, `status <status>`, plus the live-runner refusal like a second `r` and `no ticket selected: the cursor is on the feature <name>` for a folder row.
- `enter` on Agents stores the worker's ticket key in `selectedWorker` and switches to the `log` tab — ticket 04 wires the log to follow it. `createTuiControls.handleKey` passes the full dashboard through and carries the new fields in `view`; `tui.js` is untouched (wiring `decodeKeys`/tabs into the interactive view and the plain-text fallback is ticket 04).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 68547 in / 42326 out tokens, $0.6887, 35 turns
- Time: 12m 24s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-dashboard-02 into main
