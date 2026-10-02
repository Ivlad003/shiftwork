# 02: Colours and a highlighted cursor row in the interactive TUI

**What to build:** Add a `color` option to `renderDashboard(state, { width, height, color })` in `packages/cli/src/dashboard.js` (GitHub #1, #4). With `color: true`: the cursor row of the current tab (Queue, Agents, Cooldowns, Log) is reverse video across the visible width; ticket statuses are coloured (resolved green, claimed cyan, needs-info yellow, blocked dim), the `● model` worker marker cyan, cooldown rows red, the active tab label bold, the `»` notice yellow. Use plain SGR codes and apply them **after** `fit()` clips the line, so width is still counted in visible columns and the clipped text never cuts an escape sequence. `color` defaults to false: `--once`, non-TTY output and the plain-text fallback are unchanged. `interactive()` in `packages/cli/src/tui.js` passes `color: !process.env.NO_COLOR`. Update `shiftwork tui --help`, `docs/guide.md` + `docs/guide.uk.md` section 7, and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [x] Tests: with `color: true` the cursor row contains `\x1b[7m`, a resolved ticket row contains a green SGR code; with color off no line contains `\x1b[`
- [x] Test: with `color: true` and a narrow `width`, every line's visible width (escapes stripped) is ≤ `width`
- [x] `tui --once` output contains no escape sequences
- [x] `NO_COLOR=1` disables colour in the interactive view (stub-terminal test)
- [x] Guides (en + uk) and `tui --help` mention colours and `NO_COLOR`

### Notes

- `renderSized` now returns `{ lines, cursor, redRows }` (indices of the cursor row and of red cooldown rows); `tabBody` returns the same shape and `scrollRows` became `scrolled(rows, at, max)` → `{ lines, cursor }`. `renderDashboard(state, { width, height, color = false })` clips with `fit` first, then `paint` sprinkles plain SGR codes over the clipped lines — so escapes are never cut and padding of the reverse-video cursor row counts visible columns (padded to `width`, escapes excluded via a `visibleColumns` helper).
- Inline tokens are matched on the final clipped text: ` · resolved|claimed|needs-info` → green/cyan/yellow, ` · blocked by …` → dim, ` · ● model` → cyan, `»` notice line → yellow, bracketed active tab label on line 0 → bold. Colourless paths (`--once`, non-TTY, fallback, `color: false`) byte-identical to before.
- `interactive()` passes `color: !process.env.NO_COLOR`; the stub-terminal test for line widths now strips SGR before measuring.
- `npm run llms` re-run (llms-full.txt is gitignored but regenerated); Verify gate (`npm test`, `tui --once`) green.
- Attempt 2: re-ran the gate as-is — `npm test` green (486 pass, 0 fail, 10 skipped; the pi-backend test that failed in attempt 1 now passes, it was flaky, not related to this change), `tui --once` exit 0 with no escape sequences, `npm run llms` regenerated. No further code changes needed.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 53350 in / 28263 out tokens, $0.4580, 27 turns
- Time: 8m 9s
- Verify: failed at `npm test` (exit 1)

```
ords ### Review (34.852169ms)
✔ a reopen verdict sends the ticket back to ready-for-agent with the reason (16.55199ms)
✔ a follow-up verdict files a new ready ticket in the feature (21.741728ms)
✔ a review without the marker is treated as accept with a warning (17.991408ms)
✔ an unknown review verdict is treated as accept with a warning (22.649312ms)
✔ reviews are off by default (24.398089ms)
✔ the review features filter is respected per ticket (48.613946ms)
✔ the review types filter matches the ticket's effective type (11.818167ms)
✔ with a workspace, the review runs in the main repo with the landed message in its prompt (18.938313ms)
✔ a review whose tier is all cooling is recorded as not run (28.508507ms)
✔ shift reports say how long the shift took, and the ticket total from the second shift on (25.583165ms)
✔ formatDuration renders seconds, minutes and hours (0.229224ms)
✔ parallel: 2 works two independent tickets at once (92.142703ms)
✔ a ticket blocked by a running parallel ticket starts only after it resolves (172.845164ms)
✔ a provider at its concurrency cap is skipped for the next model, and no cooldown is written (102.636367ms)
✔ parallel landings go through one queue: one landing at a time (111.499221ms)
✔ parallel: 2 lists both workers in the run state while they run (128.526276ms)
✔ a STOP file hands off both parallel workers (127.783702ms)
✔ a failed worker lets the others settle before the error propagates (178.595303ms)
✔ a review whose verify re-run fails records the failing output, like a shift report (23.011442ms)
✔ claim returns a claim for a free frontier ticket and marks it claimed (15.283229ms)
✔ a ticket claimed by a live process can't be claimed again (6.754313ms)
✔ a claim left by a dead process is taken over (28.450341ms)
✔ setStatus changes only the Status line (2.652853ms)
✔ appendComment creates the Comments section when it's missing (1.649269ms)
✔ appendComment appends after existing comments (5.6344ms)
✔ release lets the ticket be claimed again (4.440999ms)
✔ a failed write leaves the ticket intact and no temp files behind (1.550511ms)
✔ setStatus updates the spec table and leaves bytes outside the markers unchanged (2.847875ms)
✔ missing spec markers are appended once, and a missing spec.md is left alone (7.356413ms)
✔ the last route column shows the model of the latest shift report (3.670279ms)
✔ the spec table ignores markers mentioned in prose and fills the block on its own lines (3.244256ms)
✔ VERSION matches shiftwork-core's package.json, so `shiftwork --version` never drifts (0.92853ms)
✔ a real pi lists the shift command with its subcommands (412.575182ms)
✔ /shift answers with the frontier of ready tickets (437.97653ms)
✔ /shift stop writes the STOP file (390.698291ms)
✔ /shift run starts a detached runner, returns at once and shows a status widget (2418.656217ms)
✔ /shift run finds the shiftwork CLI and logs its output to a file (341.171951ms)
✔ /shift run refuses to start a second runner (348.166227ms)
✔ loading the pi-shiftwork package advertises the shiftwork skill (476.36801ms)
✔ switching the model changes the advertised skills (464.718356ms)
✔ a model without a tier leaves skills untouched (411.159658ms)
ℹ tests 496
ℹ suites 0
ℹ pass 485
ℹ fail 1
ℹ cancelled 0
ℹ skipped 10
ℹ todo 0
ℹ duration_ms 8659.783045

✖ failing tests:

test at packages/cli/test/pi-backend.test.js:34:1
✖ a real pi shift runs tools and maps events to turns, text and end (1557.815412ms)
  AssertionError [ERR_ASSERTION]: context fill is reported for maxContextPct budgets
      at TestContext.<anonymous> (file:///home/kosmodev/.cache/shiftwork/worktrees/shiftwork-3b035128/tui-polish-02/packages/cli/test/pi-backend.test.js:45:9)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

- Outcome: new attempt

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 14919 in / 2386 out tokens, $0.0532, 9 turns
- Time: 1m 28s (ticket total 9m 37s)
- Verify: passed
- Outcome: resolved
- Target moved to 4e0e029: branch rebased onto it, verify gate re-run: passed
- Landed: merged shiftwork/tui-polish-02 into main
