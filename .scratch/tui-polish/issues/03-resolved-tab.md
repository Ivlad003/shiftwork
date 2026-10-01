# 03: Move fully resolved features to a Resolved tab

**What to build:** A feature whose tickets are all `resolved` leaves the Queue tab and is listed on a new fifth tab, **Resolved** (GitHub #2). In `packages/cli/src/tui-controls.js`: add `resolved` to `TABS`; `queueRows` skips fully resolved features and a `resolvedRows` (same row shape) lists only them, honouring `collapsed` and `featureFilter`; `5` opens the tab and `tab` cycles all five; the cursor, `←→` fold and `enter` → details work there as on the Queue (`enterKey`, `collapse`, `normalize`, `tabRows` no longer assume `tab === "queue"`); `esc` closes details on either tab; `n` on the Resolved tab is refused with the usual "not on the frontier: status resolved" notice. In `packages/cli/src/dashboard.js`: `TAB_LABELS`, `TAB_KEYS`, the header and the sized body render the new tab (`Resolved: none` when empty); the plain frame (`--once`) keeps listing every feature as today. Update `tui --help`, guides (en + uk) section 7 and run `npm run llms`.

**Blocked by:** 02

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [ ] Reducer tests: a fully resolved feature is absent from `queueRows` and present in `resolvedRows`; a feature with one open ticket stays on the Queue; `5` and `tab` reach the tab; `enter` there opens details and `esc` closes them
- [ ] Render test: the sized frame of the Resolved tab lists the resolved feature and its tickets; the header shows `5 Resolved`
- [ ] `tui --once` output still lists resolved features (unchanged plain frame)
- [ ] Guides (en + uk) and `tui --help` describe the Resolved tab
