# 02: Colours and a highlighted cursor row in the interactive TUI

**What to build:** Add a `color` option to `renderDashboard(state, { width, height, color })` in `packages/cli/src/dashboard.js` (GitHub #1, #4). With `color: true`: the cursor row of the current tab (Queue, Agents, Cooldowns, Log) is reverse video across the visible width; ticket statuses are coloured (resolved green, claimed cyan, needs-info yellow, blocked dim), the `● model` worker marker cyan, cooldown rows red, the active tab label bold, the `»` notice yellow. Use plain SGR codes and apply them **after** `fit()` clips the line, so width is still counted in visible columns and the clipped text never cuts an escape sequence. `color` defaults to false: `--once`, non-TTY output and the plain-text fallback are unchanged. `interactive()` in `packages/cli/src/tui.js` passes `color: !process.env.NO_COLOR`. Update `shiftwork tui --help`, `docs/guide.md` + `docs/guide.uk.md` section 7, and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js tui --once`

- [ ] Tests: with `color: true` the cursor row contains `\x1b[7m`, a resolved ticket row contains a green SGR code; with color off no line contains `\x1b[`
- [ ] Test: with `color: true` and a narrow `width`, every line's visible width (escapes stripped) is ≤ `width`
- [ ] `tui --once` output contains no escape sequences
- [ ] `NO_COLOR=1` disables colour in the interactive view (stub-terminal test)
- [ ] Guides (en + uk) and `tui --help` mention colours and `NO_COLOR`
