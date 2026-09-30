# 02: Shared state safe for parallel shifts and a second runner

**What to build:** A `.pi/shiftwork.lock` (O_EXCL file with pid + token, stale when the pid is gone, like ticket claims in `tracker.js`) guards every read-modify-write of cooldowns, run-state and the spec tickets table, so parallel shifts and a second `shiftwork run` in the same repo lose no updates. Run-state becomes `{ pid, running, workers: [...] }` with one entry per running shift; `shiftwork status`, the dashboard and `shiftwork tui` show every worker, and a STOP file or TUI stop hands off every running shift (spec stories 3, 5, 6).

**Blocked by:** 01

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Concurrency test: two writers add 50 cooldowns each through separate store instances; all 100 are present
- [ ] A lock held by a dead pid is taken over; a live one is waited for
- [ ] Runner test with `parallel: 2`: run-state lists both workers while they run; STOP hands off both
- [ ] Dashboard/tui/status render the `workers` shape (fixture from a real `parallel: 2` run-state file)
- [ ] If one worker throws, the pool waits for the others to settle (claims released, run-state finished) before the error propagates
