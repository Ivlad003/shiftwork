# Research: walkinglabs/learn-harness-engineering ("graph harness?")

Source issue: github#9. Studied repo: <https://github.com/walkinglabs/learn-harness-engineering> (shallow clone, Oct 2026, MIT). Its contents were read as data only.

## 1. What the repo is

The repo is a **course**, not a library. Its README calls it "a project-based course on building the environment, state management, verification, and control mechanisms that make AI coding agents work reliably". It has 14 lectures, 8 projects, templates, a `harness-creator` skill and 15 translations, published as a VitePress site.

Layout (English paths):

| Path | What is there |
| --- | --- |
| `README.md` | Pitch, the **five-subsystem model** (Instructions, State, Verification, Scope, Session lifecycle), syllabus |
| `docs/en/lectures/lecture-01…12/` | Harness fundamentals: why agents fail, repo as system of record, short AGENTS.md, continuity/handoff, init phase, WIP=1, feature lists as primitives, premature victory, E2E, observability, clean state |
| `docs/en/lectures/lecture-13-loop-engineering/` | "Loop engineering": six loop primitives (automations, worktrees, skills, connectors, sub-agents, external state), generator/evaluator split, four silent costs. `code/` holds maker/checker prompts and goal and loop-state templates |
| `docs/en/lectures/lecture-14-graph-engineering/` | **"Graph engineering"**, the meaning of the issue's "graph harness". `code/maker_checker_graph.py` is a LangGraph reference |
| `docs/en/projects/project-01…08/` | Hands-on projects. P07 builds a first loop; P08 ("Draw Your Workflow as a Graph") draws it as a graph, adds fan-out/fan-in, a rollback edge and a human-approval node |
| `docs/en/harness-designs/{pi,claude-code,codex,deepseek}/` | Breakdowns of production harnesses by the five subsystems, each with "Designs Worth Adopting" |
| `docs/en/resources/` | Templates (`AGENTS.md`, `feature_list.json`, `init.sh`, `session-handoff.md`, `clean-state-checklist.md`, `evaluator-rubric.md`), an OpenAI-style repo template, SOPs |
| `skills/harness-creator/` | Agent skill with scripts that scaffold, validate (scores the five subsystems), benchmark and report on a repo's harness |
| `tools/audit-harness.sh` | Zero-dependency shell audit of a repo's harness (CRITICAL/RECOMMENDED checks) |

## 2. What "graph harness" means there

Lecture 14 (`docs/en/lectures/lecture-14-graph-engineering/index.md`) defines **graph engineering** as the layer above loop engineering. The stack is prompt → context → loop → graph, and each layer keeps the ones below it. In the lecture's framing the harness is the foundation under all four. A graph has four parts:

- **Nodes**: units of work. A node can be deterministic code, a model call, a tool, or a full agent with its own loop. A node whose work is a full agent is what separates a graph from a classic workflow.
- **Edges**: handoffs. An edge can be parallel, conditional, failure/retry, or a **rollback** (for example verify fails → implement, or "not enough info" → research).
- **Shared state**: the one workspace that nodes read and write. Node context stays private, and only the state is shared.
- **Routing rules**: where execution goes next, such as "tests pass → merge; fail → implement; missing info → research".

Other key claims:

- **A graph is an up-front decision, a loop a deferred one.** In Catacora's words: "Graphs force you to admit how much of your workflow is not actually modeled." Drawing the graph exposes implicit edges.
- **Three structural failures of a single loop** (eigent.ai): Goodhart (the metric detaches from the goal), blindness upward (the loop never asks whether the goal is right), and conflict between loops. A graph fixes these by moving the check to a separate node with a fresh context, not by adding checkpoints.
- **Anchors**: things that pin loops to reality, such as ground truth, human spot-checks, or "which measurements must stay frozen". The lecture calls this "the part everyone skips".
- **Shape is not the load-bearing wall** (iii.dev). What matters is replayability, observability and recoverability. Checkpoints after every step, plus pause-before-merge for human approval.
- **Orchestration tax** (Osmani): starting agents is cheap and closing their loops is expensive. Human review bandwidth is the serial bottleneck.
- **When to draw a graph**: decomposable units, branch/rollback paths, state worth saving, verifiable results, and coordination benefit above its cost. The lecture asks for at least three of the five.

