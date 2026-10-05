# 02: Put the running CLI on PATH so `npx shiftwork` can run `shiftwork` verify commands

**What to build:** When the `shiftwork` CLI starts (`packages/cli/bin/shiftwork.js`), put a `shiftwork` executable that is this same process's `bin/shiftwork.js` at the front of `PATH`. Then `npx shiftwork run --dark-factory` (and any other command) can spawn `sh -c "shiftwork …"` — the planning ticket's Verify (`shiftwork tickets check <feature>` from `packages/cli/src/github-import.js`) and agent shells — without a global install. `npx` from a workspace/git clone runs `node packages/cli/bin/shiftwork.js` and does not leave a `shiftwork` name on PATH; `packages/cli/src/verify.js` runs each gate as `spawn("sh", ["-c", cmd])`. Do not change the imported Verify string to `npx shiftwork …`. Keep the helper in the CLI package (ADR-0004: no GitHub/npx knowledge in core).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/cli-path.test.js packages/cli/test/dark-factory.e2e.test.js packages/cli/test/verify.test.js packages/cli/test/github-import.test.js` · `npm test`

- [x] `ensureShiftworkOnPath` (new `packages/cli/src/cli-path.js` or similar): creates a directory (under `XDG_CACHE_HOME/shiftwork/bin` or `~/.cache/shiftwork/bin`) with a symlink named `shiftwork` pointing at this CLI's `bin/shiftwork.js`, prepends that directory to `env.PATH` (default `process.env`), and is idempotent when the dir is already first
- [x] `bin/shiftwork.js` calls it before handling any command, so `run`, `run --dark-factory`, `tui`, and a nested `shiftwork tickets check` all inherit it
- [x] Test with `PATH` stripped of any existing `shiftwork`: after ensure, `command -v shiftwork` resolves, and `runVerify(["shiftwork --version"], cwd)` (or `shiftwork tickets check` on a tiny fixture) exits 0 — the same `sh: shiftwork: command not found` github#18 printed
- [x] `dark-factory.e2e.test.js` no longer needs its `path-bin` `shiftwork` symlink: a run with no `shiftwork` on PATH still resolves a planning ticket whose Verify is `shiftwork tickets check <feature>`
- [x] `github-import` still writes `**Verify:** \`shiftwork tickets check <feature>\`` (not `npx shiftwork`)
- [x] Dark-factory section of `docs/guide.md` + `docs/guide.uk.md` says `npx shiftwork run --dark-factory` is enough: no global `shiftwork` install; then `npm run llms` if those files feed it

### Notes

- Repro: in this git clone, `npx shiftwork run --dark-factory` → verify/`sh` looks up `shiftwork` and prints `sh: shiftwork: command not found`. The e2e already documented the hole (`path-bin` symlink in `dark-factory.e2e.test.js`).
- Mutate `process.env.PATH` (and the env object passed in tests). `verify.js` `spawn("sh", ["-c", cmd])` does not pass `env`, so children inherit the mutated PATH; that is the same process the runner uses for the planning gate.
- Always prepend this process's bin, even when some other `shiftwork` is on PATH, so children use the same version `npx` started.
- Unix symlink is enough (`verify.js` already spawns `sh`). Refresh the symlink when it is missing or points elsewhere.
- Ticket 03 covers `tickets check` loading `.scratch` from the main checkout when cwd is a worktree; this ticket is PATH only.
- Helper and docs landed in ticket 01 (`cli-path.js`, `bin/shiftwork.js` calls it, guide + llms-full). This ticket added PATH-stripped `runVerify` coverage, dropped the e2e `path-bin` assumption (isolate `node` in a temp dir so a sibling `shiftwork` next to `node` cannot hide the bug), and asserted github-import still writes `shiftwork tickets check` not `npx`.
- `npm test` in the runner was hanging: `NO_COLOR=1` plus `FORCE_COLOR=1` made TUI colour assertions fail before they sent `q`, leaving `interactive()`'s refresh interval alive. Isolated `NO_COLOR` in `tui.test.js` and always quit the stub session. Status/pause CLI tests now pass `NODE_NO_WARNINGS=1` so Node's colour-env warning is not treated as stderr. `locatePi` PATH test compares `realpath` so `/var` vs `/private/var` on macOS matches.

