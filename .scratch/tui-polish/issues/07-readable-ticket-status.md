# 07: Readable ticket status in the Queue

**What to build:** Operator report (2026-10-01): a ticket's status in the TUI is hard to read. Today a ticket row is `NN title · <raw status> · blocked by NN`: the status is a machine word (`ready-for-agent`, `needs-info`) at the end of a long title, so it is clipped on narrow terminals; `blocked by 01` is shown even when 01 is resolved (`tier-unlimited/02` reads "ready-for-agent · blocked by 01" though it is next up); and a ready ticket looks the same as a blocked one. In `renderQueueRows` (`packages/cli/src/dashboard.js`, row data from `queueRows` in `packages/cli/src/tui-controls.js`) put a fixed-width status column **before** the title, derived from status, frontier, blockers and live workers:

| shown | when |
| --- | --- |
| `▶ working  glm-5.3` | a live worker or live claim holds it (model, or `pid N` for another runner) |
| `● next #1` | on the frontier; `#N` is its place in the order the runner will take it |
| `⧗ waits 01, 03` | `ready-for-agent` with unresolved blockers — only the unresolved ones are listed |
| `? needs you` | `needs-info` (the details view shows the reason from the last shift report) |
| `✋ for human` | `ready-for-human` |
| `○ triage` | `needs-triage` |
| `✔ done` | `resolved` |
| `✖ wontfix` | `wontfix` |
| `⏸ paused` | its feature is paused (once `feature-pause` lands; until then never shown) |

Colours (when on) as in ticket 02: done green, working cyan, next bold, waits dim, needs-you yellow. The trailing `· <status> · blocked by …` parts go away. The feature row's counts become `2/6 done · 2 next · 1 needs you` (omitting zero parts). The details view's first line shows the same label and, for `needs-info`, the reason line. `--once`/plain output uses the same words without colour. Add a legend to `tui --help` and to the guides (en + uk) section 7 ("What the TUI does"), and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/tui-controls.test.js packages/cli/test/tui.test.js packages/cli/test/status.test.js` · `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [ ] Row tests for each label in the table, including `⧗ waits` listing only unresolved blockers and `● next #N` numbered in frontier order
- [ ] A ticket whose blockers are all resolved never shows "blocked"/"waits"
- [ ] Narrow-width test (40 columns): the status column is still fully visible; the title is what gets clipped
- [ ] Feature row shows `done / next / needs you` counts without zero parts
- [ ] Details view shows the label and a needs-info ticket's reason
- [ ] Legend in `tui --help` and the guides (en + uk)
