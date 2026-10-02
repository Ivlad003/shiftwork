# 03: Move fully resolved features to a Resolved tab

**What to build:** A feature whose tickets are all `resolved` leaves the Queue tab and is listed on a new fifth tab, **Resolved** (GitHub #2). In `packages/cli/src/tui-controls.js`: add `resolved` to `TABS`; `queueRows` skips fully resolved features and a `resolvedRows` (same row shape) lists only them, honouring `collapsed` and `featureFilter`; `5` opens the tab and `tab` cycles all five; the cursor, `←→` fold and `enter` → details work there as on the Queue (`enterKey`, `collapse`, `normalize`, `tabRows` no longer assume `tab === "queue"`); `esc` closes details on either tab; `n` on the Resolved tab is refused with the usual "not on the frontier: status resolved" notice. In `packages/cli/src/dashboard.js`: `TAB_LABELS`, `TAB_KEYS`, the header and the sized body render the new tab (`Resolved: none` when empty); the plain frame (`--once`) keeps listing every feature as today. Update `tui --help`, guides (en + uk) section 7 and run `npm run llms`.

**Blocked by:** 02

**Status:** resolved
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [x] Reducer tests: a fully resolved feature is absent from `queueRows` and present in `resolvedRows`; a feature with one open ticket stays on the Queue; `5` and `tab` reach the tab; `enter` there opens details and `esc` closes them
- [x] Render test: the sized frame of the Resolved tab lists the resolved feature and its tickets; the header shows `5 Resolved`
- [x] `tui --once` output still lists resolved features (unchanged plain frame)
- [x] Guides (en + uk) and `tui --help` describe the Resolved tab

### Notes

- `TABS` is now `[queue, agents, cooldowns, log, resolved, github]`: Resolved takes `5` (the ticket's wording), so GitHub moved from `5` to `6`, `tab` cycles all six, and the reducer accepts `6`. The guides' dark-factory section and `tui --help` were updated to say `6` for the GitHub tab.
- `queueRows(dashboard, view, { resolved })`: `"skip"` (default, Queue) drops fully resolved features, `"only"` lists just them (exported as `resolvedRows`), `null` keeps them — `renderQueueSection` passes `null` so the `--once` plain frame is unchanged. A shared `folderRows(tab, …)` gives Queue and Resolved the same cursor, `←→` fold and `enter` → details; `n` on Resolved is refused with "not on the frontier: status resolved".
- `enter` on a GitHub row whose feature is fully resolved now opens it on the Resolved tab (it is no longer in the Queue's rows).
- Verify: `npm test` (619 tests, 609 pass, 10 pre-existing live-provider skips, 0 fail) and `node packages/cli/bin/shiftwork.js tui --once` (header `[1 Queue] … 5 Resolved 6 GitHub`, fully resolved features still listed). `npm run llms` re-run; `llms-full.txt` is gitignored, no repo change.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 80590 in / 28842 out tokens, $1.0564, 57 turns
- Time: 22m 35s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-03 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — The Resolved tab meets the acceptance criteria, and the verify gate passed.
- Time: 8m 33s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, spec, and the landed diff.
> The ticket notes a six-tab layout versus the spec's five. I'll read the diff and the surrounding TUI code to see whether that still meets the acceptance criteria.
> The Resolved tab matches the ticket. Fully resolved features leave the Queue, key `5` and `tab` reach the new tab, and fold, details, and `esc` work there the same way they do on the Queue. `n` is refused with `not on the frontier: status resolved`.
> 
> The six-tab layout is the right adaptation. Resolved is key `5`, and GitHub moved to `6` rather than dropping out of the cycle. Guides (en and uk), `tui --help`, and the dark-factory section all say `6`.
> 
> `npm test` passed with 609 tests, 10 pre-existing skips, and 0 failures. `node packages/cli/bin/shiftwork.js tui --once` still lists fully resolved features under a header that shows `5 Resolved` and `6 GitHub`.
> 
> Two nits are not acceptance failures. GitHub `enter` switches to Resolved before checking that the feature is actually in `resolvedRows`, so an issue with no local tickets lands there and a matching feature filter is cleared. The Queue still says `Tickets: none` when it is empty only because those features moved to Resolved, including after `f` lands on one.
> 
> 
> 
> Fully resolved features leave the Queue for a Resolved tab on key 5, with the same rows, cursor, fold, and details. The plain `--once` frame still lists them. Tests and `tui --once` passed.
