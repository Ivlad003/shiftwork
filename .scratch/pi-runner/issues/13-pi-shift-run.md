# 13: pi-shiftwork: `/shift run` with a status widget

**What to build:** In the pi TUI, `/shift run [--feature slug]` starts the CLI runner detached (logs to file), and a status widget shows the current ticket, shift, model and budget use by reading the runner state. `/shift stop` creates the STOP file. `/shift` alone keeps showing the frontier.

**Blocked by:** 05

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] A real pi in RPC mode lists `shift` and the subcommands
- [x] `/shift run` starts a detached process and returns immediately
- [x] `/shift stop` creates the STOP file

## Comments

### Notes
- **Runner state** is new: `shiftwork-core`'s `openRunState(root)` over `.pi/shiftwork-run.json` (atomic writes, chained so a reader never sees two updates crossing). `runFrontier` publishes pid, current ticket, attempt, shift, model, thinking, tier, budget and live usage (tokens, cost, turns, context %), and on finish `running: false` with the summary and `stoppedReason`. `read()` adds `live`, from the pid. Injectable as `runState`; `noRunState()` for runs without a root.
- **Extension**: one `shift` command with subcommands parsed from its argument (`run`, `stop`, `status`, default `status`), plus `getArgumentCompletions` for them. Subcommands are not separate pi commands, so the RPC test asserts they appear in the command's description; pi's `get_commands` cannot show completions.
- `/shift run` passes its remaining arguments straight to `shiftwork run`, so `--feature`, `--once` and `--dry-run` work unchanged. It removes a `STOP` file left by an earlier `/shift stop` (otherwise the new run would exit at once) and says so in the notification. Output goes to `logs/runner-<timestamp>.log`; the child is `detached` + `unref()`ed.
- The widget polls the runner state once a second and follows a runner started anywhere (another session, a terminal): `session_start` starts watching when a live runner is found, `session_shutdown` clears it. In RPC mode `setWidget` arrives as an `extension_ui_request`, which is what the test asserts on.
- New runtime dependency, with reason: `pi-shiftwork` now depends on `shiftwork` (workspace sibling), because `/shift run` starts the CLI runner. Resolution order: `SHIFTWORK_BIN`, `require.resolve("shiftwork/bin/shiftwork.js")`, `./node_modules/shiftwork/bin/shiftwork.js`.
- Tests: `packages/pi/test/shift-command.test.js` drives a real pi in RPC mode (`--offline -ns -ne -e src/index.ts`) for the command list, the frontier answer, the STOP file, the detached start with the widget (a stub runner via `SHIFTWORK_BIN`), CLI resolution through the real `shiftwork run --dry-run`, and the refusal to start a second runner. `packages/core/test/run-state.test.js` covers the run state.
- `.gitignore`: `.pi/shiftwork-run.json` and `STOP`.

### Shift 1 — pi openrouter/anthropic/claude-opus-5 (high)
- Ended: stop
- Usage: 162 in / 41513 out tokens, $5.2456, 81 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-13 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- Done by Shiftwork, 81 turns, landed as a9d3814 — but on **openrouter/anthropic/claude-opus-5 at $5.25 (pay per token)**: OpenCode Go was cooling for its usage limit and xAI got a 5-minute `server` cooldown, so `crossTier: up` fell through to the only free premium model, a paid one
- Accepted: run state file for the widget, `/shift run|stop|status` with completions, detached runner with a log file, widget following a runner started anywhere, refusal to start a second runner, real-pi RPC tests with a stub runner
- Fixed the policy that caused the cost: `paidProviders` are a last resort; when a subscription provider frees up within `preferWaitMin` (default 30) the runner waits instead. Dogfood config: `paidProviders: ["openrouter"]`, `budgets.models["openrouter/anthropic/claude-opus-5"].maxCostUsd: 3`
