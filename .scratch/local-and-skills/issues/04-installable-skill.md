# 04: Installable `shiftwork` skill for pi, Claude Code, OpenCode, Codex, Cursor

**What to build:** `skills/shiftwork/SKILL.md` (Agent Skills format) with `references/tickets.md` and `references/config.md`: how to write Shiftwork tickets (mattpocock format + Type/Model/Skills/Budget/Verify), how to run `shiftwork run/status/tui`, and how to review landed work. Package it three ways: `pi-shiftwork`'s `pi.skills`; a Claude Code plugin `plugins/shiftwork/.claude-plugin/plugin.json` plus root `.claude-plugin/marketplace.json` (so `/plugin marketplace add Ivlad003/shiftwork` then `/plugin install shiftwork@shiftwork`); and README instructions for `.agents/skills/` (OpenCode, Codex, Cursor) (spec stories 8–9).

**Blocked by:** 03

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Frontmatter and JSON validated by a test (name, description, paths exist)
- [ ] A real pi RPC check: loading `pi-shiftwork` advertises the `shiftwork` skill
- [ ] README has one install command per harness
