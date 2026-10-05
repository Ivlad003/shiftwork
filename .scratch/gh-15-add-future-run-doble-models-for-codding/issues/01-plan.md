# 01: Plan the work for github#15

**What to build:** Turn GitHub issue #15 into implementation tickets for the feature `gh-15-add-future-run-doble-models-for-codding`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-15-add-future-run-doble-models-for-codding`

- [x] Read `.scratch/gh-15-add-future-run-doble-models-for-codding/spec.md` — the issue itself, from `Source: github#15`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-15-add-future-run-doble-models-for-codding/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, write no implementation ticket and end with `<shiftwork:needs-info reason="…"/>`; that is success, and a failing verify gate is not a reason to invent a ticket

## Comments

### Shift 0 — import
- Outcome: needs-info: The issue has no description. What should Shiftwork build?

### Shift — manual (claude)
- Outcome: resolved
- Operator decision on the empty issue: **merge two** — two models work the ticket, then a merge shift combines their solutions. Ticket 02 records what was built.
