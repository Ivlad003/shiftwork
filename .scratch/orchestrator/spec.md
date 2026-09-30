# Spec: Shiftwork as an orchestrator (phase 2)

**Status:** ready-for-agent

Source: the operator's review notes in `idea.md` (2026-09-30), written after dogfooding phase 1 (`.scratch/pi-runner/`). Vocabulary: `CONTEXT.md`. Decisions: `docs/adr/`. ADR-0005 (fresh handoffs only) replaces the in-place default from phase 1.

## Problem Statement

Phase 1 made Shiftwork work tickets on pi. Using it on its own repo showed what's missing:
- **Only pi runs shifts.** I also pay for Claude Code, Codex and Grok Build (`grok`) and use OpenCode and Cursor, but Shiftwork can't give a ticket to any of them.
- **Model swaps keep the old context.** A swap in the same session carries the previous model's context and doesn't leave a handoff note, so the next model inherits confusion instead of a clean brief.
- **STOP loses context.** STOP ends the run after the current shift without asking the agent what it was in the middle of.
- **Settings are scattered by kind, not by model.** I can't give each model its own context window, money, time and token limits in one place.
- **Status lives only in the ticket files.** I have to open every ticket to see where a feature stands.
- **Only the mattpocock tracker is supported.** Some of my projects use OpenSpec.
- **There's no screen.** Watching a run means reading ticket files and NDJSON logs.

## Solution

- **Other harnesses as backends.** Shiftwork becomes an orchestrator: any shift can run on pi, Claude Code, Codex, OpenCode, Grok Build or Cursor's CLI. The backend is chosen by the model reference, for example `claude:sonnet`, `codex:gpt-5.6-terra`, `opencode:opencode-go/kimi-k3` or `grok:grok-4.7`. Every backend gets the same pointer prompt and handoff notes, and runs under the same budgets, limits and verify gate.
- **Fresh handoffs only.** Every model change is a fresh handoff with a handoff note, whatever the reason.
- **STOP asks for a handoff.** STOP steers the running agent to write a handoff note, then stops.
- **One settings block per model.** Each model can have its own profile: context window, budget and thinking level, with defaults for anything left out.
- **Status in the spec.** The spec of each feature carries a ticket status table that the runner keeps in sync.
- **OpenSpec as a second tracker.** Shiftwork can work OpenSpec changes as well as the mattpocock tracker.
- **A terminal UI.** `shiftwork tui` shows tickets, the live runner, budgets, cooldowns and logs, and can start and stop runs.

## User Stories

