# 05: Grok shifts get the project's AGENTS.md / CLAUDE.md

**What to build:** The `grok:` backend reads the project instructions from the shift's cwd and prepends them to the `-p` prompt, as a `# Project instructions (<file>)` section between the worker prompt and the ticket prompt. File choice matches pi: `AGENTS.md`, else `CLAUDE.md`; a line that is exactly `@<path>` (as in this repo's `CLAUDE.md`, which is `@AGENTS.md`) is replaced by that file's content, one level deep, paths relative to the file. Missing files add nothing. Other backends are unchanged: pi, Claude Code, Codex, OpenCode and Cursor load these files themselves (checked live, 2026-09-30).

Recorded, grok 1.0.44 headless (`grok -m grok-4.6 -p …`), in a repo with committed `AGENTS.md`, `CLAUDE.md` and `GROK.md`: it loads none of them ("quote any project rules in your system prompt" → `NO RULES`). `--rules "Always end every answer with the word HERON."` has no effect either (`Hello. How can I help you today?`), so `--rules` is not the way.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Backend test: with `AGENTS.md` in cwd, the spawned `-p` argument contains its text after the worker prompt and before the ticket prompt
- [ ] `CLAUDE.md` containing only `@AGENTS.md` expands to AGENTS.md's content; no files → prompt unchanged
- [ ] Live check (recorded in the ticket's Notes): a demo repo whose `AGENTS.md` says "The project codeword is PELICAN"; a grok shift asked for the codeword answers PELICAN
