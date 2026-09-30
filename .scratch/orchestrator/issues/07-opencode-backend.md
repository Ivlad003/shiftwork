# 07: OpenCode backend

**What to build:** Add the `opencode:` backend: `opencode run -m <provider/model> --format json --auto <prompt>`. Map its JSON output to ShiftEvents and add its limit errors (e.g. `GoUsageLimitError`). Skills are delivered via `.agents/skills/` symlinks (spec story 14).

**Blocked by:** 05

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] A fake `opencode` binary drives success, a limit error and a missing binary
- [x] The cooldown key for `opencode:opencode-go/…` is `opencode:opencode-go`
- [x] An optional live check runs behind `SHIFTWORK_LIVE_OPENCODE=1`

## Comments

### Note for the shift (operator), from the review of 05
- **Record a real transcript first.** Run the CLI once for real with a tiny prompt that uses a tool, save its output as `packages/cli/test/fixtures/<backend>-stream.jsonl` (strip session ids, paths and anything personal), and make the fake binary *replay that fixture*. Ticket 05 invented Claude Code's event format and its fake binary replayed the invention, so tests passed while the live adapter reported nothing
- Report cost with the `cost` ShiftEvent when the CLI gives it only at the end; count one turn per assistant message, not per line

### Shift 1 — pi opencode-go/kimi-k2.7-code (medium)
- Ended: stop
- Usage: 89801 in / 19002 out tokens, $0.5212, 33 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-07 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted: fixture recorded from a real `opencode run --format json`, mapper, skills via `.agents/skills`, cooldown key `opencode:opencode-go`. 33 turns on kimi
- **Fixed (live): shifts hung forever.** `opencode run` reads piped stdin as extra prompt and waits for EOF; the adapter closed stdin only in `probe`, not in `startShift`, so a live run produced no events until killed. All CLI adapters (opencode, codex, claude) now close stdin; regression test with a fake binary that reads stdin to EOF (checked: it hangs without the fix)
- Live check after the fix (`opencode:opencode-go/space-bunny-free`, demo ticket): attempt 1 failed its gate, attempt 2 resolved and landed; usage 8 turns / 43.5k tokens reported
