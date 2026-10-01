# Spec: pause and resume a feature

**Status:** ready-for-agent

Source: operator request, 2026-10-01. Vocabulary: `CONTEXT.md`.

## Problem Statement

There is no way to freeze one feature's development. The runner never reads a feature's `spec.md` status, so the only workarounds are editing every ticket's `**Status:**` to `ready-for-human` by hand, or running `run --feature <other>`, which runs one other feature instead of "everything but this one".

## Solution

- `shiftwork feature pause <feature>` sets `**Status:** paused` in `.scratch/<feature>/spec.md` (inserting the line under the title when the spec has none) and prints `⏸ <feature> paused: its tickets leave the frontier`. Tickets are not touched.
- `shiftwork feature resume <feature>` sets it back to `ready-for-agent` and prints `▶ <feature> resumed`.
- While a feature is paused, none of its tickets is on the frontier: `run`, `run --once`, `--parallel` and dark-factory skip it. `run --ticket <feature>/<NN>` and `run --feature <feature>` on a paused feature are refused with `feature <feature> is paused (shiftwork feature resume <feature>)`.
- Pausing the feature a shift is working lets that shift finish and land; the runner takes no further ticket of it. STOP (`s` in the TUI) is still the way to stop at once.
- `shiftwork status` and `run --dry-run` mark the feature `⏸ paused`; the TUI Queue shows `⏸` on the feature row and `p` toggles pause/resume on the feature under the cursor.
- A spec status other than `paused` keeps today's meaning: it doesn't gate tickets.

## Implementation Decisions

- `loadTickets` (or the tracker) reads each feature's `spec.md` `**Status:**` once per load and gives every ticket `featurePaused: true` when it is `paused`; `frontier()` in `packages/core/src/index.js` drops paused tickets, so every caller (runner, status, dry-run, TUI, dark-factory) agrees.
- Pause/resume edits only the spec's Status line and keeps the rest of the file (including the runner's ticket table) byte-for-byte; the write goes through the repo's shared-state lock like other tracker writes.
- OpenSpec tracker: out of scope; `feature pause` there exits 1 with `pause is supported for .scratch features only`.
- Docs: `docs/guide.md` + `docs/guide.uk.md` (section 7: the commands and "How the runner picks the next ticket"), `docs/agents/issue-tracker.md` (the `paused` spec status), `skills/shiftwork/references/tickets.md` and `config.md` CLI list (then `npm run sync-skills`), `shiftwork --help`, `npm run llms`.
