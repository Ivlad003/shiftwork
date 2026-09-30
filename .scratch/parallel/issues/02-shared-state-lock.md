# 02: Shared state safe for parallel shifts and a second runner

**What to build:** A `.pi/shiftwork.lock` (O_EXCL file with pid + token, stale when the pid is gone, like ticket claims in `tracker.js`) guards every read-modify-write of cooldowns, run-state and the spec tickets table, so parallel shifts and a second `shiftwork run` in the same repo lose no updates. Run-state becomes `{ pid, running, workers: [...] }` with one entry per running shift; `shiftwork status`, the dashboard and `shiftwork tui` show every worker, and a STOP file or TUI stop hands off every running shift (spec stories 3, 5, 6).

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Concurrency test: two writers add 50 cooldowns each through separate store instances; all 100 are present
- [x] A lock held by a dead pid is taken over; a live one is waited for
- [x] Runner test with `parallel: 2`: run-state lists both workers while they run; STOP hands off both
- [x] Dashboard/tui/status render the `workers` shape (fixture from a real `parallel: 2` run-state file)
- [x] If one worker throws, the pool waits for the others to settle (claims released, run-state finished) before the error propagates

### Notes

- New `packages/core/src/lock.js`: `withLock(root, fn)` — an O_EXCL `.pi/shiftwork.lock` (pid + token), taken over when the holder's pid is gone, waited for (20 ms polls, 60 s timeout, then taken over — guarded writes are atomic, so the worst case is one racing update, never a corrupt file). `createExclusive`/`readOwner`/`isAlive` moved there from `tracker.js` (claims unchanged).
- The lock guards `cooldowns.update`, every run-state write (`update`/`updateWorker`/`removeWorker`/`clear`) and `syncSpecTable`. The guarded sections call no other guarded section, so it can never nest.
- Run-state file: `{ runners: [{ pid, running, startedAt, finishedAt, feature, logFile, stoppedReason, summary, workers: [{ ticket, attempt, shift, model, thinking, tier, budget, usage }] }] }` — one entry per runner pid, so a second `shiftwork run` never clobbers the first's workers. `read()` returns the merged view (`workers` = every live runner's workers, `runners` = per-entry, `live` = any live runner) and still reads a legacy flat file as one runner with one synthesized worker.
- Readers updated: `shiftwork status` ("Running shifts:" section), the dashboard (`renderRunner` one-worker and multi-worker layouts, `tailShiftLog` follows the first live worker) and the pi widget (`workerLines` per shift, `describeRun` for notices). STOP already steers every running shift; both workers hand off (tested).
- Pool error case: `runInPool` captures the first worker error, stops scheduling, waits for the running workers to settle (claims released, worker entries removed), then `runFrontier` writes the finished run state and rethrows.
- Fixture `packages/cli/test/fixtures/parallel-run-state.json` was captured from a real `parallel: 2` run (fake backend, gates held open); tests substitute the live pid.
- CONTEXT.md: added **Worker** and **Shared-state lock**.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 117338 in / 64367 out tokens, $2.3378, 95 turns
- Time: 20m 55s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/parallel-02 into main

### Review — pi opencode-go/glm-5.3 (medium)
- Verdict: follow-up — Resolve the stray uncommitted working-tree changes left after the parallel/02 landing — the idea.md deletion (commit it or restore it) — so ticket 03 lands from a clean tree.
- Time: 2m 16s
- Verify: failed at `npm test` (exit 1)
- Findings:

