# 02: Review shifts in a fresh context

**What to build:** Optional `review: { enabled, tier, when: "resolve", features?, types? }`. After a ticket lands, the runner runs one review shift on that tier with a review prompt (pointers to the ticket, spec and the merge commit's diff) and the ticket's verify gate. The reviewer ends with `<shiftwork:review verdict="accept|reopen|follow-up" reason="…"/>`: accept → nothing more; reopen → ticket back to ready-for-agent with the reason; follow-up → a new ticket appended to the feature. The review is recorded as `### Review` in Comments (spec stories 4–6).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Runner tests with the fake backend for all three verdicts and for a missing marker (treated as accept with a warning)
- [ ] Reviews off by default; `features` / `types` filters respected
- [ ] `--dry-run` shows whether a ticket would be reviewed and on which tier
