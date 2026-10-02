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

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/github.test.js packages/cli/test/github-sync.test.js packages/cli/test/github-labels.test.js` · `npm test` · `grep -q "0006-github-is-an-import-source" llms.txt`

- [x] Test: `createGitHub({ root })` with no `exec` and no `repo` resolves the repo from a temp git repo's origin (real `git`, stubbed `gh` binary via `gh:` path to a fixture script)
- [x] Test: after a needs-info question, a later Shiftwork comment (own id / marker) is not treated as a reply; a collaborator's comment is
- [x] Test: replies are found by id; a deleted earlier comment does not hide a new reply; an old `commentsSeen` state migrates
- [x] Test: the same ticket needing info twice posts two questions; two waiting tickets both get the reply; the label is removed once
- [x] Test: `collaborators()` passes `--paginate`; one sync with three replies calls it once
- [x] Test: `github labels` with a missing `gh` and with failing `gh auth status` exits 1 with the two messages
- [x] Test: a failing `git push` prints the message, the loop continues, and the next poll retries
- [x] Test: a failed `done` label is retried next sync without a second summary comment
- [x] Test: `run --dark-factory --ticket x/01` exits 1 with the combination message
- [x] `llms.txt` lists ADR 0006

### Notes

All eleven findings fixed in `packages/cli` (attempt 1, 2026-10-01):

1. `resolveRepo` now uses `runCmd`, so the default exec resolves the repo from `origin` without an injected `exec`.
2. `github.comment` posts through `gh api …/comments -f body=` and resolves the new comment's **id**; the sync records every posted id in `ownComments`, and every comment (and the closing comment) ends with the hidden `<!-- shiftwork -->` marker (appended by the wrapper, `SHIFTWORK_MARKER`). Replies skip both.
3. `issueComments` reads `gh api repos/<repo>/issues/<n>/comments --paginate --jq` (one normalized JSON object per line, ids included). `commentsSeen` is gone; `lastCommentId` is the floor for fresh replies, and a legacy `commentsSeen` state migrates by treating every existing comment as seen.
4. Question/reply keys are per occurrence (`needs-info:NN:<k>` / `replied:NN:<k>`): a ticket that needs info again posts a new question and re-adds the label.
5. A reply goes to every waiting ticket of the issue, or to the one it names with `#NN`/`NN:` at the start (`parseTicketRef`); the `needsInfo` label is removed once, when no ticket of the issue waits any more. (The sync also patches the in-memory ticket status after `setStatus`, so later loops in the same pass see it.)
6. `collaborators()` uses `--paginate --jq .[].login`; the sync fetches it once per call (memoized), not once per reply.
7. One `ghPreFlight` (in `github.js`, next to the messages) is shared by `github labels` and dark-factory.
8. A failed `git push` is caught (`dark-factory: git push failed: <message>; commit links stay short shas until it succeeds`), retried every poll, and the syncs in between get `linkCommits: false` so their comments show short shas.
9. The close sequence is split into keys `summary` → `done` (close) → `done-label` → `working-removed`; a failed close or label is retried next sync without re-posting the summary comment.
10. `run --dark-factory` + `--ticket`/`--feature`/`--parallel`/`--dry-run` exits 1 with `--dark-factory cannot be combined with --<flag>`.
11. `llms.txt` lists ADR 0006; `npm run llms` regenerated `llms-full.txt`.

`describePost` lines changed accordingly (`comment: closing summary`, `closed the issue`, `labeled done`, `dropped the working label`); the e2e asserts the new lines. All three verify commands pass (41/41 targeted, 573 pass / 0 fail / 10 pre-existing skips in `npm test`, `grep` gate OK).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 146223 in / 96476 out tokens, $2.5679, 76 turns
- Time: 29m 21s
- Verify: failed at `npm test` (exit 1)

