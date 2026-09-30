# Shiftwork

Autonomous coding agents working in shifts: a fresh context per ticket, and a handoff to another model when a budget or provider limit runs out. Design: `RESEARCH.md` (Ukrainian); vocabulary: `CONTEXT.md`; decisions: `docs/adr/`.

## Repo

- npm workspaces monorepo. `packages/core` (`shiftwork-core`, no pi/OpenCode deps), `packages/cli` (`shiftwork`), `packages/pi` (`pi-shiftwork`), `packages/opencode` (`opencode-shiftwork`).
- Plain ESM JavaScript with hand-written `.d.ts` in core and cli. The pi extension is TypeScript, loaded by pi directly. No build step.
- Tests use `node --test`. Run everything with `npm test` at the root.
- Node >= 22. No new runtime dependencies without a reason written in the ticket.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/`, one file per ticket, with the Shiftwork lines `Type`/`Model`/`Skills`/`Budget`/`Verify`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), plus the runner's `claimed` and `resolved`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