1. As an operator, I want every model change to start a fresh context with a handoff note, so that the next model gets a clean brief instead of inherited context.
2. As an operator, I want in-place swaps to exist only if I opt in, so that the default is the safe one.
3. As an operator, I want STOP to ask the running agent for a handoff note before the shift ends, so that the next run continues where this one stopped.
4. As an operator, I want a stopped ticket to go back to ready-for-agent with the note in its Comments, so that nothing is lost.
5. As an operator, I want to set a context window per model, so that context-fill budgets and compaction use my limit rather than the vendor's.
6. As an operator, I want a money, time and token budget per model in one profile, so that each model's limits live in one place.
7. As an operator, I want models without a profile to use the defaults, so that I only configure what differs.
8. As an operator, I want the old `budgets.models` config to keep working, so that upgrading doesn't break my setup.
9. As an operator, I want the feature spec to show a table of its tickets with number, title, status and last model, so that I see where the feature stands at a glance.
10. As an operator, I want that table updated on every status change, so that it never goes stale.
11. As an operator, I want to choose a backend per model reference (`claude:`, `codex:`, `opencode:`, `grok:`, `cursor:`, or plain `provider/model` for pi), so that tiers and chains can mix harnesses.
12. As an operator, I want Claude Code shifts to run on my subscription (`claude -p`), so that they use plan limits, not API billing.
13. As an operator, I want Codex shifts through `codex exec`, so that my ChatGPT subscription works tickets.
14. As an operator, I want OpenCode shifts through `opencode run`, so that its providers and agents are available.
15. As an operator, I want Grok Build shifts through `grok` in headless mode, so that my xAI subscription works tickets with Grok's own harness.
16. As an operator, I want Cursor CLI shifts through `cursor-agent`, so that Cursor's models are available when it's installed.
17. As an operator, I want a backend that isn't installed to be skipped like a cooling provider, with a warning, so that a missing CLI never stops the run.
18. As an operator, I want every backend's usage, cost when reported, turns and errors mapped to the same shift events, so that budgets and reports work the same everywhere.
19. As an operator, I want provider and plan limits recognised in each backend's output, so that cooldowns and chain fallback work across harnesses.
20. As an operator, I want each backend to get the ticket's skill set in its own way (pi `--skill`, a generated Claude Code plugin, `.agents/skills` links in the worktree), so that skill tiers apply everywhere.
21. As an operator, I want each shift's handoff note readable by the next shift whatever its backend, so that context passes between harnesses.
22. As an operator, I want Shiftwork to work OpenSpec changes (`openspec/changes/<change>/tasks.md`), each unchecked task being a ticket, so that OpenSpec projects work too.
23. As an operator, I want OpenSpec task order to act as blockers inside a section, and sections to follow each other, so that tasks run in a valid order.
24. As an operator, I want a configurable verify gate for OpenSpec changes, so that tasks without their own verify commands are still gated.
25. As an operator, I want `shiftwork tui` to show features, tickets, statuses and the frontier, so that I can see the whole queue.
26. As an operator, I want the TUI to show the live runner (ticket, shift, model, budget use, context fill), so that I can watch a run.
27. As an operator, I want the TUI to show cooldowns and the tail of the current shift's log, so that I can see why the runner waits.
28. As an operator, I want to start, stop (with handoff) and dry-run from the TUI, so that I don't need other commands.
29. As a maintainer, I want every backend behind the existing Backend seam with its own fake-binary tests, so that no test needs a subscription.

## Implementation Decisions

- **ADR-0005: fresh handoffs only by default.** `chooseHandoffMode` returns `fresh` unless the config sets `allowInPlace: true`, which brings back the phase-1 in-place behaviour. Every handoff writes a note: the agent's own at the soft limit, otherwise the runner's.
- **STOP.** When the runner sees STOP during a shift, it uses the soft-limit path: steer with a fixed STOP handoff text, allow 2 turns, abort, and write a runner note as a fallback. The ticket goes back to `ready-for-agent`, the claim is released, and the exit code is 3.
- **Model profiles.**
  - A `models` config section maps a model ref to `{ contextWindow?, thinking?, budget? }`.
  - The planner merges them in this order: `budgets.default` → tier budget → `budgets.models[ref]` (legacy) → `models[ref].budget`, capped by the ticket budget.
  - A profile's `contextWindow` overrides the backend's window when computing context fill (`percent = tokens / contextWindow`).
- **Spec status table.**
  - The tracker owns a generated block in `spec.md`, between `<!-- shiftwork:tickets:start -->` and `<!-- shiftwork:tickets:end -->`, with columns `NN · title · status · last route`.
  - It's rewritten atomically after every status change. Text outside the markers is never touched.
- **Backend registry (CLI).**
  - `parseModelRef(ref)` returns `{ backend, model }`. The prefixes are `claude:`, `codex:`, `opencode:`, `grok:` and `cursor:`; a ref without a prefix goes to pi. The cooldown key is `backend:provider`, or the provider for pi.
  - Each backend adapter implements `startShift` from the Backend seam and declares `capabilities`: `{ inPlaceHandoff: false, skills: "plugin" | "links" | "flags" }`.
- **Per-backend commands.** Flags were checked with `--help` on this machine; `cursor-agent` isn't installed here, so its flags must be confirmed in its ticket.
  - **claude:** `claude -p --model <m> --output-format stream-json --verbose --append-system-prompt <worker> --dangerously-skip-permissions [--plugin-dir <generated>] <prompt>`.
  - **codex:** `codex exec -m <m> --json --sandbox workspace-write -o <last> <prompt>`. The worker prompt goes through an `AGENTS.md` override or the prompt prefix.
  - **opencode:** `opencode run -m <provider/model> --format json --auto <prompt>`.
  - **grok:** `grok -m <m> --output-format streaming-json --always-approve <prompt>`, headless. Always invoke Grok Build as `grok` and Cursor as `cursor-agent`, never `agent`: both installers link an `agent` binary, and the one that runs depends on PATH order.
  - **cursor:** `cursor-agent -p --output-format stream-json --model <m> <prompt>`.
