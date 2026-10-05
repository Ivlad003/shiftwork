# 03: `shiftwork graph <feature>` prints the ticket graph as Mermaid

**What to build:** A read-only CLI command that renders a feature's tickets and `Blocked by` edges as a Mermaid flowchart, with each ticket's status, so the plan's structure is on paper (research.md, idea 3; lecture 14 "a graph puts the problem on paper").

**Blocked by:** 02

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/graph.test.js` · `node --test packages/cli/test/tickets-check.test.js`

- [x] New module packages/cli/src/graph.js exports a pure `featureGraph(tickets, feature)` that returns Mermaid text: `flowchart TD`, one node per ticket `t03["03 Title · ready"]`, one edge `t02 --> t03` per blocker (blocker → blocked), a missing blocker drawn as a dashed node `t07["07 missing"]`
- [x] Node labels escape `"` and `[`/`]` in titles, so any title renders
- [x] Edges on a blocker cycle (reusing the cycle detection from ticket 02) are drawn as `-.->|cycle|` and the command prints the cycle problem lines to stderr
- [x] `shiftwork graph <feature> [--dir <path>]` in packages/cli/bin/shiftwork.js prints the graph to stdout and exits 0. An unknown feature prints `<feature>: no tickets found` and exits 1. The help text lists the command
- [x] `classDef` lines colour statuses (resolved, ready, needs-info, claimed, other) so GitHub renders them
- [x] Tests in packages/cli/test/graph.test.js: linear chain, diamond, missing blocker, cycle, title escaping, unknown feature exit code
- [x] docs/guide.md §7 command list and `skills/shiftwork` reference mention `shiftwork graph`

## Comments

### Notes

- Load tickets with `loadTickets` from shiftwork-core, like tickets-check.js.
- `bin/shiftwork.js` is being edited by other work: add one `case "graph":` and keep the change small.
- Out of scope: wiring the graph into dark-factory GitHub comments (possible follow-up).

### Shift — manual (claude)
- Outcome: resolved
- Verify: `node --test packages/cli/test/graph.test.js` passed (9/9) · `node --test packages/cli/test/tickets-check.test.js` passed (33/33).
