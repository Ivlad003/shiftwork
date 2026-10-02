# 04: Report ticket progress back to the GitHub issue

**What to build:** `packages/cli/src/github-sync.js`: `syncIssues({ root, github, config, tracker, git })` — for every imported issue in `.pi/shiftwork-github.json`, compare its feature's tickets with what was already posted (`posted` keys) and post only the difference: (a) the `github.labels.working` label (default `shiftwork:working`) + "Work started" comment when a ticket is first `claimed`; (b) per resolved ticket, a comment with the ticket title, its latest `### Shift` report and the landed commits found with `git log --grep "shiftwork: <feature>/<NN>" --format=%H` — as `https://github.com/<repo>/commit/<sha>` links when `config.github.push` is true, else the short sha; (c) a `needs-info` ticket's reason as a question comment + the `labels.needsInfo` label; (d) a new comment on the issue by a collaborator after a needs-info question: append it under the ticket's `## Comments` as `### Reply from @<login>`, set the ticket back to `ready-for-agent`, remove the `labels.needsInfo` label; (e) when every ticket of the feature is resolved and `autoClose` is on: a summary comment, the `labels.done` label, close the issue. Never delete issues or comments; the only label ever removed from an issue is `labels.needsInfo` (and `labels.working` when `done` is added). Labels are **never created** here — they must already exist (ticket 09 checks them at start). Every post is recorded before the next one, so a crash re-posts at most one comment.

**Blocked by:** 03, 09

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/github-sync.test.js` · `npm test`

- [x] Tests with a stub `github` and a temp repo: claimed → one "started" comment; resolved → one comment with the shift report and the commit link (push on) or short sha (push off); a second sync posts nothing
- [x] needs-info → question comment; a collaborator's reply is appended to the ticket and its status becomes `ready-for-agent`; a non-collaborator's reply is ignored
- [x] All tickets resolved → summary comment, the `done` label, issue closed once; with `autoClose: false` it stays open
- [x] No test calls a delete endpoint

### Notes

- `syncIssues({ root, github, config, tracker, git })` in `packages/cli/src/github-sync.js`; state keys on each issue's `posted` array: `working`, `started:<NN>`, `resolved:<NN>`, `needs-info:<NN>`, `replied:<NN>`, `done`. State is written after every post, so a crash re-posts at most one comment.
- "Work started" is posted per first-claimed ticket; the `working` label only once per issue. The needs-info reason is read from the runner's last `- Outcome: needs-info: …` (or `- Stopped: …`) line in the ticket.
- New issue comments are tracked by count (`commentsSeen` on the issue's state entry), recorded *before* the question comment is posted so the question itself is never treated as a reply; non-collaborator replies advance the count so they are never reconsidered.
- The needs-info label is removed when a reply is handled (and `working` is dropped when `done` is added, only if we added it); labels are never created or otherwise removed, and no delete endpoint exists on the `github` wrapper or the stub.
- `git` is injectable like `github`'s `exec` (default: real `git` in `root`); the tests use a real temp git repo for the landed-commit grep.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 51322 in / 27440 out tokens, $0.3284, 19 turns
- Time: 8m 29s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/github-watch-04 into main
