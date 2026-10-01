# 05: Search tickets globally, within a feature, and inside a ticket

**What to build:** A `/` search prompt in the interactive TUI (GitHub #3). View state gains `search: { query, scope, editing }` in `packages/cli/src/tui-controls.js`. On the Queue or Resolved tab, `/` opens the prompt with scope `global`; while `editing`, printable keys append to the query, `backspace` deletes, `tab` toggles the scope between `global` and `feature` (the feature under the cursor when the prompt opened), `enter` stops editing and keeps the filter, `esc` closes the prompt and clears the query. The list (`queueRows`/`resolvedRows`) keeps only tickets whose number or title contains the query (case-insensitive) plus their feature rows; the cursor is clamped to the filtered rows. With a ticket's details open, `/` searches inside the details (scope `ticket`): matches in the rendered detail lines are highlighted (reverse video when colour is on, `[…]` brackets otherwise) and `enter` scrolls to the next match. While `editing`, `n`, `r`, `s`, `d`, `f`, `q` and digits are query text, not commands (Ctrl-C still quits). `packages/cli/src/dashboard.js` shows the prompt in the header (`/ query · global`) and the key hints in the footer. Update `tui --help`, guides (en + uk) section 7 and run `npm run llms`.

**Blocked by:** 03

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Reducer tests: `/` then `f`,`o`,`o` builds the query; `backspace` removes a character; `tab` toggles global ↔ feature scope; `esc` clears; `q` while editing doesn't quit
- [ ] Row tests: a global query keeps matching tickets from several features and their feature rows; a feature-scoped query keeps only that feature's matches; matching works on number and title, case-insensitive
- [ ] Details test: a ticket-scoped query highlights matches and `enter` moves to the next match
- [ ] Render test: the header shows the prompt while searching
- [ ] Guides (en + uk) and `tui --help` describe search
