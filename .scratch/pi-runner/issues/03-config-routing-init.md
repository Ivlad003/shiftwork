# 03: Config, routing by Type, and `shiftwork init`

**What to build:** Routing is driven by `.pi/shiftwork.json`, merged over the user-level file and validated with errors that name the field. The route for a shift comes from the ticket `Model` → `routing[Type]` → the default, with a thinking level and a tier whose chain supplies the model. `shiftwork init` writes a starter config, the worker prompt, and recommended `compaction.modelOverrides` into `.pi/settings.json` (RESEARCH.md §5). `shiftwork run --dry-run` prints each frontier ticket with its route and spends nothing (spec: Config, Planner).

**Blocked by:** 02

**Status:** resolved
**Type:** code
**Verify:** `npm test` · `node packages/cli/bin/shiftwork.js run --dry-run --help`

- [x] Planner table tests cover the override order and thinking levels
- [x] An invalid config fails with the field path in the message
- [x] `init` is idempotent and never overwrites existing files without `--force`
- [x] `--dry-run` lists frontier tickets with backend/model/thinking/tier
- [x] `--feature <slug>` limits the run

## Comments

### Shift 1 — Claude Code (claude-opus-5-5), manual (pre-runner)
- Verify: `npm test` → 51 passed · `shiftwork run --dry-run --help` → ok
- Core: `loadConfig(root, userDir)` (project `.pi/shiftwork.json` over `<pi agent dir>/shiftwork.json`; objects merged, arrays replaced), `validateConfig` (errors are `field.path: problem`, CHANGE-ME placeholders rejected, every type must end in a route), pure `planShift` (ticket Model → routing[Type] → defaultTier → top-level model; unknown Type → defaultType; thinking routing → tier → global)
- Runner now plans each shift with `planShift`; `.pi/shiftwork-worker.md` overrides the built-in worker prompt
- CLI: `shiftwork init [--model] [--force]` (config with tiers quick/standard/premium and routing git/docs/test/code/refactor, worker prompt, `compaction` block in `.pi/settings.json` without touching other settings), `run --dry-run` prints type/tier/model/thinking per frontier ticket
- Compaction per model stays pi-native (`compaction.modelOverrides`); init only seeds the block and explains the formula
- Left for later tickets: chains beyond the first model (10), skills (04), budgets (07)
