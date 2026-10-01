# 01: `shiftwork run --ticket` works one chosen ticket

**What to build:** `shiftwork run --ticket <feature>/<NN>` and a `ticket` option on `runFrontier`: work exactly that ticket once, then stop. A ticket that isn't on the frontier is refused before anything is claimed, with the reason (`blocked by 02`, `status resolved`, `claimed by pid 123`), and the CLI exits 1. `--ticket` with `--feature` or `--parallel` is a usage error. `startDetachedRunner(root, { ticket })` passes it through, so the TUI can use it (spec story 5).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Runner test (fake backend): with two ready tickets, `ticket: "f/02"` works only 02
- [x] A blocked, resolved or claimed ticket is refused with its reason, and nothing is claimed or written
- [x] CLI: `--ticket` with `--feature`/`--parallel` exits 1 with a usage message; `--help` lists `--ticket`
- [x] `startDetachedRunner` passes `--ticket` to the spawned runner (test with a stub `bin`)

### Notes

- `runFrontier` resolves `options.ticket` (`<feature>/<NN>`) through `chosenTicket` before the run state is written or anything claimed; a refusal throws `--ticket <spec> is not on the frontier: <reason>` (`no such ticket`, `claimed by pid N`, `status X`, `blocked by NN`), so the CLI prints it and exits 1. A ticket with a stale claim is accepted: the tracker reopens it like the frontier does. `parseTicketSpec` is exported from `core/src/runner.js` for the TUI (tickets 02/04).
- `options.ticket` filters the serial loop's frontier page and stops after that one ticket (it implies `--once`); the pool path is skipped, so it also wins over `--parallel` if a caller passes both.
- The CLI usage error (`--ticket` with `--feature` or any `--parallel`) is thrown before `loadConfig`, so it needs no repo. `startDetachedRunner` gained `{ ticket }` and appends `--ticket <spec>` to the spawned `run` args; its default start effect also forwards `effect.ticket` for ticket 04.
- New fixture: `packages/cli/test/fixtures/argv-runner.js` (a stub `bin` that dumps its argv) for the `startDetachedRunner` test. Also an end-to-end CLI test that `run --ticket demo/02` resolves only 02 with the scripted pi backend.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 49512 in / 21317 out tokens, $0.5528, 45 turns
- Time: 7m 0s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-dashboard-01 into main
