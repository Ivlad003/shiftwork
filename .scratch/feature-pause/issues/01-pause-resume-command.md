# 01: `shiftwork feature pause|resume` and paused features off the frontier

**What to build:** The core and CLI half of the spec. (1) Tickets learn whether their feature is paused: when loading `.scratch/<feature>/issues/*.md`, read `.scratch/<feature>/spec.md`'s `**Status:**` once and set `featurePaused: true` on each ticket of a `paused` feature (`packages/core/src/index.js`, typed in `index.d.ts`). (2) `frontier()` drops tickets with `featurePaused`, so `tracker.frontier()`, the runner, `status`, `run --dry-run` and dark-factory all skip them. (3) `run --ticket <f>/<NN>` and `run --feature <f>` on a paused feature exit 1 with `feature <f> is paused (shiftwork feature resume <f>)`. (4) New commands in `packages/cli/bin/shiftwork.js` (logic in `packages/cli/src/feature-pause.js`): `shiftwork feature pause <feature> [--dir <path>]` sets the spec's Status line to `paused` (inserting `**Status:** paused` under the `# ` title when there is none) and prints `⏸ <feature> paused: its tickets leave the frontier`; `shiftwork feature resume <feature>` sets it to `ready-for-agent` and prints `▶ <feature> resumed`; an unknown feature exits 1 (`no feature <f> under .scratch/`); under the OpenSpec tracker both exit 1 with `pause is supported for .scratch features only`. The edit changes only the Status line (the rest of the file, including the runner's ticket table, byte-for-byte) and runs under the shared-state lock (`withLock`). (5) `shiftwork status` prints `⏸ paused` after a paused feature's name; `run --dry-run` prints `<feature>: paused, skipped` once per paused feature with ready tickets. Docs: `shiftwork --help`, `docs/guide.md` + `docs/guide.uk.md` (section 7: the two commands; "How the runner picks the next ticket": paused features are skipped), `docs/agents/issue-tracker.md` (the `paused` spec status), `skills/shiftwork/references/tickets.md` + `config.md` (then `npm run sync-skills`), and `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/parse-ticket.test.js packages/core/test/runner.test.js packages/cli/test/feature-pause.test.js packages/cli/test/status.test.js` · `npm test`

- [ ] Core test: a feature whose spec has `**Status:** paused` contributes no ticket to `frontier()`; another spec status (`ready-for-agent`, `needs-triage`, none) doesn't gate
- [ ] Runner test (fake backend): with feature `a` paused and `b` ready, `run` works only `b`; `run --ticket a/01` and `run --feature a` are refused with the message
- [ ] CLI tests on a temp repo: `feature pause a` sets the Status line and leaves every other byte of spec.md unchanged (ticket table included); a spec without a Status line gets one under the title; `resume` restores `ready-for-agent`; an unknown feature exits 1
- [ ] `status` shows `⏸ paused`; `run --dry-run` prints `a: paused, skipped`
- [ ] Guides (en + uk), `issue-tracker.md`, the skill references and `--help` describe pause/resume
