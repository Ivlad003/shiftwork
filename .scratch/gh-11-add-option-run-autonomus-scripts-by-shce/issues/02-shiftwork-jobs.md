# 02: `shiftwork jobs`: scripts in order or on a schedule, item by item, resumable

**What to build:** A runner for deterministic jobs (no model), defined in `.shiftwork/jobs.json` (`shiftworkPath(root, "jobs.json")`). Each job is a `sh -c` command run once per input file (`inputs` glob) or once on its own. Done items are remembered in `.shiftwork/jobs-state.json`, so a stopped or failed batch resumes, for example translating a folder of videos one file at a time. Jobs can run by `order`/`after`, or on a `schedule` under `shiftwork jobs watch`. A job with `"ticket": true` files a `ready-for-agent` ticket when an item fails every attempt, so the agent runner can fix the script. All of it lives in `packages/cli/src/jobs.js`: core is untouched apart from `openTracker().createTicket` and `withLock`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/jobs.test.js` · `npm test`

- [x] `validateJobs` checks every key (`name`, `run`, `inputs`, `output`, `order`, `concurrency`, `timeoutMin`, `retries`, `schedule`, `after`, `env`, `ticket`), lists every problem in one error, and rejects unknown keys, duplicate names, unknown or self `after`, `after` cycles, globs outside the repo, and `{input}`/`{output}` without `inputs`/`output`
- [x] Dependency-free glob (`*`, `?`, `**`) via `readdir` recursion, sorted, skipping `.git` and `node_modules`
- [x] Placeholders `{input}` `{stem}` `{dir}` `{output}` `{name}` are shell-quoted. `output` is a path template, and an existing output counts as done unless `--force`. Exit 0 without the output is a failure
- [x] `jobs run [name...] [--force] [--retry-failed] [--dry-run]`: `after` first, then `order`, then file position. `concurrency` items run at once. Each item's output goes to `logs/jobs/<name>/<stem>.log`, and its state (status, attempts, timestamps, exit code) is written under `withLock(root, …, { name: "jobs" })`. A re-run skips done items and retries failed ones while `retries` + 1 attempts remain. A job whose `after` job failed in the same run is skipped
- [x] `timeoutMin` kills the item's process group (exit 124). Children are registered with `registerChild`. A `STOP` file or SIGINT/SIGTERM (`installSignalStop`) stops after the running items finish, and a second signal kills them
- [x] Schedules `{ everyMin }`, `{ at: "HH:MM" }` and `{ cron: "m h dom mon dow" }` (lists, ranges, steps, dow 7 = Sunday, dom/dow OR'd as in cron). `nextDue` is unit-tested. `jobs watch` runs the jobs that are due in order, then sleeps in short steps until the next is due
- [x] `"ticket": true`: an item that fails every attempt creates one ticket in `.scratch/jobs-<name>/issues/` via `openTracker(root).createTicket`. The ticket holds the command, exit code, log path and log tail, with Verify `shiftwork jobs run <name> --retry-failed`. A `spec.md` is created when missing. The next run writes no second ticket
- [x] `jobs list` shows the schedule, next due time and done/failed/pending counts. `jobs status` shows the items that aren't done, with attempts, exit code, log and ticket
- [x] Exit codes: 0 all done · 2 some items failed · 3 stopped · 1 error (invalid jobs.json, unknown job)
- [x] `bin/shiftwork.js` has the `jobs` command and a help line. `docs/guide.md` has a "Jobs" section. `docs/examples/jobs.translate-videos.json` is the video example (ffmpeg → whisper → translate)

### Notes

- Without `inputs`, a job is a single item (`_` in the state). It starts afresh on every run, because a scheduled backup must run again each time.
- `jobs watch` only runs jobs that have a `schedule`. When it never ran, `everyMin` is due at once, and `at`/`cron` are due at the next matching minute (the current minute counts).
- Tests: `packages/cli/test/jobs.test.js` covers validation, glob, quoting, schedules, ordering, resume/retries, timeout, STOP, dry-run, failure tickets and watch with a fake clock. An integration test runs the bin on tiny `sh` jobs in a temp dir.

## Comments

### Shift — manual (claude)
- Verify: `node --test packages/cli/test/jobs.test.js` passed (26 tests). `npm test` passed.
- Outcome: resolved
