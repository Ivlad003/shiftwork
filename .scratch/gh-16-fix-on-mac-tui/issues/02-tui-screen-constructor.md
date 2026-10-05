# 02: Interactive TUI constructs the screen class pi-tui actually exports

**What to build:** `shiftwork tui` must open the interactive dashboard against the pi-tui that `loadPiTui` resolved, including older installs that export `TUI` and not `TuiAltScreen`. Today `packages/cli/src/tui.js` `interactive()` always does `new TuiAltScreen(terminal, false)`. On pi-tui 0.80.x that name is undefined, `new` throws `TypeError: TuiAltScreen is not a constructor`, and `packages/cli/bin/shiftwork.js` prints `shiftwork: TuiAltScreen is not a constructor` (github#16). Pick a function constructor from the loaded kit (`TuiAltScreen`, then `TUI`, then `TuiMainScreen`). If none is a function, take the plain-text fallback instead of throwing. Keep the current `TuiAltScreen` path for current pi-tui. Stay in the CLI (ADR-0004). Do not add `@earendil-works/pi-tui` as a CLI dependency.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/tui.test.js` · `npm test`

- [x] `interactive()` constructs `TuiAltScreen` when that export is a function (today's kit and the existing stub tests stay green)
- [x] A kit shaped like pi-tui 0.80.3 (`ProcessTerminal`, `Text`, `TUI`; no `TuiAltScreen`) constructs `TUI` with `(terminal, false)` and runs the same stub-terminal loop (size, one resize, a key chunk, `q` quits). 0.80's `TUI` has `addChild` / `addInputListener` / `start` / `stop` / `requestRender` and no `setLayoutRoot` — the existing `setLayoutRoot` vs `addChild` branch already covers that
- [x] A kit that loads but has no function screen class (`TuiAltScreen` / `TUI` / `TuiMainScreen` all missing or not functions) does not throw; `tui()` uses the plain-text fallback (same path as a missing pi-tui)
- [x] A regression test builds a kit object with `TUI` and no `TuiAltScreen` (do not require a real 0.80 install). Reproduce the github#16 throw before the pick, then show `interactive()` succeeds after

### Notes

- Repro from github#16: `npx shiftwork tui` → `shiftwork: TuiAltScreen is not a constructor`. Title says mac because that is where it was run; the miss is the export name, not the OS. Reporter's global `pi` is `@earendil-works/pi-coding-agent@0.80.3`; its nested `@earendil-works/pi-tui@0.80.3` exports `TUI` (`constructor(terminal, showHardwareCursor?)`) and does not export `TuiAltScreen` or `TuiMainScreen`. `Text` and `ProcessTerminal` are already there.
- `loadPiTui` treats any successful `import()` as `{ kit }`. 0.80's import succeeds, so `tui()` calls `interactive(root, kit)` and dies on `new TuiAltScreen`. A missing pi-tui already falls back; a loaded kit with no screen class must do the same.
- `locatePi` can pick a PATH/`pi.root` install older than the workspace's 0.99.1 (CLI peer on pi-coding-agent is optional). `npx shiftwork tui` with no local pi package is that case.
- Current pi-tui 0.99.1: `export class TuiAltScreen` with `constructor(terminal, showHardwareCursor, logDirectory, options = {})`. `new TuiAltScreen(terminal, false)` stays valid.
- Unwrap `kit.default` only if a test against a CJS-shaped module needs it; 0.80.3 is ESM and the named export is `TUI`.
- `tuiScreen(kit)` picks `TuiAltScreen`, then `TUI`, then `TuiMainScreen` when the export is a function. `interactive()` constructs that class with `(terminal, false)`. `tui()` calls `interactive` only when a pick exists; otherwise the existing plain-text `fallback`. Test hook: `tui(argv, { loaded, stdin, stdout })`.

## Comments

### Shift 1 — grok grok-4.6 (medium)
- Ended: stop
- Usage: 1850744 in / 36132 out tokens, $0.4519, 26 turns
- Time: 8m 20s
- Verify: failed at `node --test packages/cli/test/tui.test.js` (exit 124)

```
-bf4d1b18/gh-16-fix-on-mac-tui-02/packages/cli/test/tui.test.js:1127:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /\x1b\[7m/. Input:
    
    'shiftwork tui 0.2.0 · 2026-10-03 18:24:23 · [1 Queue]  2 Agents  3 Cooldowns  4…\n' +
      '\n' +
      '> ▾ demo 0/2 done · 2 next\n' +
      '    ● next #1  01 First\n' +
      '    ● next #2  02 Second\n' +
      '↑↓ move · ←→ fold · enter open · n run this · p pause · esc back\n' +
      'r run · s stop · d dry-run · f filter · g dark-factory · q quits'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: |-
    shiftwork tui 0.2.0 · 2026-10-03 18:24:23 · [1 Queue]  2 Agents  3 Cooldowns  4…
    
    > ▾ demo 0/2 done · 2 next
        ● next #1  01 First
        ● next #2  02 Second
    ↑↓ move · ←→ fold · enter open · n run this · p pause · esc back
    r run · s stop · d dry-run · f filter · g dark-factory · q quits
  operator: 'match'
  stack: |-
    TestContext.<anonymous> (file:///Users/kosmodev/.cache/shiftwork/worktrees/shiftwork-bf4d1b18/gh-16-fix-on-mac-tui-02/packages/cli/test/tui.test.js:1162:9)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: interactive: a kit with TUI and no TuiAltScreen (pi-tui 0.80) opens the dashboard
ok 36 - interactive: a kit with TUI and no TuiAltScreen (pi-tui 0.80) opens the dashboard
  ---
  duration_ms: 44.830959
  type: 'test'
  ...
# Subtest: tuiScreen: TuiAltScreen, then TUI, then TuiMainScreen when the export is a function
ok 37 - tuiScreen: TuiAltScreen, then TUI, then TuiMainScreen when the export is a function
  ---
  duration_ms: 0.236166
  type: 'test'
  ...
# Subtest: tui: a loaded kit with no function screen class uses the plain-text fallback
ok 38 - tui: a loaded kit with no function screen class uses the plain-text fallback
  ---
  duration_ms: 1.536833
  type: 'test'
  ...
# Subtest: interactive: a click event delivered to the layout root's handleMouse changes the view
ok 39 - interactive: a click event delivered to the layout root's handleMouse changes the view
  ---
  duration_ms: 150.529667
  type: 'test'
  ...
# Subtest: interactive: NO_COLOR disables colour in the interactive view
not ok 40 - interactive: NO_COLOR disables colour in the interactive view
  ---
  duration_ms: 22.088708
  type: 'test'
  location: '/Users/kosmodev/.cache/shiftwork/worktrees/shiftwork-bf4d1b18/gh-16-fix-on-mac-tui-02/packages/cli/test/tui.test.js:1355:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /\x1b\[7m/. Input:
    
    'shiftwork tui 0.2.0 · 2026-10-03 18:24:24 · [1 Queue]  2 Agents  3 Cooldowns  4…\n' +
      '\n' +
      '> ▾ demo 0/1 done · 1 next\n' +
      '    ● next #1  01 First\n' +
      '↑↓ move · ←→ fold · enter open · n run this · p pause · esc back\n' +
      'r run · s stop · d dry-run · f filter · g dark-factory · q quits'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: |-
    shiftwork tui 0.2.0 · 2026-10-03 18:24:24 · [1 Queue]  2 Agents  3 Cooldowns  4…
    
    > ▾ demo 0/1 done · 1 next
        ● next #1  01 First
    ↑↓ move · ←→ fold · enter open · n run this · p pause · esc back
    r run · s stop · d dry-run · f filter · g dark-factory · q quits
  operator: 'match'
  stack: |-
    TestContext.<anonymous> (file:///Users/kosmodev/.cache/shiftwork/worktrees/shiftwork-bf4d1b18/gh-16-fix-on-mac-tui-02/packages/cli/test/tui.test.js:1383:9)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: dashboardLayout: a terminal shorter than the header and footer still yields a frame
ok 41 - dashboardLayout: a terminal shorter than the header and footer still yields a frame
  ---
  duration_ms: 0.52475
  type: 'test'
  ...

[shiftwork] timed out after 10 min (verifyTimeoutMin)
```

- Outcome: new attempt

### Shift 2 — grok grok-4.6 (medium)
- Ended: STOP file, error: grok exited with code 143
- Usage: 1223764 in / 27913 out tokens, $0.0000, 19 turns
- Time: 5m 48s (ticket total 14m 8s)
- Verify: not run
- Outcome: stopped: STOP file
### Handoff — shift 2, grok:grok-4.6 → (no target), reason: STOP file
- Last output:

```
TUI tests are green. Running the full `npm test` gate next.
`tui.test.js` passed. The seven `npm test` failures look environmental, not from this change. I’ll confirm by re-running the suite without `FORCE_COLOR`, then note that on the ticket.
Unsetting `FORCE_COLOR` leaves one locatePi path failure. I’ll inspect that test and the stderr helpers so `npm test` can pass in this runner.
```

- Diff stat:

```
M packages/cli/src/tui.js
 M packages/cli/test/tui.test.js
packages/cli/src/tui.js       |  51 +++++----
 packages/cli/test/tui.test.js | 241 +++++++++++++++++++++++++++++++++++-------
 2 files changed, 235 insertions(+), 57 deletions(-)
```

### Shift — manual (claude), 2026-10-04T06:55Z
- Outcome: resolved
- Verify: passed (the ticket's node --test commands and the full `npm test`, 781 tests, 5 runs in a row)
