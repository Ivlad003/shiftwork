# Shiftwork

Shiftwork works a queue of tickets with autonomous coding agents. Each ticket gets fresh context, and work passes from model to model when a budget or provider limit runs out.

## Language

### Work

**Feature**:
A named body of work with one spec and a set of tickets, kept together in one directory of the tracker.
_Avoid_: epic, project

**Spec**:
The document describing what a feature must achieve, from the user's point of view.
_Avoid_: PRD, design doc

**Ticket**:
One vertical slice of a feature, small enough to finish in a single fresh context, with its own acceptance criteria.
_Avoid_: task, issue, job

**Blocker**:
A ticket that must be resolved before another ticket may start.
_Avoid_: dependency, prerequisite

**Frontier**:
The tickets that are ready for an agent and whose blockers are all resolved.
_Avoid_: queue, backlog, next tasks

**Claim**:
A runner's exclusive hold on a ticket while it works on it, so no other runner takes the same ticket.
_Avoid_: lock, assignment

**Verify gate**:
The ticket's commands whose success, and nothing else, decides that the ticket is resolved.
_Avoid_: tests, checks, acceptance step

### Execution

**Runner**:
The Shiftwork process that works the frontier until nothing is left or a limit stops it.
_Avoid_: orchestrator, daemon, loop

**Backend**:
The agent program that carries out a shift, such as pi, Claude Code, Codex or OpenCode.
_Avoid_: harness, engine, agent, provider

**Shift**:
A continuous stretch of work on one ticket by one model in one context.
_Avoid_: iteration, run, session

**Attempt**:
All the shifts on a ticket between two runs of its verify gate. An attempt fails when the gate fails.
_Avoid_: try, retry

**Handoff**:
Passing a ticket from one shift to the next, together with a handoff note. An **in-place handoff** keeps the context and swaps the model. A **fresh handoff** starts a new context.
_Avoid_: switch, transfer, failover

**Handoff note**:
The short written account in the ticket of what was done, what remains and what was learned, left for the next shift.
_Avoid_: summary, progress file

**Stall**:
A shift that keeps working without changing the code or its failures.
_Avoid_: loop, hang

### Models

**Provider**:
The vendor whose API serves a model, such as Anthropic, OpenAI, xAI, OpenRouter or OpenCode.
_Avoid_: backend, vendor account

**Tier**:
A capability class of models: quick, standard or premium.
_Avoid_: level, class, size

**Route**:
The backend, model, thinking level and skill set chosen for a shift.
_Avoid_: config, profile, preset

**Chain**:
The ordered list of models, from different providers, that a tier falls back through.
_Avoid_: fallback list, pool

**Skill group**:
A named set of skills that is granted together.
_Avoid_: bundle, pack

**Preloaded skill**:
A skill whose full instructions go into the shift's starting context, instead of being left for the model to load itself.
_Avoid_: inlined skill, forced skill

### Limits

**Budget**:
A limit Shiftwork sets on a shift or a ticket: tokens, cost, turns, time or context fill. The **soft limit** asks the agent to write a handoff note; the **hard limit** ends the shift.
_Avoid_: quota, cap

**Provider limit**:
A limit imposed by the provider: a rate limit that clears in minutes, or a usage limit that clears in hours or at the next billing period.
_Avoid_: budget, quota error

**Cooldown**:
The period during which a provider is skipped by every runner after it hit a provider limit.
_Avoid_: ban, backoff
