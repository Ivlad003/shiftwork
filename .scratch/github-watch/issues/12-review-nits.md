# 12: Small fixes from the operator's review of ticket 10

**What to build:** Four small fixes the operator found reviewing ticket 10 (2026-10-01), all in `packages/cli/src/github-sync.js`, `packages/cli/src/dark-factory.js` and `packages/cli/src/github-labels.js`:

1. **Don't move the reply floor when posting a question.** The needs-info loop sets `lastCommentId` to the new question's id. A collaborator reply posted between two questions of the same sync is then skipped for good. Shiftwork's own comments are already filtered out (`ownComments`, the marker), so posting a question must not move `lastCommentId`; only consuming comments in the reply loop moves it.
2. **No commit links before a push succeeded.** `darkFactoryRun` starts with `commitsOnGitHub = true`, so the first sync links commits that may not be on GitHub yet. Start as "unknown": link a commit only when the local remote-tracking refs show it on the remote (`git branch -r --contains <sha>` is non-empty; no `git fetch`), otherwise show the short sha. Do this per commit in `resolvedComment`, not per run.
3. **A reply naming a ticket that isn't waiting.** A reply starting with `#NN`/`NN:` whose ticket isn't waiting on a question is consumed silently today. Post one comment back: `Ticket NN isn't waiting for an answer; the waiting tickets are: 03, 05` (or `no ticket is waiting`), with the Shiftwork marker, and don't change any ticket.
4. **Message prefix.** `shiftwork github labels` prints errors that start with `dark-factory:`. Use `shiftwork github labels:` there; keep `dark-factory:` in `run --dark-factory`. The gh pre-flight messages take the command name as a parameter.

**Blocked by:** 11

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/github-sync.test.js packages/cli/test/dark-factory.test.js packages/cli/test/github-labels.test.js` · `npm test`

- [x] Test: two tickets ask questions in one sync, a reply to the first arrives between the two posts (stub ordering) and is still delivered on the next sync
- [x] Test: a resolved comment shows a link for a commit on `origin/main` and a short sha for one only on local `main` (temp git repo with a bare remote)
- [x] Test: a reply `#07 …` when 07 isn't waiting posts the "isn't waiting" comment once and changes no ticket
- [x] Test: `github labels` with a missing gh prints a message starting with `shiftwork github labels:`; dark-factory's still starts with `dark-factory:`

### Notes

- All four fixes are in as asked; both verify gates pass (`node --test` on the three files: 41/41; `npm test`: 578 pass, 0 fail, the 10 skips are the pre-existing live-provider probes).
- Fix 1: the question loop no longer touches `lastCommentId` at all; the floor moves only in the reply loop (and in the legacy `commentsSeen` migration). A question is safe from being read as a reply by `ownComments` + the marker, so a reply between two questions of one sync is delivered on the next sync.
- Fix 2: the per-run `commitsOnGitHub` flag and the `linkCommits` parameter are gone (`github.push` no longer gates links either). `resolvedComment` gets `onRemote[i]` per sha (`git branch -r --contains <sha>`, no fetch — exit 0 with empty output in a repo without a remote, so the short sha shows). The repo URL is resolved only when at least one commit is on the remote.
- Fix 3: the comment back is `Ticket 07 isn't waiting for an answer; the waiting tickets are: 03, 05` (the named number padded like a ticket number; `no ticket is waiting` when the last waiter was answered earlier in the same batch). It is posted per offending reply, un-keyed — the reply is consumed by the floor, so it fires once. Covered by two tests (waiting list / none waiting).
- Fix 4: `GH_INSTALL_MESSAGE`/`GH_AUTH_MESSAGE` became `ghInstallMessage(command)`/`ghAuthMessage(command)` (default `dark-factory`), `ghPreFlight` takes `command`, and `missingLabelsMessage` takes it too; `github labels` passes `LABELS_COMMAND` = `shiftwork github labels`. Messages are now `<command>: …` (e.g. `dark-factory: needs the GitHub CLI: install it from https://cli.github.com, then run gh auth login`) — the colon style matches the missing-labels error; dark-factory's own two e2e regexes were updated to match.
- Also updated to the new behavior: `makeRoot` in `github-sync.test.js` grows a bare `origin` remote (initial commit pushed), and the first sync test pushes the ticket's commit before the resolved comment so the link still appears; the old `linkCommits: false` test was replaced by the per-commit half-pushed one.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 89081 in / 48810 out tokens, $1.0983, 49 turns
- Time: 14m 56s
- Verify: passed
- Outcome: resolved
- Target moved to c988ffe: branch rebased onto it, verify gate re-run: passed
- Landed: merged shiftwork/github-watch-12 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — All four review fixes match the ticket and both verify gates pass.
- Time: 8m 37s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, spec, and the landed diff.
> The landed commit is `01997a6`. I'll read the diff against the ticket and the domain docs next.
> The four fixes are in the diff. I'll read the full sync path and related callers to check whether they actually meet the criteria.
> The four fixes are in place. I'll confirm `git push` updates remote-tracking refs the way the link check assumes, then run the verify gate.
> The four fixes in `01997a6` match the ticket, and both verify gates pass.
> 
> 1. **Reply floor.** The needs-info loop no longer writes `lastCommentId`. Only the reply loop (and the legacy `commentsSeen` migration) moves it. A `#02` reply injected between two question posts in one sync is still applied on the next sync, and Shiftwork's own comments stay filtered by `ownComments` and the marker.
> 
> 2. **Commit links.** `commitsOnGitHub` and `linkCommits` are gone. Each sha is linked only when `git branch -r --contains` is non-empty, with no fetch. I checked that locally: a commit not yet pushed is empty (exit 0), and `git push origin HEAD` updates the remote-tracking ref so the next sync links it. A half-pushed ticket gets a link for the pushed sha and a short sha for the local one. A bad sha makes git exit 129, but those shas come from `git log` in the same repo.
> 
> 3. **Reply that names a ticket that is not waiting.** One comment back, `Ticket 07 isn't waiting for an answer; the waiting tickets are: 02` (or `no ticket is waiting` when an earlier reply in the same batch answered the last waiter). No ticket status or body changes. The floor consumes the reply, so a later sync does not post again. The marker is added by `github.comment`, same as every other Shiftwork comment.
> 
> 4. **Command prefix.** `ghPreFlight` and `missingLabelsMessage` take the command name. `shiftwork github labels` uses `shiftwork github labels:`; `run --dark-factory` still defaults to `dark-factory:`.
> 
> `node --test` on the three files: 41/41. `npm test`: 578 pass, 0 fail, 10 pre-existing skips.