## Comments

### Shift 1 — grok grok-4.6 (medium)
- Ended: budget
- Usage: 2081615 in / 33020 out tokens, $0.0000, 29 turns
- Time: 22m 16s
- Verify: failed at `npm test` (exit 124)

```
: a click on a tab label or a list row, the wheel; everything else maps to null
ok 258 - mouseAction: a click on a tab label or a list row, the wheel; everything else maps to null
  ---
  duration_ms: 0.142541
  type: 'test'
  ...
# Subtest: mouse actions drive the controls: a click moves the cursor, a second opens the details
ok 259 - mouse actions drive the controls: a click moves the cursor, a second opens the details
  ---
  duration_ms: 1.122208
  type: 'test'
  ...
# Subtest: githubRows: one row per issue in the state file, sorted by number
ok 260 - githubRows: one row per issue in the state file, sorted by number
  ---
  duration_ms: 0.100916
  type: 'test'
  ...
# Subtest: reducer: enter on a GitHub row opens the issue's feature in the Queue tab, cursor on its folder
ok 261 - reducer: enter on a GitHub row opens the issue's feature in the Queue tab, cursor on its folder
  ---
  duration_ms: 0.116041
  type: 'test'
  ...
# Subtest: reducer: g toggles dark-factory — start-runner with darkFactory when idle, STOP when live
ok 262 - reducer: g toggles dark-factory — start-runner with darkFactory when idle, STOP when live
  ---
  duration_ms: 0.081209
  type: 'test'
  ...
# Subtest: g's start effect is wired through the controls with darkFactory, like n's
ok 263 - g's start effect is wired through the controls with darkFactory, like n's
  ---
  duration_ms: 1.5685
  type: 'test'
  ...
# Subtest: startDetachedRunner passes --dark-factory through and records the mode in the run state
ok 264 - startDetachedRunner passes --dark-factory through and records the mode in the run state
  ---
  duration_ms: 107.046334
  type: 'test'
  ...
# Subtest: reducer: / opens the search prompt; letters build the query, backspace deletes, the command keys are text
ok 265 - reducer: / opens the search prompt; letters build the query, backspace deletes, the command keys are text
  ---
  duration_ms: 0.626917
  type: 'test'
  ...
# Subtest: reducer: tab toggles the search scope between global and the feature under the cursor
ok 266 - reducer: tab toggles the search scope between global and the feature under the cursor
  ---
  duration_ms: 0.274333
  type: 'test'
  ...
# Subtest: queueRows: a global query keeps matching tickets from several features and their feature rows; a feature query only that feature's; number or title, case-insensitive
ok 267 - queueRows: a global query keeps matching tickets from several features and their feature rows; a feature query only that feature's; number or title, case-insensitive
  ---
  duration_ms: 0.181625
  type: 'test'
  ...
# Subtest: reducer: while a search filters the list, the cursor is clamped to the filtered rows
ok 268 - reducer: while a search filters the list, the cursor is clamped to the filtered rows
  ---
  duration_ms: 0.246709
  type: 'test'
  ...
# Subtest: reducer: / with details open searches inside them; enter advances the match, esc clears then closes
ok 269 - reducer: / with details open searches inside them; enter advances the match, esc clears then closes
  ---
  duration_ms: 0.184792
  type: 'test'
  ...
# Subtest: the controls carry the search state through the view
ok 270 - the controls carry the search state through the view
  ---
  duration_ms: 1.607875
  type: 'test'
  ...
# Subtest: decodeKeys: each key, and several keys arriving in one chunk
ok 271 - decodeKeys: each key, and several keys arriving in one chunk
  ---
  duration_ms: 0.336084
  type: 'test'
  ...
# Subtest: decodeKeys: kitty keyboard-protocol CSI-u sequences (pi-tui's ProcessTerminal sends them)
ok 272 - decodeKeys: kitty keyboard-protocol CSI-u sequences (pi-tui's ProcessTerminal sends them)
  ---
  duration_ms: 0.127042
  type: 'test'
  ...
# Subtest: kitty keys drive the controls: enter opens details, the kitty esc closes them
ok 273 - kitty keys drive the controls: enter opens details, the kitty esc closes them
  ---
  duration_ms: 0.7335
  type: 'test'
  ...

[shiftwork] timed out after 10 min (verifyTimeoutMin)
```

