# 10: Follow-up to tui-polish/09: Change the details-search editing footer from enter…

**What to build:** Change the details-search editing footer from enter next match to enter keep, and say so in the guides, because enter only stops editing until the search is kept. Filed by the review of tui-polish/09 — see its "### Review" block in .scratch/tui-polish/issues/09-follow-up-to-tui-polish-08-show-a-kept-ticket-se.md.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] It works

### Notes

- `SEARCH_KEYS.ticket` in `packages/cli/src/dashboard.js` now says `letters add to the query · backspace delete · enter keep · esc clear` — while a details search is being edited, `enter` only stops editing until the search is kept, so the jump-to-next-match claim moved to the kept footer alone (`SEARCH_KEYS.kept`, unchanged). Its comment says both prompts' `enter` only stops editing and keeps the search.
- Tests: the editing-footer assertion in `packages/cli/test/tui.test.js` now expects `enter keep` and asserts `next match` is absent while editing; the kept-search assertions are unchanged.
- Docs: `tui --help` (`packages/cli/src/tui.js`) and both guides (en/uk) now say the first `enter` in a details search stops typing and keeps the search, and `enter` again scrolls to the next match. `npm run llms` rerun (18 files; llms-full.txt is gitignored).
- Verify (`npm test`): 639 tests, 629 pass, 0 fail, 10 skipped (the same pre-existing skips).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 16634 in / 4309 out tokens, $0.1006, 18 turns
- Time: 1m 48s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-10 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — The editing footer now says enter keep, matching the reducer, and the guides say the same.
- Time: 3m 16s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, comments, and the change itself.
> The ticket is a footer-wording follow-up. I'll read the landed diff, the prior review, and the surrounding search-footer code.
> The diff is small. I'll check the reducer against the new footer wording, then run the verify gate.
> The reducer looks consistent. I'll search for leftover "next match" claims and confirm enter only stops editing.
> The footer wording matches the reducer. I'll run the verify gate next.
> The landed change does what tui-polish/10 asked. `npm test` passed: 639 tests, 629 pass, 0 fail, 10 skipped.
> 
> While a details search is being edited, `SEARCH_KEYS.ticket` now says `enter keep`, and `footerKeys` still shows that line only while `search.editing` is set. `editSearchKey` handles that `enter` by setting `editing: false` and does not advance `match`; the jump stays on the next `enter`, when `keptTicketSearch` is true and the footer is `enter next match · esc clear`. The render test asserts `enter keep` on the editing footer and that `next match` is absent there; the kept-search assertions are unchanged. `tui --help` and both guides describe the two-step `enter`.
> 
> The Ukrainian clause is a little bare (`підвал поки триває набір каже`), but it states the same fact. Not worth another ticket.
