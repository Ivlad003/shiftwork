# 10: OpenSpec tracker

**What to build:** Work OpenSpec changes through the same Tracker interface, configured with `tracker: "openspec"` or auto-detected when `openspec/changes/` exists. Each change is a feature, each unchecked `- [ ] N.M` task in `tasks.md` is a ticket blocked by the previous task, and status beyond done/undone plus comments live in `openspec/changes/<change>/.shiftwork.md`. Resolving a task ticks its checkbox. The verify gate comes from `openspec.verify` (default `["openspec validate <change>"]`) plus a task's own Verify (spec stories 22–24). This is as adition option you can you or current tracker system or openspec.

**Blocked by:** 04

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Tracker tests on a temp OpenSpec layout: frontier, claim, status, comments, checkbox ticked on resolve, archive folder ignored
- [x] A runner test with the fake backend works an OpenSpec change end to end
- [x] Auto-detection prefers `.scratch/` when both exist, unless `tracker` is set

### Notes

- New `packages/core/src/openspec.js`: `openOpenSpecTracker(root, { verify })`, `openRepoTracker(root, config)` and `detectTracker`. Each `openspec/changes/<change>/` is a feature; each numbered `- [ ] N.M` task is a ticket blocked by the previous task in file order (sections follow each other). `archive/` and hidden folders are ignored. Status/comments live in `.shiftwork.md` (one `## N.M` section per task, runner-owned); resolving ticks the task's checkbox in `tasks.md`, leaving other bytes alone. Claims live in `openspec/.claims/`.
- Verify gate: `openspec.verify` from config (default `openspec validate <change>`, `<change>` substituted) plus a task's own indented `Verify:` line.
- Config: new `tracker` (`"scratch" | "openspec"`) and `openspec.verify` fields, validated in `validateConfig`. `openRepoTracker` auto-detects: `.scratch/` wins over `openspec/changes/`; CLI `status`/`run`/`--dry-run` go through it.
- Shared-code adjustments: the runner's `seen` set keys tickets by `feature/number` (OpenSpec tasks of one change share the `.shiftwork.md` path); `buildShiftPrompt` honors an optional `ticket.specPath` (OpenSpec points at `proposal.md`); `tracker.js` file helpers (`writeAtomic`, `createExclusive`, `readOwner`, `isAlive`) are exported for reuse.
- Tests: `packages/core/test/openspec.test.js` (9 tests: list/frontier/blocking, verify gate, claim/status/comments, dead-pid takeover, checkbox tick, archive ignored, detection, fake-backend runner e2e over a 3-task change) plus `tracker`/`openspec.verify` validation cases in `config.test.js`.
- Docs: OpenSpec sections in `docs/agents/issue-tracker.md` and `packages/core/README.md`.

## Comments

### Shift 1 — pi opencode-go/kimi-k3 (medium)
- Ended: stop
- Usage: 80764 in / 40640 out tokens, $1.3535, 34 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-10 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted: OpenSpec tracker behind the same Tracker interface, tasks keyed by feature/number (all tasks of a change share tasks.md), archive ignored, state in `.shiftwork.md`. 34 turns on opencode-go/kimi-k3
- Fixed: `shiftwork status` still matched tickets by path, so every task of a change was marked as frontier; it now keys by feature/number too
- Live check on a demo OpenSpec change (free model): task 1.2 worked in its worktree, landed, its checkbox ticked in tasks.md, status and the agent's notes in .shiftwork.md
