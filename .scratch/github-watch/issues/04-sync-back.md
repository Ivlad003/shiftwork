# 04: Report ticket progress back to the GitHub issue

**What to build:** `packages/cli/src/github-sync.js`: `syncIssues({ root, github, config, tracker, git })` — for every imported issue in `.pi/shiftwork-github.json`, compare its feature's tickets with what was already posted (`posted` keys) and post only the difference: (a) `shiftwork:working` label + "Work started" comment when a ticket is first `claimed`; (b) per resolved ticket, a comment with the ticket title, its latest `### Shift` report and the landed commits found with `git log --grep "shiftwork: <feature>/<NN>" --format=%H` — as `https://github.com/<repo>/commit/<sha>` links when `config.github.push` is true, else the short sha; (c) a `needs-info` ticket's reason as a question comment + `shiftwork:needs-info` label; (d) a new comment on the issue by a collaborator after a needs-info question: append it under the ticket's `## Comments` as `### Reply from @<login>`, set the ticket back to `ready-for-agent`, remove the `shiftwork:needs-info` label; (e) when every ticket of the feature is resolved and `autoClose` is on: a summary comment, `shiftwork:done` label, close the issue. Never delete issues, comments or labels other than the `shiftwork:needs-info` label. Labels are created on first use (`gh label create --force`). Every post is recorded before the next one, so a crash re-posts at most one comment.

**Blocked by:** 03

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/github-sync.test.js` · `npm test`

- [ ] Tests with a stub `github` and a temp repo: claimed → one "started" comment; resolved → one comment with the shift report and the commit link (push on) or short sha (push off); a second sync posts nothing
- [ ] needs-info → question comment; a collaborator's reply is appended to the ticket and its status becomes `ready-for-agent`; a non-collaborator's reply is ignored
- [ ] All tickets resolved → summary comment, `shiftwork:done`, issue closed once; with `autoClose: false` it stays open
- [ ] No test calls a delete endpoint
