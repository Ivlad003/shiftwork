# Spec: landing survives a target that keeps moving

**Status:** ready-for-agent

Source: operator report, 2026-10-01. Vocabulary: `CONTEXT.md`.

## Problem Statement

`review-default/01` passed its verify gate and then went to `needs-info` with "verify gate passed but landing failed: the target moved to 463da77: branch … rebased onto it; re-verify and land again". The runner already handles one move of the target (`packages/core/src/runner.js`, after `workspace.land`): it rebases, re-runs Verify, and lands again. But re-running Verify (`npm test`) takes minutes, the operator committed to `main` again in that time, the second `land` found the target moved once more and returned another `rebase` — and the runner treats a second move as a failure. Good work stops at `needs-info` and has to be landed by hand.

## Solution

While `land` returns `rebase` (the target moved and the rebase was clean), the runner re-runs the verify gate on the rebased branch and lands again, up to `landRetries` times (default 5). Each round adds one `- Target moved to <sha>: …` line to the shift report. Only when the retries are used up, or Verify fails on the rebased state, or a rebase conflicts (existing redo path), does the ticket stop.

## Implementation Decisions

- Loop in the runner's landing block instead of the single retry; same for the parallel landing path (`queue.then(() => workspace.land(ticket))`).
- `landRetries` is a top-level config number (validated, ≥ 0), default 5; documented in the guide's config table.
- When retries run out, the reason names the count: `the target kept moving (5 rebases); branch <b> kept — land it with shiftwork run --ticket <f>/<NN> or merge it by hand`.
