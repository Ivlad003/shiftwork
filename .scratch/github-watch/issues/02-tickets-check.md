# 02: `shiftwork tickets check <feature>` — the planning ticket's verify gate

**What to build:** A CLI command `shiftwork tickets check <feature> [--min N] [--except NN]` in `packages/cli/bin/shiftwork.js` (logic in `packages/cli/src/tickets-check.js`). It loads the feature's tickets and exits 0 when at least `N` (default 1) tickets other than the excepted ones (default `01`) are `ready-for-agent` or later, each has at least one `- [ ]`/`- [x]` acceptance checkbox and a non-empty `**Verify:**` line, and every `**Blocked by:**` number exists in the feature. Otherwise it exits 1 and prints one line per problem (`gh-12/03: no Verify line`). Add it to `shiftwork --help`, `docs/guide.md` + `docs/guide.uk.md`, `skills/shiftwork/references/config.md` (CLI commands; then `npm run sync-skills`) and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/tickets-check.test.js` · `npm test`

- [ ] Tests on temp repos: passes with one good ticket besides 01; fails with only 01; fails on a ticket without Verify, without checkboxes, or blocked by a missing number; `--min 2` needs two
- [ ] The failure output names each problem ticket and reason
- [ ] `shiftwork --help` and the guides list the command
