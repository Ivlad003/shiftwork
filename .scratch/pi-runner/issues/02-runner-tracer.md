# 02: Runner tracer: one ticket end-to-end on pi

**What to build:** `shiftwork run` takes the frontier ticket, prepares a prompt from the worker prompt (ticket path, spec path, rules, the needs-info marker), runs one shift on the pi backend over RPC with one configured model, runs the verify gate and marks the ticket `resolved` or starts another attempt. After `maxAttempts` the ticket goes to `needs-info`. A ticket without `Verify` goes to `needs-info` after its attempt (ADR-0003). Every shift appends a report to `## Comments` and writes an NDJSON log. This ticket also introduces the Backend seam with a fake backend for tests and the pure `decideNext` stop rules (spec: Runner, Backend seam, pi backend, Verify). Work happens in the main checkout for now; worktrees come in 06.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js run --help`

- [x] With the fake backend: a ticket whose shift makes verify pass ends `resolved`, with a report in Comments
- [x] A failing verify starts a new attempt with the failure tail in Comments; after `maxAttempts` the status is `needs-info`
- [x] The `<shiftwork:needs-info reason="…"/>` marker in shift output sets `needs-info` with the reason
- [x] A ticket without `Verify` ends `needs-info`
- [x] `--once` works exactly one ticket; with nothing left the exit code is 0; exit code 2 when a ticket needs info
- [x] The pi adapter maps RPC events to ShiftEvents and treats `stopReason: "error"` as an error; an integration test with a real pi process and a scripted provider (or the documented stub fallback) passes without network
- [x] Findings on whether `RpcClient.waitForIdle` returns at `agent_settled` are recorded in Comments

## Comments

### Shift 1 — Claude Code (claude-opus-5-5), manual (pre-runner)
- Verify: `npm test` → 30 passed · `shiftwork run --help` → ok
- Core: `runFrontier` (claim → shift → verify gate → resolve / new attempt / needs-info, release in finally), pure `decideNext`, `WORKER_PROMPT` + `buildShiftPrompt` (pointers to ticket and spec), needs-info marker, shift report in Comments
- Backend seam: `startShift({cwd, route, prompt, systemPrompt})` → `{ events, steer, abort, capabilities }`; ShiftEvents `turn | text | error | end` (+ `raw` for logs)
- CLI: `shiftwork run [--once] [--feature] [--model] [--thinking] [--max-attempts] [--dir]`, NDJSON logs in `logs/<feature>/<NN>/attempt-<n>.jsonl`, exit 0/2/1
- pi adapter: RpcClient is loaded from the **user's own pi install** (resolvable package or `pi` on PATH), so shiftwork doesn't pin a second pi; pi is an optional peer + devDependency for tests
- Tests: fake backend at the Runner seam; real pi 0.99.1 with a test-only scripted provider extension (pi-ai `fauxProvider` registered via `pi.registerProvider`) — no network, no keys
- **Finding:** `RpcClient.waitForIdle` resolves on `agent_settled` (confirmed in rpc-client.ts); the adapter ends a shift on `agent_settled` itself
- **Finding:** pi retries a 429 on its own (≈4 s in the test) before the error reaches us; ticket 10 should lower `retry.maxRetries` for shifts
- Not done here (by design): worktrees (06), config/routing (03), STOP/status (05)
