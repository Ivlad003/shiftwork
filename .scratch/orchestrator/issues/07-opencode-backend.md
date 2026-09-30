# 07: OpenCode backend

**What to build:** Add the `opencode:` backend: `opencode run -m <provider/model> --format json --auto <prompt>`. Map its JSON output to ShiftEvents and add its limit errors (e.g. `GoUsageLimitError`). Skills are delivered via `.agents/skills/` symlinks (spec story 14).

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A fake `opencode` binary drives success, a limit error and a missing binary
- [ ] The cooldown key for `opencode:opencode-go/…` is `opencode:opencode-go`
- [ ] An optional live check runs behind `SHIFTWORK_LIVE_OPENCODE=1`

## Comments

### Note for the shift (operator), from the review of 05
- **Record a real transcript first.** Run the CLI once for real with a tiny prompt that uses a tool, save its output as `packages/cli/test/fixtures/<backend>-stream.jsonl` (strip session ids, paths and anything personal), and make the fake binary *replay that fixture*. Ticket 05 invented Claude Code's event format and its fake binary replayed the invention, so tests passed while the live adapter reported nothing
- Report cost with the `cost` ShiftEvent when the CLI gives it only at the end; count one turn per assistant message, not per line
