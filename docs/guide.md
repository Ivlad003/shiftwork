# Shiftwork guide

A plain-language walk through setting Shiftwork up and running it. Words in **bold** are defined in [CONTEXT.md](../CONTEXT.md). [Українська версія](guide.uk.md).

## How it works, in one paragraph

You write **tickets**: small Markdown files with a task and a `Verify` command. `shiftwork run` takes the next ready ticket, starts a coding agent in a fresh context (a **shift**), and when the agent stops it runs the `Verify` command. Verify passes → the work is committed and merged. Verify fails → another attempt, maybe on another model. Every shift has a **budget** (turns, tokens, money, time). When a budget runs out or a provider says "rate limit", the ticket is handed to the next model.

## 1. Install and initialise

```bash
npm i -g @earendil-works/pi-coding-agent   # pi, the default agent
pi                                          # then /login to at least one provider
npx shiftwork init --model anthropic/claude-sonnet-4-5
```

`npx shiftwork` always works without installing anything ([npm package](https://www.npmjs.com/package/shiftwork)). npx caches what it downloaded, so write `npx shiftwork@latest …` to be sure you get the newest version, or install it once with `npm i -g shiftwork` and then just run `shiftwork …`.

Shiftwork finds pi by itself: the npm package, the `pi` on PATH, and an install made by the official installer (`~/.pi/agent/install/releases/<version>`, where the `pi` on PATH is only a shell launcher). If pi lives elsewhere, point at its package folder: `"pi": { "root": "/path/to/node_modules/@earendil-works/pi-coding-agent" }`.

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
| `thinking` | Reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Set globally, per tier, per route, or per model. pi and `grok:` models use it (see below). |
| `crossTier` | `"up"`: when a whole tier is cooling, borrow from the next tier up (`"down"` or `"none"` also work). |
| `paidProviders` | Providers that cost money, e.g. `["openrouter"]`. `…:free` and `ollama/…` models never count as paid. |
| `preferWaitMin` | If a free model will be back within this many minutes, wait for it instead of using a paid one. |
| `cooldown` | How long a provider rests after a limit when it gives no reset time: `{ "rate": "15m", "usage": "5h", "quota": "24h", "server": "5m" }`. |
| `maxAttempts` | Failed Verify runs before a ticket becomes `needs-info` (default 3). |
| `verifyTimeoutMin` | Minutes one Verify command may run before it is killed, with everything it started, and the gate fails (default 10). E.g. `"verifyTimeoutMin": 20` for slow test suites. |
| `parallel` | How many frontier tickets the runner works at once (default 1). Above 1 needs `"worktree": { "enabled": true }`: every parallel ticket gets its own worktree. |
| `concurrency` | Caps the shifts running at once per provider, e.g. `{ "ollama": 1 }` for a single GPU. A full provider is skipped like a cooling one. The keys are the cooldown keys: `ollama`, `claude`, `opencode:opencode-go`. |

### Model profiles

The `models` section sets options for one model, whichever tier it sits in. The key is the model name exactly as written in a `chain` or a `Model:` line, backend prefix included.

```json
"models": {
  "ollama/qwen2.5-coder:7b": { "contextWindow": 32768 },
  "xai/grok-4.6":            { "thinking": "high" },
  "claude:opus":             { "budget": { "maxCostUsd": 4, "maxTurns": 120 } }
}
```

| Field | Meaning |
|---|---|
| `thinking` | Overrides the tier's `thinking`. Order: `routing[type].thinking` → `models[model].thinking` → `tiers[tier].thinking` → global `thinking`. |
| `contextWindow` | Context window in tokens. `maxContextPct` is measured against it instead of the window the backend reports. Useful for a local model served with a smaller window. |
| `budget` | Shift budget for this model (fields from section 5). Applied last. |

**`thinking` works for pi and `grok:`.** Models without a prefix (`provider/model`) get the level as is. For `grok:` it becomes `--reasoning-effort`, fitted to the levels the model offers (in `~/.grok/models_cache.json`): `off`/`minimal` → the lowest, `max` → the highest; an unknown model keeps its default. The `claude:`, `codex:`, `opencode:` and `cursor:` backends ignore it, even though `--dry-run` and the TUI show `thinking=…` for them too. Set a CLI agent's reasoning level its own way: in its config or with flags in `args` (section 6).

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
| `maxTokens` | tokens: every token of every turn, cached context included, so 3M ≈ 20 turns at a 140k context | `200k tokens` |
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

- A shift budget is built from `budgets.default`, then the tier's budget, then `budgets.models[model]`, then `models[model].budget` (section 2). Later ones override earlier ones.
- A tier's budget can go in `budgets.tiers.<tier>` or straight in the tier as `"budget"` (what `init` writes). If both are set, the one in the tier wins.
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

### No limits

To let agents run until they stop on their own, lift the limits for one run:

```bash
npx shiftwork run --no-budget              # every limit: turns, tokens, cost, time, context, stall
npx shiftwork run --no-limit tokens,time   # only these: tokens, cost, turns, time, context, stall
```

Both shift and ticket limits are lifted, tickets' `Budget:` lines included. The same in `.pi/shiftwork.json`: `"unlimited": true` or `"unlimited": ["tokens", "time"]`; `--no-limit` adds to the config's list. `--dry-run` shows what is left (`budget=-` when nothing is), and the runner says at start which limits are lifted. Without `cost`, paid models spend whatever they spend; without `stall`, a stuck agent keeps going; without `context`, the agent itself handles a full window.

Per tier and per model, `unlimited` takes the same values and lifts **shift limits only**:

```json
"tiers":  { "local": { "chain": ["ollama/qwen3"], "unlimited": ["turns", "time"] } },
"models": { "ollama/qwen3": { "unlimited": true } }
```

A shift on that tier or model runs with the union of the top-level, tier and model lists lifted. The ticket's own budget still caps it — a `**Budget:**` line is a per-ticket decision only the top-level `unlimited` lifts — and only that tier or model is affected, so a free tier can run without turn/time limits while paid models stay capped.

## 6. Other agents' settings

Every backend, pi included, has an optional top-level block named like its prefix: `pi`, `claude`, `codex`, `opencode`, `grok`, `cursor`.

| Field | Meaning |
|---|---|
| `command` | The program to run (not for `pi`). Defaults: `claude`, `codex`, `opencode`, `grok`, `cursor-agent`. A full path works. |
| `args` | Extra flags, placed after Shiftwork's own flags and before the prompt. |
| `env` | Extra environment variables for the agent process, on top of yours. |
| `timeoutMs` | A safety timeout for the process. Normal limits are budgets (section 5). |
| `sandbox` | `codex` only, see below. |
| `root` | `pi` only: pi's package folder, when Shiftwork can't find it by itself (section 1). |

```json
"pi":     { "env": { "PI_CODING_AGENT_DIR": "/home/me/.pi/agent-work" } },
"claude": { "args": ["--max-turns", "200"], "timeoutMs": 3600000 },
"codex":  { "sandbox": "bypass" },
"grok":   { "command": "/home/me/.grok/bin/grok" },
"cursor": { "command": "cursor-agent" }
```

`codex.sandbox`: `"approve-for-me"` (default), `"workspace-write"`, or `"bypass"` when the environment is already isolated, or when bwrap can't create a sandbox.

Shiftwork passes `args` through unchecked. See the CLI's own `--help` for what it accepts. `--dry-run` doesn't start agents, so try new `args` with one `shiftwork run --once`.

Never set `command: "agent"` for Grok or Cursor. Both installers link an `agent`, and which one runs depends on PATH order.

### Project instructions: AGENTS.md and CLAUDE.md

Agents read your repo's instruction files themselves. Checked live on 2026-09-30:

| Backend | Reads `AGENTS.md` | Reads `CLAUDE.md` |
|---|---|---|
| pi (`provider/model`) | yes | only when there's no `AGENTS.md` in the same folder |
| Claude Code (`claude:`) | no | yes |
| Codex (`codex:`) | yes | no |
| OpenCode (`opencode:`) | yes | only when there's no `AGENTS.md` |
| Cursor (`cursor:`) | yes | yes |
| Grok CLI (`grok:`) | no, so Shiftwork adds it to grok's system prompt (`--rules`) | same: `CLAUDE.md` when there's no `AGENTS.md` |

So keep the rules in `AGENTS.md` and make `CLAUDE.md` a single line, `@AGENTS.md`: every agent then sees the same rules. `xai/…` models run through pi and do get them.

Two things to keep in mind:
- Agents work in a git worktree, which only has **committed** files. An uncommitted or gitignored `AGENTS.md` (or `CLAUDE.local.md`) isn't there.
- The worktree is under `~/.cache/shiftwork/worktrees/`, so instruction files in the **parent folders** of your repo aren't picked up. Global ones (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`) work as usual.

On top of these, every agent gets Shiftwork's own `.pi/shiftwork-worker.md`.

## 7. Running and watching

```bash
npx shiftwork status                   # every ticket; → marks the ready ones
npx shiftwork run --once               # one ticket
npx shiftwork run --feature signup     # only this feature, until nothing is ready
npx shiftwork run --parallel 3         # up to three tickets at once
npx shiftwork tui                      # live dashboard
npx shiftwork tickets check signup     # planning gate: are this feature's tickets workable?
```

`shiftwork tickets check <feature> [--min N] [--except NN]` is the Verify gate for a planning ticket: it exits 0 when at least `N` (default 1) tickets besides the excepted ones (default `01`, the plan itself) are `ready-for-agent` or later, each with an acceptance checkbox and a `Verify` line, and every `Blocked by:` number exists in the feature. Otherwise it exits 1 with one line per problem (`signup/03: no Verify line`).

Every ticket runs in its own git worktree under `~/.cache/shiftwork/worktrees/`. Install dependencies there with `"worktree": { "setup": ["npm ci --ignore-scripts"] }`. With `parallel` above 1 (or `run --parallel N`) the runner works several frontier tickets at once, one worktree each; `concurrency` keeps a provider from being oversubscribed. A ticket whose landing conflicts with one that landed first is rebased onto it and its Verify gate re-run; if the rebase conflicts too, the work is redone on top of it in a fresh worktree, with one more shift (`- Landing conflict with …; redone on top of …` in the ticket). To stop gracefully, create a file named `STOP` in the repo root (or press `s` in the TUI): the running shift writes a handoff and the runner exits. `Ctrl-C`, `kill` (SIGTERM) and a closed terminal (SIGHUP) do the same; a second signal, or 60 s without the runner finishing, stops the agents and Verify commands at once, so no agent process outlives the runner. Shift logs are in `logs/<feature>/<NN>/`.

### What the TUI does

Five full-screen tabs (`1`–`5`, or `tab` to cycle): **Queue**, **Agents**, **Cooldowns**, **Log**, **GitHub**. A header shows the tabs, the last notice and, while a dark-factory runner is live, `dark-factory`; a footer shows the keys of the current tab. The interactive view uses the terminal's alternate screen, fits its height and redraws on resize. It is in colour: the cursor row is highlighted across the full width, ticket statuses are coloured (resolved green, claimed cyan, needs-info yellow, blocked dim), the `● model` marker of a live worker is cyan, cooldown rows are red, the active tab label is bold and the notice is yellow. Set `NO_COLOR` to turn colour off; `tui --once` and the plain-text fallback stay colourless. Without pi-tui, a plain-text fallback prints a frame every second; the same keys work there where they make sense.

| Tab | It shows | Keys |
|---|---|---|
| Queue | Features as folders (`▾ parallel 3/4`) with their tickets (number, title, status, blockers, `● model` when an agent holds one) | `↑↓`/`j k` move · `←→` collapse/expand · `enter` details · `n` run this ticket · `esc` back |
| Agents | One row per running shift: ticket, model, tier, shift/attempt, tokens, cost, turns, context fill, budget, elapsed | `↑↓`/`j k` move · `enter` opens that agent's log |
| Cooldowns | Active provider cooldowns and time left | `↑↓`/`j k` move |
| Log | Tail of the selected agent's shift log (else the first live worker's) | `↑↓`/`j k` move |
| GitHub | The issues `run --dark-factory` imported (`.pi/shiftwork-github.json`): `#<N> <title> · <feature> · <state>`, where the state — planning, working, needs-info, done, closed — comes from the feature's tickets, plus the time of the last sync | `↑↓`/`j k` move · `enter` opens the issue's feature in the Queue tab |

Every tab also: `r` start a detached runner (a second `r` while one is live is refused) · `s` stop with handoff · `d` dry-run · `f` filter by feature · `g` toggle dark-factory (starts `shiftwork run --dark-factory` detached when no runner is live, writes STOP when one is) · `q` quit. `n` starts `shiftwork run --ticket <feature>/<NN>` detached, like `r`; it is refused when the cursor is not on a ready frontier ticket or a runner is already live.

The TUI only watches and starts or stops runs. Models, tiers, routing and budgets are edited in `.pi/shiftwork.json`; the next ticket picks up the changes.

### Reviews after each ticket

Turn on a **review shift**: after a ticket lands, a fresh agent on the tier you choose reads the ticket, the spec and the diff, runs Verify, and gives a verdict.

```json
"review": { "enabled": true, "tier": "premium", "features": ["signup"], "types": ["code", "refactor"] }
```

`features` and `types` are optional filters. The verdict is written to the ticket as `### Review`: **accept** (done), **reopen** (back to `ready-for-agent`; the next `run` fixes forward on top of the landed commit), or **follow-up** (a new ticket is filed in the feature, with the same Verify). Reviews are off by default. `--dry-run` shows which tickets would be reviewed.

## 8. A full config example

One `.pi/shiftwork.json` that uses most of this guide: five different agents, a local model, model profiles, parallel runs and reviews.

```json
{
  "defaultType": "code",
  "thinking": "medium",
  "maxAttempts": 3,
  "maxHandoffs": 3,
  "verifyTimeoutMin": 20,
  "softLimitPct": 80,
  "parallel": 2,
  "worktree": { "enabled": true, "setup": ["npm ci --ignore-scripts"] },

  "tiers": {
    "local":    { "chain": ["ollama/qwen2.5-coder:7b"], "thinking": "off" },
    "quick":    { "chain": ["opencode:opencode-go/kimi-k3", "openrouter/qwen/qwen3.8-27b:free", "cursor:auto"],
                  "thinking": "low", "skills": ["core", "design"], "preload": ["core"],
                  "budget": { "maxTurns": 40, "maxContextPct": 60, "stallTurns": 5 } },
    "standard": { "chain": ["claude:sonnet", "codex:gpt-5.6-terra", "xai/grok-4.6"],
                  "skills": ["core"],
                  "budget": { "maxCostUsd": 1.5, "maxTokens": 3000000 } },
    "premium":  { "chain": ["claude:opus", "grok:grok-4.7", "openrouter/anthropic/claude-opus-5"],
                  "thinking": "high",
                  "budget": { "maxCostUsd": 3, "maxContextPct": 70 } }
  },

  "routing": {
    "git":      { "tier": "quick", "thinking": "low" },
    "docs":     { "tier": "local" },
    "test":     { "tier": "standard" },
    "code":     { "tier": "standard" },
    "refactor": { "tier": "premium" },
    "infra":    { "model": "claude:opus" }
  },

  "models": {
    "ollama/qwen2.5-coder:7b":            { "contextWindow": 32768 },
    "xai/grok-4.6":                       { "thinking": "high" },
    "openrouter/anthropic/claude-opus-5": { "budget": { "maxCostUsd": 3 } },
    "claude:opus":                        { "budget": { "maxCostUsd": 4, "maxTurns": 120 } }
  },

  "budgets": {
    "default": { "maxTurns": 60, "maxWallMin": 45, "stallTurns": 8 },
    "ticket":  { "maxCostUsd": 8, "maxWallMin": 120 }
  },

  "onExceed": {
    "maxCostUsd":    { "to": "downgrade", "mode": "new-process" },
    "maxTokens":     { "to": "downgrade", "mode": "new-process" },
    "maxTurns":      { "to": "next",      "mode": "new-process" },
    "maxWallMin":    { "to": "next",      "mode": "new-process" },
    "maxContextPct": { "to": "same-tier", "mode": "new-process" },
    "stallTurns":    { "to": "escalate",  "mode": "new-process" },
    "verifyFailed":  { "to": "escalate",  "mode": "new-process" }
  },

  "crossTier": "up",
  "paidProviders": ["openrouter", "xai"],
  "preferWaitMin": 20,
  "cooldown": { "rate": "15m", "usage": "5h", "quota": "24h", "server": "5m" },
  "concurrency": { "ollama": 1, "claude": 1 },

  "skillSources": { "tdd": "/home/me/.agents/skills/tdd", "design": "./skills/design" },
  "skillGroups":  { "core": ["tdd"], "design": ["design"] },

  "review": { "enabled": true, "tier": "premium", "types": ["code", "refactor"] },
  "jev": { "enabled": true, "model": ["typesafe/jev-latest", "opencode/jev-1.13-free"] },

  "pi":       { "timeoutMs": 10800000 },
  "claude":   { "args": ["--max-turns", "200"], "timeoutMs": 3600000 },
  "codex":    { "sandbox": "workspace-write" },
  "opencode": { "timeoutMs": 3600000 },
  "grok":     { "command": "grok" },
  "cursor":   { "command": "cursor-agent" }
}
```

What it does:

- **Four tiers on different agents.** `local`: Ollama only. `quick`: OpenCode → a free OpenRouter model through pi → Cursor. `standard`: Claude Code → Codex → Grok through pi. `premium`: Claude Code with Opus → Grok Build → Opus through OpenRouter.
- **Routes.** Docs go to the local model, and `infra` always goes to `claude:opus`, whatever the tiers say.
- **Model profiles.** Ollama's context fill is measured against 32k. `xai/grok-4.6` reasons at `high` although tier `standard` says `medium`. `claude:opus` gets its own budget.
- **Tier `premium`'s `thinking` (`high`)** reaches `openrouter/anthropic/claude-opus-5` (pi) and `grok:grok-4.7` (as `--reasoning-effort high`); `claude:opus` doesn't get it (section 2).
- **Parallelism.** Two tickets at once, each in its own worktree, but at most one shift on Ollama (one GPU) and one on Claude Code (one subscription).
- **Money.** `openrouter` and `xai` are paid. If a free model is back within 20 minutes, Shiftwork waits for it. When a whole tier is cooling, it borrows from the tier above (`crossTier: "up"`).
- **Reviews** run on `premium`, for `code` and `refactor` tickets only.

Check it before a run:

```bash
npx shiftwork run --dry-run
```

```
f/04  type=code  tier=standard  model=claude:sonnet  thinking=medium  budget=$1.5 · 3000000 tok · 60 turns · 45 min · 8 stall  review=premium
f/04  type=docs  tier=local  model=ollama/qwen2.5-coder:7b  thinking=off  budget=$8 · 60 turns · 45 min · 8 stall  review=no
f/05  type=infra  tier=premium  model=claude:opus  thinking=high  budget=$4 · 120 turns · 45 min · 70% ctx · 8 stall  review=no
```

## Dark-factory: labels

Dark-factory mode takes work from GitHub **issues** instead of `.scratch/`: you hand an issue over with one label, Shiftwork plans and builds it, and reports back on the issue with comments and its own labels. Every label has one meaning:

| Label | Meaning | Who sets it |
|---|---|---|
| `shiftwork:in` | The issue is handed to Shiftwork: only issues with this label are taken | You, or any collaborator |
| `shiftwork:working` | A ticket of the issue is being worked on | Shiftwork |
| `shiftwork:needs-info` | Shiftwork asked a question in a comment and the issue waits for an answer | Shiftwork |
| `shiftwork:done` | Every ticket of the issue is resolved | Shiftwork |

Rename them in the `github` block of `.pi/shiftwork.json`. Only `in` is required — without it there is no way to hand an issue over; the others default to the names above:

```json
"github": {
  "repo": "owner/name",
  "labels": {
    "in": "shiftwork:in",
    "working": "shiftwork:working",
    "needsInfo": "shiftwork:needs-info",
    "done": "shiftwork:done"
  }
}
```

`repo` is `owner/name` (defaults to the `origin` remote). A missing label is an error, never silently created: dark-factory exits with the missing names and tells you to run the command below.

Shiftwork does all GitHub work with the GitHub CLI and its login — no token in the config, and Shiftwork never reads or stores one. Set it up once:

1. Install the GitHub CLI: <https://cli.github.com>. Shiftwork runs your installed `gh` (point at it with `"gh": "/path/to/gh"` in the `github` block when it is not on PATH).
2. Log in: `gh auth login`.
3. Check the login: `gh auth status`.
4. Add the `github` block (above) to `.pi/shiftwork.json`.
5. Create the labels: `npx shiftwork github labels --create`. It prints `✔ name exists` / `✖ name missing` for each configured label and creates the missing ones with a colour and a description; it never edits or deletes a label. Without `--create` it only checks, and exits 1 when a label is missing.
6. Hand work over: a collaborator puts the `in` label on an issue.

## Dark-factory mode

`npx shiftwork run --dark-factory` runs the whole loop unattended: every `github.pollMin` minutes (default 5) it polls the repo's issues, imports the new ones, reports back, works the frontier until it is empty, reports back again, and waits for the next poll. It stops like any runner: a STOP file or a signal ends it after the current shift. `npx shiftwork run --dark-factory --once` does one poll plus one frontier pass, then exits.

The TUI has a hand on it: the **GitHub** tab (`5`) lists the imported issues and the time of the last sync, and `g` starts `run --dark-factory` detached when no runner is live (a second `g`, like `s`, writes STOP); the header shows `dark-factory` while it runs.

How it treats the issues:

- **Collaborators only.** An issue is imported only when its author is a collaborator of the repo (plus the logins in `github.authors`) — issue text is untrusted input to an unattended agent, so anyone else's issue is ignored, and so is an issue without the `in` label. Each issue becomes a feature under `.scratch/`: a spec (the issue itself) and a planning ticket that splits it into implementation tickets.
- **It reports back, never deletes.** A comment when work starts, a comment per resolved ticket with its shift report and links to the landed commits, a question when a ticket needs information — and a collaborator's answer to that question goes back into the ticket. See [`Dark-factory: labels`](#dark-factory-labels) for the labels it sets.
- **Closing.** When every ticket of an issue is resolved, the issue is closed with a summary comment (`github.autoClose`, default true). Nothing on GitHub is ever deleted.
- **Push.** The runner lands on local `main`; the commit links in the comments resolve only once the commits are on GitHub. Set `"push": true` in the `github` block and dark-factory runs `git push origin HEAD` in the main checkout after every pass that landed commits. Without it the comments show the short shas only.

At start, before anything is imported, dark-factory checks your `gh` and its labels: no GitHub CLI, no logged-in `gh`, or a missing label each ends it with an error and how to fix it. Set up all of it once in [`Dark-factory: labels`](#dark-factory-labels).

## 9. Not there yet

- Editing config from the TUI.
