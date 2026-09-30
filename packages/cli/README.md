# shiftwork

CLI for [Shiftwork](https://github.com/Ivlad003/shiftwork). Autonomous agents work in shifts: a fresh context per ticket, with model handoff on budgets and provider limits.

**Requirements:** Node ≥ 22 and [pi](https://pi.dev), installed with `npm i -g @earendil-works/pi-coding-agent`, with at least one provider logged in (`/login` in pi).

```bash
npx shiftwork init --model anthropic/<model-id>   # .pi/shiftwork.json, worker prompt, pi compaction settings
npx shiftwork status                              # tickets and the ready frontier
npx shiftwork run --dry-run                       # which model/tier/thinking each ticket would get
npx shiftwork run --once                          # work one ticket
npx shiftwork run                                 # work the frontier until nothing is left
```

Tickets live in `.scratch/<feature>/issues/NN-slug.md`, in the [mattpocock-skills](https://github.com/mattpocock/skills) format, and are resolved only by their `**Verify:**` commands. Every shift is a fresh `pi --mode rpc --no-session` process. Its report goes to the ticket's `## Comments`, and its events go to `logs/<feature>/<NN>/`.

Routing: the ticket's `**Model:**`, then `routing[Type]` → tier → first model of the tier's chain, then `defaultTier`. See `.pi/shiftwork.json` after `init`.

Exit codes: `0` all resolved or nothing to do · `2` some tickets need info · `1` error.

Status: early development. Worktrees, budgets with handoff, provider fallback, skill tiers and Jev are on the way.
