# 05: Research rollback edge: `<shiftwork:needs-research/>`

**What to build:** A rollback edge from implement to research (research.md, idea 4; lecture 14 "not enough info → research node"). An implementation shift that ends with `<shiftwork:needs-research reason="…"/>` makes the runner file a `Type: research` ticket in the same feature, add it to the current ticket's `**Blocked by:**`, and keep the current ticket `ready-for-agent`, so the frontier works the research ticket first, with no human in between.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/runner.test.js` · `node --test packages/core/test/prompt.test.js` · `node --test packages/core/test/tracker.test.js`

- [x] runner.js parses the marker from the final message only, standalone, like `needsInfoOf` (`needsResearchOf`). needs-info wins when both markers are present
- [x] On the marker, the runner creates the next-numbered ticket via the tracker's `createTicket` with title `Research: <reason>`, `type: "research"`, Verify `test -s .scratch/<feature>/research.md`, a "What to build" naming the blocked ticket and the reason, and one acceptance checkbox
- [x] The current ticket's `**Blocked by:**` line gains the new number (a `None …` line is replaced), its status stays `ready-for-agent`, its worktree branch is kept, and the shift report records `- Outcome: needs-research: <reason> → <feature>/<NN>`. This does not count as a failed attempt
- [x] At most one research rollback per ticket: a second marker on the same ticket is treated as needs-info with the reason
- [x] OpenSpec tracker: the marker falls back to needs-info (no ticket creation there)
- [x] `WORKER_PROMPT` in prompt.js documents the marker next to needs-info: use it when the missing piece is reading (code, docs, an external API), and needs-info when only a human has it
- [x] Tests in runner.test.js (fake backend): marker → research ticket filed, blocker added, ticket stays ready, attempt count unchanged; second marker → needs-info; needs-info + needs-research → needs-info. prompt.test.js covers the new rule text
- [x] docs/guide.md (§4 research ticket / §7 runner steps) and the shiftwork skill (`SKILL.md`, `references/tickets.md`) describe the marker

## Comments

### Notes

- Builds on gh-10's research ticket (`trackerOnly` research handling, `- Research:` prompt pointer). `createTicket` lives in packages/core/src/tracker.js.
- In dark-factory the new ticket is a normal ticket of the imported feature, so the reconcile step reports it like any other.

### Shift — manual (claude)
- Outcome: resolved
- Runner: `needsResearchOf` (final message only, standalone); a marker without needs-info files a research ticket (`fileResearchTicket` via `createTicket`, now with `checkboxes`), adds it with the new tracker `addBlocker`, keeps the ticket ready with its branch, reports `- Outcome: needs-research: <reason> → <feature>/<NN>`, and returns it to the same run's frontier once the research resolves. A second rollback, or a tracker without `createTicket`/`addBlocker` (OpenSpec), is needs-info.
- Fix found on the way: a plan or research ticket's gate now runs in the repo root, not the worktree, whose stale `.scratch/` copy never has the new `research.md`.
- Prompt: `WORKER_PROMPT` documents the marker beside needs-info. Docs: guide §4/§7 (en, uk), SKILL.md, references/tickets.md (synced), CONTEXT "Research rollback".
- Verify: `node --test packages/core/test/runner.test.js` · `node --test packages/core/test/prompt.test.js` · `node --test packages/core/test/tracker.test.js` passed; `npm test` passed.