- Outcome: new attempt
### Handoff — shift 1, grok:grok-4.6 → opencode-go/glm-5.3, reason: budget.maxWallMin (22.26 / 20)
- Last output:

```
The CLI already has a `cli-path` module. I’ll read it, the tests, and the docs to see what’s still missing.
The PATH helper is already on this branch from the planning ticket. I’ll add the missing tests (win over another `shiftwork`, planning-gate via `runVerify`) and refresh generated docs.
Unit tests passed. Next I’ll run the e2e suite and the full `npm test` gate.
```

- Diff stat:

```
M packages/cli/test/cli-path.test.js
 M packages/cli/test/dark-factory.e2e.test.js
 M packages/cli/test/github-import.test.js
packages/cli/test/cli-path.test.js         | 58 ++++++++++++++++++++++++++----
 packages/cli/test/dark-factory.e2e.test.js |  6 ++--
 packages/cli/test/github-import.test.js    |  2 ++
 3 files changed, 57 insertions(+), 9 deletions(-)
```

- Verify failure: `npm test` (exit 124)

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: error, error: No API key found for opencode-go.

Use /login to log into a provider via OAuth or API key. See:
  /Users/kosmodev/Documents/pet_project/shiftwork/node_modules/@earendil-works/pi-coding-agent/docs/providers.md
  /Users/kosmodev/Documents/pet_project/shiftwork/node_modules/@earendil-works/pi-coding-agent/docs/models.md
- Usage: 0 in / 0 out tokens, $0.0000, 0 turns
- Time: 0s (ticket total 22m 16s)
- Verify: failed at `npm test` (exit 124)

```
ction: a click on a tab label or a list row, the wheel; everything else maps to null
ok 258 - mouseAction: a click on a tab label or a list row, the wheel; everything else maps to null
  ---
  duration_ms: 0.118041
  type: 'test'
  ...
# Subtest: mouse actions drive the controls: a click moves the cursor, a second opens the details
ok 259 - mouse actions drive the controls: a click moves the cursor, a second opens the details
  ---
  duration_ms: 1.086209
  type: 'test'
  ...
# Subtest: githubRows: one row per issue in the state file, sorted by number
ok 260 - githubRows: one row per issue in the state file, sorted by number
  ---
  duration_ms: 0.108333
  type: 'test'
  ...
# Subtest: reducer: enter on a GitHub row opens the issue's feature in the Queue tab, cursor on its folder
ok 261 - reducer: enter on a GitHub row opens the issue's feature in the Queue tab, cursor on its folder
  ---
  duration_ms: 0.115
  type: 'test'
  ...
# Subtest: reducer: g toggles dark-factory — start-runner with darkFactory when idle, STOP when live
ok 262 - reducer: g toggles dark-factory — start-runner with darkFactory when idle, STOP when live
  ---
  duration_ms: 0.080125
  type: 'test'
  ...
# Subtest: g's start effect is wired through the controls with darkFactory, like n's
ok 263 - g's start effect is wired through the controls with darkFactory, like n's
  ---
  duration_ms: 1.666625
  type: 'test'
  ...
# Subtest: startDetachedRunner passes --dark-factory through and records the mode in the run state
ok 264 - startDetachedRunner passes --dark-factory through and records the mode in the run state
  ---
  duration_ms: 111.9175
  type: 'test'
  ...
# Subtest: reducer: / opens the search prompt; letters build the query, backspace deletes, the command keys are text
ok 265 - reducer: / opens the search prompt; letters build the query, backspace deletes, the command keys are text
  ---
  duration_ms: 0.4945
  type: 'test'
  ...
# Subtest: reducer: tab toggles the search scope between global and the feature under the cursor
ok 266 - reducer: tab toggles the search scope between global and the feature under the cursor
  ---
  duration_ms: 0.1725
  type: 'test'
  ...
# Subtest: queueRows: a global query keeps matching tickets from several features and their feature rows; a feature query only that feature's; number or title, case-insensitive
ok 267 - queueRows: a global query keeps matching tickets from several features and their feature rows; a feature query only that feature's; number or title, case-insensitive
  ---
  duration_ms: 0.169875
  type: 'test'
  ...
# Subtest: reducer: while a search filters the list, the cursor is clamped to the filtered rows
ok 268 - reducer: while a search filters the list, the cursor is clamped to the filtered rows
  ---
  duration_ms: 0.240625
  type: 'test'
  ...
# Subtest: reducer: / with details open searches inside them; enter advances the match, esc clears then closes
ok 269 - reducer: / with details open searches inside them; enter advances the match, esc clears then closes
  ---
  duration_ms: 0.187625
  type: 'test'
  ...
# Subtest: the controls carry the search state through the view
ok 270 - the controls carry the search state through the view
  ---
  duration_ms: 2.697417
  type: 'test'
  ...
# Subtest: decodeKeys: each key, and several keys arriving in one chunk
ok 271 - decodeKeys: each key, and several keys arriving in one chunk
  ---
  duration_ms: 0.333833
  type: 'test'
  ...
# Subtest: decodeKeys: kitty keyboard-protocol CSI-u sequences (pi-tui's ProcessTerminal sends them)
ok 272 - decodeKeys: kitty keyboard-protocol CSI-u sequences (pi-tui's ProcessTerminal sends them)
  ---
  duration_ms: 0.121792
  type: 'test'
  ...
# Subtest: kitty keys drive the controls: enter opens details, the kitty esc closes them
ok 273 - kitty keys drive the controls: enter opens details, the kitty esc closes them
  ---
  duration_ms: 3.230167
  type: 'test'
  ...

[shiftwork] timed out after 10 min (verifyTimeoutMin)
```

