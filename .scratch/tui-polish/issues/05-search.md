# 05: Search tickets globally, within a feature, and inside a ticket

**What to build:** A `/` search prompt in the interactive TUI (GitHub #3). View state gains `search: { query, scope, editing }` in `packages/cli/src/tui-controls.js`. On the Queue or Resolved tab, `/` opens the prompt with scope `global`; while `editing`, printable keys append to the query, `backspace` deletes, `tab` toggles the scope between `global` and `feature` (the feature under the cursor when the prompt opened), `enter` stops editing and keeps the filter, `esc` closes the prompt and clears the query. The list (`queueRows`/`resolvedRows`) keeps only tickets whose number or title contains the query (case-insensitive) plus their feature rows; the cursor is clamped to the filtered rows. With a ticket's details open, `/` searches inside the details (scope `ticket`): matches in the rendered detail lines are highlighted (reverse video when colour is on, `[…]` brackets otherwise) and `enter` scrolls to the next match. While `editing`, `n`, `r`, `s`, `d`, `f`, `q` and digits are query text, not commands (Ctrl-C still quits). `packages/cli/src/dashboard.js` shows the prompt in the header (`/ query · global`) and the key hints in the footer. Update `tui --help`, guides (en + uk) section 7 and run `npm run llms`.

**Blocked by:** 03

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Reducer tests: `/` then `f`,`o`,`o` builds the query; `backspace` removes a character; `tab` toggles global ↔ feature scope; `esc` clears; `q` while editing doesn't quit
- [x] Row tests: a global query keeps matching tickets from several features and their feature rows; a feature-scoped query keeps only that feature's matches; matching works on number and title, case-insensitive
- [x] Details test: a ticket-scoped query highlights matches and `enter` moves to the next match
- [x] Render test: the header shows the prompt while searching
- [x] Guides (en + uk) and `tui --help` describe search

### Notes

- View state: `search: { query, scope: "global" | "feature" | "ticket", feature, editing, match }` — `feature` is the feature under the cursor captured when `/` opened the prompt (the scope `tab` toggles to), `match` is the details search's current match (`enter` advances it; rendering wraps it with modulo).
- `searchFilter` in `tui-controls.js` filters `queueRows` for global/feature scopes (number or title, case-insensitive; feature rows keep the whole feature's counts); a ticket scope and an empty query leave the list alone. Cursor clamping comes free through `normalize`.
- While `search.editing`, `editSearchKey` intercepts printable keys (incl. `n r s d f q`, digits, `/` and spaces) before the command switch; arrows and Ctrl-C fall through (Ctrl-C still quits). `/` on other tabs than Queue/Resolved (and without details open) is a no-op.
- `esc` clears a kept search before it closes the details; `enter` on a kept global/feature search keeps its usual action (opens the filtered row's details).
- `renderDetails` brackets every match (`[…​]`) and scrolls to the current match's line; the paint layer (`unbracket`) turns the brackets into reverse video in colour, after clipping, so widths still fit. Header shows `/ <query> · <scope>` (`feature <name>` for a feature scope); the footer's first line swaps to the search keys while a search is open.
- `npm run llms` regenerated `llms-full.txt` (18 files).
- Verify (`npm test`): 633 tests, 623 pass, 0 fail, 10 skipped (the same pre-existing skips).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 108759 in / 51855 out tokens, $1.4647, 58 turns
- Time: 16m 29s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-05 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: follow-up — Show TUI search editing hints only while search.editing is true, and render the search prompt on its own header line so the query and scope are not clipped off by the tab labels.
- Time: 9m 29s
- Verify: passed
- Findings:

> I'll review the landed search ticket against its acceptance criteria and the feature spec, starting with the ticket, spec, and the landed diff.
> The ticket landed as `8d10dfa`. I'll read the commit and the domain docs, then check the implementation against the acceptance criteria.
> The commit touches the reducer, renderer, help text, and guides. I'll read those paths next and check whether `npm run llms` actually landed.
> The search ticket meets its acceptance criteria, and `npm test` passed (623 pass, 0 fail, 10 skipped). Two interactive-chrome bugs are still worth a follow-up.
> 
> The reducer, list filter, and details search match the ticket. `/` then letters builds the query; backspace, tab (global ↔ the feature captured when the prompt opened), and esc behave as specified. While editing, `q`, `n`, `r`, `s`, `d`, `f`, and digits are query text, and Ctrl-C still quits. `queueRows` and `resolvedRows` keep matching tickets from several features, plus their feature rows and full counts; a feature scope stays inside the captured feature; matching is case-insensitive on number and title. A ticket-scoped query brackets matches (`[…]`, reverse video when colour is on) and `enter` advances to the next matching line, wrapping in the renderer. Guides (en and uk, section 7) and `tui --help` describe this. `llms-full.txt` is gitignored; the guides it concatenates are updated.
> 
> After `enter` keeps a list search, the footer still says letters, backspace, tab, and enter edit the query. They do not: `q` quits and `r` starts a runner. Those hints are only true while `search.editing` is set. The prompt is also appended to a header that is already about 105 columns, so at width 80 it is clipped away entirely (`…4…`) and at the 120-column width the other TUI tests use, the scope is cut off. The render test only sees it because it uses width 160.
> 
> Smaller nits, not the follow-up: a kept feature scope reopened with `/` recaptures whatever row is under the cursor (it can drop the original feature); tab while a ticket search is editing cycles tabs and leaves editing on; list matching concatenates number and title, so a query can hit across that boundary.
- Follow-up: tui-polish/08 — Follow-up to tui-polish/05: Show TUI search editing hints only while search.edi…
