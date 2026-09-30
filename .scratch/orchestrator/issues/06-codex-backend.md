# 06: Codex backend

**What to build:** Add the `codex:` backend: `codex exec -m <m> --json --sandbox workspace-write -o <last-message-file> <prompt>`, with the worker prompt prepended to the prompt. Map its JSON events to ShiftEvents and add Codex limit patterns (`usage_limit_reached`, rate limits). Skills are delivered as symlinks in the worktree's `.agents/skills/`, excluded from git (spec story 13).

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A fake `codex` binary drives success, a limit error and a missing binary
- [ ] Skill symlinks never get committed (tested through the git workspace)
- [ ] An optional live check runs behind `SHIFTWORK_LIVE_CODEX=1`
