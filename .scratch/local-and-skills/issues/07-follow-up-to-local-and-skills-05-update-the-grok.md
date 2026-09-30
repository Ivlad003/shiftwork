# 07: Guide: grok shifts now get AGENTS.md / CLAUDE.md

**What to build:** Update the Grok rows in docs/guide.md and docs/guide.uk.md to say Shiftwork injects AGENTS.md/CLAUDE.md into grok prompts now that local-and-skills/05 landed, dropping the stale 'fix planned' note. Filed by the review of local-and-skills/05 — see its "### Review" block in .scratch/local-and-skills/issues/05-grok-project-instructions.md.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] The Grok rows in `docs/guide.md` and `docs/guide.uk.md` say Shiftwork injects the file; the stale "fix planned" note is gone

## Comments

### Resolved by the operator (Claude Code), 2026-09-30
- Two-line docs fix, done directly. The review's reason was written as the task this time, so the reviewer-prompt change from 06 works.
