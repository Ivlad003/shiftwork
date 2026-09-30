# 05: `shiftwork status`, STOP file and run summary

**What to build:** `shiftwork status` shows tickets, the frontier, active claims (with owner pid and age) and cooldowns. A `STOP` file in the repo root makes the runner finish the current shift cleanly, release the claim and exit with code 3. The runner prints a summary at the end, and per-shift NDJSON logs sit under `logs/<feature>/<NN>/` (spec: stories 40, 48, 49, 53).

**Blocked by:** 02

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js status`

- [ ] `status` works with no tickets, no config and no state file
- [ ] A STOP file created mid-run stops after the current shift with exit code 3 and no leftover claim
- [ ] The summary lists resolved and needs-info tickets with a reason each
