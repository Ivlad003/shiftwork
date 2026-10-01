# 03: Import collaborators' GitHub issues into `.scratch/`

**What to build:** `packages/cli/src/github-import.js`: `importIssues({ root, github, config, now })` lists open issues (filtered by `github.labels.in` when set), keeps those whose author is in `github.collaborators()` or `config.github.authors`, and for each one not yet in `.pi/shiftwork-github.json` writes `.scratch/gh-<N>-<slug>/spec.md` (`**Status:** ready-for-agent`, the title, `Source: github#<N> <url>`, `Author: <login>`, the body under `## Issue`) and `issues/01-plan.md`: `**Type:** plan`, `**Verify:** \`shiftwork tickets check gh-<N>-<slug>\``, with instructions to read the spec, investigate the repo, write tickets `02…` following the `shiftwork` skill's ticket format (one or several, as the issue needs), and to end with `<shiftwork:needs-info reason="…"/>` instead when the issue is unclear. When `config.github.planTier` is set, `plan` tickets route to it (`routing.plan.tier`, unless the config already routes `plan`). It records `{ number, feature, importedAt, lastCommentId: null, posted: [] }` per issue in `.pi/shiftwork-github.json` (add it to `.gitignore`) and returns the imported list. The slug is the title, lower-cased, ASCII-folded, 40 characters max. Non-collaborators are skipped and returned as `skipped` with their login.

**Blocked by:** 01, 02

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/github-import.test.js` · `npm test`

- [ ] Tests with a stub `github`: a collaborator's issue creates spec.md and 01-plan.md with the expected lines; a second run imports nothing (idempotent); a non-collaborator's issue is skipped; `authors` admits an extra login; `labels.in` filters
- [ ] The generated 01-plan.md passes `parseTicket` (Type plan, Verify line) and the generated spec names the issue URL
- [ ] `.pi/shiftwork-github.json` is in `.gitignore`
