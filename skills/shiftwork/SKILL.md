---
name: shiftwork
description: Drive Shiftwork, the ticket runner that works `.scratch/<feature>/issues/*.md` tickets in fresh-context shifts until their Verify commands pass. Use when writing or triaging a Shiftwork ticket (the Status/Type/Model/Skills/Budget/Verify lines), when running or steering the runner (`shiftwork run`, `status`, `tui`, or `/shift` in pi), or when judging a landed ticket as a review shift.
license: MIT
---

# Shiftwork

Shiftwork works a queue of Markdown tickets with coding agents: one fresh context per ticket, a handoff to another model when a budget or a provider limit runs out, and the ticket's `**Verify:**` commands — nothing else — deciding that it is resolved. When the repo has `CONTEXT.md` and `docs/adr/`, use their vocabulary.

Reach for the references when the branch needs them:

- [`references/tickets.md`](references/tickets.md): the ticket format — every line's meaning, the statuses, the Comments conventions.
- [`references/config.md`](references/config.md): `.pi/shiftwork.json` — routing, tiers, budgets, cooldowns, review shifts, worktrees, the CLI commands and exit codes.

## Write a ticket

1. Read the feature's `spec.md` and the tickets under `.scratch/<feature>/issues/`: the frontier is the open tickets whose `**Blocked by:**` blockers are all `resolved`.
2. Write `.scratch/<feature>/issues/<NN>-<slug>.md` following `references/tickets.md`: a short statement of the slice, acceptance checkboxes, the Shiftwork lines, and `**Verify:**` commands you can run yourself.
3. Keep one ticket one vertical slice, small enough to finish in a single fresh context; file anything larger as several tickets with blockers between them.
4. The ticket is done when it is `ready-for-agent`, every checkbox is checkable from the ticket alone, and its `**Verify:**` commands fail before the work and pass after it.

## Run and steer

1. Once per repo: `npx shiftwork init --model <provider>/<model-id>` (add `--ollama` to route to local models). Read `references/config.md` before changing what init wrote.
2. See the frontier and the routing before spending anything: `npx shiftwork status`, then `npx shiftwork run --dry-run`.
3. Run: `npx shiftwork run --once` works one ticket; `npx shiftwork run` works the frontier until nothing is left. Watch `npx shiftwork tui` (r run · s stop · d dry-run · f filter · q quit); in pi, `/shift`, `/shift run`, `/shift stop`.
4. Stopping is graceful: a runner told to stop finishes its current shift first, so change the ticket or the config and let the shift land.
5. Dark-factory takes work from GitHub issues instead: `npx shiftwork run --dark-factory` polls the repo (`github` block in `.pi/shiftwork.json`, collaborators only, labels required), imports and plans each issue, works the frontier and reports back on the issue; `--once` is one poll plus one pass. It needs the operator's `gh` CLI (`gh auth login`) — see docs/guide.md "Dark-factory mode".
6. The run is done when every ticket is `resolved` and its Verify commands pass in a clean checkout, or when a ticket carries `<shiftwork:needs-info reason="…"/>` for what only the operator knows.

## Review landed work

1. Read the ticket, all of its `## Comments`, the feature spec, and the landed diff: `git log -3 --oneline`, then `git show <sha>` for each landed commit.
2. Run the ticket's Verify commands yourself before deciding anything.
3. Judge against the ticket's acceptance criteria, the spec and the repo's standards, not against what you would have written.
4. Change no files: a review reports. End with exactly one marker: `<shiftwork:review verdict="accept" reason="…"/>` — or `reopen` (the ticket goes back to `ready-for-agent`, the landed commit stays) or `follow-up` (the runner files a new ticket from your reason).
