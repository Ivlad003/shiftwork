# 02: `shiftwork stop` command, with `--dark-factory`

**What to build:** A CLI command that stops the live runner the way `s` in the TUI does — write the STOP file so the running shifts hand off and the runner exits — and a `--dark-factory` flag that stops only a dark-factory runner (GitHub #17). Today the only ways are a STOP file by hand, `s`/`g` in the TUI, `/shift stop` in pi, or a signal.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/stop.test.js` · `node --test packages/cli/test/run.e2e.test.js packages/cli/test/dark-factory.e2e.test.js`

- [x] `shiftwork stop` with a live runner (`openRunState(root).read()`) writes `STOP` (`Stopped from shiftwork stop at <iso>`), prints `STOP file written · runner pid N (<mode or run>) hands off and stops`, exits 0; an existing `STOP` is kept
- [x] With no live runner it prints that nothing is running, writes no `STOP` (a stale one would block the next start), exits 0
- [x] `--dark-factory` stops only a dark-factory runner; while a plain run is live (alone or next to it) it writes nothing and exits 1 — `STOP` is repo-wide
- [x] `--wait [sec]` polls until no runner is live (default 120 s), then removes the `STOP` it wrote; exit 1 on timeout, `STOP` left in place
- [x] `--force` also sends SIGTERM to the runner pid(s)
- [x] Listed in the `shiftwork --help` text and dispatched in `packages/cli/bin/shiftwork.js`; documented in `docs/guide.md` (+ `docs/guide.uk.md`) section 7 "Stopping: `shiftwork stop`" and "Dark-factory mode"

### Notes

- Code in `packages/cli/src/stop.js` (`stop(argv, { log, error, kill, sleep, pollMs })` returns the exit code); tests in `packages/cli/test/stop.test.js` (13, including a bin dispatch/help test).

## Comments

### Shift — manual (claude)
- Outcome: resolved
- Verify: `node --test packages/cli/test/stop.test.js` 13 pass; run/dark-factory e2e + status 17 pass.
