# 04: Skill groups, tiers and preloaded skills in shifts

**What to build:** A shift sees exactly its skill set: the tier's skill groups adjusted by the ticket's `Skills: +group -group`, resolved to paths from `skillSources`, passed to pi as `-ns --skill …`. Preloaded skills have their full `SKILL.md` bodies appended to the shift's system prompt (spec: Planner skill arithmetic; RESEARCH.md §3a).

**Blocked by:** 03

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Planner tests cover ± arithmetic, unknown group errors and unknown skill warnings
- [ ] A missing skill path doesn't crash the run; it's reported in the shift report
- [ ] The pi integration test proves a skill outside the set isn't advertised
- [ ] Preloaded skill bodies appear in the system prompt passed to the backend
