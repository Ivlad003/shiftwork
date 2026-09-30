# 10: Provider limits, shared cooldowns and chain fallback

**What to build:** Errors from a shift are classified into rate, usage, quota or server limits, with reset hints. The provider gets a cooldown in `.pi/shiftwork-state.json`, shared by every runner, and the shift is relaunched on the next chain model in the same worktree without counting an attempt. When the whole chain is cooling down, `crossTier` decides: move to the neighbouring tier, or wait for the earliest cooldown to end (spec: Limit classifier, Cooldowns; RESEARCH.md §6a).

**Blocked by:** 07

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Classifier table tests built from pi-ai's patterns plus Claude, ChatGPT and OpenCode usage-limit wording
- [x] A 429 from the fake backend produces a cooldown and a relaunch on the next provider, and the attempt counter is unchanged
- [x] All-cooling with `crossTier: none` waits (with an injected clock), then resumes
- [x] Cooldowns survive a runner restart

## Comments

### Notes
- `classifyError` (pure) maps provider errors to `rate` | `usage` | `quota` | `server`, with reset hints from `retry-after` / `x-ratelimit-reset` / "resets at". Usage/quota beat a wrapping 429.
- Shared cooldowns stay in `.pi/shiftwork-state.json` via `openCooldowns`. A classified error cools the provider and the same worktree relaunches on the next free chain model without incrementing the attempt.
- `planShift` skips cooled providers; with `crossTier: none` it returns `{ wait }` for the earliest reset; `up`/`down` try the neighbouring tier. The runner waits through an injected `clock`.
- Config: `cooldown` defaults `15m/5h/24h/5m`, `crossTier: none`. `npm test`: 167 passed.

### Shift 1 — pi xai/grok-4.6 (medium)
- Ended: stop
- Usage: 166827 in / 36965 out tokens, $1.2136, 24 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-10 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- Done by Shiftwork: 24 turns on xai/grok-4.6, landed as 7be6bbe
- Checked `classifyError` on the real OpenCode Go error from ticket 08 (`429 GoUsageLimitError`) → usage; rate / quota / server / "resets at" hints also classified; plain code errors → null
- Fixed: a provider limit skipped the verify gate and always relaunched, so work finished just before the limit (ticket 08's case) was redone on the next model; the gate now runs first and a pass resolves the ticket (the provider still cools down)
- Fixed: all-cooling waits slept for the whole cooldown (up to 24 h) in one go, so a STOP file wasn't noticed; waits now wake at least once a minute
- Dogfood config: kimi first again, grok 4.6 inside the standard chain so an OpenCode Go usage limit falls through to xAI; `crossTier: up`