- Outcome: new attempt

### Shift 3 — grok grok-4.6 (medium)
- Ended: budget
- Usage: 2496432 in / 47899 out tokens, $0.0000, 28 turns
- Time: 20m 6s (ticket total 42m 22s)
- Verify: failed at `npm test` (exit 124)

```
 click on a tab label or a list row, the wheel; everything else maps to null
ok 258 - mouseAction: a click on a tab label or a list row, the wheel; everything else maps to null
  ---
  duration_ms: 0.117375
  type: 'test'
  ...
# Subtest: mouse actions drive the controls: a click moves the cursor, a second opens the details
ok 259 - mouse actions drive the controls: a click moves the cursor, a second opens the details
  ---
  duration_ms: 0.927625
  type: 'test'
  ...
# Subtest: githubRows: one row per issue in the state file, sorted by number
ok 260 - githubRows: one row per issue in the state file, sorted by number
  ---
  duration_ms: 0.080666
  type: 'test'
  ...
# Subtest: reducer: enter on a GitHub row opens the issue's feature in the Queue tab, cursor on its folder
ok 261 - reducer: enter on a GitHub row opens the issue's feature in the Queue tab, cursor on its folder
  ---
  duration_ms: 0.104583
  type: 'test'
  ...
# Subtest: reducer: g toggles dark-factory — start-runner with darkFactory when idle, STOP when live
ok 262 - reducer: g toggles dark-factory — start-runner with darkFactory when idle, STOP when live
  ---
  duration_ms: 0.074042
  type: 'test'
  ...
# Subtest: g's start effect is wired through the controls with darkFactory, like n's
ok 263 - g's start effect is wired through the controls with darkFactory, like n's
  ---
  duration_ms: 1.673958
  type: 'test'
  ...
# Subtest: startDetachedRunner passes --dark-factory through and records the mode in the run state
ok 264 - startDetachedRunner passes --dark-factory through and records the mode in the run state
  ---
  duration_ms: 106.188334
  type: 'test'
  ...
# Subtest: reducer: / opens the search prompt; letters build the query, backspace deletes, the command keys are text
ok 265 - reducer: / opens the search prompt; letters build the query, backspace deletes, the command keys are text
  ---
  duration_ms: 0.460959
  type: 'test'
  ...
# Subtest: reducer: tab toggles the search scope between global and the feature under the cursor
ok 266 - reducer: tab toggles the search scope between global and the feature under the cursor
  ---
  duration_ms: 0.178167
  type: 'test'
  ...
# Subtest: queueRows: a global query keeps matching tickets from several features and their feature rows; a feature query only that feature's; number or title, case-insensitive
ok 267 - queueRows: a global query keeps matching tickets from several features and their feature rows; a feature query only that feature's; number or title, case-insensitive
  ---
  duration_ms: 0.201625
  type: 'test'
  ...
# Subtest: reducer: while a search filters the list, the cursor is clamped to the filtered rows
ok 268 - reducer: while a search filters the list, the cursor is clamped to the filtered rows
  ---
  duration_ms: 0.237334
  type: 'test'
  ...
# Subtest: reducer: / with details open searches inside them; enter advances the match, esc clears then closes
ok 269 - reducer: / with details open searches inside them; enter advances the match, esc clears then closes
  ---
  duration_ms: 0.195292
  type: 'test'
  ...
# Subtest: the controls carry the search state through the view
ok 270 - the controls carry the search state through the view
  ---
  duration_ms: 1.65875
  type: 'test'
  ...
# Subtest: decodeKeys: each key, and several keys arriving in one chunk
ok 271 - decodeKeys: each key, and several keys arriving in one chunk
  ---
  duration_ms: 0.310292
  type: 'test'
  ...
# Subtest: decodeKeys: kitty keyboard-protocol CSI-u sequences (pi-tui's ProcessTerminal sends them)
ok 272 - decodeKeys: kitty keyboard-protocol CSI-u sequences (pi-tui's ProcessTerminal sends them)
  ---
  duration_ms: 0.119041
  type: 'test'
  ...
# Subtest: kitty keys drive the controls: enter opens details, the kitty esc closes them
ok 273 - kitty keys drive the controls: enter opens details, the kitty esc closes them
  ---
  duration_ms: 0.934917
  type: 'test'
  ...

[shiftwork] timed out after 10 min (verifyTimeoutMin)
```

