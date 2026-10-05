# 01: Plan the work for github#12

**What to build:** Turn GitHub issue #12 into implementation tickets for the feature `gh-12-add-step-reflection-find-what-hepepd-eve`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-12-add-step-reflection-find-what-hepepd-eve`

- [x] Read `.scratch/gh-12-add-step-reflection-find-what-hepepd-eve/spec.md` — the issue itself, from `Source: github#12`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-12-add-step-reflection-find-what-hepepd-eve/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, write no implementation ticket and end with `<shiftwork:needs-info reason="…"/>`; that is success, and a failing verify gate is not a reason to invent a ticket

## Comments

### Shift 0 — import
- Outcome: needs-info: The issue has no description. What should Shiftwork build?

### Shift — manual (claude)
- Outcome: resolved
- The issue has a title only; read as: record the agents' tool calls in the shift logs, then mine them for shell steps repeated across shifts and suggest a script for each. One implementation ticket, `02-tool-events-and-shiftwork-reflect.md` (built and resolved in the same session).