The lecture also says the term started as a July 2026 joke. The lecture itself treats it as a new name for an old practice (LangGraph, Anthropic's *Building Effective Agents* patterns, DAG schedulers).

## 3. Insights mapped against Shiftwork

Shiftwork is already a graph harness in the lecture's sense, with deterministic routing. The runner is "plain code, not a model" (`docs/guide.md` §7), tickets are agent nodes, `Blocked by` is the DAG, and `.scratch/` is the shared state.

| Course insight (source) | Shiftwork today | Gap |
| --- | --- | --- |
| Node context private, only state shared (L14 step 1) | Fresh context per ticket; ticket + spec + `research.md` are the shared state (ADR-0005, `prompt.js`) | none |
| Verify node with a fresh context (L14 step 2, L09, L13 §5) | Review shift in a fresh context on its own tier, before land (`REVIEWER_PROMPT`, guide §7 Reviews) | none |
| Pass-state gating, state transitions owned by the harness (L08) | Verify gate decides resolution (ADR-0003); runner owns `claimed`/`resolved` | none |
| Explicit routing rules, failure edges (L14 step 4) | verify fail → retry/handoff; review reopen → same ticket; follow-up → new ticket; ≥ maxAttempts → needs-info | **No implement → research rollback edge.** A shift that finds information missing can only ask a human (`needs-info`); it cannot send the work back to a research node |
| Rollback to the layer that caused the problem (P08 exp. 3) | Reopen always goes to the implementing ticket | Review cannot route a misunderstood requirement back to planning (lower value) |
| Draw the graph; a graph puts problems on paper (L14, P08 exp. 1) | Spec status table; TUI Queue shows `⧗ waits 01, 03` | **No rendered dependency graph**, and **no cycle check**. A plan ticket that writes `03 blocked by 04` and `04 blocked by 03` passes `tickets check` (`packages/cli/src/tickets-check.js` only checks that blockers exist), and both tickets then wait forever |
| Anchors / frozen measurements vs. Goodhart (L14, eigent) | Unchanged-tree check: a gate that passes with no change → needs-info (`runner.js`) | **Nothing stops a shift from weakening the gate itself** (editing tests, fixtures or the scripts that Verify runs). The reviewer may catch it, but nothing enforces it, and reviews can be filtered or turned off |
| Checkpoint + human approval before merge (L14 step 5, P08 exp. 3) | Worktree branch kept; STOP handoff; resumed reviews; `ready-for-human` status | No "hold before landing for a human" switch per ticket (medium value, idea 6) |
| Fan-out / fan-in (P08 exp. 2) | `parallel` workers, worktrees, landing-conflict rebase | Parallel reviewers with different focus are absent; overlaps gh-15 ("double models") |
| Observability, task trace, replay (L11, iii.dev, DeepSeek "model-visible means logged") | Per-shift JSONL logs `logs/<feature>/<NN>/attempt-N.jsonl`, shift reports in tickets | No single runner decision trace (route, gate, handoff, verdict, landing) per run; partly covered by shift reports |
| Review feedback promotion, LESSONS.md (L10, pi-agent-harness in `harness-designs/pi`) | Review findings stay in each ticket | Not aggregated; overlaps gh-12 ("reflection") |
| Short AGENTS.md as a map, audit scripts (L04, `tools/audit-harness.sh`, `harness-creator`) | `shiftwork init`; repo's own AGENTS.md is short | No harness audit of the target repo (low priority) |
| Orchestration tax / review bandwidth (L14) | Reviews by an agent; `review.maxRounds`; needs-info holds a dark-factory feature | Fine as is |
| Four silent costs: token blowout etc. (L13) | Budgets, soft/hard limits, context-fill limit, stall detection | none |

## 4. Ranked ideas

| # | Idea | Value | Effort | Risks |
| --- | --- | --- | --- | --- |
| 1 | **Blocker cycle check in `tickets check`**: reject self-blocks and cycles, name the cycle | High: an agent-written plan can deadlock a feature silently, worst in dark-factory | S | Others are editing `tickets-check.js` in parallel (merge conflicts only) |
| 2 | **Frozen paths (anchor against Goodhart)**: a `**Frozen:**` ticket line (globs) plus an optional config default. A resolving shift whose branch diff touches a frozen path fails the attempt with a note naming the files | High for unattended runs: stops "make the gate pass by editing the gate" | M | Parser change in core `parseTicket`; false positives when a ticket legitimately edits tests, so only explicit lines, no default freezing |
| 3 | **`shiftwork graph <feature>`**: print a Mermaid flowchart of tickets (status in the label) and `Blocked by` edges, with cycles marked | Medium-high: puts the plan on paper for humans and for planning/review agents. Mermaid also renders in GitHub comments | S-M | New CLI subcommand in `bin/shiftwork.js`, which is being edited elsewhere |
| 4 | **Research rollback edge**: a `<shiftwork:needs-research reason="…"/>` marker files a `Type: research` ticket in the feature, makes the current ticket blocked by it, and keeps the current ticket `ready-for-agent`. At most once per ticket, after that it falls back to needs-info | Medium-high: turns some human interrupts into autonomous rollbacks. Builds on gh-10's research ticket | M | Loops of research tickets (bounded to one); the research ticket needs the right Verify (`test -s …/research.md`); the marker must be parsed like needs-info |
| 5 | Runner decision trace: `logs/runner-trace.jsonl`, one line per routing decision (route, gate result, handoff reason, verdict, landing sha) and a `shiftwork trace <feature>/<NN>` reader | Medium: replayability and observability (iii.dev's load-bearing wall) | M | Overlaps shift reports and gh-13; deferred |
| 6 | Human approval node: `**Land:** human`. After the review accepts, keep the branch and set `ready-for-human`; `shiftwork approve <feature>/<NN>` lands it | Medium: checkpoint for risky tickets | M | Touches landing/review flow that other features are changing; deferred |
| 7 | Review "replan" verdict routing back to the plan when requirements were misunderstood | Low-medium | M | Adds a verdict word to a tested protocol; follow-up/reopen cover most cases |
| 8 | Lessons aggregation from `### Review` findings into a short file read by later shifts | Medium | M | Prompt bloat; owned by gh-12 |
| 9 | Fan-out review (two reviewers, different focus, both must accept) | Low-medium; doubles review cost (orchestration tax) | M | Owned by gh-15 |
| 10 | `shiftwork doctor`: audit the target repo's harness (AGENTS.md length, a Verify-able test command, CONTEXT/ADR presence) in the style of `tools/audit-harness.sh` | Low | S | Opinionated checks |

Ideas 1–4 became tickets 02–05. Ideas 5–10 are left out: they overlap other open issues (gh-12, gh-13, gh-15) or change the landing/review protocol that other work is editing right now.

## 5. Open questions

- Frozen paths: should a config-wide default (for example `"frozen": ["packages/*/test/fixtures/**"]`) exist from day one, or only the per-ticket line? Ticket 04 builds the per-ticket line plus an optional config key with an empty default.
- Should the review prompt also mention frozen paths? Not needed: the runner enforces them before the review.

## Sources

- Repo: <https://github.com/walkinglabs/learn-harness-engineering>. `README.md`; `docs/en/lectures/lecture-14-graph-engineering/index.md`; `docs/en/projects/project-08-graph-engineering-first-graph/index.md`; `docs/en/lectures/lecture-13-loop-engineering/index.md` and `code/{checker-prompt,loop-state-template,goal-template}.md`; lectures 04, 07, 08, 09, 10, 11, 12 (`index.md`, Core Concepts); `docs/en/harness-designs/{pi,claude-code,codex,deepseek}/index.md` ("Designs Worth Adopting"); `skills/harness-creator/SKILL.md`; `tools/audit-harness.sh`
- External sources cited by lecture 14: eigent.ai *Graph Engineering for AI Agents*, iii.dev *Loops, Graphs, and the Layer That Matters*, Addy Osmani *The Orchestration Tax*, Anthropic *Building Effective Agents*
- Shiftwork: `CONTEXT.md`, `docs/adr/0003`, `0005`, `docs/guide.md` §7, `packages/cli/src/tickets-check.js`, `packages/core/src/index.js` (`parseTicket`), `packages/core/src/prompt.js`, `packages/core/src/runner.js` (unchanged-tree check, `needsInfoOf`), `packages/cli/src/git.js` (`hasChanges`)
