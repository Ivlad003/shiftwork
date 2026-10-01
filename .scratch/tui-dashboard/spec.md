# Spec: interactive TUI dashboard (phase 5)

**Status:** ready-for-agent

Source: operator request, 2026-10-01, after release 0.1.1. Vocabulary: `CONTEXT.md`.

## Problem Statement

- **One long frame.** `shiftwork tui` prints the runner, every feature's ticket table, cooldowns and the log tail as one list. On a real repo it is taller than the terminal, so the top scrolls away and nothing can be selected.
- **No navigation.** There is no way to move through features or tickets, open a ticket, or see which agent works on which ticket without reading the whole frame.
- **No way to pick the next ticket.** `r` works the whole frontier. `shiftwork run` has no option to work one chosen ticket, so the TUI can't offer it either.

## Solution

- **Tabs.** Four full-screen tabs, switched with `1`–`4` (and `tab`): **Queue**, **Agents**, **Cooldowns**, **Log**. A header shows the tabs and the last notice; a footer shows the keys of the current tab.
- **Queue.** Features as folders (`▾ parallel 3/4`), their tickets underneath with number, title, status, blockers and the agent working on it (`● claude:sonnet`). `↑↓`/`j k` move, `←→` collapse and expand a feature, `enter` opens the ticket's details, `n` runs the selected ticket.
- **Details.** The selected ticket's Type, Model, Budget, Verify, Blocked by, What to build, its dry-run route and its latest shift report from `## Comments`. `esc` goes back.
- **Agents.** One row per running shift: ticket, model ref, tier, shift/attempt, tokens, cost, turns, context fill, budget, elapsed. `enter` on a row opens its log in the Log tab.
- **Cooldowns** and **Log** as today, but full-screen; the log follows the agent selected on the Agents tab.
- **Run one ticket.** `shiftwork run --ticket <feature>/<NN>` works exactly that ticket, and `n` in the TUI starts it detached, like `r`.
- **Full screen.** The interactive view uses pi-tui's alternate screen, fits the terminal height (lists scroll to keep the cursor visible) and redraws on resize.

## User Stories

1. As an operator, I want to see features as folders with their tickets inside, so that I can find a ticket without scrolling a long frame.
2. As an operator, I want to move a cursor through tickets and open one, so that I can read its task, Verify, route and last shift report in the TUI.
3. As an operator, I want to see which agent (model, tier, shift) works on which ticket, with its usage, so that I can watch several parallel shifts.
4. As an operator, I want to choose the next ticket and start it from the TUI, so that I decide what runs instead of the frontier order.
5. As an operator, I want `shiftwork run --ticket feature/NN`, so that scripts and the TUI can run one chosen ticket.
6. As an operator, I want the dashboard to fit my terminal and keep working after a resize, so that nothing scrolls away.
7. As an operator, I want `r`, `s`, `d` and `q` to keep working, so that nothing I already use is lost.

## Implementation Decisions

- **`run --ticket`.** `runFrontier` gets a `ticket: "<feature>/<NN>"` option: it works that ticket once and stops. A ticket that is not on the frontier is refused before anything is claimed, with the reason (`blocked by 02`, `status resolved`, `claimed by pid 123`); the CLI exits 1. It implies `--once` and combines with nothing else that selects tickets (`--feature`, `--parallel`).
- **State and keys stay pure.** The TUI's view state (`tab`, cursor per tab, collapsed features, `details`, `selectedWorker`, `notice`, `dryRun`) is reduced by `reduceKey(state, key, dashboard)` with no I/O; effects stay data (`start-runner` gets an optional `ticket`). A separate `decodeKeys(data)` turns raw terminal input into key names (`up`, `down`, `left`, `right`, `enter`, `esc`, `tab`, `backspace`, printable characters), including several keys in one chunk.
- **Rendering is pure and sized.** `renderDashboard(state, { width, height })` returns exactly `height` lines or fewer, each at most `width` columns; a list longer than the space scrolls so the cursor row is visible. The plain-text fallback and `--once` render the Queue and Agents tabs one after the other without a height limit (today's tests keep their meaning).
- **Details are loaded on demand.** Only the selected ticket's body and Comments are read, when details open; the per-second refresh reads what it reads today plus the selected worker's log.
- **`n` is refused** when the selected row is not a ready frontier ticket, or a runner is live, with a notice, like a second `r` today.
- **pi-tui.** Interactive mode uses `TuiAltScreen` instead of `TuiMainScreen`, reads the terminal size from the `ProcessTerminal`, and re-renders on resize.

## Testing Decisions

- Runner tests with the fake backend: `ticket` works only that ticket; a blocked, resolved or claimed ticket is refused with its reason and nothing is claimed.
- Table tests for `reduceKey` (tab switching, cursor bounds, collapse, details open/close, `n` allowed/refused) and `decodeKeys` (arrow sequences, several keys in one chunk).
- Table tests for `renderDashboard(state, { width, height })`: line count ≤ height, line width ≤ width, cursor visible after scrolling, the agent marker on a worked ticket.
- `shiftwork tui --once` keeps printing one frame; the interactive view itself is checked live in a terminal, as before (no pty in the tests).

## Out of Scope

Starting a chosen ticket while a runner is live (it needs a queue the live runner reads); editing tickets or config from the TUI; mouse support.

<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | `shiftwork run --ticket` works one chosen ticket | resolved | opencode-go/glm-5.3 |
| 02 | TUI view state and key decoding | resolved | opencode-go/glm-5.3 |
| 03 | Tabbed, height-aware dashboard rendering | resolved | xai/grok-4.6 |
| 04 | Interactive full-screen TUI with tabs and run-this-ticket | resolved | xai/grok-4.6 |
<!-- shiftwork:tickets:end -->
