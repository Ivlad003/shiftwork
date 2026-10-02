# 02: `shiftwork tickets check <feature>` — the planning ticket's verify gate

**What to build:** A CLI command `shiftwork tickets check <feature> [--min N] [--except NN]` in `packages/cli/bin/shiftwork.js` (logic in `packages/cli/src/tickets-check.js`). It loads the feature's tickets and exits 0 when at least `N` (default 1) tickets other than the excepted ones (default `01`) are `ready-for-agent` or later, each has at least one `- [ ]`/`- [x]` acceptance checkbox and a non-empty `**Verify:**` line, and every `**Blocked by:**` number exists in the feature. Otherwise it exits 1 and prints one line per problem (`gh-12/03: no Verify line`). Add it to `shiftwork --help`, `docs/guide.md` + `docs/guide.uk.md`, `skills/shiftwork/references/config.md` (CLI commands; then `npm run sync-skills`) and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/tickets-check.test.js` · `npm test`

- [x] Tests on temp repos: passes with one good ticket besides 01; fails with only 01; fails on a ticket without Verify, without checkboxes, or blocked by a missing number; `--min 2` needs two
- [x] The failure output names each problem ticket and reason
- [x] `shiftwork --help` and the guides list the command

### Notes

- Logic in `packages/cli/src/tickets-check.js` (`checkFeatureTickets`, `parseExcept`); wired in `packages/cli/bin/shiftwork.js` as `tickets check <feature> [--min N] [--except NN]` (comma-separated or repeated, bare numbers padded like ticket numbers), plus `--dir`. Problems print one per line and exit 1; success prints a count line and exits 0.
- "ready-for-agent or later" = `ready-for-agent`, `claimed`, `resolved`; statuses before ready (needs-triage, needs-info, ready-for-human, wontfix) neither count nor fail. A ticket blocked by a number missing from the feature never counts as ready, since it can never be unblocked.
- Core's `parseTicket` swallows the next line when a field is empty (`**Verify:** ` alone picks up the checkbox line as the value), so the gate checks the Verify line against the raw ticket file with a newline-anchored regex instead of `ticket.verify`.
- `--except 01,2` normalizes to `01, 02` via `parseExcept`; docs updated in `docs/guide.md`, `docs/guide.uk.md`, `skills/shiftwork/references/config.md` (Commands table), then `npm run sync-skills` and `npm run llms` (llms-full.txt unchanged).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 36668 in / 15882 out tokens, $0.3141, 31 turns
- Time: 5m 15s
- Verify: failed at `npm test` (exit 1)

```
me provider runs (42.074057ms)
✔ shouldReview is off by default and respects the when/features/types filters (0.569773ms)
✔ an accepted review runs on the review tier and records ### Review (19.564314ms)
✔ a reopen verdict sends the ticket back to ready-for-agent with the reason (29.01301ms)
✔ a follow-up verdict files a new ready ticket in the feature (17.310896ms)
✔ a review without the marker is treated as accept with a warning (26.861629ms)
✔ an unknown review verdict is treated as accept with a warning (39.764734ms)
✔ reviews are off by default (22.499331ms)
✔ the review features filter is respected per ticket (46.777513ms)
✔ the review types filter matches the ticket's effective type (13.953203ms)
✔ with a workspace, the review runs in the main repo with the landed message in its prompt (15.233492ms)
✔ a review whose tier is all cooling is recorded as not run (55.189527ms)
✔ shift reports say how long the shift took, and the ticket total from the second shift on (54.73628ms)
✔ formatDuration renders seconds, minutes and hours (0.204734ms)
✔ parallel: 2 works two independent tickets at once (105.112357ms)
✔ a ticket blocked by a running parallel ticket starts only after it resolves (126.399335ms)
✔ a provider at its concurrency cap is skipped for the next model, and no cooldown is written (65.767654ms)
✔ parallel landings go through one queue: one landing at a time (119.648087ms)
✔ parallel: 2 lists both workers in the run state while they run (103.214764ms)
✔ a STOP file hands off both parallel workers (87.145309ms)
✔ a failed worker lets the others settle before the error propagates (177.473254ms)
✔ a review whose verify re-run fails records the failing output, like a shift report (7.259259ms)
✔ claim returns a claim for a free frontier ticket and marks it claimed (10.173434ms)
✔ a ticket claimed by a live process can't be claimed again (5.399075ms)
✔ a claim left by a dead process is taken over (32.824267ms)
✔ setStatus changes only the Status line (7.883648ms)
✔ appendComment creates the Comments section when it's missing (3.649805ms)
✔ appendComment appends after existing comments (2.226296ms)
✔ release lets the ticket be claimed again (5.121634ms)
✔ a failed write leaves the ticket intact and no temp files behind (2.285992ms)
✔ setStatus updates the spec table and leaves bytes outside the markers unchanged (3.131417ms)
✔ missing spec markers are appended once, and a missing spec.md is left alone (11.252638ms)
✔ the last route column shows the model of the latest shift report (3.405466ms)
✔ the spec table ignores markers mentioned in prose and fills the block on its own lines (3.599282ms)
✔ VERSION matches shiftwork-core's package.json, so `shiftwork --version` never drifts (1.093373ms)
✔ a real pi lists the shift command with its subcommands (458.935772ms)
✔ /shift answers with the frontier of ready tickets (490.41019ms)
✔ /shift stop writes the STOP file (367.002594ms)
✔ /shift run starts a detached runner, returns at once and shows a status widget (2318.651144ms)
✔ /shift run finds the shiftwork CLI and logs its output to a file (347.759066ms)
✔ /shift run refuses to start a second runner (342.607313ms)
✔ loading the pi-shiftwork package advertises the shiftwork skill (577.25088ms)
✖ switching the model changes the advertised skills (60488.828533ms)
✔ a model without a tier leaves skills untouched (296.805945ms)
ℹ tests 522
ℹ suites 0
ℹ pass 511
ℹ fail 1
ℹ cancelled 0
ℹ skipped 10
ℹ todo 0
ℹ duration_ms 66589.086934

✖ failing tests:

test at packages/pi/test/skill-filter.test.js:73:1
✖ switching the model changes the advertised skills (60488.828533ms)
  Error: Timeout waiting for agent to become idle. Stderr: 
      at Timeout._onTimeout (file:///home/kosmodev/.cache/shiftwork/worktrees/shiftwork-3b035128/github-watch-02/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js:370:24)
      at listOnTimeout (node:internal/timers:685:17)
      at process.processTimers (node:internal/timers:618:7)
```

- Outcome: new attempt

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 12467 in / 1913 out tokens, $0.0514, 11 turns
- Time: 58s (ticket total 6m 13s)
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/github-watch-02 into main
