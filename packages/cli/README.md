# shiftwork

CLI for [Shiftwork](https://github.com/Ivlad003/shiftwork). Autonomous agents work in shifts: a fresh context per ticket, with model handoff on budgets and provider limits.

```bash
npx shiftwork status      # list tickets and the ready frontier
```

In development: `shiftwork run`. It will run each ticket in a fresh `pi`, `claude -p`, `codex exec` or `opencode run` process, gate the result on `Verify` commands, and fall back to another provider on limits.

Status: early development.
