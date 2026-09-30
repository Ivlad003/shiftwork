# Spec: Shiftwork runner for pi (phase 1)

**Status:** ready-for-agent

Vocabulary: `CONTEXT.md`. Decisions: `docs/adr/0001`–`0004`. Background research: `RESEARCH.md` §2–§8. Ukrainian summary: `docs/TZ.md`.

## Problem Statement

I want coding agents to work through a list of tickets on their own, overnight or while I'm busy. Today every agent session accumulates context until it degrades, and nothing stops an agent from claiming it's done when it isn't. When a model hits a rate or usage limit, the whole run stops. Cheap work (git chores, docs) burns expensive models. Weak models can't find the skills they need, and strong models drown in skills they don't. I also have no way to cap what one ticket may cost, or to pass work between models without losing what was learned.

## Solution

`shiftwork run` works the frontier of Markdown tickets. Every ticket runs in its own git worktree, and every shift is a fresh pi process with a route (model, thinking level, skill set) chosen from the ticket's type and tier. A ticket is resolved only when its verify gate passes. Budgets cap each shift and each ticket. When a budget runs out, work is handed off to another model, either in place or in a fresh context, with a handoff note written into the ticket. When a provider limit hits, that provider cools down for every runner and the shift moves to the next model in the tier's chain. Untyped tickets are classified by Jev. The `pi-shiftwork` package brings status, launching and skill tiers into the pi TUI. Once this works, the remaining Shiftwork backends are built by Shiftwork itself.

## User Stories

