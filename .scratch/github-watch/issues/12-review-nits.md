# 12: Small fixes from the operator's review of ticket 10

**What to build:** Four small fixes the operator found reviewing ticket 10 (2026-10-01), all in `packages/cli/src/github-sync.js`, `packages/cli/src/dark-factory.js` and `packages/cli/src/github-labels.js`:

1. **Don't move the reply floor when posting a question.** The needs-info loop sets `lastCommentId` to the new question's id. A collaborator reply posted between two questions of the same sync is then skipped for good. Shiftwork's own comments are already filtered out (`ownComments`, the marker), so posting a question must not move `lastCommentId`; only consuming comments in the reply loop moves it.
2. **No commit links before a push succeeded.** `darkFactoryRun` starts with `commitsOnGitHub = true`, so the first sync links commits that may not be on GitHub yet. Start as "unknown": link a commit only when `git branch -r --contains <sha>` (or `git merge-base --is-ancestor <sha> origin/<branch>` after `git fetch` is not needed — use the local `origin/*` refs) shows it on the remote; otherwise the short sha. Do this per commit in `resolvedComment`, not per run.
3. **A reply naming a ticket that isn't waiting.** A reply starting with `#NN`/`NN:` whose ticket isn't waiting on a question is consumed silently today. Post one comment back: `Ticket NN isn't waiting for an answer; the waiting tickets are: 03, 05` (or `no ticket is waiting`), with the Shiftwork marker, and don't change any ticket.
4. **Message prefix.** `shiftwork github labels` prints errors that start with `dark-factory:`. Use `shiftwork github labels:` there; keep `dark-factory:` in `run --dark-factory`. The gh pre-flight messages take the command name as a parameter.

**Blocked by:** 11

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/github-sync.test.js packages/cli/test/dark-factory.test.js packages/cli/test/github-labels.test.js` · `npm test`

- [ ] Test: two tickets ask questions in one sync, a reply to the first arrives between the two posts (stub ordering) and is still delivered on the next sync
- [ ] Test: a resolved comment shows a link for a commit on `origin/main` and a short sha for one only on local `main` (temp git repo with a bare remote)
- [ ] Test: a reply `#07 …` when 07 isn't waiting posts the "isn't waiting" comment once and changes no ticket
- [ ] Test: `github labels` with a missing gh prints a message starting with `shiftwork github labels:`; dark-factory's still starts with `dark-factory:`
