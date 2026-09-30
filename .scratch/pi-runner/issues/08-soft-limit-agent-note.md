# 08: Soft limit: the agent writes its own handoff note

**What to build:** At `softLimitPct` of any budget, the runner steers the agent to finish its step, append `### Handoff` to the ticket and stop, allowing up to 2 more turns. If a compliant note appears, it's used; otherwise the runner falls back to its own note at the hard limit (RESEARCH.md §6b).

**Blocked by:** 07

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] With the fake backend: a compliant shift's note is kept and no runner note is added
- [ ] A non-compliant shift gets a runner note after the hard limit
- [ ] The steer text is fixed and documented in the worker prompt
