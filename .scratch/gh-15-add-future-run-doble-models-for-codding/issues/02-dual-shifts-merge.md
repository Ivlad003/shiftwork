# 02: Dual shifts — two models on one ticket, then a merge shift

**What to build:** A ticket opted in (`dual` config block, or the ticket's own `**Dual:** yes`) gets, on its first round, two candidate shifts on two models (different providers when possible), each in its own worktree on `shiftwork/<feature>-<NN>-a` / `-b`, each through its own Verify gate. If both pass, a merge shift on `dual.mergeTier` (default: the review tier) runs in the ticket's own worktree, created from A's branch, with both branch diffs in its prompt, and combines them. If only one passes, it is taken with no merge. If neither passes, the next attempt is an ordinary single shift. The result then goes through the normal review and landing. Design: `docs/adr/0007-dual-shifts.md`.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] `dual: { enabled, types?, features?, models? | tiers?, mergeTier?, budget? }` validated in `packages/core/src/config.js` (`true`/`false` shorthand; models and tiers are exclusive)
- [x] `**Dual:** yes|no` ticket line parsed (`parseTicket`), `shouldDual` exported
- [x] Runner: candidates run in parallel within provider slots, each with its own gate; the work is committed on each candidate branch
- [x] Both pass → a merge shift from A's branch; a merge that fails its gate falls back to A
- [x] Only one passes → that branch is taken, no merge; neither → retry (or needs-info at `maxAttempts`), branches kept
- [x] Ticket budget totals every shift: a merge the budget no longer covers is skipped and A taken
- [x] No worktrees, no Verify, or no second model → a single shift and a `### Dual` warning
- [x] `### Dual — A: …, verify; B: …, verify; merge: …` recorded; candidate branches removed when the ticket lands
- [x] Workspace: `prepare(t, { from })`, candidate tickets with a `suffix`, `diff(t)` (`git diff --stat <target>...<branch>`)
- [x] Docs: ADR-0007, guide (en/uk) "Dual shifts", CONTEXT "Dual shift", issue-tracker `**Dual:**` line

## Comments

### Shift — manual (claude)
- Outcome: resolved
- Core: `runDualShifts`, `runDualCandidate`, `runDualShift`, `planDualRoutes`, `planMergeRoute` in `packages/core/src/runner.js`; `buildMergePrompt` and the candidate prompt line in `prompt.js`; `checkDual` in `config.js`.
- CLI: `packages/cli/src/git.js` gains a candidate `suffix`, `prepare(t, { from })` and `diff(t)`.
- Tests: 7 runner tests (both pass + merge, only B, neither → retry, neither on last attempt, no worktree, budget cap, `shouldDual`), 2 git tests, 1 config test.
- Verify: `npm test` passed.

### Shift — manual (claude)
- Outcome: resolved
- Tests added: both pass + merge fails its gate → A's branch lands (`### Dual … took A`); dual + before-land review accept → lands; reopen → nothing lands, candidates kept, next run is a single fix-forward shift whose landing drops them.
- Bugs fixed: the merge-fallback note read "verify verify failed"; a reopened (or needs-info, then answered) dual ticket never dropped its candidate branches when it later landed — the runner now recovers them from the ticket's `### Dual — A:` block.
- Verify: `npm test` passed.
