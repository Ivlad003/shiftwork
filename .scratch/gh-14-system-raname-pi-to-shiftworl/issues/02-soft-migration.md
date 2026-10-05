# 02: Soft migration of Shiftwork's files from `.pi/` to `.shiftwork/`

**What to build:** Shiftwork's own per-repo files (`shiftwork.json`, `shiftwork-worker.md`, `shiftwork-run.json`, `shiftwork-state.json`, `shiftwork-github.json`, `shiftwork.lock`, `shiftwork-<name>.lock`) live in `.shiftwork/`, resolved through one helper in core (`packages/core/src/paths.js`: `stateDir(root)` / `shiftworkPath(root, name)`). `.shiftwork/` exists → use it; else Shiftwork files under `.pi/` → use `.pi/` and print `shiftwork: using legacy .pi/ — run "shiftwork migrate" to move to .shiftwork/` once per process; else `.shiftwork/`. `shiftwork migrate [--dry-run]` moves them. pi's own files (`.pi/settings.json`, skills, prompts, `~/.pi/agent/…`) stay where pi reads them.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] `packages/core/src/paths.js` resolver (`SHIFTWORK_DIR`, `LEGACY_DIR`, `isShiftworkFile`, `legacyFiles`, `stateDir`, `shiftworkPath`), exported from core with `.d.ts`; tests for fresh / legacy / new / both and the once-per-process stderr hint
- [x] config, lock, run state, cooldowns, GitHub import state, worker prompt (bin + dry-run) and dashboard go through the resolver; the pi extension reads them through core
- [x] `shiftwork init` writes `.shiftwork/shiftwork.json` + `.shiftwork/shiftwork-worker.md` (a legacy repo keeps `.pi/`), and pi's `settings.json` still to `.pi/`
- [x] `shiftwork migrate [--dry-run] [--dir]`: prints each move, skips files already in `.shiftwork/`, leaves pi's files, idempotent, refused (exit 1) while a runner is live; in help and the dispatcher
- [x] `.gitignore` ignores the `.shiftwork/` state files (legacy `.pi/` entries kept); guide.md + guide.uk.md, READMEs, CONTEXT.md, the skill (synced) and llms-full.txt updated
- [x] This repo migrated with `shiftwork migrate` (no runner live)

## Comments

### Shift — manual (claude)
- Outcome: resolved
- Verify: `npm test` green (paths.test.js 6, migrate.test.js 6, init tests updated; tests that hard-coded `.pi/` now use `.shiftwork/`).
- User-level config stays at `<pi agent dir>/shiftwork.json` (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`): it is addressed through pi's agent dir, which pi also owns; moving it is a separate decision.
- This repo: moved `.pi/shiftwork.json`, `.pi/shiftwork-run.json`, `.pi/shiftwork-github.json` to `.shiftwork/`.
