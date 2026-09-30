# 14: pi-shiftwork: tier skill filter for interactive sessions

**What to build:** In interactive pi sessions, a `before_agent_start` handler narrows `systemPromptOptions.skills` to the tier skill set of `ctx.model`, using the same config as the runner. It follows `/model` switches. Models without a tier keep all skills and get a one-time notice (RESEARCH.md §3a).

**Blocked by:** 04

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] A real pi RPC test: switching the model changes the advertised skills
- [x] A model without a tier leaves skills untouched

## Comments

### Notes
- Interactive filter uses `skillsForModel` from shiftwork-core (`tierForModel` + `resolveSkills`), matching on `${ctx.model.provider}/${ctx.model.id}` and `dirname(skill.filePath)`.
- Models with no tier stay unrestricted and get one notify per session. Missing/invalid config leaves skills as they are.

### Note from the review of ticket 04
- A first attempt at this filter slipped into ticket 04 and was removed. Two bugs to avoid: it compared tier chains (`provider/model`) with `ctx.model.id` (no provider), and skill directories with `skill.filePath` (the SKILL.md file). Use `${ctx.model.provider}/${ctx.model.id}` and compare `dirname(skill.filePath)`; reuse `planShift`'s skill resolution from shiftwork-core instead of re-implementing it.

### Shift 1 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 91171 in / 19078 out tokens, $1.3115, 35 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-14 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- Done by Shiftwork on xai/grok-4.6, 35 turns, landed with a merge commit (main had moved on); 211 tests
- Accepted: the shift read the note from ticket 04's review and avoided both bugs — it matches `provider/id` and `dirname(skill.filePath)`, and reuses core's `skillsForModel` instead of re-implementing the resolution; models without a tier stay unrestricted with one notice per session
- Phase 1 (pi-runner) complete: 14/14
