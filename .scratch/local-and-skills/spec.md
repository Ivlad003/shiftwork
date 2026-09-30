# Spec: local models, fresh-context reviews, llms.txt and installable skills (phase 3)

**Status:** resolved

Source: operator requests, 2026-09-30, after phase 2. Vocabulary: `CONTEXT.md`.

## Problem Statement

- **Local models aren't configured.** I want to code with local models through Ollama, but Shiftwork has no way to find and route them.
- **Review lives in one growing session.** Reviewing each landed ticket happens in a single long operator session (Claude Code), whose context keeps growing.
- **Other agents can't pick up Shiftwork.** There's no `llms.txt`, and no skill that teaches them how to write and run Shiftwork tickets.

## Solution

- **Local models.** `shiftwork init --ollama` discovers local Ollama models and writes them into pi's `models.json` and a `local` tier. Local models are never paid, and a server that isn't running makes them unavailable, not cooling.
- **Reviews as shifts.** An optional review shift runs after every resolved ticket in a fresh context, on its own tier. It records findings in the ticket and can reopen the ticket or file a follow-up, so no long-lived orchestrator context is needed.
- **Docs and skills for agents.**
  - An `llms.txt` at the repo root describes Shiftwork for LLMs, and `npm run llms` generates `llms-full.txt` from the docs.
  - A `shiftwork` skill in Agent Skills format covers writing tickets, running Shiftwork and reviewing its work.
  - The skill is installable in pi (`pi install npm:pi-shiftwork`), in Claude Code (plugin marketplace in this repo), and in OpenCode, Codex and Cursor (`.agents/skills`).

## User Stories

1. As an operator, I want `shiftwork init --ollama` to list my local Ollama models and add them to pi's `models.json`, so that pi can run them.
2. As an operator, I want a `local` tier with those models, so that I can route ticket types to them.
3. As an operator, I want local models treated as free and a stopped Ollama server treated as unavailable, so that neither budgets nor cooldowns misfire.
4. As an operator, I want a review shift after every resolved ticket, in a fresh context on a configured tier, so that no single session accumulates every review.
5. As an operator, I want the review to append `### Review` findings, and to either accept, reopen the ticket with reasons, or create a follow-up ticket, so that problems become work instead of notes.
6. As an operator, I want reviews off by default, and configurable per feature and ticket type, so that I pay for them only where they help.
7. As an agent, I want an `llms.txt` at the repo root that says what Shiftwork is and where its docs live, so that I learn the project quickly.
8. As an agent, I want an installable `shiftwork` skill that teaches the ticket format, Verify gates, Type/Model/Skills/Budget lines and how to run and monitor Shiftwork, so that I can drive it in any harness.
9. As an operator, I want to install that skill in pi, Claude Code, OpenCode, Codex and Cursor with one documented command each, so that every harness knows Shiftwork.

## Implementation Decisions

- **Ollama.**
  - Discovery goes through Ollama's HTTP API: `GET /api/tags` for the model list and `POST /api/show` for the context length. The base URL is `OLLAMA_HOST`, default `http://localhost:11434`.
  - The pi provider is written into `~/.pi/agent/models.json` as `ollama` with `api: "openai-completions"`, `baseUrl: <host>/v1` and `apiKey: "ollama"`, following pi's `docs/models.md` example. Existing providers are merged, never overwritten.
  - The planner treats every `ollama/…` model as free. A "connection refused" error makes the backend unavailable (the same path as a missing CLI).
- **Review shifts.**
  - Configured as `review: { enabled, tier, when: "resolve", features?, types? }`.
  - After a ticket lands, the runner runs one shift with a review prompt that points to the ticket, the spec and the merge commit's diff. It uses the chosen tier and the verify gate of the ticket.
  - The reviewer ends with a marker: `<shiftwork:review verdict="accept|reopen|follow-up" reason="…"/>`.
  - `reopen` sets the ticket back to ready-for-agent with the reason in its Comments (the landed commit stays; the next shift fixes forward). `follow-up` appends a new ticket to the feature, blocked by nothing.
- **llms.txt.** Root `llms.txt` follows the llmstxt.org format: a title, a summary blockquote, then sections of links to README, CONTEXT, ADRs, specs and package READMEs. `npm run llms` concatenates those docs into `llms-full.txt`. A test checks that every link in `llms.txt` exists.
- **Skill.**
  - `skills/shiftwork/SKILL.md`, in Agent Skills format with name, description and body, plus a `references/` folder holding the ticket format and the config reference.
  - Packaged three ways:
    - the `pi` key of `pi-shiftwork` lists `skills`;
    - a Claude Code plugin in `plugins/shiftwork/` with `.claude-plugin/plugin.json` and a root `.claude-plugin/marketplace.json`, so `/plugin marketplace add Ivlad003/shiftwork` works;
    - the README documents copying or linking it into `.agents/skills/` for OpenCode, Codex and Cursor.

## Testing Decisions

- **Ollama:** tested against a fake Ollama HTTP server (a small node:http server in the test). No real Ollama is needed.
- **Review shifts:** Runner tests with the fake backend emitting each verdict marker.
- **llms.txt:** a link-check test.
- **Skill:** a test that validates the frontmatter and the plugin/marketplace JSON, plus that `pi-shiftwork` lists the skill; a real pi RPC check that the skill is advertised when the package is loaded.

## Out of Scope

Installing Ollama itself; model downloads; publishing to external skill registries.

<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | Local models through Ollama | resolved | opencode-go/glm-5.3 |
| 02 | Review shifts in a fresh context | resolved | opencode-go/glm-5.3 |
| 03 | `llms.txt` and `llms-full.txt` | resolved | opencode-go/glm-5.3 |
| 04 | Installable `shiftwork` skill for pi, Claude Code, OpenCode, Codex, Cursor | resolved | opencode-go/glm-5.3 |
| 05 | Grok shifts get the project's AGENTS.md / CLAUDE.md | resolved | opencode-go/glm-5.3 |
| 06 | sync-skills resolves the repo root from its own location; delete stray skill copies | resolved |  |
| 07 | Guide: grok shifts now get AGENTS.md / CLAUDE.md | resolved |  |
<!-- shiftwork:tickets:end -->
