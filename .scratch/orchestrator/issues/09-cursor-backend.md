# 09: Cursor CLI (`cursor-agent`) backend

**What to build:** Add the `cursor:` backend for Cursor's CLI. `cursor-agent` 2026.09.28 is installed here, and its flags were checked with `--help`: `cursor-agent -p --output-format stream-json --model <m> --force --trust --workspace <worktree> [--plugin-dir <generated skills plugin>] <prompt>`. Use `--list-models` for the available models. Don't use its own `--worktree`: Shiftwork already gives the shift a worktree. It isn't logged in yet (`cursor-agent status` → "Not logged in"): an auth error must be classified so the backend is skipped with a clear warning, not retried (spec story 16). Always invoke it as **`cursor-agent`**, never `agent`. The Cursor installer (`curl https://cursor.com/install -fsS | bash`) also links `~/.local/bin/agent`, but Grok Build's `~/.grok/bin/agent` comes first in PATH on this machine, so `agent` opens Grok (reported by the operator).

**Blocked by:** 05

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] A fake `cursor-agent` binary drives success, a limit error and a missing binary
- [x] A missing `cursor-agent` is skipped with a warning, not an error
- [x] "Authentication required" / "Not logged in" makes the backend unavailable with a warning (like a missing binary), not a cooldown
- [x] An optional live check runs behind `SHIFTWORK_LIVE_CURSOR=1`

## Comments

### Notes
- `cursor-agent` 2026.09.28 turned out to be **logged in** on this machine (status → "Logged in as …"), so the fixture is a real recorded transcript: `packages/cli/test/fixtures/cursor-stream.jsonl` (a tool-using run that wrote `hello.txt`), with session ids, paths and timestamps stripped. The fake binary replays it.
- Stream format (`cursor-agent -p --output-format stream-json`): `system/init` (model), `user` echo, `connection`/`retry` noise, `thinking` deltas (ignored, not reply text), one `assistant` event per message (text only, **no usage**), `tool_call` started/completed (ignored), and a single `result` at the end with `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` and `is_error`. No cost field.
- Mapper: one turn per assistant message; each assistant event closes the previous message's turn, so the last turn (closed by `result`) carries the whole run's usage; `context` comes from the result too.
- Invocation: `cursor-agent -p --output-format stream-json --model <m> --force --trust --workspace <worktree> [--plugin-dir <generated>] <prompt>`. Never `agent`, never `--worktree`. Verified for real that `--plugin-dir` accepts a plain `skills/` symlink dir (no manifest needed) and that the live probe + tiny shift pass (`SHIFTWORK_LIVE_CURSOR=1`).
- Auth: `cursor-agent status` prints "Not logged in" (exit 0) when logged out; a logged-out run exits 1 with stderr "Error: Authentication required. …". The backend checks `status` before spawning (skipped when `CURSOR_API_KEY` is set — key auth is decided by the run) and also maps a run-time auth failure to the same unavailable message. Both paths produce `cursor-agent backend not available: …`, which the runner's `isBackendUnavailable` matches — skipped with a warning like a missing binary, never a classified cooldown (`classifyError` returns null on it).
- Core change: the runner's `BACKEND_UNAVAILABLE` regex now accepts `cursor(?:-agent)?` (the binary is `cursor-agent`, the other backends' binaries equal their backend names). Locked by a runner test chaining `cursor:auto` → `fake/m1` for both the missing-binary and not-logged-in messages.

### Note for the shift (operator), from the review of 05
- **Record a real transcript first.** Run the CLI once for real with a tiny prompt that uses a tool, save its output as `packages/cli/test/fixtures/<backend>-stream.jsonl` (strip session ids, paths and anything personal), and make the fake binary *replay that fixture*. Ticket 05 invented Claude Code's event format and its fake binary replayed the invention, so tests passed while the live adapter reported nothing
- Report cost with the `cost` ShiftEvent when the CLI gives it only at the end; count one turn per assistant message, not per line

### Shift 1 — pi opencode-go/kimi-k3 (medium)
- Ended: stop
- Usage: 133114 in / 37541 out tokens, $1.5267, 46 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-09 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted as is: `cursor-agent` adapter (never `agent`), recorded fixture, auth errors make the backend unavailable. 46 turns on opencode-go/kimi-k3
- Live check (`cursor:auto`, demo ticket, logged in as the operator): resolved on the first attempt, 3 turns; Cursor reports no cost (subscription), so cost budgets don't apply to it — use turns/time budgets
