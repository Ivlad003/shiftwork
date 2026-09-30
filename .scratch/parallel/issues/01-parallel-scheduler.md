# 01: Parallel scheduler with provider concurrency caps

**What to build:** `parallel: N` config (and `shiftwork run --parallel N`, default 1) makes `runFrontier` work up to N frontier tickets at once, each in its own worktree; `parallel > 1` without `worktree.enabled` is a config error. `concurrency: { "<provider>": n }` caps running shifts per provider: the planner skips a full provider like a cooling one but writes no cooldown. After any ticket finishes the frontier is re-read, so unblocked tickets join. Landings go through one in-process queue. Cooldown probes run concurrently (spec stories 1–2).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Runner test: two independent tickets with `parallel: 2` overlap in time (fake backend records start/end); a ticket blocked by one of them starts only after it resolves
- [ ] `parallel: 1` keeps today's order: existing runner tests pass unchanged
- [ ] Planner test: a provider at its `concurrency` cap is skipped for the next model in the chain, and no cooldown is written
- [ ] `validateConfig` rejects `parallel > 1` without `worktree.enabled`, and non-positive caps
