# 01: Plan the work for github#9

**What to build:** Turn GitHub issue #9 into implementation tickets for the feature `gh-9-graph-harrness`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-9-graph-harrness`

- [x] Read `.scratch/gh-9-graph-harrness/spec.md` — the issue itself, from `Source: github#9`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-9-graph-harrness/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, write no implementation ticket and end with `<shiftwork:needs-info reason="…"/>`; that is success, and a failing verify gate is not a reason to invent a ticket

## Comments

### Shift — manual (claude)

- Read the issue and studied walkinglabs/learn-harness-engineering; findings in `.scratch/gh-9-graph-harrness/research.md`
- Wrote tickets 02 (blocker cycle check), 03 (`shiftwork graph`), 04 (frozen paths), 05 (research rollback edge)
- Outcome: resolved
