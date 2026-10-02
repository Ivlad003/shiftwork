# Spec: the frontier is worked feature by feature

**Status:** ready-for-agent

Source: operator request, 2026-10-01: "the order should be by feature, closing all of a feature's tickets one feature at a time, without jumping between features". Vocabulary: `CONTEXT.md`.

## Problem Statement

The runner takes whatever order `tracker.frontier()` returns. `frontier()` in `packages/core/src/index.js` sorts by number, then feature, but `tracker.frontier()` in `packages/core/src/tracker.js` throws that away (`tickets.filter((t) => ready.has(t.path))`) and returns the load order: feature directories alphabetically. The result is accidental: `github-watch` went entirely before `review-default/01`, while `tier-unlimited/02`, a feature that was already started, waited behind features that merely sort earlier. And when the current feature has a ticket blocked on one being reviewed, nothing keeps the runner on that feature. `docs/agents/issue-tracker.md` says "first by number wins", which matches neither.

## Solution

**Feature by feature.**

1. **Within a feature:** ticket number order (`01`, `02`, …), as today's blockers allow.
2. **Stay on the current feature:** after a ticket of feature F lands, the next ticket is F's next ready ticket for as long as F has one. The runner moves on only when F has nothing ready (all resolved, or the rest blocked, `needs-info`, `ready-for-human` or claimed by another runner).
3. **Which feature next:** a feature already **started** (at least one ticket `resolved` or `claimed`) goes before one not started. Among equals, alphabetical feature name: simple and predictable (prefix names with numbers to force an order).
4. **A fresh runner** (no current feature yet) starts with rule 3, so it resumes a started feature before opening a new one.
5. **`--parallel N`:** slots are filled in the same order: the current feature's ready tickets first, then the next feature's.
6. `status`, `run --dry-run` and the TUI Queue's "Frontier:" line show the frontier in this order.

## Implementation Decisions

- A pure `orderFrontier(frontier, tickets, { current })` in `packages/core/src/index.js` (exported, typed in `index.d.ts`): sorts by (feature == current first) → (started before not started) → feature name → ticket number. `tracker.frontier()` (and the OpenSpec tracker's) return `orderFrontier(…, { current: null })`; the runner's `frontierPage` re-orders with `current` = the feature of the ticket it last worked.
- `docs/agents/issue-tracker.md` ("Frontier: … first by number wins") is updated to the feature-by-feature rule.
- No config option for other orders.

<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | Work the frontier feature by feature | needs-info | opencode-go/glm-5.3 |
<!-- shiftwork:tickets:end -->
