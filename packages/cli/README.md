# shiftwork

CLI for [Shiftwork](https://github.com/Ivlad003/shiftwork) · [npm](https://www.npmjs.com/package/shiftwork) · [guide](https://github.com/Ivlad003/shiftwork/blob/main/docs/guide.md). Autonomous agents work in shifts: a fresh context per ticket, with model handoff on budgets and provider limits.

**Requirements:** Node ≥ 22 and [pi](https://pi.dev), installed with `npm i -g @earendil-works/pi-coding-agent`, with at least one provider logged in (`/login` in pi).

```bash
npx shiftwork init --model anthropic/<model-id>   # .pi/shiftwork.json, worker prompt, pi compaction settings
npx shiftwork status                              # tickets and the ready frontier
npx shiftwork tui                                 # live dashboard: runner, budgets, cooldowns, logs — r run · s stop · d dry-run · f filter · q quit
npx shiftwork run --dry-run                       # which model/tier/thinking each ticket would get, and whether it gets a review
npx shiftwork run --once                          # work one ticket
npx shiftwork run                                 # work the frontier until nothing is left
```

Local models through [Ollama](https://ollama.com): `npx shiftwork init --ollama` discovers them (`OLLAMA_HOST`, default `http://localhost:11434`), adds an `ollama` provider to `~/.pi/agent/models.json` and a `local` tier to `.pi/shiftwork.json`. Route ticket types to it with `routing.<type>.tier: "local"`. Local models are never paid, and a stopped Ollama server makes the backend unavailable instead of cooling.

Tickets live in `.scratch/<feature>/issues/NN-slug.md`, in the [mattpocock-skills](https://github.com/mattpocock/skills) format, and are resolved only by their `**Verify:**` commands. Every shift is a fresh `pi --mode rpc --no-session` process. Its report goes to the ticket's `## Comments`, and its events go to `logs/<feature>/<NN>/`.

In a git repo, every ticket runs in its own worktree on branch `shiftwork/<feature>-<NN>`, outside the repo under `~/.cache/shiftwork/worktrees/`. A resolved ticket is committed and merged into the branch you started from; a ticket that needs info keeps its branch. Dependencies aren't copied into worktrees: set `worktree.setup`, for example `["npm ci --ignore-scripts"]`. Files the setup creates are never committed. Use `--no-worktree` to work in the main checkout.

Routing: the ticket's `**Model:**`, then `routing[Type]` → tier → first model of the tier's chain, then `defaultTier`. See `.pi/shiftwork.json` after `init`.

Optional review shifts, off by default: `review: { "enabled": true, "tier": "premium" }` in `.pi/shiftwork.json` runs one review shift on that tier in a fresh context after every ticket lands. The reviewer reads the ticket, the spec and the landed diff, runs the verify gate, and ends with `<shiftwork:review verdict="accept|reopen|follow-up" reason="…"/>`. The verdict is recorded as `### Review` in the ticket's Comments: `accept` ends it, `reopen` sends the ticket back to ready-for-agent with the reason (the landed commit stays), `follow-up` files a new ticket in the feature. Restrict reviews with `features` (feature names) and `types` (ticket types); `run --dry-run` prints `review=<tier>` for tickets that will be reviewed and `review=no` for the rest.

Exit codes: `0` all resolved or nothing to do · `2` some tickets need info or a review reopened one · `1` error.

Status: early development. Worktrees, budgets with handoff, provider fallback, skill tiers and Jev are on the way.