1. As an operator, I want to run `shiftwork run` in a repo, so that every ready ticket gets worked without me.
2. As an operator, I want tickets in the mattpocock-skills local tracker format, so that `/to-spec` and `/to-tickets` output is directly executable.
3. As an operator, I want the frontier to respect `Blocked by`, so that tickets run in a valid order.
4. As an operator, I want the lowest-numbered frontier ticket taken first, so that runs are predictable.
5. As an operator, I want a ticket marked `claimed` while it's being worked, so that I can see what's in progress.
6. As an operator, I want a claim left by a crashed runner to be taken over automatically, so that a crash doesn't block a ticket forever.
7. As an operator, I want every shift to start with a fresh context, so that one ticket's history never pollutes another.
8. As an operator, I want a ticket resolved only when its `Verify` commands pass, so that "done" means done.
9. As an operator, I want a ticket without `Verify` to go to `needs-info` after its attempt, so that unverifiable work gets a human look instead of a false resolve.
10. As an operator, I want each shift to append a report to the ticket's `## Comments`, so that the ticket file tells the whole story.
11. As an operator, I want the report to include route, token usage, cost, verify output (trimmed) and why the shift ended, so that I can audit decisions.
12. As an operator, I want a failed verify gate to start a new attempt with the failure in the ticket, so that the next shift knows what broke.
13. As an operator, I want `maxAttempts` per ticket, so that a hopeless ticket stops and goes to `needs-info`.
14. As an operator, I want to map ticket `Type` to a tier or model, so that git chores use a cheap model and hard code uses a strong one.
15. As an operator, I want `**Model:**` on a ticket to override routing, so that I can pin a model when I know better.
16. As an operator, I want a thinking level per route, so that cheap tasks don't burn reasoning tokens.
17. As an operator, I want each tier to have a chain of models from different providers, so that there's always somewhere to fall back to.
18. As an operator, I want skill groups granted per tier, so that strong models see few skills and weak ones see more.
19. As an operator, I want `**Skills:** +group -group` on a ticket, so that I can adjust skills for one ticket.
20. As an operator, I want some skills preloaded for weak tiers, so that weak models don't miss instructions they wouldn't load themselves.
21. As an operator, I want a shift to see only its skill set (pi `-ns --skill`), so that other installed skills don't leak in.
22. As an operator, I want budgets for tokens, cost, turns, time and context fill, with overrides per model and tier, so that no shift runs away.
23. As an operator, I want a total budget per ticket across all its shifts, so that one ticket can't eat the night.
24. As an operator, I want `**Budget:**` on a ticket to override its limits, so that big tickets can get more room.
25. As an operator, I want a soft limit that asks the agent to write a handoff note and stop, so that handoffs carry the agent's own understanding.
26. As an operator, I want a hard limit that ends the shift and has the runner write the handoff note, so that a runaway agent can't ignore the soft limit.
27. As an operator, I want in-place handoffs (same session, model swapped, optionally compacted), so that cost-driven switches keep useful history.
28. As an operator, I want fresh handoffs (new process), so that stalls and a full context get a clean start.
29. As an operator, I want `onExceed` rules choosing the handoff mode and target (next, downgrade, escalate, same-tier) per exceeded budget, so that each situation gets the right response.
30. As an operator, I want an `auto` handoff mode that picks in-place or fresh from the reason and context sizes, so that I don't have to.
31. As an operator, I want a ticket that exhausts its ticket budget to go to `needs-info`, not to yet another model, so that spending has a ceiling.
32. As an operator, I want rate and usage limits recognised from provider errors, so that they're treated as limits, not as the agent failing.
33. As an operator, I want a provider in cooldown to be skipped by every runner and every later ticket, so that one limit doesn't cost ten failed shifts.
34. As an operator, I want the cooldown length taken from the provider's reset hint when there is one, or from defaults per limit kind, so that we return as soon as it's sensible.
35. As an operator, I want a shift interrupted by a provider limit relaunched on the next chain model in the same worktree, not counted as a failed attempt, so that limits don't burn my attempts.
36. As an operator, I want the runner to wait for the earliest cooldown to end when a whole chain is cooling down, or move to the neighbouring tier if configured, so that the run neither dies nor spins.
37. As an operator, I want a stall (N turns without diff changes) to trigger a fresh handoff, so that loops get broken.
38. As an operator, I want repeated verify failures to escalate to a stronger tier, so that tickets beyond a cheap model still get done.
39. As an operator, I want a limit on handoffs per ticket and no return to a model that just stalled, so that models don't ping-pong.
40. As an operator, I want a `STOP` file to make the runner finish the current shift cleanly and exit, so that I can stop it from anywhere.
41. As an operator, I want each ticket worked in its own git worktree and branch, so that failed work never touches my main checkout.
42. As an operator, I want a resolved ticket's branch merged into the target branch, and failed branches kept, so that good work lands and bad work can be inspected.
43. As an operator, I want untyped tickets classified by Jev into a type and complexity, so that routing works even when tickets are terse.
44. As an operator, I want classification to fall back to the default type when Jev is unavailable, so that a missing key never blocks a run.
45. As an operator, I want `shiftwork init` to create the config, the worker prompt and recommended per-model compaction settings, so that setup takes a minute.
46. As an operator, I want config at project level merged over user level, so that defaults are shared and projects can differ.
47. As an operator, I want clear errors for an invalid config, naming the field, so that mistakes are fixed fast.
48. As an operator, I want `shiftwork status` to show tickets, the frontier, claims and cooldowns, so that I know where things stand.
49. As an operator, I want an NDJSON log per shift, so that I can debug any decision after the fact.
50. As an operator, I want `shiftwork run --once` to work exactly one ticket, so that I can try things safely.
51. As an operator, I want `shiftwork run --dry-run` to print what would run with which route, so that I can check routing without spending.
52. As an operator, I want `shiftwork run --feature <slug>` to limit the run to one feature, so that I can focus.
53. As an operator, I want a meaningful exit code (all resolved / some need info / stopped), so that scripts can react.
54. As an operator in the pi TUI, I want `/shift` to show the frontier, so that I don't leave pi to check.
55. As an operator in the pi TUI, I want `/shift run` to start the runner in the background with a status widget, so that I can keep working while it runs.
56. As an operator in the pi TUI, I want my own interactive sessions filtered to the current model's tier skill set, so that the tiers apply to me as well.
57. As an agent in a shift, I want a worker prompt that tells me the ticket path, the spec path, the rules and how to report, so that I work the ticket the Shiftwork way.
58. As an agent, I want to mark a ticket as needing information with a clear marker, so that I can stop honestly instead of guessing.
59. As an agent, I want the previous handoff notes and verify failures in the ticket, so that I continue rather than restart.
60. As a Shiftwork maintainer, I want the core free of pi and OpenCode dependencies, so that other backends plug in with thin adapters.
61. As a Shiftwork maintainer, I want the runner tested end to end against a fake backend, so that tests are fast, offline and deterministic.
62. As a Shiftwork maintainer, I want the pi adapter tested against a real pi process with a scripted provider, so that protocol drift in pi is caught without API keys.
63. As a Shiftwork maintainer, I want to run phase 2 tickets with `shiftwork run` on this repo, so that Shiftwork builds itself from here on.

