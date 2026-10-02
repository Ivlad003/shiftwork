# 01: Keep re-verifying and landing while the target moves

**What to build:** As the spec describes. In `packages/core/src/runner.js`, the block after `let landed = await workspace.land(ticket)` handles one `landed.rebase`; turn it into a loop: while `landed.rebase` and fewer than `config.landRetries` (default 5) rounds ran, re-run the verify gate in the worktree, push the `- Target moved to … verify gate re-run: …` note, and `land` again. A failing gate on the rebased state keeps today's `needs-info` reason; a conflict keeps today's redo path; retries used up → `needs-info` with `the target kept moving (<n> rebases); branch <branch> kept — land it with shiftwork run --ticket <f>/<NN> or merge it by hand`. Apply the same loop to the parallel landing path (around `queue.then(() => workspace.land(ticket))`). Validate `landRetries` in `packages/core/src/config.js` (non-negative integer, default 5), type it in `index.d.ts`, add it to the config table in `docs/guide.md` + `docs/guide.uk.md` and `skills/shiftwork/references/config.md` (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/runner.test.js packages/core/test/config.test.js packages/cli/test/git.test.js` · `npm test`

- [x] Runner test (fake workspace): `land` returns `rebase` twice, then ok → the ticket resolves, the report has two `Target moved` lines, Verify ran three times
- [x] Runner test: `land` keeps returning `rebase` → after `landRetries` rounds the ticket is `needs-info` with the "kept moving" reason; `landRetries: 0` keeps the old single-try behaviour of stopping at the first move
- [x] Runner test: Verify failing on the rebased state still gives today's `verify gate failed on the branch rebased onto …` reason
- [x] Parallel path test with the same two-moves shape
- [x] Config test: `landRetries` defaults to 5; negative or non-integer fails
- [x] Guides (en + uk) and `references/config.md` list `landRetries`

### Notes

- There is only one landing block in `runner.js` (`workTicket`): the serial loop and the parallel pool both funnel through it, and the pool's `land` is wrapped by `withLandingQueue` (`queue.then(() => workspace.land(ticket))`), so the loop written once covers the parallel path — every retry round's `land` goes through the queue like any other landing. The parallel test (`options: { parallel: 2 }`) exercises exactly that wrapped path.
- `landRetries` counts whole rebase + gate re-run + land-again rounds, exactly the loop shape in the What-to-build line (`while landed.rebase && rounds < landRetries`). So `landRetries: 1` reproduces today's single-retry behaviour, and `landRetries: 0` stops at the first move with no gate re-run — one `land` call, `needs-info` with `the target kept moving (0 rebases); …`. A gate failing on a rebased state breaks the loop with today's reason (a new test covers it failing on the *second* rebased state, after one clean round); a conflict exits the loop into today's fix-forward path unchanged.
- `landRetries: 5` added to `DEFAULTS` in `config.js` and validated as a non-negative integer next to `maxHandoffs`; `runner.js` still reads `config.landRetries ?? 5` because tests pass raw config objects. Typed via a new `ShiftworkConfig` interface in `index.d.ts` (return type of `loadConfig`/`validateConfig`), the first typed config knob; the rest of the config stays `Record<string, unknown>`.
- `npm run sync-skills` and `npm run llms` re-run after the doc edits (`llms-full.txt` is gitignored).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 78035 in / 37566 out tokens, $1.1144, 79 turns
- Time: 13m 42s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/landing-race-01 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — The rebase retry loop, landRetries config, docs and tests match the ticket, and the verify gate passes.
- Time: 5m 47s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, comments, and the verify gate.
> The landed commit is `0fc8280`. I'll read that diff and the surrounding runner, config, and docs next.
> The loop is the core of the change. I'll read the landing block and the tests it sits next to.
> The ticket's focused gate passed. I'll run the full `npm test` suite next.
> `npm test` failed one parallel e2e. I'll check whether that failure comes from the landing-retry change or is a pre-existing race.
> The landing retry matches the ticket. `workTicket` loops while `land` returns `rebase`, up to `landRetries` (default 5): each round re-runs Verify in the worktree, records a `Target moved` note, and lands again. A failing gate still uses today's rebased-branch `needs-info` reason, a conflict still takes today's redo path, and a used-up budget keeps the branch with `the target kept moving (<n> rebases); …`. The serial loop and the parallel pool share that block, and every retry `land` goes through `withLandingQueue`.
> 
> `landRetries` is a non-negative integer in `config.js`, typed on `ShiftworkConfig`, and listed in both guides and the synced skill config. The acceptance tests cover two clean moves, exhaustion, `landRetries: 0`, a later gate failure, the parallel two-move shape, and config validation.
> 
> The focused gate passed (119 tests). Full `npm test` had one failure in `parallel tickets touching one file land`, a `git worktree add` error during prepare, before this loop runs. That test passed on its own immediately after, and this commit does not touch worktree creation.
