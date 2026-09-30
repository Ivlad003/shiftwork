# Shiftwork guide

A plain-language walk through setting Shiftwork up and running it. Words in **bold** are defined in [CONTEXT.md](../CONTEXT.md).

## How it works, in one paragraph

You write **tickets**: small Markdown files with a task and a `Verify` command. `shiftwork run` takes the next ready ticket, starts a coding agent in a fresh context (a **shift**), and when the agent stops it runs the `Verify` command. Verify passes → the work is committed and merged. Verify fails → another attempt, maybe on another model. Every shift has a **budget** (turns, tokens, money, time). When a budget runs out or a provider says "rate limit", the ticket is handed to the next model.

## 1. Install and initialise

```bash
npm i -g @earendil-works/pi-coding-agent   # pi, the default agent
pi                                          # then /login to at least one provider
npx shiftwork init --model anthropic/claude-sonnet-4-5
```

`init` creates:

| File | What it is |
|---|---|
| `.pi/shiftwork.json` | Your config: models, tiers, routing, budgets. Everything below goes here. |
| `.pi/shiftwork-worker.md` | The instructions every agent gets. Edit it to add house rules. |
| `.pi/settings.json` | pi compaction settings. |

A second config at `~/.pi/agent/shiftwork.json` (or `$PI_CODING_AGENT_DIR/shiftwork.json`) applies to every repo; the project file wins field by field.

Check what would happen without spending anything:

```bash
npx shiftwork run --dry-run
```

## 2. Models, tiers and routing

### Naming a model

| You write | Runs through |
|---|---|
| `anthropic/claude-sonnet-4-5`, `openrouter/qwen/qwen3.8-27b:free`, `ollama/qwen2.5-coder:7b` | pi, with that provider (`pi --list-models` shows them all) |
| `claude:sonnet` | Claude Code CLI |
| `codex:gpt-5.6-terra` | Codex CLI |
| `opencode:opencode-go/kimi-k3` | OpenCode CLI |
| `grok:grok-4.7` | Grok CLI |
| `cursor:auto` | Cursor agent CLI |

A CLI backend must be installed and logged in on its own. If it isn't, Shiftwork skips it with a warning and moves to the next model; it does not count as a failed attempt.

### Tiers: lists of models to try

A **tier** is an ordered list (`chain`) of models. Shiftwork uses the first one that isn't cooling down.

```json
"tiers": {
  "quick":    { "chain": ["opencode-go/space-bunny-free", "openrouter/qwen/qwen3.8-27b:free"], "thinking": "low" },
  "standard": { "chain": ["opencode-go/glm-5.3", "claude:sonnet", "xai/grok-4.6"] },
  "premium":  { "chain": ["xai/grok-4.7", "openrouter/anthropic/claude-opus-5"], "thinking": "high" }
}
```

You can mix providers and backends in one chain. That's how you "connect agents from different providers": put them in the same tier, in the order you prefer.

### Routing: which tier gets which kind of task

Each ticket has a **Type** (`code`, `test`, `docs`, `git`, `refactor`, or any word you invent). `routing` maps a type to a tier or to one model:

```json
"defaultType": "code",
"routing": {
  "git":      { "tier": "quick", "thinking": "low" },
  "docs":     { "tier": "quick" },
  "code":     { "tier": "standard" },
  "refactor": { "tier": "premium" },
  "infra":    { "model": "claude:opus" }
}
```

To add a new kind of task, invent a type name, add it to `routing`, and write `**Type:** infra` in the ticket.

How Shiftwork picks a model for a ticket, first match wins:

1. The ticket's own `**Model:** provider/model` line.
2. `routing[<ticket Type>]`: a model, or the first free model of that tier.
3. `defaultTier`, then the top-level `model`.

A ticket without a `Type` gets `defaultType`, unless Jev (a small classifier model, `jev` in the config) guesses its type. Turn that off with `"jev": { "enabled": false }`.

### Other routing knobs

| Field | Meaning |
|---|---|
| `thinking` | Reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Set globally, per tier, per route, or per model. |
| `crossTier` | `"up"`: when a whole tier is cooling, borrow from the next tier up (`"down"` or `"none"` also work). |
| `paidProviders` | Providers that cost money, e.g. `["openrouter"]`. `…:free` and `ollama/…` models never count as paid. |
| `preferWaitMin` | If a free model will be back within this many minutes, wait for it instead of using a paid one. |
| `cooldown` | How long a provider rests after a limit when it gives no reset time: `{ "rate": "15m", "usage": "5h", "quota": "24h", "server": "5m" }`. |
| `maxAttempts` | Failed Verify runs before a ticket becomes `needs-info` (default 3). |

