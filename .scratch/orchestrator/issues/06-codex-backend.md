# 06: Codex backend

**What to build:** Add the `codex:` backend: `codex exec -m <m> --json --sandbox workspace-write -o <last-message-file> <prompt>`, with the worker prompt prepended to the prompt. Map its JSON events to ShiftEvents and add Codex limit patterns (`usage_limit_reached`, rate limits). Skills are delivered as symlinks in the worktree's `.agents/skills/`, excluded from git (spec story 13).

**Blocked by:** 05

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [ ] A fake `codex` binary drives success, a limit error and a missing binary
- [ ] Skill symlinks never get committed (tested through the git workspace)
- [ ] An optional live check runs behind `SHIFTWORK_LIVE_CODEX=1`

## Comments

### Note for the shift (operator), from the review of 05
- **Record a real transcript first.** Run the CLI once for real with a tiny prompt that uses a tool, save its output as `packages/cli/test/fixtures/<backend>-stream.jsonl` (strip session ids, paths and anything personal), and make the fake binary *replay that fixture*. Ticket 05 invented Claude Code's event format and its fake binary replayed the invention, so tests passed while the live adapter reported nothing
- Report cost with the `cost` ShiftEvent when the CLI gives it only at the end; count one turn per assistant message, not per line

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: timeout, error: shift timed out after undefined ms
- Usage: 64851 in / 19952 out tokens, $0.3798, 37 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-06 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted: the shift recorded a real `codex exec --json` transcript as its fixture (checked against a fresh live run: same `thread.started / item.* / turn.completed` shape), skills via `.agents/skills` symlinks excluded from git, Codex limit patterns
- Fixed: `--approve-for-me` uses Codex's workspace-write sandbox, which can't start here (`bwrap: loopback: Operation not permitted` when run from a sandboxed shell), so shifts couldn't write files. New `codex.sandbox`: `approve-for-me` (default) | `workspace-write` | `bypass` (the ticket worktree is the isolation); the CLI now passes every backend section of the config, not only pi and claude
- Fixed: the pi shift ended on the adapter's 60-min safety timeout ("timed out after undefined ms") at the same moment as the 60-min `maxWallMin` budget, so the budget's handoff never ran. Safety timeouts are now 3 h in all adapters, and the message gives the real time
