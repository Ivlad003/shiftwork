# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## Shiftwork additions

Shiftwork executes these tickets itself (see `CONTEXT.md` and ADR-0001). A ticket may carry these optional lines, directly under `**Status:**`. The mattpocock skills ignore them:

- `**Type:**` routing key, for example `code`, `git`, `docs`, `test`, `refactor`. If omitted, the runner classifies the ticket.
- `**Model:**` `provider/model-id`. Overrides routing.
- `**Skills:**` skill-group adjustments, for example `+design -git`.
- `**Budget:**` ticket budget overrides, for example `$2 · 50 turns`.
- `**Verify:**` backtick-quoted commands separated by `·`. They form the verify gate (ADR-0003).

Besides the triage roles, the runner writes two statuses: `claimed` (the runner holds the ticket) and `resolved` (the verify gate passed). It appends shift reports and handoff notes under `## Comments`.

**Write every ticket with a `**Verify:**` line.** A ticket without one can't be resolved automatically.
