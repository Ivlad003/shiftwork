# 08: Grok Build (`grok`) backend

**What to build:** Add the `grok:` backend for xAI's Grok Build CLI. Always invoke it as **`grok`**, never `agent`: Grok Build and Cursor both install an `agent` symlink, and the one that runs depends on PATH order. The command, checked with `--help` (grok 1.0.41+), is `grok -m <m> --output-format streaming-json --always-approve <prompt>`, headless. Map its NDJSON (ACP session updates) to ShiftEvents and add its limit errors. Skills are delivered via `.agents/skills/` symlinks (spec story 15).

**Blocked by:** 05

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] A fake `grok` binary drives success, a limit error and a missing binary
- [x] Headless-mode flags come from `grok --help` and are recorded in the ticket
- [x] An optional live check runs behind `SHIFTWORK_LIVE_GROK=1`

## Comments

### Notes
- **Headless-mode flags (`grok --help`, grok 1.0.44):** the working headless command is `grok -m <m> --output-format streaming-json --always-approve -p <prompt>`. **`-p/--single` is required**: a positional prompt (the spec's `grok ... <prompt>`) opens the interactive TUI and crashes with `No such device or address (os error 6)` when there's no TTY. `-p` is a single *user* turn, not a single agent step — a recorded run did 2 turns with a tool call and file write. `--output-format streaming-json` = "NDJSON: one ACP session update per line".
- **Real transcript recorded first** (`packages/cli/test/fixtures/grok-stream.jsonl`): `grok -p "Create a file named hello.txt..." -m grok-4.7 --output-format streaming-json --always-approve` in a scratch dir. Sanitized: session/request ids and `signature` fields dropped, paths → `/work`, `available_commands` reduced to a generic tool list (it enumerates the user's installed skills). The fake binary replays this fixture.
- **NDJSON shapes (grok 1.0.44):** `available_commands` (noise, repeated), `text` `{data}` (streaming chunks of one assistant message), `tool_call`/`tool_call_update` (ignored), `usage` (one per assistant message/model call: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `reasoning_tokens`), `error` `{message}`, `end` `{stopReason, usage (totals), num_turns, total_cost_usd, modelUsage}`.
- **Mapper decisions:** one `turn` per `usage` event (matches `num_turns`); text chunks joined and emitted with the turn; input = input + cache_read + cache_creation, output = output + reasoning (same convention as the opencode adapter); `cost` emitted once from `end.total_cost_usd` since cost is only reported at the end; `end.stopReason` `end_turn`→`stop`, `cancelled`→`aborted`, `error`→`error`.
- **grok exits 0 on fatal errors** (verified: unknown model prints `{"type":"error",...}` and exits 0), so the backend ends the shift with `error` when the stream carried an error event and no `end` event arrived.
- **Limit errors:** strings from the grok 1.0.44 binary — "You hit your free usage limit.", "You hit your weekly limit.", "You've hit the rate limit for your plan.", "Agent-message quota exceeded (", "run out of credits". Added to `classifyError`: `hit your weekly limit` (usage) and `out of credits` (quota); the rest were already covered.
- **Live check:** `SHIFTWORK_LIVE_GROK=1 node --test packages/cli/test/grok-backend.test.js` ran green against the real binary (probe + tiny shift emits a turn and ends `stop`).

### Note for the shift (operator), from the review of 05
- **Record a real transcript first.** Run the CLI once for real with a tiny prompt that uses a tool, save its output as `packages/cli/test/fixtures/<backend>-stream.jsonl` (strip session ids, paths and anything personal), and make the fake binary *replay that fixture*. Ticket 05 invented Claude Code's event format and its fake binary replayed the invention, so tests passed while the live adapter reported nothing
- Report cost with the `cost` ShiftEvent when the CLI gives it only at the end; count one turn per assistant message, not per line

### Shift 1 — pi opencode-go/kimi-k3 (medium)
- Ended: stop
- Usage: 88090 in / 24241 out tokens, $1.2930, 43 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/orchestrator-08 into main

### Review — Claude Code (claude-opus-5-5)
- Accepted as is: fixture recorded from a real `grok` run, adapter invoked as `grok` (never `agent`), stdin closed. 43 turns on opencode-go/kimi-k3
- Live check (`grok:grok-4.7`, demo ticket): resolved on the first attempt, 5 turns, $0.0268 — usage and cost reported
