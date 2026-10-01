# 05: `shiftwork run --dark-factory`

**What to build:** `run --dark-factory` in `packages/cli/bin/shiftwork.js`: a loop that every `github.pollMin` minutes runs `importIssues` then `syncIssues` (tickets 03, 04), then works the frontier with today's `runFrontier` until it is empty, syncs again, and waits for the next poll; when `github.push` is true it runs `git push origin HEAD` in the main checkout after a frontier pass that landed commits, before syncing. It stops like the runner does: a STOP file or a signal ends it after the current shift; `--once` does one poll + one frontier pass. It prints one line per import/sync action. At start, before anything else, using the operator's installed `gh` (ticket 09's `github.gh`, else `gh` on `PATH`): `gh` not found exits 1 with "dark-factory needs the GitHub CLI: install it from https://cli.github.com, then run gh auth login"; `gh auth status` failing exits 1 with "dark-factory needs an authenticated gh: run gh auth login"; then `checkLabels` (ticket 09) — any missing label exits 1 with ticket 09's error message, before any issue is imported. Add the mode to `shiftwork run --help`, `docs/guide.md` + `docs/guide.uk.md` (a "Dark-factory mode" section: collaborators only, closing, push; it links to the "Dark-factory: labels" section from ticket 09), `skills/shiftwork/SKILL.md` "Run and steer" (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** 04, 09

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] e2e test (stub `gh` via an injected exec or `SHIFTWORK_GH`, stub backend like `run.e2e.test.js`): one issue is imported, its plan ticket and one generated ticket resolve, the issue gets its comments and is closed, `--once` exits 0
- [ ] STOP file during the wait ends the loop; `gh auth status` failure exits 1 with the message
- [ ] `gh` not on PATH exits 1 with the install message (test with an empty PATH or a bad `github.gh`)
- [ ] A missing label exits 1 with the missing-labels error and imports nothing
- [ ] With `push: false` no `git push` runs; with `push: true` it runs once after landing
- [ ] Help, guides (en + uk) and the skill describe the mode
