# 09: Follow-up to tui-polish/08: Show a kept ticket search's real keys in the footer…

**What to build:** Show a kept ticket search's real keys in the footer — enter jumps to the next match and esc clears the search — instead of the tab keys, and update the guides to match. Filed by the review of tui-polish/08 — see its "### Review" block in .scratch/tui-polish/issues/08-follow-up-to-tui-polish-05-show-tui-search-editi.md.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] It works

### Notes

- `footerKeys` in `packages/cli/src/dashboard.js` now keeps a kept details search's real keys in the footer — `enter next match · esc clear` (the new `SEARCH_KEYS.kept`) — instead of the tab's `enter open · esc back`, which were false while such a search is open. The predicate `keptTicketSearch` moved out of `tui-controls.js`'s privacy and is exported, so the footer shares the reducer's own notion of a kept ticket search. A kept list search still brings the tab's keys back, as in tui-polish/08.
- Tests: the kept ticket-search render now asserts `^enter next match · esc clear$` on its own footer line and that `esc back` and the editing hints are gone. `tui --help` and both guides (en/uk) now say a kept details search keeps its own keys while a kept list filter brings the tab's back. `npm run llms` rerun (18 files; llms-full.txt is gitignored).
- Verify (`npm test`): 639 tests, 629 pass, 0 fail, 10 skipped (the same pre-existing skips).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 31108 in / 8528 out tokens, $0.1894, 23 turns
- Time: 3m 2s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-09 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: follow-up — Change the details-search editing footer from enter next match to enter keep, and say so in the guides, because enter only stops editing until the search is kept.
- Time: 5m 38s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria, starting with the ticket, spec, and the change itself.
> The follow-up is narrow: footer keys for a kept ticket search. I'll check the reducer and the guides against that claim.
> The change is small. I'll run the verify gate and check the footer against the reducer's actual keys.
> The landed change does what tui-polish/09 asked. `npm test` passed: 639 tests, 629 pass, 0 fail, 10 skipped.
> 
> `footerKeys` now keeps a kept details search on `SEARCH_KEYS.kept` (`enter next match · esc clear`) instead of the tab line. It uses the same `keptTicketSearch` predicate the reducer uses, so the hint and the keys stay one notion: a non-empty ticket-scoped query that is no longer being edited. In that state `enter` increments `match` and `esc` clears the search before it closes the details. A kept list filter still restores the tab keys, and the list-search test still asserts that. Guides (en and uk) and `tui --help` describe the split.
> 
> One hint of the same kind is still wrong, and this ticket did not touch it. While a details search is being edited, the footer still says `enter next match`, but `enter` only sets `editing: false`. The jump happens on the next `enter`, which is when the new kept line is finally true. The list prompt already says `enter keep` for that step.
> 
> 
> 
> A kept ticket search now shows its real keys, and the verify gate is green. The editing footer for that same search still claims `enter` jumps to the next match.
- Follow-up: tui-polish/10 — Follow-up to tui-polish/09: Change the details-search editing footer from enter…
