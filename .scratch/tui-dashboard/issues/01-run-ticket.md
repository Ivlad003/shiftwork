# 01: `shiftwork run --ticket` works one chosen ticket

**What to build:** `shiftwork run --ticket <feature>/<NN>` and a `ticket` option on `runFrontier`: work exactly that ticket once, then stop. A ticket that isn't on the frontier is refused before anything is claimed, with the reason (`blocked by 02`, `status resolved`, `claimed by pid 123`), and the CLI exits 1. `--ticket` with `--feature` or `--parallel` is a usage error. `startDetachedRunner(root, { ticket })` passes it through, so the TUI can use it (spec story 5).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Runner test (fake backend): with two ready tickets, `ticket: "f/02"` works only 02
- [ ] A blocked, resolved or claimed ticket is refused with its reason, and nothing is claimed or written
- [ ] CLI: `--ticket` with `--feature`/`--parallel` exits 1 with a usage message; `--help` lists `--ticket`
- [ ] `startDetachedRunner` passes `--ticket` to the spawned runner (test with a stub `bin`)
