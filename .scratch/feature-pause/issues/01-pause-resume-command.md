# 01: `shiftwork feature pause|resume` and paused features off the frontier

**What to build:** The core and CLI half of the spec. (1) Tickets learn whether their feature is paused: when loading `.scratch/<feature>/issues/*.md`, read `.scratch/<feature>/spec.md`'s `**Status:**` once and set `featurePaused: true` on each ticket of a `paused` feature (`packages/core/src/index.js`, typed in `index.d.ts`). (2) `frontier()` drops tickets with `featurePaused`, so `tracker.frontier()`, the runner, `status`, `run --dry-run` and dark-factory all skip them. (3) `run --ticket <f>/<NN>` and `run --feature <f>` on a paused feature exit 1 with `feature <f> is paused (shiftwork feature resume <f>)`. (4) New commands in `packages/cli/bin/shiftwork.js` (logic in `packages/cli/src/feature-pause.js`): `shiftwork feature pause <feature> [--dir <path>]` sets the spec's Status line to `paused` (inserting `**Status:** paused` under the `# ` title when there is none) and prints `⏸ <feature> paused: its tickets leave the frontier`; `shiftwork feature resume <feature>` sets it to `ready-for-agent` and prints `▶ <feature> resumed`; an unknown feature exits 1 (`no feature <f> under .scratch/`); under the OpenSpec tracker both exit 1 with `pause is supported for .scratch features only`. The edit changes only the Status line (the rest of the file, including the runner's ticket table, byte-for-byte) and runs under the shared-state lock (`withLock`). (5) `shiftwork status` prints `⏸ paused` after a paused feature's name; `run --dry-run` prints `<feature>: paused, skipped` once per paused feature with ready tickets. Docs: `shiftwork --help`, `docs/guide.md` + `docs/guide.uk.md` (section 7: the two commands; "How the runner picks the next ticket": paused features are skipped), `docs/agents/issue-tracker.md` (the `paused` spec status), `skills/shiftwork/references/tickets.md` + `config.md` (then `npm run sync-skills`), and `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/parse-ticket.test.js packages/core/test/runner.test.js packages/cli/test/feature-pause.test.js packages/cli/test/status.test.js` · `npm test`

- [x] Core test: a feature whose spec has `**Status:** paused` contributes no ticket to `frontier()`; another spec status (`ready-for-agent`, `needs-triage`, none) doesn't gate
- [x] Runner test (fake backend): with feature `a` paused and `b` ready, `run` works only `b`; `run --ticket a/01` and `run --feature a` are refused with the message
- [x] CLI tests on a temp repo: `feature pause a` sets the Status line and leaves every other byte of spec.md unchanged (ticket table included); a spec without a Status line gets one under the title; `resume` restores `ready-for-agent`; an unknown feature exits 1
- [x] `status` shows `⏸ paused`; `run --dry-run` prints `a: paused, skipped`
- [x] Guides (en + uk), `issue-tracker.md`, the skill references and `--help` describe pause/resume

### Notes

- `loadTickets` reads each feature's `spec.md` Status once per load and marks its tickets `featurePaused: true` (typed in `index.d.ts`); `frontier()` drops them, so the tracker, runner, status, dry-run, dark-factory and the TUI all agree. `run --ticket`/`--feature` refuse a paused feature inside `runFrontier` before anything is claimed or written.
- `setSpecStatus` (core, exported): the spec's Status-line edit under `withLock`, built on the extracted pure `applyStatusLine` that `setStatusLine` now shares. The CLI half is `packages/cli/src/feature-pause.js` (`feature pause|resume <feature> [--dir]`); it detects the tracker from the config but tolerates a broken model config (pause doesn't route models), and refuses OpenSpec with `pause is supported for .scratch features only`.
- Dry-run's `<feature>: paused, skipped` line is computed locally in `collectDryRunLines` (paused features that would have a frontier ticket), so the TUI's `d` gets it too. The TUI Queue's ⏸ row and `p` key are ticket 02.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 91239 in / 37547 out tokens, $1.3569, 66 turns
- Time: 13m 40s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/feature-pause-01 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — Pause and resume keep paused features off the frontier, refuse targeted runs, and match the spec, docs, and verify gate.
- Time: 7m 34s
- Verify: passed
- Findings:

> I'll review the landed pause/resume ticket against its acceptance criteria, starting with the ticket, spec, and the landed diff.
> The commit is on main. Next I’ll read the diff and the docs it claims to update, then run the verify gate.
> The implementation matches the ticket on a first pass. I’ll probe the status-line edit and run the verify gate before deciding.
> The landed change in `e96c5b1` meets the ticket. A paused feature's spec status is read once in `loadTickets`, stored as `featurePaused`, and dropped by `frontier()`, so the runner, status, dry-run, dark-factory, and the pi `/shift` frontier all skip those tickets. `run --ticket` and `run --feature` refuse a paused feature before any claim or write, with `feature <f> is paused (shiftwork feature resume <f>)`.
> 
> `feature pause|resume` edits only the spec Status line under the shared-state lock, inserts the line under the title when it is missing, and exits 1 for an unknown feature or an OpenSpec tracker. Status prints `⏸ paused`. Dry-run prints `<feature>: paused, skipped` once per paused feature that still has ready tickets. Guides (en and uk), `issue-tracker.md`, the skill references (synced), and `--help` describe the commands.
> 
> The verify gate passed: the four named test files (118 tests) and `npm test` (639 passed, 10 skipped). The TUI `⏸` row and `p` key are already ticket 02, not part of this change.
