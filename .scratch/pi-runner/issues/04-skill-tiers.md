# 04: Skill groups, tiers and preloaded skills in shifts

**What to build:** A shift sees exactly its skill set: the tier's skill groups adjusted by the ticket's `Skills: +group -group`, resolved to paths from `skillSources`, passed to pi as `-ns --skill …`. Preloaded skills have their full `SKILL.md` bodies appended to the shift's system prompt (spec: Planner skill arithmetic; RESEARCH.md §3a).

**Blocked by:** 03

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Planner tests cover ± arithmetic, unknown group errors and unknown skill warnings
- [x] A missing skill path doesn't crash the run; it's reported in the shift report
- [x] The pi integration test proves a skill outside the set isn't advertised
- [x] Preloaded skill bodies appear in the system prompt passed to the backend

## Comments

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: stop
- Usage: 110166 in / 31560 out tokens, $1.3174, 85 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-04 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- First ticket done by Shiftwork itself (dogfooding): 85 turns on opencode-go/kimi-k2.7-code, verify gate green, landed as 50fd80c
- Accepted: `-ns --skill`, preloaded SKILL.md bodies in the system prompt, warnings in the shift report, config validation, real-pi test proving a skill outside the set isn't advertised
- Accepted deviation from RESEARCH.md §3a: `skillGroups` map to skill *source names*, `skillSources` map name → path (explicit, deterministic) instead of skill names searched in source dirs
- Fixed: `-ns` was always passed, so a config without skill groups left shifts with no skills at all; now only when the tier or the ticket configures skills (`route.skills.restricted`)
- Removed: an interactive TUI skill filter in pi-shiftwork (that is ticket 14, and it never matched — see the note there)
