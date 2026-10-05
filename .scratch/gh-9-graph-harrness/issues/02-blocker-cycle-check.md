# 02: Reject blocker cycles in `tickets check`

**What to build:** `shiftwork tickets check <feature>` also fails when the feature's `**Blocked by:**` lines form a cycle or a ticket blocks itself, naming the cycle, so a plan cannot silently deadlock a feature (research.md, idea 1).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/tickets-check.test.js`

- [x] `checkFeatureTickets` (packages/cli/src/tickets-check.js) reports `<feature>/<NN>: blocked by itself` for a ticket that lists its own number
- [x] It reports each cycle once as `<feature>: blocker cycle 03 → 04 → 03` (numbers in ascending start order, deterministic), covering every ticket of the feature, the excepted plan ticket included
- [x] Tickets on a cycle do not count as workable toward `--min`, the same as a ticket with a missing blocker
- [x] An acyclic diamond (`04` blocked by `02, 03`, both blocked by `01`) still passes
- [x] Tests in packages/cli/test/tickets-check.test.js for self-block, a 2-cycle, a 3-cycle and the diamond
- [x] docs/guide.md §7 (the `tickets check` paragraph) mentions the cycle check

## Comments

### Notes

- Use a plain DFS over `blockedBy`. No new dependency.
- Other agents are editing `tickets-check.js` in parallel: keep the change local to the check and rebase carefully.

### Shift — manual (claude)
- Outcome: resolved
- Verify: `node --test packages/cli/test/tickets-check.test.js` passed (33/33).
