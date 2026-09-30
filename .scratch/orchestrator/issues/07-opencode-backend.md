# 07: OpenCode backend

**What to build:** Add the `opencode:` backend: `opencode run -m <provider/model> --format json --auto <prompt>`. Map its JSON output to ShiftEvents and add its limit errors (e.g. `GoUsageLimitError`). Skills are delivered via `.agents/skills/` symlinks (spec story 14).

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A fake `opencode` binary drives success, a limit error and a missing binary
- [ ] The cooldown key for `opencode:opencode-go/…` is `opencode:opencode-go`
- [ ] An optional live check runs behind `SHIFTWORK_LIVE_OPENCODE=1`
