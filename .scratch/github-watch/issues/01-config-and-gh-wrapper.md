# 01: `github` config block and an injectable `gh` wrapper

**What to build:** Validate a `github` block in `.pi/shiftwork.json` (`packages/core/src/config.js`): `repo` (`owner/name`, optional), `authors` (string array), `labels.in` (string), `pollMin` (positive number, default 5), `autoClose` (boolean, default true), `push` (boolean, default false), `planTier` (an existing tier, optional); unknown keys fail with their path. Add `packages/cli/src/github.js`: `createGitHub({ root, repo, exec })` where `exec(args) → Promise<string>` defaults to running `gh` with `execFile`; methods `repo()` (configured, else parsed from `git remote get-url origin`), `collaborators()`, `listIssues({ label })`, `issueComments(n)`, `comment(n, body)`, `addLabels(n, labels)`, `removeLabel(n, label)`, `close(n, comment)`, each built on `gh api` / `gh issue` with `--json` and parsed output. Types in `packages/core/src/index.d.ts` for the config; document the block in `skills/shiftwork/references/config.md` (then `npm run sync-skills`).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/core/test/config.test.js packages/cli/test/github.test.js` · `npm test`

- [ ] Config tests: a full `github` block validates and gets defaults; bad `repo`, negative `pollMin`, unknown `planTier`, unknown key each fail with their path
- [ ] `github.test.js` with a stub `exec`: each method sends the expected `gh` argv and parses the stubbed JSON; `repo()` falls back to the origin URL (https and ssh forms)
- [ ] No real `gh` or network call in tests
