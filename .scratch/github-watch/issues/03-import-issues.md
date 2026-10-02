# 03: Import collaborators' GitHub issues into `.scratch/`

**What to build:** `packages/cli/src/github-import.js`: `importIssues({ root, github, config, now })` lists open issues (filtered by `github.labels.in` when set), keeps those whose author is in `github.collaborators()` or `config.github.authors`, and for each one not yet in `.pi/shiftwork-github.json` writes `.scratch/gh-<N>-<slug>/spec.md` (`**Status:** ready-for-agent`, the title, `Source: github#<N> <url>`, `Author: <login>`, the body under `## Issue`) and `issues/01-plan.md`: `**Type:** plan`, `**Verify:** \`shiftwork tickets check gh-<N>-<slug>\``, with instructions to read the spec, investigate the repo, write tickets `02…` following the `shiftwork` skill's ticket format (one or several, as the issue needs), and to end with `<shiftwork:needs-info reason="…"/>` instead when the issue is unclear. When `config.github.planTier` is set, `plan` tickets route to it (`routing.plan.tier`, unless the config already routes `plan`). It records `{ number, feature, importedAt, lastCommentId: null, posted: [] }` per issue in `.pi/shiftwork-github.json` (add it to `.gitignore`) and returns the imported list. The slug is the title, lower-cased, ASCII-folded, 40 characters max. Non-collaborators are skipped and returned as `skipped` with their login.

**Blocked by:** 01, 02

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/github-import.test.js` · `npm test`

- [x] Tests with a stub `github`: a collaborator's issue creates spec.md and 01-plan.md with the expected lines; a second run imports nothing (idempotent); a non-collaborator's issue is skipped; `authors` admits an extra login; `labels.in` filters
- [x] The generated 01-plan.md passes `parseTicket` (Type plan, Verify line) and the generated spec names the issue URL
- [x] `.pi/shiftwork-github.json` is in `.gitignore`

### Notes

- `.pi/shiftwork-github.json` is `{ issues: { "<N>": { number, feature, importedAt, lastCommentId, posted } } }` (numbers as string keys, so tickets 04/06 can reuse `readIssueState` / `writeIssueState` from `github-import.js`). Skipped non-collaborators are not recorded, so a later run re-evaluates them.
- `planTier` routing: `importIssues` sets `routing.plan = { tier: github.planTier }` on the passed `config` in place (unless `routing.plan` already exists), so the dark-factory runner (ticket 05) can pass the same config on after importing.
- `importIssues` returns `{ imported: [{ number, title, url, author, feature }], skipped: [{ number, login }] }`.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 37116 in / 15577 out tokens, $0.2725, 24 turns
- Time: 5m 8s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/github-watch-03 into main
