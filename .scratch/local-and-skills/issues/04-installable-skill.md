# 04: Installable `shiftwork` skill for pi, Claude Code, OpenCode, Codex, Cursor

**What to build:** `skills/shiftwork/SKILL.md` (Agent Skills format) with `references/tickets.md` and `references/config.md`: how to write Shiftwork tickets (mattpocock format + Type/Model/Skills/Budget/Verify), how to run `shiftwork run/status/tui`, and how to review landed work. Package it three ways: `pi-shiftwork`'s `pi.skills`; a Claude Code plugin `plugins/shiftwork/.claude-plugin/plugin.json` plus root `.claude-plugin/marketplace.json` (so `/plugin marketplace add Ivlad003/shiftwork` then `/plugin install shiftwork@shiftwork`); and README instructions for `.agents/skills/` (OpenCode, Codex, Cursor) (spec stories 8–9).

**Blocked by:** 03

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Frontmatter and JSON validated by a test (name, description, paths exist)
- [x] A real pi RPC check: loading `pi-shiftwork` advertises the `shiftwork` skill
- [x] README has one install command per harness

### Notes

- The canonical skill is `skills/shiftwork/` (SKILL.md + `references/tickets.md`, `references/config.md`). `scripts/sync-skills.mjs` (`npm run sync-skills`, also a `prepack` in packages/pi) copies it into `packages/pi/skills/shiftwork/` — the npm tarball cannot reach outside the package — and `plugins/shiftwork/skills/shiftwork/` for the Claude Code plugin. The copies are committed; `packages/cli/test/skill.test.js` fails with `run "npm run sync-skills"` when they drift.
- `packages/pi/package.json` now has `pi.skills: ["./skills/shiftwork"]` and `files` includes `skills`; `npm pack --dry-run` confirmed the tarball carries SKILL.md and both references.
- Claude Code packaging: root `.claude-plugin/marketplace.json` + `plugins/shiftwork/.claude-plugin/plugin.json`, skill auto-discovered at `plugins/shiftwork/skills/`.
- The real pi RPC check (`packages/pi/test/skill-advertised.test.js`) loads the local package with `-e <packages/pi>` and asserts the recorded advertised skills include `shiftwork`.
- README install commands: pi `pi install npm:pi-shiftwork`; Claude Code `/plugin marketplace add Ivlad003/shiftwork` + `/plugin install shiftwork@shiftwork`; OpenCode/Codex/Cursor `npx degit Ivlad003/shiftwork/skills/shiftwork .agents/skills/shiftwork` (plus a link-your-checkout alternative).
- Verify gate `npm test`: 391 pass, 0 fail (9 pre-existing skips).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 59954 in / 31586 out tokens, $0.7524, 50 turns
- Time: 9m 51s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/local-and-skills-04 into main

### Review — pi opencode-go/glm-5.3 (medium)
- Verdict: follow-up — The skill, packaging, tests and README all meet the ticket, but the landed commit carries stray duplicate skill copies (packages/pi/packages/pi/ and packages/pi/plugins/) that the cwd-based prepack regenerates on every npm pack — sync-skills.mjs should resolve the repo root from its own file location and the strays should be deleted.
- Time: 1m 31s
- Verify: passed
- Findings:

> The stray nested `packages/pi/packages/pi/` and `packages/pi/plugins/` directories in the landed commit catch my eye. Let me look at the skill content and run the verify gate.
> Verify gate passes (391 pass, 0 fail, 9 pre-existing skips), matching the ticket's report. Let me quickly confirm the cause of the stray nested directories and check the uncommitted `.scratch` changes.
> ## Review of local-and-skills/04 — Installable `shiftwork` skill
> 
> **Verify gate:** `npm test` run myself — 391 pass, 0 fail, 9 pre-existing skips. Matches the shift report.
> 
> **Against the ticket's acceptance criteria:**
> 
> - [x] Frontmatter/JSON validated by a test — `packages/cli/test/skill.test.js` checks name/description constraints, that every relative link and both references exist, that `pi.skills` + `files` package the skill, and that the marketplace/plugin JSON are valid and consistent. The drift check even runs the sync twice (idempotence) and compares byte-for-byte with a `run "npm run sync-skills"` hint in the failure message. Good.
> - [x] Real pi RPC check — `packages/pi/test/skill-advertised.test.js` loads the local package via `-e` and asserts the recorded advertised skills include `shiftwork`. Passed in my run.
> - [x] README — one install command per harness: pi `pi install npm:pi-shiftwork`, Claude Code marketplace/plugin commands, degit for OpenCode/Codex/Cursor plus a link-your-checkout alternative. Passed.
> 
> The skill content itself is solid Agent Skills format: valid frontmatter, progressive disclosure through `references/tickets.md` and `references/config.md`, consistent with the repo's CONTEXT/ticket vocabulary. `npm pack --dry-run` confirms the tarball carries SKILL.md and both references.
> 
> **One defect found (the reason for follow-up):** the landed commit includes two stray, byte-identical duplicate copies of the skill:
> 
> - `packages/pi/packages/pi/skills/shiftwork/` (note the doubled `packages/pi`)
> - `packages/pi/plugins/shiftwork/skills/shiftwork/`
> 
> Root cause: `packages/pi/package.json` gained `"prepack": "node ../../scripts/sync-skills.mjs"`, and npm runs prepack with cwd = `packages/pi`, while `syncSkills()` takes `repoRoot` from `process.cwd()`. So every `npm pack`/`npm publish` of pi-shiftwork syncs into nested paths inside `packages/pi` — which is exactly how these files got committed. They don't reach the tarball (the `files` allowlist excludes them) and the drift test doesn't catch them (it only checks `SKILL_TARGETS` from the real root), so the shipped artifact is fine — but junk is committed on main and will regenerate on every pack. The fix is small: resolve the repo root from `import.meta.filename` (or `__dirname`-relative) in `scripts/sync-skills.mjs` instead of `process.cwd()`, and delete the stray directories.
> 
> Everything the ticket asked for is done and verified; the stray copies are a side defect of the packaging path, worth a small follow-up ticket rather than reopening.
- Follow-up: local-and-skills/06 — Follow-up to local-and-skills/04: The skill, packaging, tests and README all me…

### Review — operator (Claude Code), 2026-09-30
- The automatic review shift caught a real defect (cwd-relative `prepack` sync committing nested skill copies) and filed a follow-up, 06. That's the review loop working end to end; I confirmed the root cause and fixed it directly in 06.
- Skill, plugin/marketplace JSON and the pi RPC advertise test checked in the diff; `npm pack` of pi-shiftwork carries the skill.
- Verdict: accept (with 06).
