# 09: Cursor CLI (`cursor-agent`) backend

**What to build:** Add the `cursor:` backend for Cursor's CLI. `cursor-agent` 2026.09.28 is installed here, and its flags were checked with `--help`: `cursor-agent -p --output-format stream-json --model <m> --force --trust --workspace <worktree> [--plugin-dir <generated skills plugin>] <prompt>`. Use `--list-models` for the available models. Don't use its own `--worktree`: Shiftwork already gives the shift a worktree. It isn't logged in yet (`cursor-agent status` → "Not logged in"): an auth error must be classified so the backend is skipped with a clear warning, not retried (spec story 16). Always invoke it as **`cursor-agent`**, never `agent`. The Cursor installer (`curl https://cursor.com/install -fsS | bash`) also links `~/.local/bin/agent`, but Grok Build's `~/.grok/bin/agent` comes first in PATH on this machine, so `agent` opens Grok (reported by the operator).

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A fake `cursor-agent` binary drives success, a limit error and a missing binary
- [ ] A missing `cursor-agent` is skipped with a warning, not an error
- [ ] "Authentication required" / "Not logged in" makes the backend unavailable with a warning (like a missing binary), not a cooldown
- [ ] An optional live check runs behind `SHIFTWORK_LIVE_CURSOR=1`

## Comments

### Note for the shift (operator), from the review of 05
- **Record a real transcript first.** Run the CLI once for real with a tiny prompt that uses a tool, save its output as `packages/cli/test/fixtures/<backend>-stream.jsonl` (strip session ids, paths and anything personal), and make the fake binary *replay that fixture*. Ticket 05 invented Claude Code's event format and its fake binary replayed the invention, so tests passed while the live adapter reported nothing
- Report cost with the `cost` ShiftEvent when the CLI gives it only at the end; count one turn per assistant message, not per line