- Outcome: new attempt
### Handoff — shift 3, grok:grok-4.6 → opencode-go/glm-5.3, reason: budget.maxWallMin (20.10 / 20)
- Last output:

```
`shiftwork` is still on PATH next to `node`, so the stripped-PATH repro never failed. I’ll isolate `node` in a temp dir and drop any directory that contains `shiftwork`.
The full suite is still running past 12 minutes. I’ll inspect the log to find which test is stuck.
`tui.test.js` is still running after its tests finished — that’s the hang. I’ll inspect open handles and stop the stuck suite.
```

- Diff stat:

```
M packages/cli/test/cli-path.test.js
 M packages/cli/test/dark-factory.e2e.test.js
 M packages/cli/test/github-import.test.js
packages/cli/test/cli-path.test.js         | 78 +++++++++++++++++++++++++-----
 packages/cli/test/dark-factory.e2e.test.js | 18 ++++---
 packages/cli/test/github-import.test.js    |  2 +
 3 files changed, 77 insertions(+), 21 deletions(-)
```

- Verify failure: `npm test` (exit 124)

### Shift 4 — pi opencode-go/glm-5.3 (medium)
- Ended: error, error: No API key found for opencode-go.

Use /login to log into a provider via OAuth or API key. See:
  /Users/kosmodev/Documents/pet_project/shiftwork/node_modules/@earendil-works/pi-coding-agent/docs/providers.md
  /Users/kosmodev/Documents/pet_project/shiftwork/node_modules/@earendil-works/pi-coding-agent/docs/models.md
- Usage: 0 in / 0 out tokens, $0.0000, 0 turns
- Time: 0s (ticket total 42m 22s)
- Verify: failed at `npm test` (exit 124)