> Now let me run the verify gate:
> The verify gate passes (415 pass, 0 fail, 10 skipped). Let me check the remaining acceptance criterion — the fixture-based readers:
> All acceptance criteria appear covered and the verify gate passes. Let me check two loose ends — the stray working-tree changes left by the shift:
> The landed commit is clean, but the working tree carries residue from the run: an uncommitted deletion of the tracked `idea.md` (old operator notes), plus the ticket bookkeeping (`.scratch` status/spec-table updates) that the review landing will sweep in as usual. Let me confirm the code has no other rough edges worth flagging:
> ## Review of parallel/02 — Shared state safe for parallel shifts and a second runner
> 
> **Verify gate:** `npm test` at root — **415 pass, 0 fail, 10 skipped**. Run myself, passed cleanly.
> 
> **Acceptance criteria — all five met:**
> 1. ✅ Concurrency test: `cooldowns.test.js` — two stores × 50 adds, all 100 present. This is the real test (it exercises file-level read-modify-write), and it passes.
> 2. ✅ `lock.test.js` — dead-pid lock taken over (< 5 s), live lock waited for, lock file removed after the section, correct path.
> 3. ✅ `runner.test.js` — `parallel: 2` run-state lists both workers mid-run; a STOP file hands off both (claims empty, tickets back to ready-for-agent, run-state finished).
> 4. ✅ `parallel-run-state.json` fixture captured from a real run; `status.test.js`, `tui.test.js`, `tui-controls.test.js` all render the `workers` shape.
> 5. ✅ Failed-worker test: verify-gate throw in one worker, the other settles slowly — error propagates only after the second ticket resolves, claims release, and the run-state finishes.
> 
> **Spec conformance:** matches the spec's implementation decisions exactly — `.pi/shiftwork.lock` with O_EXCL pid+token, stale when the pid is gone, same approach as claims; run-state becomes per-pid entries with `workers`; readers (status, dashboard, pi widget, tui) all updated in the same ticket. `createExclusive`/`readOwner`/`isAlive` cleanly relocated from `tracker.js` to `lock.js` with claims unchanged. Timeout-then-takeover (60 s) is documented as safe because every guarded write is atomic — reasonable. No nesting: guarded sections (`cooldowns.update`, run-state writes, `syncSpecTable`) call no other guarded section, and the run-state store keeps its in-process write queue so its own writes never contend with themselves. Legacy flat run-state still reads as one runner with one synthesized worker (tested). No new dependencies; hand-written `.d.ts` updated; CONTEXT.md gained **Worker** and **Shared-state lock** in the repo's vocabulary format.
> 
> **Minor nits (not blockers):**
> - `runner.js` `startWorker`: the `error = thrown;` line is over-indented (cosmetic only).
> - `lock.test.js`'s "sections never interleave" test pushes to an in-memory array, so it can't actually detect interleaving — the cooldowns test is the one that carries that weight.
> 
> **One loose end:** the landed commit is clean, but the working tree carries an uncommitted deletion of the tracked `idea.md` (old operator notes, already transformed into tickets by e12642f). It's not part of the landed commit, and left dirty it can leak into ticket 03's landing.
> 
> 
> 
> **Summary:** The landed work is correct and complete — all five acceptance criteria are implemented and tested, the verify gate passes, the spec's stories 3/5/6 and implementation decisions are honored, and the vocabulary and type declarations were kept in sync. Only residue needs attention: the uncommitted `idea.md` deletion left in the working tree, which the follow-up ticket should resolve.
- Follow-up: parallel/04 — Follow-up to parallel/02: Resolve the stray uncommitted working-tree changes le…

### Review — operator (Claude Code), 2026-09-30
- **Fixed, a real race:** the review shift's own verify run failed; the cause was not a flake. `createExclusive` opened the file (`wx`) and wrote the owner in a second step, so a waiter reading in between saw an empty file, judged it stale and deleted a fresh lock. Reproduced: the two-writer cooldowns test lost 42 of 100 cooldowns about 1 run in 3. Now the owner goes to a temp file that is hard-linked into place, so the lock never appears empty (this also fixes the same window in ticket claims). `acquire` treats an unreadable file as held, and takes a stale lock over only if the owner it judged is still there. New test for the in-between state; the two-writer test passed 40/40 runs after the fix.
- Live check on the demo repo (`parallel: 2`): `shiftwork status`, polled every 3 s, listed both workers with their models (01 glm-5.3, 02 qwen :free), then 03 joining when 01 resolved; a 429 on qwen handed 02 over to glm as soon as its slot freed. All three resolved; no lock file left behind.
- Limitation: the hard link needs a filesystem that supports links (every local Linux/macOS one does).
- Follow-up 04 (the `idea.md` deletion) isn't ticket work: the operator deleted that file on purpose. Closed.
- Verdict: accept.
