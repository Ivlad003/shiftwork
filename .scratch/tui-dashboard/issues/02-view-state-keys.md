# 02: TUI view state and key decoding

**What to build:** Extend the pure key reducer in `packages/cli/src/tui-controls.js` to the tabbed view of the spec: state `{ tab, cursor: { queue, agents, … }, collapsed, details, selectedWorker, notice, dryRun, featureFilter }`. Keys: `1`–`4` and `tab` switch tabs; `up`/`down`/`k`/`j` move the cursor within bounds; `left`/`right` collapse/expand the feature under the cursor (Queue); `enter` opens details of the selected ticket (Queue) or selects a worker and switches to Log (Agents); `esc`/`backspace` close details; `n` emits `start-runner` with the selected ticket, refused with a notice when it isn't a ready frontier ticket or a runner is live; `r`, `s`, `d`, `f`, `q`, Ctrl-C keep today's behaviour. Add `decodeKeys(data) → string[]` for raw terminal input (arrow sequences `\x1b[A`…, `\r`, `\x1b`, `\t`, `\x7f`, printable characters, several keys in one chunk). The visible rows the cursor moves over come from one pure helper (`queueRows(dashboard, view)`) shared with rendering (spec stories 1, 2, 4, 7).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Table tests for `reduceKey`: tab switching, cursor clamped at both ends, collapse hides a feature's tickets from `queueRows`, details open/close, `n` allowed and refused (blocked ticket, live runner)
- [ ] Table tests for `decodeKeys`: each arrow, enter, esc, tab, backspace, and `"\x1b[B\x1b[Bn"` → `["down", "down", "n"]`
- [ ] Today's `tui-controls` tests for `r`/`s`/`d`/`f`/`q` still pass
