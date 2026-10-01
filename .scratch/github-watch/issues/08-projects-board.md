# 08: Projects v2 board as an optional source

**What to build:** Optionally take work from a GitHub Projects v2 board column instead of labels: `github.project: { owner, number, column }` — import only issues in that Status column, and move the card to "In progress" / "Done" as tickets progress. Needs the token scopes `read:project` and `project` (`gh auth refresh -s read:project,project`).

**Blocked by:** 05

**Status:** wontfix
**Type:** code
**Verify:** `npm test`

- [ ] Operator decides whether the board is wanted at all, and which column names map to "to do", "in progress" and "done"

## Comments

### Notes

Closed by the operator (2026-10-01): labels cover this; no Projects v2 board source.
