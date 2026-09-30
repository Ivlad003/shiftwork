# 06: sync-skills resolves the repo root from its own location; delete stray skill copies

**What to build:** The skill, packaging, tests and README all meet the ticket, but the landed commit carries stray duplicate skill copies (packages/pi/packages/pi/ and packages/pi/plugins/) that the cwd-based prepack regenerates on every npm pack — sync-skills.mjs should resolve the repo root from its own file location and the strays should be deleted. Filed by the review of local-and-skills/04 — see its "### Review" block in /home/kosmodev/pet_project/shiftwork/.scratch/local-and-skills/issues/04-installable-skill.md.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] `scripts/sync-skills.mjs` resolves the root from `import.meta.dirname`, not the cwd
- [x] Stray `packages/pi/packages/` and `packages/pi/plugins/` removed; a test runs the script from `packages/pi` (as npm's prepack does) and checks nothing nests there

## Comments

### Resolved by the operator (Claude Code), 2026-09-30
- Fixed directly (a two-line change). `npm pack --dry-run -w packages/pi` syncs from the right root and packs the 3 skill files; no nested copies.
- The review's follow-up also exposed two gaps in follow-up tickets, fixed in the runner: the "see its ### Review block in …" path is now repo-relative, and the reviewer prompt asks for a follow-up reason written as the task (this ticket's generated title was the praise half of the reason).
