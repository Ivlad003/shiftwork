# 01: Keep re-verifying and landing while the target moves

**What to build:** As the spec describes. In `packages/core/src/runner.js`, the block after `let landed = await workspace.land(ticket)` handles one `landed.rebase`; turn it into a loop: while `landed.rebase` and fewer than `config.landRetries` (default 5) rounds ran, re-run the verify gate in the worktree, push the `- Target moved to … verify gate re-run: …` note, and `land` again. A failing gate on the rebased state keeps today's `needs-info` reason; a conflict keeps today's redo path; retries used up → `needs-info` with `the target kept moving (<n> rebases); branch <branch> kept — land it with shiftwork run --ticket <f>/<NN> or merge it by hand`. Apply the same loop to the parallel landing path (around `queue.then(() => workspace.land(ticket))`). Validate `landRetries` in `packages/core/src/config.js` (non-negative integer, default 5), type it in `index.d.ts`, add it to the config table in `docs/guide.md` + `docs/guide.uk.md` and `skills/shiftwork/references/config.md` (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/runner.test.js packages/core/test/config.test.js packages/cli/test/git.test.js` · `npm test`

- [ ] Runner test (fake workspace): `land` returns `rebase` twice, then ok → the ticket resolves, the report has two `Target moved` lines, Verify ran three times
- [ ] Runner test: `land` keeps returning `rebase` → after `landRetries` rounds the ticket is `needs-info` with the "kept moving" reason; `landRetries: 0` keeps the old single-try behaviour of stopping at the first move
- [ ] Runner test: Verify failing on the rebased state still gives today's `verify gate failed on the branch rebased onto …` reason
- [ ] Parallel path test with the same two-moves shape
- [ ] Config test: `landRetries` defaults to 5; negative or non-integer fails
- [ ] Guides (en + uk) and `references/config.md` list `landRetries`
