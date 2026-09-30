# Spec: parallel shifts (phase 4)

**Status:** ready-for-agent

Source: operator request, 2026-09-30, during phase 3. Vocabulary: `CONTEXT.md`.

## Problem Statement

- **One ticket at a time.** `shiftwork run` works the frontier one ticket after another, even when several frontier tickets are independent and several providers are idle. A feature of five 20-minute tickets takes 100 minutes when two or three could run side by side.
- **Shared state assumes one writer.** Worktrees and exclusive claims already isolate the work, but the rest was written for a single runner: `.pi/shiftwork-run.json` holds one `ticket`, cooldowns are read-modify-write (a second writer loses updates), landings run `git merge` in the root checkout, and the spec table is rewritten on every status change.
- **Independent steps run in sequence.** Cooldown probes run one after another before every ticket.

## Solution

- **Parallel scheduler.** `parallel: N` in `.pi/shiftwork.json` (or `run --parallel N`, default 1 = today's behaviour) works up to N frontier tickets at once in one process, each in its own worktree. Parallel > 1 requires `worktree.enabled`.
- **Provider concurrency.** `concurrency: { "<provider>": n }` caps the shifts running at once on a provider (e.g. `ollama: 1` for a single GPU, subscriptions that allow one session). The planner skips a model whose provider is full, as it skips a cooling one, but without writing a cooldown.
- **Serialised shared state.** Landings go through one in-process queue; cooldowns, run-state and the spec table are updated under a lock file so two processes (two `shiftwork run` in one repo) don't lose writes.
- **Conflicts fix forward.** A ticket whose branch no longer merges because a parallel ticket landed first is rebased onto the new target and verified again; if the rebase conflicts, it gets one more shift in a fresh worktree from the new target, with the conflict noted in its Comments, instead of going straight to needs-info.
- **Parallel where it's free.** Cooldown probes run concurrently.

## User Stories

1. As an operator, I want `parallel: 3` to work three independent frontier tickets at once, so that a feature finishes sooner.
2. As an operator, I want per-provider concurrency caps, so that a local GPU or a one-session subscription is never oversubscribed.
3. As an operator, I want every landing, cooldown and status change to survive parallel shifts and a second runner process, so that no state is lost.
4. As an operator, I want a ticket that conflicts with one that landed first to be rebased or redone on top of it, so that parallelism doesn't turn into needs-info tickets.
5. As an operator, I want `shiftwork status`, the dashboard and `shiftwork tui` to show every running shift, so that I can see and stop each one.
6. As an operator, I want a STOP file or TUI stop to hand off every running shift, so that stopping works as before.

## Implementation Decisions

- `runFrontier` keeps its loop but schedules through a pool: take frontier tickets not yet seen, claim, start `workTicket` until N are running, wait for any to finish, re-read the frontier (a resolved ticket may unblock others). `parallel: 1` must keep the current order and behaviour exactly (existing runner tests unchanged).
- Blockers stay the only dependency signal: tickets on the frontier are assumed independent; file overlap is caught at landing.
- Provider slots are in-memory counters inside the process; cross-process caps are out of scope (the lock file covers state, not slots).
- The lock is a `.pi/shiftwork.lock` file created with `O_EXCL`, holding pid + token, stale when the pid is gone (same approach as ticket claims in `tracker.js`).
- Run-state becomes `{ pid, running, workers: [{ ticket, attempt, shift, model, tier, usage, … }] }`; readers of the old single-ticket shape (dashboard, tui, status) are updated in the same ticket.
- Rebase on conflict: `git rebase <target>` in the ticket's worktree, then the ticket's Verify gate, then land again. A second failure → needs-info as today.

## Testing Decisions

- Runner tests with the fake backend: two independent tickets overlap in time (the fake backend records start/end), a blocked ticket waits for its blocker, `parallel: 1` keeps order.
- Planner test: a provider at its concurrency cap is skipped without a cooldown.
- Concurrency test for the lock: two writers updating cooldowns 50 times each end with all entries.
- Git test with two real worktrees touching the same file: the second one is rebased (clean case) or gets a fix-forward shift (conflicting case).
- Live check: `shiftwork run --parallel 2 --feature <demo>` on a demo repo with two independent tickets on two providers.

## Out of Scope

Splitting one ticket across several agents; cross-process provider slots; parallel Verify commands (their order matters).

<!-- shiftwork:tickets:start -->
<!-- shiftwork:tickets:end -->
