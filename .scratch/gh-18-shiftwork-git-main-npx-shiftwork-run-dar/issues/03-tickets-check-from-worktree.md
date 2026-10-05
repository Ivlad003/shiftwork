# 03: `tickets check` loads the main checkout's tracker from a git worktree

**What to build:** `shiftwork tickets check` (`packages/cli/src/tickets-check.js`, default `--dir`) must load `.scratch` from the **main checkout** when it is invoked with cwd inside a git worktree. Planning tickets write `02…` at the main tracker's path (the shift prompt says so; `git.js` excludes `.scratch` from ticket commits), but the runner runs Verify in the ticket worktree (`verify(commands, cwd)` in `packages/core/src/runner.js`). Today `tickets check` uses `process.cwd()`, so it reads the worktree's stale `.scratch` copy (or none, when the feature was imported after the worktree was created) and the planning gate fails after ticket 02 puts `shiftwork` on PATH. `--dir` stays an explicit override. No change to core's `loadTickets`; resolve the root in the CLI.

**Blocked by:** 02

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/tickets-check.test.js packages/cli/test/github-import.test.js` · `npm test`

- [x] With `--dir` omitted, `tickets check` uses the primary worktree / main checkout when cwd is a **linked** git worktree; a non-git cwd and a normal (non-worktree) clone keep using cwd — do not resolve via `--git-common-dir` on a normal clone, or `shiftwork tickets check` from a subdirectory would change root
- [x] `--dir <path>` still wins
- [x] Test: a temp git repo with a feature under main `.scratch/`, plus a `git worktree add` checkout that has no copy of those tickets; `checkFeatureTickets` (or `node …/bin/shiftwork.js tickets check <feature>`) with cwd = the worktree exits 0 and counts the main checkout's tickets
- [x] The same command with `--dir` pointing at an empty directory does not fall back to main (override is honoured)
- [x] Imported `01-plan.md` Verify stays `shiftwork tickets check <feature>` with no baked-in absolute `--dir`

### Notes

- Default `worktree.enabled` is true (`packages/cli/src/init.js`). Dark-factory e2e hides this because it passes `--no-worktree`.
- Detect a linked worktree when `git rev-parse --git-dir` and `--git-common-dir` differ (or `.git` is a file). Then the main working tree is the first `worktree` line of `git worktree list --porcelain` (absolute), which is the directory that contains `.git/`. Resolve paths with `--path-format=absolute` so a relative `.git` is not mistaken for main.
- Keep git invocation in the CLI, injectable in tests (same `exec` seam as `packages/cli/src/exec.js` / github), so the test does not depend on `PATH` beyond `git`.
- Ticket 02 is the blocker so a nested `shiftwork tickets check` from Verify already finds the binary; this ticket is which tree that command reads.

## Comments

### Shift — manual (claude)
- Outcome: resolved
- `resolveTrackerRoot` now asks git with `--path-format=absolute` (a normal clone's subdirectory no longer looked like a linked worktree); injectable `exec` seam; tests for linked worktree (real + injected), subdirectory, non-git, `--dir` override.
- Verify: `node --test packages/cli/test/tickets-check.test.js packages/cli/test/github-import.test.js` passed 41/41 at implementation time; `npm test` 802/803 — the one failure is a new github-import research-ticket test from parallel work on `github-import.js`, unrelated to this ticket.
