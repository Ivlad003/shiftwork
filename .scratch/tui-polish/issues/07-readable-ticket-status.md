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

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/tui-controls.test.js packages/cli/test/tui.test.js packages/cli/test/status.test.js` · `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [x] Row tests for each label in the table, including `⧗ waits` listing only unresolved blockers and `● next #N` numbered in frontier order
- [x] A ticket whose blockers are all resolved never shows "blocked"/"waits"
- [x] Narrow-width test (40 columns): the status column is still fully visible; the title is what gets clipped
- [x] Feature row shows `done / next / needs you` counts without zero parts
- [x] Details view shows the label and a needs-info ticket's reason
- [x] Legend in `tui --help` and the guides (en + uk)

### Notes

- The column is derived in one place, `ticketStatusColumn(dashboard, ticket)` in `packages/cli/src/tui-controls.js` (exported), and carried on every `queueRows` ticket row as `label` + `tone` plus its pieces (`blockers` unresolved-only, `order` the 1-based frontier place, `worker`, `claim`). Rendering, the details view and the paint layer all reuse it.
- `queueRows` feature rows now count `done` / `next` / `needsYou` / `total` (was `resolved` / `ready`); `renderQueueRows` prints them as `2/6 done · 2 next · 1 needs you`, omitting zero `next`/`needs you` parts.
- The row reads `<padded label>  NN title`: the column is padded to the widest label rendered in that call, so titles align and a narrow terminal clips the title, never the words. The trailing `· <status> · blocked by …` parts are gone; the `● <model>` worker marker moved into the `▶ working <model>` label.
- Colour: the paint layer finds the label glyphs (`▶ ● ⧗ ? ✔`) with one regex and colours by glyph — working cyan, next bold, waits dim, needs you yellow, done green (ticket 02's palette). The old ` · blocked by` rule is gone; the ` · (resolved|claimed|needs-info)` rule stays (the Agents head and the GitHub tab still show those words).
- The details view's first line carries the label; a needs-info ticket gets a `Reason:` line, taken from the last shift report's `- Outcome: needs-info: …` line, else a `<shiftwork:needs-info reason=…/>` marker (`needsInfoReason` in dashboard.js).
- Edge cases: a claimed ticket with no visible worker/claim reads `▶ working ?` (a frame between the claim dying and the next frontier refresh); an unknown status reads `○ triage`. `⏸ paused` is documented in the legend but has no code path until feature-pause lands.
- Docs: legend added to `tui --help` (`packages/cli/src/tui.js`), `docs/guide.md` and `docs/guide.uk.md` section 7; `npm run llms` re-ran (llms-full.txt is gitignored).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 133814 in / 60803 out tokens, $2.2852, 86 turns
- Time: 22m 49s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-07 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — The status column, feature counts, details reason, legend and verify gate all match the ticket.
- Time: 8m 40s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, spec, and the landed diff.
> The ticket landed in `b06a254`. I'll read the commit, the domain vocabulary, and the code it changed.
> The commit is large. I'll read the status-column code and the remaining docs changes next, then run the verify gate.
> I'll check that the status glyphs match across code, help, and guides, then run the verify gate.
> The landed change in `b06a254` meets the ticket. The Queue and Resolved rows now lead with one derived status column, and the old trailing machine status and blocker text are gone.
> 
> `ticketStatusColumn` is the single source for the label. A live worker or claim shows as `▶ working`, a frontier ticket as `● next #N` in frontier order, a ready ticket with unresolved blockers as `⧗ waits` listing only those blockers, and the other statuses use their own words. A ticket whose blockers are all resolved is on the frontier, so it shows as next, not waits. Feature rows read `2/6 done · 2 next · 1 needs you`, dropping zero `next` and `needs you` parts. The details view repeats the label and, for `needs-info`, a `Reason:` line from the last shift report or the needs-info marker. `--once` uses the same words without colour. The legend is in `tui --help` and in section 7 of both guides.
> 
> The verify gate passed: the three named test files (86 tests), `npm test` (629 passed, 0 failed), and `tui --once`, which shows the new column on the live queue.
