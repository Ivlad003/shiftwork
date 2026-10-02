# 01: `github` config block and an injectable `gh` wrapper

**What to build:** Validate a `github` block in `.pi/shiftwork.json` (`packages/core/src/config.js`): `repo` (`owner/name`, optional), `authors` (string array), `labels.in` (string), `pollMin` (positive number, default 5), `autoClose` (boolean, default true), `push` (boolean, default false), `planTier` (an existing tier, optional); unknown keys fail with their path. Add `packages/cli/src/github.js`: `createGitHub({ root, repo, exec })` where `exec(args) → Promise<string>` defaults to running `gh` with `execFile`; methods `repo()` (configured, else parsed from `git remote get-url origin`), `collaborators()`, `listIssues({ label })`, `issueComments(n)`, `comment(n, body)`, `addLabels(n, labels)`, `removeLabel(n, label)`, `close(n, comment)`, each built on `gh api` / `gh issue` with `--json` and parsed output. Types in `packages/core/src/index.d.ts` for the config; document the block in `skills/shiftwork/references/config.md` (then `npm run sync-skills`).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/config.test.js packages/cli/test/github.test.js` · `npm test`

- [x] Config tests: a full `github` block validates and gets defaults; bad `repo`, negative `pollMin`, unknown `planTier`, unknown key each fail with their path
- [x] `github.test.js` with a stub `exec`: each method sends the expected `gh` argv and parses the stubbed JSON; `repo()` falls back to the origin URL (https and ssh forms)
- [x] No real `gh` or network call in tests

### Notes

- `exec(args)` receives the full argv including the binary (`["gh", …]` / `["git", "remote", "get-url", "origin"]`), so the origin-remote fallback goes through the same injectable seam; its default runs `execFile(args[0], args.slice(1))` in `root`. The wrapper exports `parseRepoUrl` (https, ssh and `ssh://` origin forms, optional `.git`).
- `config.github` is always a defaulted object (`authors: []`, `pollMin: 5`, `autoClose: true`, `push: false`) — same pattern as `review`/`jev`; later tickets can read `config.github.<key>` without handling `undefined`.
- `listIssues` normalizes each issue to `{ number, title, body, state, author (login), labels (names), url }` and `issueComments` to `{ author, body, createdAt }`, so ticket 03/04 work on plain fields, not `gh`'s nested JSON shapes.
- Skill reference updated and `npm run sync-skills` run (packages/pi + plugins copies in sync).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 32815 in / 15822 out tokens, $0.2262, 19 turns
- Time: 4m 44s
- Verify: passed
- Outcome: resolved
- Target moved to afdec71: branch rebased onto it, verify gate re-run: passed
- Landed: merged shiftwork/github-watch-01 into main
