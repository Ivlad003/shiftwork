# 01: Parallel scheduler with provider concurrency caps

**What to build:** `parallel: N` config (and `shiftwork run --parallel N`, default 1) makes `runFrontier` work up to N frontier tickets at once, each in its own worktree; `parallel > 1` without `worktree.enabled` is a config error. `concurrency: { "<provider>": n }` caps running shifts per provider: the planner skips a full provider like a cooling one but writes no cooldown. After any ticket finishes the frontier is re-read, so unblocked tickets join. Landings go through one in-process queue. Cooldown probes run concurrently (spec stories 1–2).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Runner test: two independent tickets with `parallel: 2` overlap in time (fake backend records start/end); a ticket blocked by one of them starts only after it resolves
- [x] `parallel: 1` keeps today's order: existing runner tests pass unchanged
- [x] Planner test: a provider at its `concurrency` cap is skipped for the next model in the chain, and no cooldown is written
- [x] `validateConfig` rejects `parallel > 1` without `worktree.enabled`, and non-positive caps

### Notes

- `runFrontier` keeps the serial loop verbatim for `parallel: 1` (and `--once`); a `runInPool` loop works up to N tickets at once, `Promise.race`-ing the workers and re-reading the frontier after each one settles. Outcomes are recorded as they settle, so `summary.resolved` is no longer strictly in ticket order under `parallel > 1`.
- Provider slots are in-memory counters (`createProviderSlots` in `runner.js`) taken per **shift**: `planShift` + `acquire` run in one synchronous block, so two workers can never take the last slot together. A full provider reaches the planner as `fullProviders` and is skipped like a cooling one — no cooldown is written, and an all-full chain returns `{ wait: now + 60s }` (no end time is known) so the worker re-plans.
- Landings go through one in-process queue (`withLandingQueue`) in the pool path only; the serial path is byte-for-byte today's behaviour. A same-provider in-place swap can conservatively look busy at a cap of 1 (noted in a comment in `workTicket`).
- `probeCooldowns` now probes all due cooldowns concurrently (`Promise.all`) and applies the store writes afterwards, one at a time.
- `validateConfig`: `parallel` defaults to 1 and must be a positive integer; `> 1` requires `worktree.enabled`; `concurrency` values must be positive integers. CLI: `run --parallel N`, and `--no-worktree` + `parallel > 1` is an error. `docs/guide.md` / `guide.uk.md` updated (the "not there yet" bullet now points at the remaining tickets 02–03).
- Run-state still holds one `ticket` field: with `parallel > 1` the last writer wins — that is ticket 02's `workers: [...]` shape, together with the lock file and rebase-on-conflict (ticket 03).
- Verify: `npm test` green (412 tests, 10 pre-existing skips) — also stress-run 6× full suite and 80× the four parallel tests after fixing two test-timing flakes (`Date.now()` millisecond resolution made an overlap look serial; gate setup moved before the first `await` in the fake backend).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 135337 in / 70819 out tokens, $2.9095, 94 turns
- Time: 30m 2s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/parallel-01 into main

### Review — pi opencode-go/glm-5.3 (medium)
- Verdict: accept — All four acceptance criteria are met with real, stable tests, the verify gate is green, the serial path is preserved unchanged, and the deferred shared-state work is explicitly routed to tickets 02–03.
- Time: 2m 22s
- Verify: passed
- Findings:

