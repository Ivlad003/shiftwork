# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`. Its `Status:` line is the feature's pause switch: `paused` (set by `shiftwork feature pause <feature>`) keeps every ticket of the feature off the runner's frontier until `shiftwork feature resume <feature>`; any other value doesn't gate tickets
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
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed. It is worked feature by feature: a feature that is already started (a resolved or claimed ticket) goes before one that isn't; among equals, feature name, then ticket number. The runner stays on the feature it last worked while that feature has a frontier ticket.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## Shiftwork additions

Shiftwork executes these tickets itself (see `CONTEXT.md` and ADR-0001). A ticket may carry these optional lines, directly under `**Status:**`. The mattpocock skills ignore them:

- `**Type:**` routing key, for example `code`, `git`, `docs`, `test`, `refactor`. If omitted, the runner classifies the ticket.
- `**Model:**` `provider/model-id`. Overrides routing.
- `**Skills:**` skill-group adjustments, for example `+design -git`.
- `**Budget:**` ticket budget overrides, for example `$2 · 50 turns`.
- `**Dual:**` `yes` or `no`. Turns dual shifts (two models, then a merge; ADR-0007) on or off for this ticket, overriding `dual.enabled`.
- `**Verify:**` backtick-quoted commands separated by `·`. They form the verify gate (ADR-0003).
- `**Frozen:**` backtick-quoted globs separated by `·` (or `,`). Frozen paths: a branch that changed one does not resolve, even with the gate passing. Added to the config's `frozen` list.

Besides the triage roles, the runner writes two statuses: `claimed` (the runner holds the ticket) and `resolved` (the verify gate passed). It appends shift reports and handoff notes under `## Comments`.

**Write every ticket with a `**Verify:**` line.** A ticket without one can't be resolved automatically.

## OpenSpec tracker

Shiftwork can also work [OpenSpec](https://openspec.dev) changes through the same tracker interface. Set `"tracker": "openspec"` in `.shiftwork/shiftwork.json`, or let it auto-detect: `openspec/changes/` is used when `.scratch/` doesn't exist (`.scratch/` wins when both exist).

- One feature per change: `openspec/changes/<change>/`. The `archive/` folder is ignored.
- Each unchecked `- [ ] N.M` task in `tasks.md` is a ticket, blocked by the previous task (so sections follow each other). A checked box is a resolved ticket; resolving a task ticks its box.
- Status beyond done/undone (`claimed`, `needs-info`, …), shift reports and comments live in `openspec/changes/<change>/.shiftwork.md`, one `## N.M` section per task. The runner owns this file.
- The verify gate is `openspec.verify` from the config (default `["openspec validate <change>"]`, `<change>` substituted) plus a task's own indented `Verify:` line under the task.
