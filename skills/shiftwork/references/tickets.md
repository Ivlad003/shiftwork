# Writing Shiftwork tickets

Tickets are Markdown files at `.scratch/<feature>/issues/<NN>-<slug>.md`, numbered from `01`, one file per ticket: the local tracker of the mattpocock-skills format. One feature per directory `.scratch/<feature>/`, whose `spec.md` is the feature's single source of truth; file one spec per feature, one slice per ticket.

## The Shiftwork lines

A ticket states its triage state with `**Status:**`, then carries these optional lines directly under it:

| Line | Meaning |
| --- | --- |
| `**Type:**` | routing key: `code`, `git`, `docs`, `test`, `refactor`, `research`, … . Omitted → the runner classifies the ticket. |
| `**Model:**` | `provider/model-id`. Overrides routing for this one ticket. |
| `**Skills:**` | skill-group adjustments, for example `+design -git`. |
| `**Budget:**` | budget overrides for this ticket, for example `$2 · 50 turns`. |
| `**Verify:**` | backtick-quoted commands separated by `·`. The **verify gate**: the only judge of resolution. |
| `**Frozen:**` | backtick-quoted globs (`*`, `**`, `?`) separated by `·` or `,`: **frozen paths** no shift of this ticket may change, added to the config's `frozen` list. A passing gate on a branch that changed one is a failed attempt (`- Frozen paths changed: …`). Leave out what the ticket is meant to change, such as the tests it adds. |
| `**Blocked by:**` | ticket numbers that must be `resolved` before this one starts. |

## Statuses

Triage roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. The runner owns two more: `claimed` (it holds the ticket) and `resolved` (the verify gate passed).

The feature's `spec.md` has a `**Status:**` line too — the feature's pause switch: `paused` (set by `npx shiftwork feature pause <feature>`) keeps every ticket of the feature off the runner's frontier until `npx shiftwork feature resume <feature>`; `resume` sets the spec back to `ready-for-agent`. Any other spec status doesn't gate tickets.

Never edit a `**Status:**` line while working a ticket. Report progress by ticking the acceptance checkboxes you completed.

## Writing one

- A ticket is one vertical slice, small enough to finish in a single fresh context. Split anything larger.
- Acceptance criteria are `- [ ]` checkboxes an agent can check from the ticket alone.
- Write a `**Verify:**` line with commands you can run yourself — `npm test`, a build, a lint. A ticket without one cannot be resolved.
- Work only what the ticket asks; keep changes small and consistent with the surrounding code.
- When the work needs reading before coding — an unfamiliar API, an external repo or doc, unclear existing code — file a `**Type:** research` ticket first. It investigates and writes its findings (sources, facts, decisions, open questions) to `.scratch/<feature>/research.md`, changes no product code, and its gate is `` `test -s .scratch/<feature>/research.md` ``. List it in the implementation tickets' `**Blocked by:**`. Otherwise skip it. Once `research.md` exists, every later shift's prompt points at it (`- Research: …`) to read if it needs background.
- When something only a human has, stop and write exactly `<shiftwork:needs-info reason="one sentence saying what you need"/>`.
- When what is missing is reading — code, docs, an external API — not a human's answer, stop and write exactly `<shiftwork:needs-research reason="one sentence saying what must be researched"/>`. The runner files the next-numbered `**Type:** research` ticket (`Research: <reason>`, Verify `` `test -s .scratch/<feature>/research.md` ``), adds it to this ticket's `**Blocked by:**` and keeps this ticket `ready-for-agent` with its branch, so the research runs first. It is not a failed attempt, and it works once per ticket: a second one, or the OpenSpec tracker, becomes needs-info. When both markers are present, needs-info wins.

## Comments

Everything the next shift needs is appended under a `## Comments` heading at the bottom of the ticket:

- The runner appends shift reports under `### Shift` headings — those headings are the runner's; never write one.
- `### Notes` is yours for anything the next shift should know.
- `### Handoff` is written only when asked for a handoff: what was done, what remains, hypotheses, files touched.
- `### Review` sections record review verdicts: accept, reopen or follow-up.

## Worktrees

In a git repo, every ticket runs in its own worktree on branch `shiftwork/<feature>-<NN>`. When a prompt names the ticket's path, read and update that path — never the `.scratch/` copy inside the worktree.