## Implementation Decisions

**Modules** (deep modules; each interface stays small):

- **Tracker (core).**
  - Interface: open a tracker on a repo root; then `list` tickets, `frontier`, `claim(ticket)` returning a claim or nothing, `setStatus(claim|ticket, status)`, `appendComment(ticket, markdown)`, `release(claim)`.
  - Hides: parsing (the existing parser), O_EXCL claim files with pid + token and stale-pid takeover, atomic write via tmp + rename, and keeping unknown lines of a ticket byte-for-byte.
- **Config (core).**
  - Interface: `loadConfig(root, userDir)` returns a validated, merged, defaulted config, or throws with the offending field path.
  - Sections: `routing` (type → tier | model, thinking), `tiers` (chain, skills, preload, budgets), `skillGroups`, `skillSources`, `budgets` (default, models, ticket), `softLimitPct`, `onExceed`, `cooldown` defaults, `crossTier`, `maxAttempts`, `maxHandoffs`, `stallTurns`, `git` (target branch, merge style), `jev` (enabled, model).
  - Config lives in `.pi/shiftwork.json`; the user-level copy is under the pi agent dir.
- **Planner (core, pure).**
  - Interface: `planShift({ ticket, config, history, cooldowns, now, reason? })` returns a Route `{ backend, model, thinking, tier, skills: { paths, preload }, budget }`, or `{ wait: until }`, or `{ stop: reason }`.
  - Hides: the override order (ticket Model → routing[type] → default), tier chains skipping cooled-down providers, `onExceed` targets (next/downgrade/escalate/same-tier), crossTier, the no-return-after-stall rule, skill group ± arithmetic and path resolution, and merging budgets (model → tier → default, capped by what's left of the ticket budget).
- **Meter (core, pure).**
  - Interface: `createMeter(budget, softLimitPct)` returning `observe(shiftEvent)`, which answers `null | { level: "soft" | "hard", reason }`.
  - Hides: token, cost, turn, time and context accounting, and stall detection from diff snapshots.
- **Limit classifier (core, pure).**
  - Interface: `classifyError(message, headers?)` returns `null | { kind: "rate" | "usage" | "quota" | "server", resetAt? }`.
  - Patterns: pi-ai's retryable and non-retryable lists plus usage-limit wording, and reset hints from `retry-after` / "resets at".
- **Cooldowns (core).**
  - Interface: `openCooldowns(root)` with `active(now)`, `add(provider, until, kind)`.
  - Backed by `.pi/shiftwork-state.json`, written atomically, shared by all runners.
- **Backend seam (core defines it; adapters implement it).** This is the real seam: pi now, fake in tests, claude/codex/opencode in phase 2.
  - Interface: `startShift({ cwd, route, prompt, systemPrompt, signal })` returns a Shift.
  - A Shift offers: an async iterable of normalized ShiftEvents (`turn { usage, costUsd, contextPct }`, `text`, `error { message }`, `end { stopReason }`), `steer(text)`, `abort()`, and optionally `swapModel(model, thinking)` and `compact(instructions)`, declared through `capabilities: { inPlaceHandoff }`.
  - The core never sees backend-specific event shapes.
- **Runner (core).**
  - Interface: `runFrontier({ tracker, config, backend, verify, git, classify, clock, log, signal, options: { once, dryRun, feature } })` returns a summary `{ resolved, needsInfo, stoppedReason }`.
  - Owns the loop: claim, plan, shift(s), meter, handoff or fallback, verify, resolve or needs-info, release. Stop rules come from a pure `decideNext(state)`.
  - Every dependency is injected; that's what makes one seam enough for tests.
- **Handoff notes (core).**
  - Soft-limit path: the runner steers the agent with a fixed instruction to append `### Handoff` to the ticket and stop, allowing up to 2 turns.
  - Hard-limit path, or when the agent doesn't comply: the runner writes the note from the shift's log tail, `git diff --stat` and the last verify failure. This uses the cheapest available model through the backend's one-shot completion, or a mechanical note if none is available.
  - The note format follows the mattpocock `handoff` skill: pointers, not copies, and secrets redacted.
- **Git (CLI adapter).**
  - Interface: `prepare(ticket)` returns a worktree path on branch `shiftwork/<feature>-<NN>` from the target branch; `diffStat(path)`; `land(ticket)` merges into the target (fast-forward if possible, else a merge commit) and removes the worktree; `keep(ticket)` leaves the branch for inspection.
  - The ticket file is edited in the main checkout, never in the worktree, so that status is always visible in one place.
- **Verify (CLI adapter).**
  - Interface: `verify(commands, cwd, timeout)` returns `{ ok, results: [{ cmd, code, outputTail }] }`.
  - Runs sequentially and stops at the first failure.
- **pi backend (CLI adapter).**
  - Uses pi's exported `RpcClient`, one process per shift: `--mode rpc --no-session -ns --skill <path>… --model <provider/id> --thinking <level> --append-system-prompt <worker+preloaded>`.
  - Maps pi JSON events to ShiftEvents. Supports in-place handoff through `set_model` and `compact`, and gets stats from `get_session_stats`. Treats `agent_settled` as the end, and `stopReason: "error"` as an error even with exit code 0.
- **Classifier (CLI adapter).**
  - Interface: `classify(ticket)` returns `{ type, complexity } | null`.
  - Uses pi's model registry `classify` with the Jev model (`typesafe/jev-latest`, or `opencode/jev-1.13-free`) from a short-lived pi process or SDK call. `null` on any failure.
- **pi-shiftwork extension.**
  - `/shift` shows status.
  - `/shift run` spawns the CLI runner detached, tails its state, and shows a status widget.
  - A `before_agent_start` filter narrows `systemPromptOptions.skills` to the tier set of the current model.

**Ticket lines.** `Type`, `Model`, `Skills`, `Budget`, `Verify`, as documented in `docs/agents/issue-tracker.md`. Agent markers in shift output: `<shiftwork:needs-info reason="…"/>`.

**CLI.** `shiftwork init | status | run [--once] [--dry-run] [--feature <slug>]`. Exit codes: 0 all resolved or nothing to do; 2 some tickets need info; 3 stopped (STOP file, all cooling down with `crossTier: none`, or ticket budget exhausted).

## Testing Decisions

- **Test only external behaviour.** A good test goes through a module's interface. Tests never reach into claim files or internal state.
- **The main seam is the Runner.** Runner tests use a real temp git repo with real `.scratch` tickets, real verify commands (small shell commands against files) and a **fake backend**. The fake backend is scripted per test: which files a shift writes, which ShiftEvents it emits (usage, errors such as a 429 or "usage limit reached", stall patterns), and whether it complies with a steer. Almost every user story above is covered at this seam.
- **Pure modules** (Planner, Meter, Limit classifier, Config) get table-driven tests on their interfaces, because the combinations are many and cheap to enumerate.
- **pi adapter integration test.** A real pi process, spawned through the adapter, with a test-only pi extension that registers a scripted provider (pi-ai's faux provider shape), so no network or keys are needed. It proves the event mapping, `-ns --skill` isolation, `set_model` in-place handoff and error mapping. If a scripted provider can't be registered from an extension, the fallback is a stub RPC process speaking pi's documented protocol, and the gap gets noted in the ticket.
- **pi-shiftwork** is tested the way it already has been by hand: a real pi in RPC mode checks that `/shift` is registered and answers, and that the skill filter changes the advertised skills per model.
- **Prior art:** none in the repo yet beyond the manual pi RPC check. Use `node --test` with no test framework dependency.

## Out of Scope

- Backends `claude`, `codex`, `opencode`, and the OpenCode plugin. These are phase 2, built with Shiftwork itself.
- Parallel runners. Claims are designed for them, but the runner is sequential.
- Notifications beyond exit codes and logs.
- Money budgets across days or months (only per-shift and per-ticket).
- Web UI.
- Virtual-model provider fallback inside interactive pi sessions (`registerVirtualModel`). That's useful for humans, not needed for the runner.

## Further Notes

- **Order of work.** Tickets 01–03 are built by hand, with Claude Code in this repo. From 04 on, run `shiftwork run --feature pi-runner` and review the landed branches. That's the dogfooding promised in ADR-0004.
- **Unverified pi behaviours to confirm early** (RESEARCH.md §8):
  - `ctx.modelRegistry.classify` in practice (Jev ticket);
  - whether `RpcClient.waitForIdle` returns only at `agent_settled`;
  - `set_model` mid-run after an error.

  Tickets that depend on these start by confirming them and record the finding in `## Comments`.
