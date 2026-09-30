# 05: Grok shifts get the project's AGENTS.md / CLAUDE.md

**What to build:** The `grok:` backend reads the project instructions from the shift's cwd and prepends them to the `-p` prompt, as a `# Project instructions (<file>)` section between the worker prompt and the ticket prompt. File choice matches pi: `AGENTS.md`, else `CLAUDE.md`; a line that is exactly `@<path>` (as in this repo's `CLAUDE.md`, which is `@AGENTS.md`) is replaced by that file's content, one level deep, paths relative to the file. Missing files add nothing. Other backends are unchanged: pi, Claude Code, Codex, OpenCode and Cursor load these files themselves (checked live, 2026-09-30).

Recorded, grok 1.0.44 headless (`grok -m grok-4.6 -p …`), in a repo with committed `AGENTS.md`, `CLAUDE.md` and `GROK.md`: it loads none of them ("quote any project rules in your system prompt" → `NO RULES`). `--rules "Always end every answer with the word HERON."` has no effect either (`Hello. How can I help you today?`), so `--rules` is not the way.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Backend test: with `AGENTS.md` in cwd, the spawned `-p` argument contains its text after the worker prompt and before the ticket prompt
- [x] `CLAUDE.md` containing only `@AGENTS.md` expands to AGENTS.md's content; no files → prompt unchanged
- [x] Live check (recorded in the ticket's Notes): a demo repo whose `AGENTS.md` says "The project codeword is PELICAN"; a grok shift asked for the codeword answers PELICAN

### Notes

- Implementation: `loadProjectInstructions(cwd)` in `packages/cli/src/grok-backend.js` — reads `AGENTS.md`, else `CLAUDE.md`, from the shift's cwd; a line that is exactly `@<path>` is replaced by that file's content (one level deep, path relative to the cwd; a dangling `@path` is kept as a plain line). Injected as `# Project instructions (<file>)` after the worker prompt and preloaded skills, immediately before the ticket prompt.
- Tests: `recordedPrompt()` helper in `packages/cli/test/grok-backend.test.js` (a fake grok that records its `-p` argument) covers order, CLAUDE.md + `@NOTES.md` expansion, dangling import, and the unchanged prompt with no files.
- Live check (2026-09-30, grok 1.0.44, model `grok-4.6`, headless `-p`): demo repo whose `AGENTS.md` says "The project codeword is PELICAN."; shift asked "What is the project codeword? Reply with the codeword only." answered exactly `PELICAN` (before this change the same probe answered without any project rules). Also added as a `SHIFTWORK_LIVE_GROK=1` live test.
- Verify gate: `npm test` at the root — 405 tests, 395 pass, 10 skipped (live tests for other backends), 0 fail.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 20611 in / 8620 out tokens, $0.1443, 22 turns
- Time: 3m 51s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/local-and-skills-05 into main

### Review — pi opencode-go/glm-5.3 (medium)
- Verdict: follow-up — Update the Grok rows in docs/guide.md and docs/guide.uk.md to say Shiftwork injects AGENTS.md/CLAUDE.md into grok prompts now that local-and-skills/05 landed, dropping the stale 'fix planned' note.
- Time: 1m 6s
- Verify: passed
- Findings:

> The landed change looks focused. Let me check the earlier ticket commit (guide updates) and run the verify gate.
> The verify gate passes (405 tests, 395 pass, 10 skipped, 0 fail — matching the ticket's report). Let me confirm the final state of the implementation and the live-test gating.
> Review complete. Here's what I found:
> 
> **Ticket:** `.scratch/local-and-skills/issues/05-grok-project-instructions.md` — Grok shifts get the project's `AGENTS.md`/`CLAUDE.md`. Landed as merge `efceae0` (code) plus ticket commit `1cf2b2b` (ticket + guide docs).
> 
> **Verify gate:** `npm test` — 405 tests, 395 pass, 10 skipped (live gates for other backends), 0 fail. Matches the ticket's recorded result.
> 
> **Against the acceptance criteria:**
> - ✅ `AGENTS.md` in cwd lands in the spawned `-p` argument between the worker prompt and the ticket prompt — `loadProjectInstructions(cwd)` in `packages/cli/src/grok-backend.js`, injected into the `[systemPrompt, preload.text, projectInstructions, prompt]` join; the test asserts the exact ordering by index.
> - ✅ File choice matches pi: `AGENTS.md`, else `CLAUDE.md`; a line exactly `@<path>` expands one level deep (imported content isn't rescanned), a dangling import is kept as a plain line, missing files add nothing (`""` is filtered out by `filter(Boolean)`). All four cases covered by tests via the `recordedPrompt()` fake-grok helper, including the unchanged-prompt baseline.
> - ✅ Live check recorded in the ticket's Notes (PELICAN codeword, grok 1.0.44) and also added as a `SHIFTWORK_LIVE_GROK=1` gated live test.
> - ✅ Other backends untouched — the diff touches only the grok backend and its test, matching the recorded finding that pi, Claude Code, Codex, OpenCode and Cursor load these files themselves.
> - ✅ Uncommitted working-tree changes are only the runner's spec-table/status updates and the review marker, not code.
> 
> **One minor finding (docs staleness, not code):** the guide table added in the ticket's own commit `1cf2b2b` (`docs/guide.md` and `docs/guide.uk.md`) says Grok reads neither file with the parenthetical "(fix planned: ticket `local-and-skills/05`)". The literal table is still true — the grok CLI reads neither — but the "fix planned" note is stale since the same ticket landed the injection, and a guide reader could reasonably conclude grok shifts never see project rules, which is no longer the case. The code work itself is complete and correct, so this is a follow-up task, not a reopen.
> 
> 
> 
> **Summary:** The landed change meets every acceptance criterion — correct injection point, pi-matching file choice with one-level `@path` expansion, dangling-import and no-file edge cases tested, live check recorded and gated, other backends untouched, verify gate green (405/395/10/0). The only residue is the guide's now-stale "fix planned: ticket local-and-skills/05" note in both guide languages.
- Follow-up: local-and-skills/07 — Follow-up to local-and-skills/05: Update the Grok rows in docs/guide.md and doc…

### Review — operator (Claude Code), 2026-09-30
- Re-ran the live test myself (`SHIFTWORK_LIVE_GROK=1`, real grok 1.0.44): the PELICAN codeword from AGENTS.md reaches the shift. The fake-grok tests pin the prompt order and the `@path` expansion.
- The review shift's follow-up (07, stale guide rows) was right; fixed directly.
- Verdict: accept.
