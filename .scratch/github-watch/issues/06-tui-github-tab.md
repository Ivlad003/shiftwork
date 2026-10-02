# 06: TUI GitHub tab and dark-factory toggle

**What to build:** A **GitHub** tab in the TUI (`packages/cli/src/tui-controls.js`, `packages/cli/src/dashboard.js`), after the existing tabs: one row per issue in `.pi/shiftwork-github.json` — `#<N> <title> · <feature> · <state>` where state is planning / working / needs-info / done / closed from the feature's tickets, plus the time of the last sync; `enter` opens the issue's feature in the Queue tab with the cursor on it. A key `g` toggles dark-factory: when no runner is live it starts `shiftwork run --dark-factory` detached (like `r`, via `startDetachedRunner` with a `darkFactory` flag), when one is live it writes STOP; the header shows `dark-factory` while such a runner is live (record `mode: "dark-factory"` in the run state). Update `tui --help`, guides (en + uk) section 7 and run `npm run llms`.

**Blocked by:** 05

**Status:** resolved
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [x] Reducer tests: the GitHub tab's rows come from the state file; `enter` jumps to the feature in the Queue; `g` emits start-runner with `darkFactory: true` when idle and stop-runner when live
- [x] Render test: the tab lists issues with their state; the header shows `dark-factory` for a dark-factory run state
- [x] `startDetachedRunner` passes `--dark-factory` (argv-runner stub test)
- [x] Guides (en + uk) and `tui --help` describe the tab and `g`

### Notes

- The GitHub tab is the fifth (`1`–`5`, `tab` cycles): one row per issue in `.pi/shiftwork-github.json` — `#<N> <title> · <feature> · <state>`, state derived from the feature's tickets (planning / working / needs-info / done / closed), plus the time of the last sync (`syncedAt`, written by `syncIssues` on every sync, shown as `GitHub: N issues · last sync Xm ago` in the tab's head).
- The issue title is now recorded in the state entry at import (`github-import.js`), so the rows come from the state file alone; an unreadable state file yields empty rows, never a crash.
- `g` toggles dark-factory: `start-runner` with `darkFactory: true` when idle → `startDetachedRunner` spawns `run --dark-factory` and records `mode: "dark-factory"` in the run state (also recorded by `darkFactoryRun` itself, shell-started or not); when a runner is live it writes STOP like `s`.
- The run state's merged view (`openRunState().read()`) now carries `mode` (core `run-state.js` + `index.d.ts`); the header shows `dark-factory` only while such a runner is live. `enter` on a GitHub row opens the feature in the Queue tab, the cursor on its folder row, clearing a feature filter that would hide it.
- `npm run llms` re-run (llms-full.txt regenerated).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 100794 in / 42453 out tokens, $1.7095, 83 turns
- Time: 14m 40s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/github-watch-06 into main
