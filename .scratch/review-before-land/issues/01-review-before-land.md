# 01: Review on the branch before it lands (new default)

**What to build:** As the spec describes. `review.when` accepts `"before-land"` (new default), `"after-land"`, and `"resolve"` as an alias of `"after-land"` (`packages/core/src/config.js`, `index.d.ts`); `review.maxRounds` (positive integer, default 2). In `packages/core/src/runner.js`, with `before-land`: once the verify gate passes in the worktree, run the review shift there (`cwd` = the worktree, prompt from `buildReviewPrompt` pointing at `git diff <target>...HEAD` and `git log <target>..HEAD`); accept → land (landing retries re-run Verify only); follow-up → land and file the follow-up; reopen → don't land, set `ready-for-agent`, keep the worktree, and the next shift of the ticket runs on the same branch with the review findings in its prompt; after `maxRounds` reopens → `needs-info` (`review rejected it <n> times; branch <b> kept`); no verdict → `needs-info`, branch kept, nothing lands. A landing conflict that redoes the work gets a fresh review. Same for the parallel landing path. `after-land` keeps today's code path unchanged. `run --dry-run` shows `review=<tier> (before land)` / `(after land)`. Update `packages/core/src/prompt.js` (reviewer prompt wording for a branch), the guides (en + uk, the reviews section), `CONTEXT.md`, `skills/shiftwork/SKILL.md` and `references/config.md` (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** None (can start immediately; build on `review-default/02` and `landing-race/01` if they have landed)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/runner.test.js packages/core/test/config.test.js packages/cli/test/run.e2e.test.js packages/cli/test/init-dry-run.test.js` · `npm test`

- [ ] Runner test (fake backend + fake workspace): with no `review.when`, the review shift runs before `land`; accept → `land` called once, ticket resolved
- [ ] Runner test: reopen → `land` never called, ticket `ready-for-agent`, the next shift reuses the same branch/worktree and gets the findings in its prompt; a second accept then lands
- [ ] Runner test: `maxRounds` reopens → `needs-info` with the reason, branch kept, nothing landed
- [ ] Runner test: follow-up → lands and files the follow-up; no verdict → nothing lands, `needs-info`
- [ ] Runner test: `when: "after-land"` and `"resolve"` keep today's order (land, then review)
- [ ] Parallel-path test: a before-land reopen doesn't land while another slot's ticket lands
- [ ] e2e test (scripted backend, like the existing review e2e): the reviewer sees an unlanded branch; `main` gets the commit only after accept
- [ ] Dry-run shows `(before land)`; guides (en + uk), `CONTEXT.md`, the skill and `references/config.md` describe the order
