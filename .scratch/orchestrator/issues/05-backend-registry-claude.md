# 05: Backend registry and the Claude Code backend

**What to build:** Model refs pick the backend: `claude:`, `codex:`, `opencode:`, `grok:`, `cursor:`, and no prefix for pi. The registry resolves each ref to an adapter, and a backend whose binary isn't installed is skipped like a cooling provider, with a warning. This ticket adds the first CLI backend, Claude Code: `claude -p --model <m> --output-format stream-json --verbose --append-system-prompt <worker> --dangerously-skip-permissions [--plugin-dir <generated skills plugin>] <prompt>`. It maps stream-json events to ShiftEvents (turns, usage, cost, text, errors, end) and adds Claude Code limit patterns to `classifyError` (spec stories 11–12, 17–21).

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] `parseModelRef` table tests, including cooldown keys `backend:provider`
- [x] A fake `claude` binary on PATH drives the adapter: a success run, a usage-limit error that cools `claude`, and a missing binary that is skipped
- [x] Skill set delivered as a generated plugin dir with symlinks; preloaded skills are prepended to the prompt
- [x] An optional live check runs behind `SHIFTWORK_LIVE_CLAUDE=1`

### Notes
- Added `parseModelRef(ref)` in `packages/core/src/planner.js` that returns `{ backend, model, provider, rawModel }` for `claude:`, `codex:`, `opencode:`, `grok:`, `cursor:` prefixes and pi refs.
- Updated `planShift` to set `backend`, `model`, `provider`, `rawModel` from the parsed ref; `providerOf` now uses `parseModelRef` so CLI backends cool under their backend name.
- Updated `runner.js` to use `route.provider` for cooldowns and to treat a missing CLI backend (`<backend>: command not found`) as a usage cooldown, skipping it without counting an attempt.
- Added Claude Code usage/limit patterns to `classifyError`.
- Created `packages/cli/src/claude-backend.js`: spawns `claude -p --output-format stream-json`, maps stream-json events to ShiftEvents, builds a temporary plugin dir with symlinks to granted skills, and prepends preloaded skills to the system prompt.
- Created `packages/cli/src/backend-registry.js` that dispatches `pi` and `claude` adapters by `route.backend`.
- Updated `packages/cli/bin/shiftwork.js` to use the registry.
- Added `packages/cli/test/claude-backend.test.js` and new core tests for `parseModelRef`, CLI backend routing/cooling, and missing-backend skip. Live check gated by `SHIFTWORK_LIVE_CLAUDE=1`.
- `npm test` passes.

## Comments

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: stop
- Usage: 133106 in / 40870 out tokens, $1.4068, 64 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-05 into main

### Review — Claude Code (claude-opus-5-5)
- Done by Shiftwork on opencode-go/kimi-k2.7-code (the new probe cleared OpenCode Go's guessed cooldown first), 64 turns
- Accepted: backend registry and `parseModelRef`, probe through `claude -p`, generated plugin dir for skills, missing CLI treated as an unavailable backend
- **Fixed (serious): the stream-json format was invented.** The adapter mapped `text` / `usage` / `context` / `done` events that Claude Code never emits, and the fake binary replayed the same invented events, so all tests passed while a live run reported "0 in / 0 out, 1 turn" (a synthetic turn from `finish`). Rewrote the mapper from a recorded real transcript (now `test/fixtures/claude-stream.jsonl`, environment stripped): `assistant` message.usage per unique message id, `rate_limit_event` (status ≠ allowed → limit error with the reset time), `result` (total_cost_usd → a new `cost` ShiftEvent, is_error). Core runner and meter now count `cost` events
- Live check after the fix (claude:haiku, demo ticket): resolved, 6 turns, $0.0501
- Known limit: per-turn output tokens are the first streamed value (Claude Code updates them later); totals are right in `result`