## 3. Local models (Ollama)

1. Install [Ollama](https://ollama.com), start it (`ollama serve` or the desktop app) and pull a model: `ollama pull qwen2.5-coder:7b`.
2. Run `npx shiftwork init --ollama`. It finds your models (on `OLLAMA_HOST`, default `http://localhost:11434`), adds an `ollama` provider to `~/.pi/agent/models.json` (your other providers stay) and adds a `local` tier to `.pi/shiftwork.json`.
3. Send some tasks to it: `"routing": { "docs": { "tier": "local" } }`. Or add `ollama/…` models to an existing tier's chain.

Re-run `init --ollama` after pulling new models. If Ollama isn't running, `init` tells you how to start it and changes nothing.

Good to know:
- Local models are free, so money budgets don't apply to them.
- If Ollama stops mid-run, the ticket moves to the next model, and the `ollama` provider rests for the `usage` cooldown (5 h by default). After restarting Ollama, delete its entry from `.pi/shiftwork-state.json` to use it right away.
- `onExceed` `escalate` and `downgrade` only know `quick < standard < premium`. From the `local` tier, use `next` or `same-tier` instead.

## 4. Writing tickets

A ticket is `.scratch/<feature>/issues/NN-short-name.md`:

```markdown
# 03: Email validation in signup

**What to build:** reject invalid emails in POST /signup with a 400 and a message.

**Blocked by:** 01, 02
**Status:** ready-for-agent
**Type:** code
**Model:** claude:sonnet
**Skills:** +design -git
**Budget:** $2 · 50 turns · 30 min
**Verify:** `npm test -- signup` · `npm run lint`

- [ ] Invalid email → 400
- [ ] Valid email still signs up
```

| Line | Required | Meaning |
|---|---|---|
| `Status` | yes | `ready-for-agent` to be picked up. Shiftwork sets `claimed`, `resolved` or `needs-info`. |
| `Blocked by` | no | Ticket numbers in the same feature that must be `resolved` first. |
| `Verify` | strongly advised | Shell commands, separated by `·`. **Only these decide success.** Make sure they fail before the work is done. |
| `Type` | no | Picks the route (section 2). |
| `Model` | no | Forces one model, skipping routing. |
| `Skills` | no | Adds (`+group`) or removes (`-group`) skill groups for this ticket. |
| `Budget` | no | Limits for this ticket (section 5). |

After each shift, Shiftwork appends a report to the ticket's `## Comments`: the model, usage, Verify result and outcome. Agents leave `### Handoff` notes there for the next shift.

You can write tickets by hand, or have an agent write them with the mattpocock skills `/to-spec` and `/to-tickets`. OpenSpec changes (`openspec/changes/`) work too; see the [core README](../packages/core/README.md#openspec-tracker).

### Skills per tier

Skills are folders with a `SKILL.md`. Name where they live (full or repo-relative paths; `~` is not expanded), group them, then give groups to tiers. Weak models can get more skills, and `preload` ones are pasted into their starting context:

```json
"skillSources": { "tdd": "/home/me/.agents/skills/tdd", "design": "./skills/design" },
"skillGroups":  { "core": ["tdd"], "design": ["design"] },
"tiers": { "quick": { "chain": ["…"], "skills": ["core", "design"], "preload": ["core"] } }
```

## 5. Limits: time, tokens, money

Yes, all of these exist. There are two levels:

- **Shift budget**: limits one agent session. When it runs out, the ticket is handed to another model (same ticket, fresh context, with the handoff note).
- **Ticket budget**: a total across all shifts of the ticket. When it runs out, the ticket stops as `needs-info`.

| Field | Limits | In a `Budget:` line |
|---|---|---|
| `maxTurns` | agent turns | `50 turns` |
| `maxTokens` | tokens | `200k tokens` |
| `maxCostUsd` | dollars | `$2` |
| `maxWallMin` | wall-clock minutes | `30 min`, `1h 30min` |
| `maxContextPct` | how full the context window may get | `60% context` |
| `stallTurns` | turns in a row where neither the diff nor the failing test output changed | `5 stall` |

Shorthands work: `200k tokens`, `1.5M tokens`, `1h`, `1h 30min`, `1h30m`, `1.5h`, and Ukrainian units (`30 хв`, `1 год`, `10 ходів`). A part Shiftwork doesn't understand is ignored, so check with `shiftwork run --dry-run`, which prints each ticket's budget.

Where to set them in `.pi/shiftwork.json`:

```json
"budgets": {
  "default": { "maxTurns": 150, "maxWallMin": 60, "maxContextPct": 80 },
  "tiers":   { "premium": { "maxCostUsd": 3 } },
  "models":  { "openrouter/anthropic/claude-opus-5": { "maxCostUsd": 3 } },
  "ticket":  { "maxTurns": 400, "maxWallMin": 180 }
}
```

- A shift budget is built from `default`, then the tier's, then the model's. Later ones override earlier ones.
- `budgets.ticket` is the default ticket total. A ticket's own `Budget:` line overrides it, and no shift may use more than the ticket has left.

What happens near and at a limit:

- At `softLimitPct` (default 80 %) of any shift limit, the agent is told to finish its step and write a handoff note.
- At 100 %, the shift ends, and `onExceed` decides where the ticket goes next:

```json
"onExceed": {
  "maxTurns":      { "to": "next",      "mode": "new-process" },
  "maxWallMin":    { "to": "next",      "mode": "new-process" },
  "maxContextPct": { "to": "same-tier", "mode": "new-process" },
  "verifyFailed":  { "to": "escalate" }
}
```

`to`: `next` (next model in the chain), `same-tier` (another model of the tier), `escalate` / `downgrade` (a tier up or down). `maxHandoffs` (default 3) caps handoffs per ticket.

## 6. Other agents' settings

Each CLI backend has an optional block with `command`, `args`, `env` and `timeoutMs`:

```json
"claude": { "args": ["--max-turns", "200"], "timeoutMs": 3600000 },
"codex":  { "sandbox": "bypass" },
"cursor": { "command": "cursor-agent" }
```

`codex.sandbox`: `"approve-for-me"` (default), `"workspace-write"`, or `"bypass"` when the environment is already isolated, or when bwrap can't create a sandbox.

## 7. Running and watching

```bash
npx shiftwork status                   # every ticket; → marks the ready ones
npx shiftwork run --once               # one ticket
npx shiftwork run --feature signup     # only this feature, until nothing is ready
npx shiftwork tui                      # live dashboard
```

Every ticket runs in its own git worktree under `~/.cache/shiftwork/worktrees/`. Install dependencies there with `"worktree": { "setup": ["npm ci --ignore-scripts"] }`. To stop gracefully, create a file named `STOP` in the repo root (or press `s` in the TUI): the running shift writes a handoff and the runner exits. Shift logs are in `logs/<feature>/<NN>/`.

### What the TUI does

| It shows | Keys |
|---|---|
| The running ticket, its model, tier, usage and budget; the ready tickets per feature; active cooldowns; the log tail | `r` start a run · `s` stop with handoff · `d` dry run (route and budget of each ready ticket) · `f` filter by feature · `q` quit |

The TUI only watches and starts or stops runs. Models, tiers, routing and budgets are edited in `.pi/shiftwork.json`; the next ticket picks up the changes.

### Reviews after each ticket

Turn on a **review shift**: after a ticket lands, a fresh agent on the tier you choose reads the ticket, the spec and the diff, runs Verify, and gives a verdict.

```json
"review": { "enabled": true, "tier": "premium", "features": ["signup"], "types": ["code", "refactor"] }
```

`features` and `types` are optional filters. The verdict is written to the ticket as `### Review`: **accept** (done), **reopen** (back to `ready-for-agent`; the next `run` fixes forward on top of the landed commit), or **follow-up** (a new ticket is filed in the feature, with the same Verify). Reviews are off by default. `--dry-run` shows which tickets would be reviewed.

## 8. Not there yet

- Several tickets at once: planned in [`.scratch/parallel/`](../.scratch/parallel/spec.md).
- `llms.txt` and an installable skill: in progress in [`.scratch/local-and-skills/`](../.scratch/local-and-skills/spec.md).
- Editing config from the TUI.
