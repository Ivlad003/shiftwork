# 08: Grok Build (`grok`) backend

**What to build:** Add the `grok:` backend for xAI's Grok Build CLI. Always invoke it as **`grok`**, never `agent`: Grok Build and Cursor both install an `agent` symlink, and the one that runs depends on PATH order. The command, checked with `--help` (grok 1.0.41+), is `grok -m <m> --output-format streaming-json --always-approve <prompt>`, headless. Map its NDJSON (ACP session updates) to ShiftEvents and add its limit errors. Skills are delivered via `.agents/skills/` symlinks (spec story 15).

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A fake `grok` binary drives success, a limit error and a missing binary
- [ ] Headless-mode flags come from `grok --help` and are recorded in the ticket
- [ ] An optional live check runs behind `SHIFTWORK_LIVE_GROK=1`

## Comments

### Note for the shift (operator), from the review of 05
- **Record a real transcript first.** Run the CLI once for real with a tiny prompt that uses a tool, save its output as `packages/cli/test/fixtures/<backend>-stream.jsonl` (strip session ids, paths and anything personal), and make the fake binary *replay that fixture*. Ticket 05 invented Claude Code's event format and its fake binary replayed the invention, so tests passed while the live adapter reported nothing
- Report cost with the `cost` ShiftEvent when the CLI gives it only at the end; count one turn per assistant message, not per line
