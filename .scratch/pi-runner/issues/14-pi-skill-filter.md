# 14: pi-shiftwork: tier skill filter for interactive sessions

**What to build:** In interactive pi sessions, a `before_agent_start` handler narrows `systemPromptOptions.skills` to the tier skill set of `ctx.model`, using the same config as the runner. It follows `/model` switches. Models without a tier keep all skills and get a one-time notice (RESEARCH.md §3a).

**Blocked by:** 04

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A real pi RPC test: switching the model changes the advertised skills
- [ ] A model without a tier leaves skills untouched
