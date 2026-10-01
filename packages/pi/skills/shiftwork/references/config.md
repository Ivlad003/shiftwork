# Configuring and running Shiftwork

`.pi/shiftwork.json` sits at the repo root (merged over `<pi agent dir>/shiftwork.json`). `npx shiftwork init --model <provider>/<model-id>` writes it; `--ollama` also writes an `ollama` provider into pi's `models.json` and a `local` tier.

## Keys

- `model`, `defaultTier`, `routing.<type>` (`{ tier, model, thinking }`): routing order is the ticket's `**Model:**` → `routing[Type]` → the tier chain's first model → `defaultTier` → `model`.
- `tiers.<name>`: `chain` — fallback order of `"provider/model"` entries — plus `thinking`, `skills`/`preload` (skill groups) and a per-tier `budget`.
- `budgets` — `default`, `tiers.<name>`, `models.<provider/model>` and `ticket` (written by a `**Budget:**` line): token, cost, turn and context limits. Past a limit, Shiftwork hands the shift to another model.
- `unlimited` — `true` or a list of limit names (`tokens`, `cost`, `turns`, `time`, `context`, `stall`), lifts every limit or only those. Also accepted on `tiers.<name>`, `models.<provider/model>` and `backends.<name>` (backend names: `pi`, `claude`, `codex`, `opencode`, `grok`, `cursor`): a shift on that tier, model or backend runs with the union of the top-level, tier, model and backend lists lifted — every limit for that route, the ticket's own `Budget:` line included. Budgets stay global; the per-route lists are how chosen agents and models run without limits.
- `maxAttempts`, `maxHandoffs`, `softLimitPct`, `crossTier`, `allowInPlace`: how hard the runner tries before giving up on a ticket and whether handoffs stay in-process.
- `landRetries` (default 5): while a parallel landing keeps moving the target, the runner rebases onto it, re-runs Verify and lands again, this many rounds; past it the ticket goes to `needs-info` with the branch kept.
- `cooldown`: `rate`/`usage`/`quota`/`server` durations. All workers share one provider's cooldown; a missing CLI or a stopped Ollama server makes a backend unavailable instead.
- `skillGroups` / `skillSources`: named groups of skill paths. A tier's `skills` narrows the skills advertised to its models; `preload` forces some of them into context.
- `jev`: `{ enabled, model }` — the ticket classifier for tickets without `**Type:**`.
- `review`: `{ enabled, tier, budget?, features?, types? }` or `false` — on by default. One review shift runs in a fresh context after every ticket lands, on the strongest configured tier (`premium` → `standard` → `quick`, else the first tier in `tiers`); the reviewer works locally (no network services or live APIs — no `gh api`, `curl` or package installs) and ends with `<shiftwork:review verdict="accept|reopen|follow-up" reason="…"/>`. A review without a valid verdict is retried once on the next model of the review tier's chain; a second miss records `Verdict: none` and puts the ticket in `needs-info` — no silent accept. A review stopped by the runner stopping (a STOP file or a signal) is not a missing verdict: no retry, no `needs-info` — the ticket stays as it is with `- Review: not finished (stopped)`, and the next run reviews it again. `budget` is the review shift's whole budget (default `{ maxWallMin: 20, maxTurns: 60 }`): ticket, tier and model budgets never cap it and no `unlimited` list lifts it — only `review.budget` itself does. `features`/`types` narrow the reviews; `"review": false` (or `{ "enabled": false }`) turns them off, and `shiftwork run --no-review` for one run. With no tiers reviews stay off (no tier to review on).
- `worktree`: `{ enabled, setup }` — `setup` is shell commands (for example `["npm ci --ignore-scripts"]`) whose files are never committed.
- `tracker`: `"scratch"` (default) or `"openspec"`.
- `github`: dark-factory mode's source repo — `{ repo, authors, labels, pollMin, autoClose, push, planTier, gh }`. `repo` is `owner/name` (defaults to the `origin` remote), `authors` adds logins whose issues are imported on top of repo collaborators, `labels: { in (required), working, needsInfo, done }` — `in` is the label a collaborator puts on an issue to hand it to Shiftwork (missing → config error); the others default to `shiftwork:working` / `shiftwork:needs-info` / `shiftwork:done` and Shiftwork sets them itself; `pollMin` (minutes between polls, default 5), `autoClose` (close the issue when every ticket of it is resolved, default true), `push` (`git push` main after a landing so commit links resolve, default false), `planTier` (the tier the planning ticket runs on), `gh` (path to the GitHub CLI binary; `gh` from PATH when omitted — Shiftwork uses the operator's installed `gh` and its login, no token). A missing repo label is an error, never silently created: `shiftwork github labels` checks (exit 1 when missing) and `--create` creates the missing ones (see docs/guide.md "Dark-factory: labels").
- Local models (`ollama/…`) are never paid, and a stopped Ollama server (`OLLAMA_HOST`, default `http://localhost:11434`) makes them unavailable, not cooling.

## Commands

| Command | What |
| --- | --- |
| `npx shiftwork init [--model <provider>/<id>] [--ollama]` | write `.pi/shiftwork.json` and pi settings |
| `npx shiftwork status` | the tickets and the ready frontier; `⏸ paused` after a paused feature's name |
| `npx shiftwork feature pause <feature>` / `resume <feature>` | freeze a feature (`**Status:** paused` in its spec — its tickets leave the frontier; `run --ticket`/`--feature` on it are refused) / thaw it back to `ready-for-agent` |
| `npx shiftwork run --dry-run` | which model, tier and thinking each ticket gets, and whether it gets a review |
| `npx shiftwork run --once` | work one ticket |
| `npx shiftwork run` | work the frontier until nothing is left |
| `npx shiftwork run --dark-factory` | poll the repo's GitHub issues (`github` block), report back and work the frontier; `--once` is one poll + one pass |
| `npx shiftwork tickets check <feature> [--min <n>] [--except NN]` | planning gate: at least n tickets besides the excepted ones (default `01`) are ready with checkboxes and a Verify line, and every Blocked-by number exists |
| `npx shiftwork github labels [--create]` | check the dark-factory labels exist in the GitHub repo (`✔ exists` / `✖ missing`, exit 1 when any is missing); `--create` creates the missing ones with a colour and a description, never edits or deletes one |
| `npx shiftwork tui` | live dashboard: r run · s stop · d dry-run · f filter · q quit |

In pi: `/shift` (frontier), `/shift run`, `/shift stop`.

Exit codes: `0` all resolved or nothing to do · `2` some tickets need info or a review reopened one · `1` error. Shift events land in `logs/<feature>/<NN>/`.
