# Spec: the frontier is worked in ticket-number order

**Status:** ready-for-agent

Source: operator request, 2026-10-01. Vocabulary: `CONTEXT.md`.

## Problem Statement

`docs/agents/issue-tracker.md` says the frontier is taken "first by number wins", and `frontier()` in `packages/core/src/index.js` sorts by number, then feature. But `tracker.frontier()` in `packages/core/src/tracker.js` returns `tickets.filter((t) => ready.has(t.path))` — the load order, which is the feature directories' alphabetical order. So the runner works every ready ticket of `github-watch` before `review-default/01`, and `tier-unlimited/02` waits behind features that merely sort earlier.

## Solution

`tracker.frontier()` (and the OpenSpec tracker's) return the frontier in `frontier()`'s order: ticket number first, then feature name. The serial runner, `--parallel` scheduling, `status` and `run --dry-run` all show and use that order.

## Implementation Decisions

- Return the sorted list from `frontier(reopened)` mapped back to the original ticket objects (orphaned claims keep their `claimed` status object as today), instead of filtering the load order.
- Same in `packages/core/src/openspec.js`.
- No config option for other orders.
