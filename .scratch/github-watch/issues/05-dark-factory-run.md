# 05: `shiftwork run --dark-factory`

**What to build:** `run --dark-factory` in `packages/cli/bin/shiftwork.js`: a loop that every `github.pollMin` minutes runs `importIssues` then `syncIssues` (tickets 03, 04), then works the frontier with today's `runFrontier` until it is empty, syncs again, and waits for the next poll; when `github.push` is true it runs `git push origin HEAD` in the main checkout after a frontier pass that landed commits, before syncing. It stops like the runner does: a STOP file or a signal ends it after the current shift; `--once` does one poll + one frontier pass. It prints one line per import/sync action. At start, before anything else, using the operator's installed `gh` (ticket 09's `github.gh`, else `gh` on `PATH`): `gh` not found exits 1 with "dark-factory needs the GitHub CLI: install it from https://cli.github.com, then run gh auth login"; `gh auth status` failing exits 1 with "dark-factory needs an authenticated gh: run gh auth login"; then `checkLabels` (ticket 09) — any missing label exits 1 with ticket 09's error message, before any issue is imported. Add the mode to `shiftwork run --help`, `docs/guide.md` + `docs/guide.uk.md` (a "Dark-factory mode" section: collaborators only, closing, push; it links to the "Dark-factory: labels" section from ticket 09), `skills/shiftwork/SKILL.md` "Run and steer" (then `npm run sync-skills`), and run `npm run llms`.

**Blocked by:** 04, 09

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] e2e test (stub `gh` via an injected exec or `SHIFTWORK_GH`, stub backend like `run.e2e.test.js`): one issue is imported, its plan ticket and one generated ticket resolve, the issue gets its comments and is closed, `--once` exits 0
- [x] STOP file during the wait ends the loop; `gh auth status` failure exits 1 with the message
- [x] `gh` not on PATH exits 1 with the install message (test with an empty PATH or a bad `github.gh`)
- [x] A missing label exits 1 with the missing-labels error and imports nothing
- [x] With `push: false` no `git push` runs; with `push: true` it runs once after landing
- [x] Help, guides (en + uk) and the skill describe the mode

### Notes

- `packages/cli/src/dark-factory.js`: `darkFactoryRun({ root, config, tracker, backend, verify, workspace, classifyTicket, shiftLog, once, github, exec, git, log, err, runFrontier, sleep })` → exit code (3 stopped · 1 start-up error · 0 for `--once`). Pre-flight order: no `github` block → gh missing (`gh auth status` ENOENT/EACCES) → not authenticated → `checkLabels`; all before any import. The loop: import → sync → one full `runFrontier` pass → `git push origin HEAD` in the main checkout when `github.push` and HEAD moved → sync → stop on STOP/stopped pass, else wait `pollMin` minutes (waking once a minute so a STOP file ends the wait).
- The loop's `runFrontier`, `exec`, `git` and `sleep` are injectable; bin/shiftwork.js wires the real ones plus the existing `installSignalStop`, so a signal writes STOP and ends it after the current shift like the runner.
- The gh stub is a fixture, `packages/cli/test/fixtures/gh-stub.mjs`: answers from `$SHIFTWORK_GH_STATE` and records comments/labels/closing back into it; the CLI test points `github.gh` at it.
- e2e (`dark-factory.e2e.test.js`): real pi shifts via the scripted provider; the plan shift writes the implementation ticket (its Verify gate `shiftwork tickets check <feature>` runs a `shiftwork` symlink put on PATH), one replayed script serves both shifts; unit tests (`dark-factory.test.js`) cover the loop, STOP, push and the three start-up errors.
- One line per action: `github#N imported: <title> → <feature>`, `github#N: comment: ticket NN resolved` etc. (`describePost`), `✔/✖/⚠` frontier lines as in `run`.
- Docs: “Dark-factory mode” sections in guide.md/guide.uk.md (linking the labels section), `--dark-factory` in the run help, SKILL.md “Run and steer” + a commands row in references/config.md; `npm run sync-skills` and `npm run llms` run.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 74463 in / 40688 out tokens, $0.8438, 49 turns
- Time: 14m 28s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/github-watch-05 into main
