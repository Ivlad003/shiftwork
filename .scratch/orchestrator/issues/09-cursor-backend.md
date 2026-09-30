# 09: Cursor CLI (`cursor-agent`) backend

**What to build:** Add the `cursor:` backend for Cursor's CLI: `cursor-agent -p --output-format stream-json --model <m> <prompt>`. `cursor-agent` is **not installed on this machine**: implement it from Cursor's CLI docs, test it with a fake binary, and record in Comments which flags still need live confirmation (spec story 16).

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A fake `cursor-agent` binary drives success, a limit error and a missing binary
- [ ] A missing `cursor-agent` is skipped with a warning, not an error
- [ ] The flags still to confirm live are listed in the ticket
