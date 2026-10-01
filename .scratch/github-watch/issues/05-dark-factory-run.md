# 05: `shiftwork run --dark-factory`

**What to build:** `run --dark-factory` in `packages/cli/bin/shiftwork.js`: a loop that every `github.pollMin` minutes runs `importIssues` then `syncIssues` (tickets 03, 04), then works the frontier with today's `runFrontier` until it is empty, syncs again, and waits for the next poll; when `github.push` is true it runs `git push origin HEAD` in the main checkout after a frontier pass that landed commits, before syncing. It stops like the runner does: a STOP file or a signal ends it after the current shift; `--once` does one poll + one frontier pass. It prints one line per import/sync action. `gh auth status` failing at start exits 1 with "dark-factory needs an authenticated gh". Add the mode to `shiftwork run --help`, `docs/guide.md` + `docs/guide.uk.md` (a "Dark-factory mode" section: collaborators only, labels, closing, push), `skills/shiftwork/SKILL.md` "Run and steer" (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** 04

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] e2e test (stub `gh` via an injected exec or `SHIFTWORK_GH`, stub backend like `run.e2e.test.js`): one issue is imported, its plan ticket and one generated ticket resolve, the issue gets its comments and is closed, `--once` exits 0
- [ ] STOP file during the wait ends the loop; `gh auth status` failure exits 1 with the message
- [ ] With `push: false` no `git push` runs; with `push: true` it runs once after landing
- [ ] Help, guides (en + uk) and the skill describe the mode
