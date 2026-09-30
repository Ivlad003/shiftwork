# Configuring and running Shiftwork

`.pi/shiftwork.json` sits at the repo root (merged over `<pi agent dir>/shiftwork.json`). `npx shiftwork init --model <provider>/<model-id>` writes it; `--ollama` also writes an `ollama` provider into pi's `models.json` and a `local` tier.

## Keys

- `model`, `defaultTier`, `routing.<type>` (`{ tier, model, thinking }`): routing order is the ticket's `**Model:**` → `routing[Type]` → the tier chain's first model → `defaultTier` → `model`.
- `tiers.<name>`: `chain` — fallback order of `"provider/model"` entries — plus `thinking`, `skills`/`preload` (skill groups) and a per-tier `budget`.
- `budgets` — `default`, `tiers.<name>`, `models.<provider/model>` and `ticket` (written by a `**Budget:**` line): token, cost, turn and context limits. Past a limit, Shiftwork hands the shift to another model.
- `maxAttempts`, `maxHandoffs`, `softLimitPct`, `crossTier`, `allowInPlace`: how hard the runner tries before giving up on a ticket and whether handoffs stay in-process.
- `cooldown`: `rate`/`usage`/`quota`/`server` durations. All workers share one provider's cooldown; a missing CLI or a stopped Ollama server makes a backend unavailable instead.
- `skillGroups` / `skillSources`: named groups of skill paths. A tier's `skills` narrows the skills advertised to its models; `preload` forces some of them into context.
- `jev`: `{ enabled, model }` — the ticket classifier for tickets without `**Type:**`.
- `review`: `{ enabled, tier, features?, types? }` — off by default. Enabled, one review shift runs in a fresh context on `tier` after every ticket lands; the reviewer ends with `<shiftwork:review verdict="accept|reopen|follow-up" reason="…"/>`.
- `worktree`: `{ enabled, setup }` — `setup` is shell commands (for example `["npm ci --ignore-scripts"]`) whose files are never committed.
- `tracker`: `"scratch"` (default) or `"openspec"`.
- Local models (`ollama/…`) are never paid, and a stopped Ollama server (`OLLAMA_HOST`, default `http://localhost:11434`) makes them unavailable, not cooling.

## Commands

| Command | What |
| --- | --- |
| `npx shiftwork init [--model <provider>/<id>] [--ollama]` | write `.pi/shiftwork.json` and pi settings |
| `npx shiftwork status` | the tickets and the ready frontier |
| `npx shiftwork run --dry-run` | which model, tier and thinking each ticket gets, and whether it gets a review |
| `npx shiftwork run --once` | work one ticket |
| `npx shiftwork run` | work the frontier until nothing is left |
| `npx shiftwork tui` | live dashboard: r run · s stop · d dry-run · f filter · q quit |

In pi: `/shift` (frontier), `/shift run`, `/shift stop`.

Exit codes: `0` all resolved or nothing to do · `2` some tickets need info or a review reopened one · `1` error. Shift events land in `logs/<feature>/<NN>/`.