```
click on a tab label or a list row, the wheel; everything else maps to null
ok 258 - mouseAction: a click on a tab label or a list row, the wheel; everything else maps to null
  ---
  duration_ms: 0.181584
  type: 'test'
  ...
# Subtest: mouse actions drive the controls: a click moves the cursor, a second opens the details
ok 259 - mouse actions drive the controls: a click moves the cursor, a second opens the details
  ---
  duration_ms: 0.945875
  type: 'test'
  ...
# Subtest: githubRows: one row per issue in the state file, sorted by number
ok 260 - githubRows: one row per issue in the state file, sorted by number
  ---
  duration_ms: 0.080667
  type: 'test'
  ...
# Subtest: reducer: enter on a GitHub row opens the issue's feature in the Queue tab, cursor on its folder
ok 261 - reducer: enter on a GitHub row opens the issue's feature in the Queue tab, cursor on its folder
  ---
  duration_ms: 0.125292
  type: 'test'
  ...
# Subtest: reducer: g toggles dark-factory — start-runner with darkFactory when idle, STOP when live
ok 262 - reducer: g toggles dark-factory — start-runner with darkFactory when idle, STOP when live
  ---
  duration_ms: 0.095584
  type: 'test'
  ...
# Subtest: g's start effect is wired through the controls with darkFactory, like n's
ok 263 - g's start effect is wired through the controls with darkFactory, like n's
  ---
  duration_ms: 1.568459
  type: 'test'
  ...
# Subtest: startDetachedRunner passes --dark-factory through and records the mode in the run state
ok 264 - startDetachedRunner passes --dark-factory through and records the mode in the run state
  ---
  duration_ms: 104.660208
  type: 'test'
  ...
# Subtest: reducer: / opens the search prompt; letters build the query, backspace deletes, the command keys are text
ok 265 - reducer: / opens the search prompt; letters build the query, backspace deletes, the command keys are text
  ---
  duration_ms: 0.500542
  type: 'test'
  ...
# Subtest: reducer: tab toggles the search scope between global and the feature under the cursor
ok 266 - reducer: tab toggles the search scope between global and the feature under the cursor
  ---
  duration_ms: 0.176375
  type: 'test'
  ...
# Subtest: queueRows: a global query keeps matching tickets from several features and their feature rows; a feature query only that feature's; number or title, case-insensitive
ok 267 - queueRows: a global query keeps matching tickets from several features and their feature rows; a feature query only that feature's; number or title, case-insensitive
  ---
  duration_ms: 0.175958
  type: 'test'
  ...
# Subtest: reducer: while a search filters the list, the cursor is clamped to the filtered rows
ok 268 - reducer: while a search filters the list, the cursor is clamped to the filtered rows
  ---
  duration_ms: 0.239209
  type: 'test'
  ...
# Subtest: reducer: / with details open searches inside them; enter advances the match, esc clears then closes
ok 269 - reducer: / with details open searches inside them; enter advances the match, esc clears then closes
  ---
  duration_ms: 0.170042
  type: 'test'
  ...
# Subtest: the controls carry the search state through the view
ok 270 - the controls carry the search state through the view
  ---
  duration_ms: 1.539958
  type: 'test'
  ...
# Subtest: decodeKeys: each key, and several keys arriving in one chunk
ok 271 - decodeKeys: each key, and several keys arriving in one chunk
  ---
  duration_ms: 0.289959
  type: 'test'
  ...
# Subtest: decodeKeys: kitty keyboard-protocol CSI-u sequences (pi-tui's ProcessTerminal sends them)
ok 272 - decodeKeys: kitty keyboard-protocol CSI-u sequences (pi-tui's ProcessTerminal sends them)
  ---
  duration_ms: 0.111959
  type: 'test'
  ...
# Subtest: kitty keys drive the controls: enter opens details, the kitty esc closes them
ok 273 - kitty keys drive the controls: enter opens details, the kitty esc closes them
  ---
  duration_ms: 0.746333
  type: 'test'
  ...

[shiftwork] timed out after 10 min (verifyTimeoutMin)
```

- Outcome: new attempt

### Shift 5 — grok grok-4.6 (medium)
- Ended: STOP file, error: grok exited with code 143
- Usage: 979464 in / 22992 out tokens, $0.0000, 16 turns
- Time: 4m 56s (ticket total 47m 18s)
- Verify: not run
- Outcome: stopped: STOP file
### Handoff — shift 5, grok:grok-4.6 → (no target), reason: STOP file
- Last output:

```
I'll start by reading the ticket, its comments, and the feature spec so I know what attempt 3 must fix.
Previous shifts timed out on `npm test`; I’ll inspect the current CLI PATH helper, tests, and docs next.
Implementation looks mostly in place. I’ll check docs, github-import, and why `npm test` hung last time.
```

- Diff stat:

