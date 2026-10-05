# Spec: Add before  implementation step research read if needed.

**Status:** resolved

Source: github#10 https://github.com/Ivlad003/shiftwork/issues/10
Author: Ivlad003

## Issue

Decision (operator): the lightweight design. A research step is an ordinary ticket with `**Type:** research` that the plan ticket writes first (as `02`) when the issue needs reading before coding — an unfamiliar API, an external repo or doc, unclear existing code. It investigates and writes its findings (sources, facts, decisions, open questions) to `.scratch/<feature>/research.md`, changes no product code, has Verify `test -s .scratch/<feature>/research.md`, and the implementation tickets list it in `**Blocked by:**`; otherwise it is skipped. "Read if needed": every plan and implementation shift prompt carries `- Research: <path>` (absolute in a worktree, like the spec path) only when that file exists; a research ticket's prompt tells it to write findings there instead of product code. Like plan tickets, a research ticket's work lives under `.scratch/` (excluded from commits), so the runner skips the unchanged-tree check and the review for it.


<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | Plan the work for github#10 | needs-info | grok-4.6 |
<!-- shiftwork:tickets:end -->