- **Skill delivery.**
  - **claude:** a temporary plugin directory whose `skills/` holds symlinks to the granted skills, passed with `--plugin-dir`.
  - **codex, opencode, grok, cursor:** symlinks in the worktree's `.agents/skills/`, added to the worktree's git exclude so they're never committed.
  - Preloaded skills are prepended to the prompt for every backend.
- **Limits.** Every adapter maps its error output into the shared `classifyError`, adding patterns for Claude Code ("usage limit reached|resets"), Codex ("rate_limit|usage_limit_reached") and Grok Build.
- **OpenSpec tracker.**
  - Configured with `tracker: "openspec"`, or detected when `openspec/changes/` exists. The same Tracker interface covers both trackers.
  - Each change is a feature. Each unchecked `- [ ] N.M` item in `tasks.md` is a ticket, and each ticket is blocked by the previous item.
  - Status beyond done/undone (claimed, needs-info, comments) lives in `openspec/changes/<change>/.shiftwork.md`, one section per task. Resolving a task ticks its checkbox.
  - The verify gate comes from `openspec.verify` in config (default `["openspec validate <change>"]`) plus any Verify line on the task.
- **TUI.**
  - `shiftwork tui`, built on `@earendil-works/pi-tui`, which is resolved from the user's pi install like `RpcClient`.
  - It reads the tracker, the run state (`.pi/shiftwork-run.json`), the cooldowns and the logs. Nothing in it is required to run Shiftwork.
  - Keys: `r` runs, `s` stops (with handoff), `d` dry-runs, `f` filters by feature, `q` quits.

## Testing Decisions

- **Same seams as phase 1.**
  - The Runner uses the fake backend.
  - Each CLI backend adapter is tested against a **fake binary**: a small Node script on PATH that prints recorded or synthetic output of that tool, including a limit error. No subscription is needed.
  - One optional live check per backend runs behind `SHIFTWORK_LIVE_<BACKEND>=1`.
- **Spec table and OpenSpec tracker:** tested at the Tracker interface on temp dirs, including byte-for-byte preservation outside the markers.
- **TUI:** tested through a render function (state → lines) and key handling on a fake runner, not through a real terminal.
- **Profiles and fresh-only handoffs:** table tests on `planShift` / `chooseHandoffMode`, plus Runner tests.

## Out of Scope

- Running two backends on the same ticket at the same time.
- Web UI.
- Paying for API usage in harnesses that support subscriptions (Claude Code and Codex use their own login).
- A native Cursor IDE integration beyond `cursor-agent`.

## Further Notes

- **Run with Shiftwork itself:** `shiftwork run --feature orchestrator`.
- **Backends not installed on this machine:** `cursor-agent`. Its ticket will end in needs-info if the verify gate can't be satisfied without it; the fake-binary tests should still pass.

<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | Fresh handoffs only by default (ADR-0005) | resolved | xai/grok-4.6 |
| 02 | STOP asks the agent for a handoff note | resolved | xai/grok-4.6 |
| 03 | Per-model profiles: context window, budget, thinking | resolved | xai/grok-4.6 |
| 04 | Ticket status table in the feature spec | resolved | xai/grok-4.6 |
| 05 | Backend registry and the Claude Code backend | resolved | opencode-go/kimi-k2.7-code |
| 06 | Codex backend | resolved | opencode-go/kimi-k2.7-code |
| 07 | OpenCode backend | resolved | opencode-go/kimi-k2.7-code |
| 08 | Grok Build (`grok`) backend | ready-for-agent |  |
| 09 | Cursor CLI (`cursor-agent`) backend | ready-for-agent |  |
| 10 | OpenSpec tracker | ready-for-agent |  |
| 11 | `shiftwork tui`: read-only dashboard | ready-for-agent |  |
| 12 | `shiftwork tui`: run, stop with handoff, dry-run | ready-for-agent |  |
<!-- shiftwork:tickets:end -->
