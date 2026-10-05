# 02: `shiftwork logs` — read and follow the agents' shift logs live

**What to build:** A `shiftwork logs [<feature>/<NN>] [-f|--follow] [--raw] [--all] [--dir <path>]` command (new `packages/cli/src/logs.js`, wired in `packages/cli/bin/shiftwork.js`) that renders the runner's NDJSON shift logs (`logs/<feature>/<NN>/attempt-*.jsonl`, written by `createShiftLogger` in `dashboard.js`) as readable lines, and follows them while agents work.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/logs.test.js`

- [x] With no ticket: the live runner's workers (from `openRunState(root).read()`), each at its current shift log (`currentShiftLogName`), lines prefixed `feature/NN` when there are several; with no live runner, the most recent shift log (exit 1 when there is none)
- [x] With `<feature>/<NN>` (a bare `f/1` is padded to `01`): that ticket's current (most recently written) attempt log; `--all` prints every attempt, oldest first, each under a `── feature/NN · attempt-N.jsonl ──` header; exit 1 when the ticket has no logs (without `-f`)
- [x] Pretty rendering (`formatEvent`): `start` header (backend · model · tier · attempt · shift), `text` wrapped to the terminal width with indented continuations, `tool` as `$ cmd` / `✎ path` / `⚙ name {input}`, `turn` dim (tokens, cost), `context` hidden unless `--raw`, `error` red, `end` with its stop reason, unknown events JSON with `--raw` else skipped; `HH:MM:SS` on every line; colour unless `NO_COLOR` or not a TTY
- [x] `readFrom(file, offset)` returns whole lines only (a half-written line waits), handles a missing or truncated file
- [x] `-f` follows by byte offset (fs.watch on `logs/` plus a 500 ms poll), switches with a header when a new attempt file appears, follows the live runner across tickets and exits 0 when no runner is live, stops cleanly (exit 0) on SIGINT; a closed pipe (`| head`) exits quietly
- [x] Help line in `bin/shiftwork.js`; `docs/guide.md` section 7 "Reading shift logs: `shiftwork logs`"

### Notes

- A TUI key for opening the live log was left out: the Agents tab's `enter` already shows the selected worker's log tail.
- Tool lines depend on backends emitting `{ type: "tool", name, input }` events (parallel work); until then, logs show text, turns, errors and ends.
- `docs/guide.uk.md` not updated.
