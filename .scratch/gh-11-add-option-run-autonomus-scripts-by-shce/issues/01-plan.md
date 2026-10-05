# 01: Plan the work for github#11

**What to build:** Turn GitHub issue #11 into implementation tickets for the feature `gh-11-add-option-run-autonomus-scripts-by-shce`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-11-add-option-run-autonomus-scripts-by-shce`

- [x] Read `.scratch/gh-11-add-option-run-autonomus-scripts-by-shce/spec.md` — the issue itself, from `Source: github#11`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-11-add-option-run-autonomus-scripts-by-shce/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, write no implementation ticket and end with `<shiftwork:needs-info reason="…"/>`; that is success, and a failing verify gate is not a reason to invent a ticket

## Comments

### Shift — manual (claude)
- Read the issue: run plain scripts (no model) over many files one by one, or on a schedule, e.g. translating videos.
- Planned and built it as one slice, ticket 02 (`shiftwork jobs`). The issue is clear enough, so there is no needs-info.
- Outcome: resolved
