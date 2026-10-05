# 02: Tool events in the shift logs, and `shiftwork reflect`

**What to build:** Find the steps agents repeat shift after shift that a script could take over (GitHub #12). Part A: every backend mapper logs the agent's tool calls as `{ type: "tool", name, input }` (the shell command, or the file path, ≤ 500 chars), so the shift logs record them. Part B: `shiftwork reflect [--since <days>] [--min <n>] [--write]` mines `logs/**/attempt-*.jsonl` for shell commands, and runs of 2–4 consecutive commands, repeated across at least `--min` (default 3) shifts, and suggests a script for each; `--write` saves the report and files an `automate-*` feature.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/claude-backend.test.js packages/cli/test/codex-backend.test.js packages/cli/test/cursor-backend.test.js packages/cli/test/grok-backend.test.js packages/cli/test/opencode-backend.test.js packages/cli/test/pi-backend.test.js packages/cli/test/reflect.test.js`

- [x] claude (`tool_use` blocks), codex (`command_execution`/`file_change`/`mcp_tool_call`/`web_search` items, once per item id), cursor (`tool_call` started), grok (`tool_call`, not its updates), opencode (`tool_use`) and pi (`tool_execution_start`) emit `tool` events; tests from the recorded fixtures
- [x] The core runner loop and the meter ignore event types they don't know (read: `packages/core/src/meter.js`, `runShift` in `runner.js`); `createShiftLogger` writes them as is
- [x] `normalizeCommand` turns a command into a template (`<path>`, `<str>`, `<n>`, `<sha>`; leading `cd … &&` and `bash -lc '…'` dropped); `findRepeatedSteps` ranks commands and 2–4-step runs by occurrences × shifts, drops trivial lookups and runs always seen inside a longer one
- [x] `findVerifyFailures` reports the same `Verify: failed at \`…\`` command failing at least twice in the tickets' `## Comments`
- [x] `suggestScript` names `scripts/<name>.sh` and writes a bash skeleton with the varying parts as arguments
- [x] `--write` saves `.scratch/reflections/<YYYY-MM-DD>.md` and creates `.scratch/automate-<name>/` (spec + one ready-for-agent ticket per top suggestion, up to 5; never overwrites an existing feature; nothing when there is no suggestion)
- [x] `shiftwork reflect` in the CLI help; a "Finding repeated steps" subsection in `docs/guide.md`

## Comments

### Shift — manual (claude)
- Outcome: resolved
- Files: `packages/cli/src/{claude,codex,cursor,grok,opencode,pi}-backend.js` (a local `toolEvent` helper + mapper branches), their tests, new `packages/cli/src/reflect.js` + `packages/cli/test/reflect.test.js`, `case "reflect"` + help in `packages/cli/bin/shiftwork.js`, `docs/guide.md`.
- Verify: the ticket's `node --test` command passed (77 pass, 9 skipped); full `npm test` 870 pass, 0 fail.
- Note: logs written before this change have no `tool` events, so `reflect` finds no steps in them until new shifts run; the verify-failure scan works on the existing tickets.
