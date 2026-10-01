# 06: TUI GitHub tab and dark-factory toggle

**What to build:** A **GitHub** tab in the TUI (`packages/cli/src/tui-controls.js`, `packages/cli/src/dashboard.js`), after the existing tabs: one row per issue in `.pi/shiftwork-github.json` — `#<N> <title> · <feature> · <state>` where state is planning / working / needs-info / done / closed from the feature's tickets, plus the time of the last sync; `enter` opens the issue's feature in the Queue tab with the cursor on it. A key `g` toggles dark-factory: when no runner is live it starts `shiftwork run --dark-factory` detached (like `r`, via `startDetachedRunner` with a `darkFactory` flag), when one is live it writes STOP; the header shows `dark-factory` while such a runner is live (record `mode: "dark-factory"` in the run state). Update `tui --help`, guides (en + uk) section 7 and run `npm run llms`.

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [ ] Reducer tests: the GitHub tab's rows come from the state file; `enter` jumps to the feature in the Queue; `g` emits start-runner with `darkFactory: true` when idle and stop-runner when live
- [ ] Render test: the tab lists issues with their state; the header shows `dark-factory` for a dark-factory run state
- [ ] `startDetachedRunner` passes `--dark-factory` (argv-runner stub test)
- [ ] Guides (en + uk) and `tui --help` describe the tab and `g`