```
cords ### Review (68.612223ms)
✔ a reopen verdict sends the ticket back to ready-for-agent with the reason (23.892716ms)
✔ a follow-up verdict files a new ready ticket in the feature (20.239475ms)
✔ a review without the marker is treated as accept with a warning (20.527452ms)
✔ an unknown review verdict is treated as accept with a warning (19.629313ms)
✔ reviews are off by default (17.05113ms)
✔ the review features filter is respected per ticket (52.793758ms)
✔ the review types filter matches the ticket's effective type (14.332453ms)
✔ with a workspace, the review runs in the main repo with the landed message in its prompt (17.237744ms)
✔ a review whose tier is all cooling is recorded as not run (23.982361ms)
✔ shift reports say how long the shift took, and the ticket total from the second shift on (16.708309ms)
✔ formatDuration renders seconds, minutes and hours (0.253335ms)
✔ parallel: 2 works two independent tickets at once (78.995828ms)
✔ a ticket blocked by a running parallel ticket starts only after it resolves (100.095733ms)
✔ a provider at its concurrency cap is skipped for the next model, and no cooldown is written (129.033625ms)
✔ parallel landings go through one queue: one landing at a time (143.336628ms)
✔ parallel: 2 lists both workers in the run state while they run (72.758529ms)
✔ a STOP file hands off both parallel workers (106.641818ms)
✔ a failed worker lets the others settle before the error propagates (202.860895ms)
✔ a review whose verify re-run fails records the failing output, like a shift report (15.7717ms)
✔ claim returns a claim for a free frontier ticket and marks it claimed (9.745959ms)
✔ a ticket claimed by a live process can't be claimed again (9.88602ms)
✔ a claim left by a dead process is taken over (35.309603ms)
✔ setStatus changes only the Status line (2.872619ms)
✔ appendComment creates the Comments section when it's missing (2.208302ms)
✔ appendComment appends after existing comments (3.548763ms)
✔ release lets the ticket be claimed again (6.961745ms)
✔ a failed write leaves the ticket intact and no temp files behind (2.405697ms)
✔ setStatus updates the spec table and leaves bytes outside the markers unchanged (3.57327ms)
✔ missing spec markers are appended once, and a missing spec.md is left alone (6.653089ms)
✔ the last route column shows the model of the latest shift report (3.836978ms)
✔ the spec table ignores markers mentioned in prose and fills the block on its own lines (4.338843ms)
✔ VERSION matches shiftwork-core's package.json, so `shiftwork --version` never drifts (1.285749ms)
✔ a real pi lists the shift command with its subcommands (435.827618ms)
✔ /shift answers with the frontier of ready tickets (546.532206ms)
✔ /shift stop writes the STOP file (431.432204ms)
✔ /shift run starts a detached runner, returns at once and shows a status widget (2376.4061ms)
✔ /shift run finds the shiftwork CLI and logs its output to a file (353.604462ms)
✔ /shift run refuses to start a second runner (349.364242ms)
✔ loading the pi-shiftwork package advertises the shiftwork skill (514.943748ms)
✔ switching the model changes the advertised skills (459.820758ms)
✔ a model without a tier leaves skills untouched (366.612303ms)
ℹ tests 583
ℹ suites 0
ℹ pass 572
ℹ fail 1
ℹ cancelled 0
ℹ skipped 10
ℹ todo 0
ℹ duration_ms 9436.065801

✖ failing tests:

test at packages/cli/test/pi-backend.test.js:34:1
✖ a real pi shift runs tools and maps events to turns, text and end (1509.163149ms)
  AssertionError [ERR_ASSERTION]: context fill is reported for maxContextPct budgets
      at TestContext.<anonymous> (file:///home/kosmodev/.cache/shiftwork/worktrees/shiftwork-3b035128/github-watch-10/packages/cli/test/pi-backend.test.js:45:9)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

- Outcome: new attempt

### Notes

Attempt 2 (2026-10-01): no code changes were needed — attempt 1's implementation was already complete and correct. The single `npm test` failure in shift 1 was `pi-backend.test.js` "a real pi shift runs tools and maps events to turns, text and end", whose `context fill is reported for maxContextPct budgets` assertion is timing-sensitive against a real pi session and unrelated to this ticket's files. Re-ran the full gate:

- `node --test packages/cli/test/github.test.js packages/cli/test/github-sync.test.js packages/cli/test/github-labels.test.js` → 41/41 pass
- `npm test` → 573 pass, 0 fail, 10 pre-existing skips (pi-backend included, pass)
- `grep -q "0006-github-is-an-import-source" llms.txt` → OK

All eleven findings remain fixed as described in the Notes above; files changed are the same as attempt 1's.

### Shift 2 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 12602 in / 1905 out tokens, $0.0516, 11 turns
- Time: 1m 3s (ticket total 30m 24s)
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/github-watch-10 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — no verdict given
- Time: 51m 42s
- Verify: passed
- Warning: review ended without a verdict marker; treated as accept
- Findings:

> I'll review the landed ticket against its acceptance criteria and the spec, starting with the ticket, spec, and the landed diff.
> The ticket is resolved and merged. Next I’ll read the landed diff, the ADR, and the coding standards, then run the verify gate.
> The eleven findings are in the diff. I’ll check the CLI flag handling, comment tracking, and tests for gaps against those criteria.
