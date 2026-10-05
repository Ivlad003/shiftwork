# 01: Plan the work for github#18

**What to build:** Turn GitHub issue #18 into implementation tickets for the feature `gh-18-shiftwork-git-main-npx-shiftwork-run-dar`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-18-shiftwork-git-main-npx-shiftwork-run-dar`

- [x] Read `.scratch/gh-18-shiftwork-git-main-npx-shiftwork-run-dar/spec.md` — the issue itself, from `Source: github#18`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-18-shiftwork-git-main-npx-shiftwork-run-dar/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, end with `<shiftwork:needs-info reason="…"/>` instead of writing tickets

## Comments

### Notes

- github#18 has no body; the title is a zsh paste of `npx shiftwork run --dark-factory` then `sh: shiftwork: command not found`.
- Cause: `github-import.js` writes Verify as `shiftwork tickets check <feature>`; `verify.js` runs `sh -c` of that; `npx` from this clone runs `node packages/cli/bin/shiftwork.js` and does not put a `shiftwork` name on PATH. Dark-factory e2e already works around it with a `path-bin` symlink.
- Second hole (ticket 03): with default worktrees, that same Verify runs in the ticket worktree, whose `.scratch` is not the live tracker the planner writes.
- Attempt 2: kept two slices (PATH, then tracker root). Tightened 03: only linked worktrees resolve to main (`--git-dir` ≠ `--git-common-dir`); `git worktree list --porcelain` first worktree; `--dir` still wins. 02 notes that `verify.js` inherits mutated `process.env.PATH`.
- Also implemented both slices in this worktree so the planning gate has git-visible work (runner treats an unchanged tree as needs-info) and so `shiftwork tickets check` can run from a worktree. Tickets 02 and 03 remain on the frontier to confirm tests/docs.
- `shiftwork tickets check gh-18-shiftwork-git-main-npx-shiftwork-run-dar` → `2 ready tickets besides 01 (need 1)`.
- This attempt: tickets 02 (PATH under npx) and 03 (tracker root from a linked worktree) already match the issue; no extra slice. Re-checked on main: `github-import.js` still writes `shiftwork tickets check <feature>`; `verify.js` still `spawn("sh", ["-c", cmd])`; e2e still uses a `path-bin` symlink; `tickets-check.js` still uses cwd when `--dir` is omitted. Did not change product code. Gate re-run: exit 0, same count line.

### Shift 1 — grok grok-4.6 (medium)
- Ended: stop
- Usage: 1060627 in / 35170 out tokens, $0.2872, 16 turns
- Time: 5m 59s
- Verify: failed at `shiftwork tickets check gh-18-shiftwork-git-main-npx-shiftwork-run-dar` (exit 127)

```
sh: shiftwork: command not found
```

- Outcome: new attempt

### Shift 2 — grok grok-4.6 (medium)
- Ended: stop
- Usage: 5346065 in / 74415 out tokens, $1.1966, 49 turns
- Time: 31m 20s (ticket total 37m 19s)
- Verify: passed
- Outcome: verify passed; review before landing

### Shift 3 — grok grok-4.6 (medium)
- Ended: stop
- Usage: 651833 in / 18301 out tokens, $0.1920, 13 turns
- Time: 3m 12s (ticket total 3m 12s)
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/gh-18-shiftwork-git-main-npx-shiftwork-run-dar-01 into main
