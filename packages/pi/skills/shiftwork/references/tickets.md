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
| `**Blocked by:**` | ticket numbers that must be `resolved` before this one starts. |

## Statuses

Triage roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. The runner owns two more: `claimed` (it holds the ticket) and `resolved` (the verify gate passed).

Never edit a `**Status:**` line while working a ticket. Report progress by ticking the acceptance checkboxes you completed.

## Writing one

- A ticket is one vertical slice, small enough to finish in a single fresh context. Split anything larger.
- Acceptance criteria are `- [ ]` checkboxes an agent can check from the ticket alone.
- Write a `**Verify:**` line with commands you can run yourself — `npm test`, a build, a lint. A ticket without one cannot be resolved.
- Work only what the ticket asks; keep changes small and consistent with the surrounding code.
- When something only a human has, stop and write exactly `<shiftwork:needs-info reason="one sentence saying what you need"/>`.

## Comments

Everything the next shift needs is appended under a `## Comments` heading at the bottom of the ticket:

- The runner appends shift reports under `### Shift` headings — those headings are the runner's; never write one.
- `### Notes` is yours for anything the next shift should know.
- `### Handoff` is written only when asked for a handoff: what was done, what remains, hypotheses, files touched.
- `### Review` sections record review verdicts: accept, reopen or follow-up.

## Worktrees

In a git repo, every ticket runs in its own worktree on branch `shiftwork/<feature>-<NN>`. When a prompt names the ticket's path, read and update that path — never the `.scratch/` copy inside the worktree.
