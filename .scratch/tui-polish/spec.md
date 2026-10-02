# Spec: TUI polish — keys, colours, cursor, resolved tab, mouse, search

**Status:** ready-for-agent

Source: GitHub issues #1, #2, #3, #4, #5, #7 (Ivlad003/shiftwork, 2026-10-01). Vocabulary: `CONTEXT.md`. Builds on `.scratch/tui-dashboard/`.

## Problem Statement

- **Esc does nothing in a ticket's details (#7).** pi-tui's `ProcessTerminal` enables the kitty keyboard protocol (flags 7), so the terminal sends Esc as `ESC[27u` and Ctrl-C as `ESC[99;5u`. `decodeKeys` in `packages/cli/src/tui-controls.js` treats every CSI sequence it doesn't know as junk and drops it, so `esc` never reaches the reducer, and Ctrl-C likely doesn't quit either.
- **The cursor row is hard to see (#1).** It is marked only by a `>` in column 0.
- **No colours (#4).** Statuses, live workers, cooldowns and notices are all plain text.
- **Resolved features clutter the Queue (#2).** A feature whose tickets are all resolved stays in the list forever.
- **No mouse (#5).** `TuiAltScreen` already turns on SGR mouse reporting, but the layout root is a plain `Text` with no `handleMouse`, so clicks and the wheel are lost.
- **No search (#3).** No way to find a ticket by title or number across features, within one feature, or a word inside an open ticket.

## Solution

- **Kitty-aware key decoding.** `decodeKeys` understands CSI-u (`ESC[<code>[;<mods>[:<event>]]u`): 27 → `esc`, 13 → `enter`, 9 → `tab`, 127 → `backspace`, `99;5` (Ctrl+c) → `"\x03"`, other printable codes → the character; release events (`:3`) are dropped. Legacy sequences keep working.
- **Styled frame.** `renderDashboard(state, { width, height, color })`: with `color: true` the cursor row is reverse video and statuses are coloured (resolved green, claimed/live worker cyan, needs-info yellow, blocked dim, cooldowns red, active tab bold, notice yellow). Styling is applied after clipping, so `width` is still counted in visible columns. Off by default; on in the interactive view unless `NO_COLOR` is set. `--once` and the plain-text fallback stay colourless.
- **Resolved tab.** Features with every ticket resolved leave the Queue and move to a fifth tab, **Resolved** (`5`; `tab` cycles all five). Its rows, cursor, fold and `enter` → details work like the Queue's.
- **Mouse.** Click a tab label to switch tabs; click a row to move the cursor, click it again to open it (= `enter`); the wheel moves the cursor.
- **Search.** `/` opens a search prompt: in the Queue/Resolved list it filters tickets by number or title — globally, or within the cursor's feature after `tab` toggles the scope; inside open details it highlights matches and `enter` jumps to the next one. `esc` closes the prompt and clears the query.

## Implementation Decisions

- The reducer stays pure: mouse input becomes reducer actions (`{ type: "click", … }`, `{ type: "wheel", … }`) — no I/O, testable without a terminal.
- `renderSized` exposes a hit map (which screen line is which row index of the tab, and the column span of each tab label on line 0) for the mouse layer; the layout root becomes a small component `{ render(width), handleMouse(event) }` wrapping today's `Text`.
- Search state lives in the view: `search: { query, scope: "global" | "feature" | "ticket", editing }`. While editing, printable keys, backspace and enter go to the query rather than their usual action.
- No new runtime dependencies; plain SGR escape codes, no pi-tui colour helpers.
- Docs: `shiftwork tui --help`, `docs/guide.md` and `docs/guide.uk.md` section 7 ("What the TUI does"), then `npm run llms`.

## Out of Scope

- Themes or configurable colours.
- Searching ticket bodies in global scope (titles and numbers only).

<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | Decode kitty keyboard-protocol keys (Esc, Ctrl-C) in the TUI | resolved | opencode-go/glm-5.3 |
| 02 | Colours and a highlighted cursor row in the interactive TUI | resolved | opencode-go/glm-5.3 |
| 03 | Move fully resolved features to a Resolved tab | resolved | opencode-go/glm-5.3 |
| 04 | Mouse clicks and wheel in the interactive TUI | ready-for-agent | opencode-go/glm-5.3 |
| 05 | Search tickets globally, within a feature, and inside a ticket | resolved | opencode-go/glm-5.3 |
| 06 | Show live agents on the feature row, also when it is collapsed | resolved | opencode-go/glm-5.3 |
| 07 | Readable ticket status in the Queue | resolved | opencode-go/glm-5.3 |
| 08 | Follow-up to tui-polish/05: Show TUI search editing hints only while search.edi… | resolved | opencode-go/glm-5.3 |
| 09 | Follow-up to tui-polish/08: Show a kept ticket search's real keys in the footer… | resolved | opencode-go/glm-5.3 |
| 10 | Follow-up to tui-polish/09: Change the details-search editing footer from enter… | resolved | opencode-go/glm-5.3 |
<!-- shiftwork:tickets:end -->
