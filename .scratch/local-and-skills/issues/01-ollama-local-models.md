# 01: Local models through Ollama

**What to build:** `shiftwork init --ollama` discovers local models (`GET /api/tags`, `POST /api/show` for context length; host from `OLLAMA_HOST`, default `http://localhost:11434`), merges an `ollama` provider into `~/.pi/agent/models.json` (`api: openai-completions`, `baseUrl: <host>/v1`, `apiKey: ollama`; existing providers kept), and adds a `local` tier with the models to `.pi/shiftwork.json`. The planner treats `ollama/…` models as free, and "connection refused" / "ECONNREFUSED" makes the backend unavailable instead of cooling (spec stories 1–3).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] A test with a fake Ollama HTTP server: init writes models.json with the right context windows and keeps other providers
- [x] Without a running server, `init --ollama` explains how to start Ollama and changes nothing
- [x] Planner: ollama models are never paid; an ECONNREFUSED shift error marks the backend unavailable (runner test)

### Notes

- New `packages/cli/src/ollama.js`: `ollamaHost` (OLLAMA_HOST, default `http://localhost:11434`, scheme added when missing), `discoverOllamaModels` (`GET /api/tags`, `POST /api/show`, context length from any `*.context_length` key of `model_info`), `writeOllamaProvider` (merges the `ollama` provider into `<agentDir>/models.json`, `PI_CODING_AGENT_DIR` respected, other providers kept), `ollamaUnavailableMessage`.
- `init --ollama` discovers first: unreachable or empty server → prints the start-Ollama guidance and returns before any write. On success it runs the normal init, writes models.json (`api: openai-completions`, `baseUrl: <host>/v1`, `apiKey: ollama`, per-model `contextWindow`), and sets `tiers.local` (chain of `ollama/<id>` models, `thinking: low`, budget with turns/context/stall only — no cost) in `.pi/shiftwork.json`, refreshing it on re-runs.
- Planner: `isFreeModel` — OpenRouter `…:free` ids and `ollama/…` models are never paid, even when their provider is in `paidProviders`.
- Runner: `connection refused` / `ECONNREFUSED` in a shift error now goes down the backend-unavailable path (same as a missing CLI): skipped without counting an attempt, cooldown on the provider, no server-error cooling.
- Tests: `packages/cli/test/init-ollama.test.js` (fake `node:http` Ollama server; three tests incl. the no-server case using a freed port), plus planner and runner tests. `npm test`: 371 tests, 0 fail.
- Also: `--ollama` in the CLI help and a README paragraph.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 68697 in / 24097 out tokens, $0.7770, 47 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/local-and-skills-01 into main

### Review — operator (Claude Code), 2026-09-30
- Live check with a fake Ollama server (`/api/tags` + `/api/show`) and the real CLI: `init --ollama` merged `ollama` into models.json next to an existing provider; `pi --list-models` shows `ollama qwen2.5-coder:7b 32.8K`. The `local` tier passes `validateConfig`. With no server: prints the ECONNREFUSED guidance and writes nothing.
- **Fixed:** the runner test used an invented error (`fetch failed: connect ECONNREFUSED …`). Recorded from pi 0.99.1 against a stopped Ollama: `"stopReason":"error","errorMessage":"Connection error."` — no ECONNREFUSED, so the regex never fired and a stopped Ollama burned every attempt. Now `Connection error.` counts as unavailable for local providers (`ollama`) only; on cloud providers it stays an ordinary failed attempt (a network blip must not cool OpenRouter for 5 h). Tests use the recorded text, plus a cloud negative case.
- Known limitation: "unavailable" reuses the `usage` cooldown (5 h default), so after `ollama serve` the local tier stays skipped until the cooldown expires or `.pi/shiftwork-state.json` is cleared.
- Verdict: accept.