```
M packages/cli/test/cli-path.test.js
 M packages/cli/test/dark-factory.e2e.test.js
 M packages/cli/test/github-import.test.js
packages/cli/test/cli-path.test.js         | 78 +++++++++++++++++++++++++-----
 packages/cli/test/dark-factory.e2e.test.js | 18 ++++---
 packages/cli/test/github-import.test.js    |  2 +
 3 files changed, 77 insertions(+), 21 deletions(-)
```

### Shift 6 — grok grok-4.6 (medium)
- Ended: stop
- Usage: 2849525 in / 39411 out tokens, $0.6040, 32 turns
- Time: 9m 52s (ticket total 9m 52s)
- Verify: passed
- Outcome: verify passed; review before landing

### Review — grok grok-4.7 (high), retried on claude claude-opus-5-5 (high)
- Verdict: accept — The CLI puts its own bin first on PATH before any command, new tests reproduce the github#18 'command not found' and show it fixed, Verify stays `shiftwork tickets check`, the docs are updated, and both verify gates pass with no hang.
- Time: 1m 14s
- Verify: passed
- Warning: grok-4.7: review ended without a verdict marker
- Findings:

> Both gates pass. I'm running a last check: the full suite with the runner's colour env (`NO_COLOR=1 FORCE_COLOR=1`), the setup that made earlier shifts hang.
> I recommend accepting this ticket: it meets every acceptance criterion and both verify gates pass.
> 
> **What the change contains.** The fix itself landed with ticket 01:
> - `packages/cli/src/cli-path.js` creates a `shiftwork` symlink in the cache bin directory, swapping it in atomically through a temp link and rename. It is refreshed when it is missing or points elsewhere.
> - That directory always goes first on `PATH`, and running it again changes nothing.
> - `packages/cli/bin/shiftwork.js` calls it before handling any command.
> - The dark-factory sections of `docs/guide.md` and `docs/guide.uk.md` say `npx shiftwork run --dark-factory` is enough, with no global install.
> 
> This branch adds only tests:
> - **`cli-path.test.js`:** a stripped `PATH` builds a temp directory holding only a `node` symlink, so a `shiftwork` sitting next to `node` can't hide the bug. With it, the test first shows `runVerify(["shiftwork --version"])` failing with `shiftwork: command not found`, then passing after the fix. Two more tests: this CLI wins when another `shiftwork` is earlier on `PATH`, and `shiftwork tickets check f` passes on a small fixture.
> - **`dark-factory.e2e.test.js`:** it no longer relies on a `shiftwork` link next to `node`. It also checks that the planning ticket's Verify is still `shiftwork tickets check <feature>`.
> - **`github-import.test.js`:** it checks that the written Verify line contains no `npx shiftwork`.
> - **The `npm test` hang that timed out shifts 1–4 is fixed:**
>   - `tui.test.js` clears `NO_COLOR` and always sends `q` to the stub session, so no refresh timer is left running.
>   - The status and pause tests set `NODE_NO_WARNINGS=1`.
>   - The `locatePi` test compares real paths, so `/var` and `/private/var` on macOS match.
> 
> **Verify gates, run myself:**
> - The four targeted test files: 26 of 26 pass.
> - `npm test`: 687 pass, 0 fail, 10 not counted as passes (probably skipped), done in about 15s. It also passes in 14s with the runner's `NO_COLOR=1 FORCE_COLOR=1`, the setup that used to hang.
> 
> **Minor, not blocking.** In the e2e helper, the `dir !== nodeOnly` filter does nothing, because the new temp directory can't already be on `PATH`. The temp directories the tests create are never cleaned up, which matches the existing tests.
> 
> Making `tickets check` read the main checkout's `.scratch` from a worktree is ticket 03 and correctly left out here.

- Landed: merge conflict in the target; branch shiftwork/gh-18-shiftwork-git-main-npx-shiftwork-run-dar-02 kept (Command failed: git merge -q --no-ff --no-edit -m shiftwork: merge gh-18-shiftwork-git-main-npx-shiftwork-run-dar/02 Put the running CLI on PATH so `npx shiftwork` can run `shiftwork` verify commands shiftwork/gh-18-shiftwork-git-main-npx-shiftwork-run-dar-02)

### Shift — manual (claude), 2026-10-04T06:55Z
- Outcome: resolved
- Verify: passed (the ticket's node --test commands and the full `npm test`, 781 tests, 5 runs in a row)
