# 13: pi-shiftwork: `/shift run` with a status widget

**What to build:** In the pi TUI, `/shift run [--feature slug]` starts the CLI runner detached (logs to file), and a status widget shows the current ticket, shift, model and budget use by reading the runner state. `/shift stop` creates the STOP file. `/shift` alone keeps showing the frontier.

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] A real pi in RPC mode lists `shift` and the subcommands
- [ ] `/shift run` starts a detached process and returns immediately
- [ ] `/shift stop` creates the STOP file
