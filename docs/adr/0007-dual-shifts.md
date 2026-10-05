# Dual shifts: two candidates, then a merge shift

GitHub issue #15 asked for a ticket worked by two models at once, then either the better result picked or the two merged. The operator chose **merge**. A ticket opted in (`dual.enabled` with optional `types`/`features` filters, or its own `**Dual:** yes` line) gets, on its first round only, two **candidate shifts** on two models, different providers where the config has them (`dual.models` or `dual.tiers` pick them explicitly). Each candidate works in its own worktree on `shiftwork/<feature>-<NN>-a` / `-b`, at the same time as far as the provider slots allow, and goes through its own Verify gate. Its work is committed on its branch, so `git diff <target>...<branch>` shows it.

## Decision

- **Both pass:** one **merge shift** on `dual.mergeTier` (default: the review tier) starts in a fresh context in the ticket's own worktree, created from A's branch. Its prompt points at both branch diffs and both verify results, and its job is to combine the best of both and pass the gate. A merge that fails its gate, asks a question or errors is dropped, and A's branch is taken.
- **One passes:** that branch is taken. No merge shift runs, and the `### Dual` block says why.
- **Neither passes:** this counts as one failed attempt. The next attempt is an ordinary single shift from the target, or needs-info at `maxAttempts`, with both candidate branches kept.
- The ticket's branch then goes through the usual review and landing. The candidate branches are removed once the ticket lands, like any landed branch, and kept otherwise.
- The ticket records a shift report for every candidate and for the merge, plus `### Dual — A: <route>, <verify>; B: <route>, <verify>; merge: <outcome>`.
- Each candidate gets the normal shift budget, and the ticket budget still totals every shift: a merge that the ticket budget no longer covers is skipped and A taken. `dual.budget` is the merge shift's own budget.
- Without worktrees (`worktree.enabled: false`, `--no-worktree`), without Verify commands, or with no second model, the ticket runs as an ordinary single shift and the ticket records a `### Dual` warning.
- The core stays backend-free (ADR-0004). The workspace interface grows only what the merge needs: a candidate is a ticket with a `suffix` (its own branch and worktree), `prepare(t, { from })` starts a new branch from another branch, and `diff(t)` gives `git diff --stat <target>...<branch>`.

## Considered Options

- **Pick the better candidate, no merge.** This is cheaper, but the operator chose merge. Picking is still what happens when only one candidate passes, or when the merge fails.
- **Dual on every attempt.** Retries, reopens and handoffs stay single: they continue work that is already on the ticket's branch, and doubling them would double the cost of every failure.
- **Candidates edit the ticket file.** Two agents writing one file at once would overwrite each other's changes. The candidates' prompts tell them to leave the ticket alone, and the runner records both shifts.

## Consequences

- A dual ticket's first round costs two worker shifts plus a merge shift. Turn it on for the work that is worth the extra cost.
- A retry after a failed dual starts from the target, not from either candidate; the candidate branches stay readable until the ticket lands.
