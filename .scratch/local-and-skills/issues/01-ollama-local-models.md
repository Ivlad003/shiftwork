# 01: Local models through Ollama

**What to build:** `shiftwork init --ollama` discovers local models (`GET /api/tags`, `POST /api/show` for context length; host from `OLLAMA_HOST`, default `http://localhost:11434`), merges an `ollama` provider into `~/.pi/agent/models.json` (`api: openai-completions`, `baseUrl: <host>/v1`, `apiKey: ollama`; existing providers kept), and adds a `local` tier with the models to `.pi/shiftwork.json`. The planner treats `ollama/…` models as free, and "connection refused" / "ECONNREFUSED" makes the backend unavailable instead of cooling (spec stories 1–3).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A test with a fake Ollama HTTP server: init writes models.json with the right context windows and keeps other providers
- [ ] Without a running server, `init --ollama` explains how to start Ollama and changes nothing
- [ ] Planner: ollama models are never paid; an ECONNREFUSED shift error marks the backend unavailable (runner test)
