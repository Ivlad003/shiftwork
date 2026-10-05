# 01: Plan the work for github#13

**What to build:** Turn GitHub issue #13 into implementation tickets for the feature `gh-13-add-log-readed-for-agent-realtime`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-13-add-log-readed-for-agent-realtime`

- [x] Read `.scratch/gh-13-add-log-readed-for-agent-realtime/spec.md` — the issue itself, from `Source: github#13`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-13-add-log-readed-for-agent-realtime/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, write no implementation ticket and end with `<shiftwork:needs-info reason="…"/>`; that is success, and a failing verify gate is not a reason to invent a ticket

## Comments

### Shift 0 — import
- Outcome: needs-info: The issue has no description. What should Shiftwork build?

### Shift — manual (claude)
- Outcome: resolved
- The issue body is empty; the title ("log reader for agent realtime") and the operator's brief define it: a `shiftwork logs` command that reads and follows the shift logs in `logs/<feature>/<NN>/`. Planned and built as ticket 02.
