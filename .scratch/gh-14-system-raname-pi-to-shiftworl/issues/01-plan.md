# 01: Plan the work for github#14

**What to build:** Turn GitHub issue #14 into implementation tickets for the feature `gh-14-system-raname-pi-to-shiftworl`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-14-system-raname-pi-to-shiftworl`

- [x] Read `.scratch/gh-14-system-raname-pi-to-shiftworl/spec.md` — the issue itself, from `Source: github#14`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-14-system-raname-pi-to-shiftworl/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, write no implementation ticket and end with `<shiftwork:needs-info reason="…"/>`; that is success, and a failing verify gate is not a reason to invent a ticket

## Comments

### Shift 0 — import
- Outcome: needs-info: The issue has no description. What should Shiftwork build?

### Shift — manual (claude)
- Outcome: resolved
- Operator decision: soft migration. Shiftwork's own files move from `.pi/` to `.shiftwork/`; a repo with them still in `.pi/` keeps working (legacy mode, one stderr hint) until `shiftwork migrate`. pi's own files stay in `.pi/`.
- One implementation ticket: `02-soft-migration.md`.
