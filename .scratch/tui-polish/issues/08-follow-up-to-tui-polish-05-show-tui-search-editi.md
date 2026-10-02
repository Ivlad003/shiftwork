# 08: Follow-up to tui-polish/05: Show TUI search editing hints only while search.edi…

**What to build:** Show TUI search editing hints only while search.editing is true, and render the search prompt on its own header line so the query and scope are not clipped off by the tab labels. Filed by the review of tui-polish/05 — see its "### Review" block in .scratch/tui-polish/issues/05-search.md.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] It works

### Notes

- `footerKeys` in `packages/cli/src/dashboard.js` now swaps in the search keys only while `search.editing` is true; a kept search (after `enter`) brings the tab's keys back, so `q` quits and `r` runs again.
- The prompt left `headerLine` and got its own `searchLine` (`/ <query> · <scope>`), pushed as the second header line in both `renderSized` and `renderPlain` — the tab labels no longer clip it, width 80 included. The mouse hit map and tab spans come from the same header length / line 0, so they are unaffected.
- Tests: the list and ticket search tests now render at width 80 and assert the prompt sits alone on line 1 (`^…$`), and that a kept search keeps the prompt but restores the tab keys. `tui --help` and both guides now say "on its own line" and "while you type". `npm run llms` rerun (18 files; llms-full.txt is gitignored).
- Verify (`npm test`): 639 tests, 629 pass, 0 fail, 10 skipped (the same pre-existing skips).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 26117 in / 7399 out tokens, $0.1884, 27 turns
- Time: 2m 53s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-08 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: follow-up — Show a kept ticket search's real keys in the footer — enter jumps to the next match and esc clears the search — instead of the tab keys, and update the guides to match.
- Time: 4m 28s
- Verify: passed
- Findings:

> I'll start by reading the ticket, the spec, and the landed diff so I can judge the change against its acceptance criteria.
> The ticket is a follow-up to the search review. I'll read that review and the landed diff next.
> The follow-up is narrow: search hints only while editing, and the prompt on its own line. I'll read the renderer and the tests that cover it.
> Tests passed. I'll check the width-80 footer and the hit map with a search line open, since those are the two places this change could still lie.
> The landed change does what tui-polish/08 asked. `npm test` passed: 639 tests, 629 pass, 0 fail, 10 skipped.
> 
> `footerKeys` now swaps in the search keys only while `search.editing` is true. After `enter` keeps a list search, the Queue keys return, so `q` quits and `r` runs again, and the editing hints are gone. The prompt is no longer appended to the tab header. `searchLine` is its own header line in both `renderSized` and `renderPlain` (`/ <query> · <scope>`). At width 80 the tab line is still clipped (`…4…`), but `/ widget · global` sits whole on line 1. Tab spans stay on line 0, and the hit-map rows start below the search line, so mouse clicks are unaffected. Guides (en and uk) and `tui --help` say "on its own line" and "while you type".
> 
> One hint regression remains. A kept ticket search still treats `enter` as "next match" and `esc` as "clear the search, then close details" (`keptTicketSearch` and the `esc` branch in `reduceKey`). After editing stops, the footer now shows the tab keys — `enter open · esc back` — which are false for those two keys. While editing, the ticket footer still says `enter next match`, but `enter` only stops editing. That second mismatch was already there; this change made the kept state worse.
- Follow-up: tui-polish/09 — Follow-up to tui-polish/08: Show a kept ticket search's real keys in the footer…