> Now let me run the verify gate.
> Full suite green: 412 tests, 402 pass, 10 pre-existing skips, 0 fail — matches the ticket's report. Let me stress the four new parallel tests a bit (the ticket mentions timing flakes were fixed) and inspect the pool loop's edge cases in the current code.
> The tests are stable. Let me check the uncommitted working-tree changes (`idea.md` deleted, spec/ticket modified) and confirm no existing runner tests were modified by the landed commit.
> One check on repo standards: core has hand-written `.d.ts` — does the `Config` type there need the new `parallel`/`concurrency` fields?
> The `.d.ts` types config as `Record<string, unknown>`, so no type declaration needed updating. My review is complete.
> 
> ## Review of parallel/01 — Parallel scheduler with provider concurrency caps
> 
> **Verify gate:** `npm test` green — 412 tests, 402 pass, 10 pre-existing skips, 0 fail, matching the ticket's report. I also stress-ran the four new parallel tests 15× with no flakes (the two timing fixes noted in the ticket — `performance.now()` for overlaps, gate setup before the first `await` — hold up).
> 
> **Acceptance criteria — all four met with real tests:**
> - Overlap test with a gate backend recording start/end; the blocked-ticket test asserts it starts only after its blocker resolves (frontier is re-read after each settle, as the spec decides)
> - Existing runner tests untouched: the only deletion in `runner.test.js` is the extended import line; the serial loop is preserved verbatim for `parallel: 1` and `--once`
> - Planner test covers skip-to-next-model, all-full chain → `{ wait: now + 60s }` (no known end time), and a pinned model on a full provider
> - `validateConfig` covers `parallel > 1` without `worktree.enabled`, non-positive/non-integer `parallel` and `concurrency` caps; CLI adds `--parallel N` and rejects `--no-worktree` + `parallel > 1`
> 
> **Quality:** Slot `planShift` + `acquire` in one synchronous block, `finally`-released per shift, landing queue serialises only `land` (serial path byte-for-byte unchanged), `probeCooldowns` probes concurrently then writes one at a time. Docs updated in both languages with an honest "not there yet" bullet pointing at tickets 02–03. No new runtime deps. Deferred items (lock file, `workers: [...]` run-state, rebase-on-conflict) match the spec's ticket table exactly.
> 
> **Minor observations (not blocking):**
> - In `runReviewShift`, a wait caused by full providers still renders the pre-existing "every *tier* model is cooling until …" skip message — slightly misleading wording in a ticket comment, cosmetic only.
> - The uncommitted working tree holds the usual post-landing bookkeeping plus a deletion of the root `idea.md` (old operator notes) that is outside both the ticket and the landed commit — worth knowing it's there, but not this ticket's concern.
> 
> 
> 
> **Summary:** Clean landing. `runFrontier` grows a `runInPool` path (Promise.race over workers, frontier re-read per settle), in-memory provider slots (`createProviderSlots`) flow into `planShift` as `fullProviders` (skipped like cooling, no cooldown written), landings serialise through `withLandingQueue`, cooldown probes run concurrently, config/CLI validation covers all error cases, and both guides document the new knobs. Verify passed; recommend a small wording fix for the review-skip message whenever someone is next in `runReviewShift`, but it doesn't warrant reopening.

### Review — operator (Claude Code), 2026-09-30
- Diff read: `parallel: 1` and `--once` keep the old loop; the only change to existing runner tests is the import line; slot plan+acquire is one synchronous block; landings go through one queue.
- Live check, demo repo (`parallel: 2`, `concurrency: { opencode-go: 1, openrouter: 1 }`, tickets 01 and 02 independent, 03 blocked by 01): 01 ran on `opencode-go/glm-5.3` while 02 ran **at the same time** on `openrouter/qwen/qwen3.8-27b:free` (the opencode-go slot was taken); 03 started as soon as 01 resolved, while 02 was still running, and got glm again. All three resolved and merged; files correct. Whole run 1m 14s.
- The only cooldown written was a real upstream 429 on the `:free` qwen model, after its work was done (gate passed → resolved). A full slot wrote none.
- Known gaps, owned by 02: cooldowns and run-state are still read-modify-write without a lock, so two workers can lose a write, and run-state shows one ticket. Also, if `workTicket` throws, `Promise.race` rejects and the other workers are left running detached — make 02's pool wait for them (`allSettled`) before rethrowing.
- Verdict: accept.
