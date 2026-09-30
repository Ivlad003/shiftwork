# 10: Provider limits, shared cooldowns and chain fallback

**What to build:** Errors from a shift are classified into rate, usage, quota or server limits, with reset hints. The provider gets a cooldown in `.pi/shiftwork-state.json`, shared by every runner, and the shift is relaunched on the next chain model in the same worktree without counting an attempt. When the whole chain is cooling down, `crossTier` decides: move to the neighbouring tier, or wait for the earliest cooldown to end (spec: Limit classifier, Cooldowns; RESEARCH.md §6a).

**Blocked by:** 07

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Classifier table tests built from pi-ai's patterns plus Claude, ChatGPT and OpenCode usage-limit wording
- [ ] A 429 from the fake backend produces a cooldown and a relaunch on the next provider, and the attempt counter is unchanged
- [ ] All-cooling with `crossTier: none` waits (with an injected clock), then resumes
- [ ] Cooldowns survive a runner restart
