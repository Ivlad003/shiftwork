# 10: Fix the review findings in GitHub sync, the gh wrapper and dark-factory

**What to build:** Fix what the operator's review (2026-10-01) found in tickets 01–09:

1. **`exec` bug.** `resolveRepo` in `packages/cli/src/github.js` (~line 34) calls the injected `exec` instead of `runCmd`; without an injected `exec` and without `github.repo`, every call throws `exec is not a function`. Use `runCmd`.
2. **Shiftwork's own comments count as replies.** Comments are posted through the operator's `gh`, so their author is a collaborator. In `packages/cli/src/github-sync.js`, a reply to a needs-info question must not be a comment Shiftwork posted: record the id of every comment Shiftwork posts in `.pi/shiftwork-github.json` (`ownComments`) and skip those; also skip comments whose body carries a hidden marker `<!-- shiftwork -->` that every Shiftwork comment now ends with.
3. **Track comments by id, not by count.** Replace `commentsSeen` (a count) with `lastCommentId` (as the spec's state record says): fresh comments are those with an id greater than it. `issueComments` returns ids (`gh api repos/<repo>/issues/<n>/comments --paginate`). Migrate a state file that still has `commentsSeen` by treating every existing comment as seen.
4. **Needs-info more than once.** A ticket that becomes `needs-info` again after a reply posts its new question and label again (keys per occurrence, e.g. `needs-info:NN:<k>`, not one permanent key).
5. **Several needs-info tickets on one issue.** A collaborator reply is appended to every ticket of the issue that is waiting on a question (or to the one it names with `#NN`/`NN:` at the start, when it does); each such ticket goes back to `ready-for-agent`; the `needsInfo` label is removed once, when no ticket of the issue is waiting any more.
6. **Collaborators: all pages, once per sync.** `collaborators()` uses `gh api … --paginate`; `syncIssues` and `importIssues` fetch it once per call, not once per reply.
7. **`shiftwork github labels` pre-flight.** Before listing labels, run the same `gh` checks as dark-factory (missing `gh` → install message with https://cli.github.com; not logged in → `run gh auth login`), exit 1 with those messages — share one pre-flight function between `github-labels.js` and `dark-factory.js`.
8. **`git push` failure must not kill dark-factory.** Catch it, print `dark-factory: git push failed: <message>; commit links stay short shas until it succeeds`, post short shas for that sync, retry the push on the next poll.
9. **Close retry.** If adding the `done` label (or closing) fails after the summary comment is posted, the next sync retries the label and the close without re-posting the comment.
10. **Unsupported flags.** `run --dark-factory` combined with `--ticket`, `--feature`, `--parallel` or `--dry-run` exits 1 with `--dark-factory cannot be combined with --<flag>` instead of ignoring it.
11. **`llms.txt`.** Add `docs/adr/0006-github-is-an-import-source.md` to the ADR list, then run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/github.test.js packages/cli/test/github-sync.test.js packages/cli/test/github-labels.test.js` · `npm test` · `grep -q "0006-github-is-an-import-source" llms.txt`

- [ ] Test: `createGitHub({ root })` with no `exec` and no `repo` resolves the repo from a temp git repo's origin (real `git`, stubbed `gh` binary via `gh:` path to a fixture script)
- [ ] Test: after a needs-info question, a later Shiftwork comment (own id / marker) is not treated as a reply; a collaborator's comment is
- [ ] Test: replies are found by id; a deleted earlier comment does not hide a new reply; an old `commentsSeen` state migrates
- [ ] Test: the same ticket needing info twice posts two questions; two waiting tickets both get the reply; the label is removed once
- [ ] Test: `collaborators()` passes `--paginate`; one sync with three replies calls it once
- [ ] Test: `github labels` with a missing `gh` and with failing `gh auth status` exits 1 with the two messages
- [ ] Test: a failing `git push` prints the message, the loop continues, and the next poll retries
- [ ] Test: a failed `done` label is retried next sync without a second summary comment
- [ ] Test: `run --dark-factory --ticket x/01` exits 1 with the combination message
- [ ] `llms.txt` lists ADR 0006
