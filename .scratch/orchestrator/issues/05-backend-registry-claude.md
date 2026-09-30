# 05: Backend registry and the Claude Code backend

**What to build:** Model refs pick the backend: `claude:`, `codex:`, `opencode:`, `grok:`, `cursor:`, and no prefix for pi. The registry resolves each ref to an adapter, and a backend whose binary isn't installed is skipped like a cooling provider, with a warning. This ticket adds the first CLI backend, Claude Code: `claude -p --model <m> --output-format stream-json --verbose --append-system-prompt <worker> --dangerously-skip-permissions [--plugin-dir <generated skills plugin>] <prompt>`. It maps stream-json events to ShiftEvents (turns, usage, cost, text, errors, end) and adds Claude Code limit patterns to `classifyError` (spec stories 11–12, 17–21).

**Blocked by:** 01

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] `parseModelRef` table tests, including cooldown keys `backend:provider`
- [ ] A fake `claude` binary on PATH drives the adapter: a success run, a usage-limit error that cools `claude`, and a missing binary that is skipped
- [ ] Skill set delivered as a generated plugin dir with symlinks; preloaded skills are prepended to the prompt
- [ ] An optional live check runs behind `SHIFTWORK_LIVE_CLAUDE=1`
