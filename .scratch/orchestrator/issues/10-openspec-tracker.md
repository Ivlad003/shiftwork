# 10: OpenSpec tracker

**What to build:** Work OpenSpec changes through the same Tracker interface, configured with `tracker: "openspec"` or auto-detected when `openspec/changes/` exists. Each change is a feature, each unchecked `- [ ] N.M` task in `tasks.md` is a ticket blocked by the previous task, and status beyond done/undone plus comments live in `openspec/changes/<change>/.shiftwork.md`. Resolving a task ticks its checkbox. The verify gate comes from `openspec.verify` (default `["openspec validate <change>"]`) plus a task's own Verify (spec stories 22–24).

**Blocked by:** 04

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] Tracker tests on a temp OpenSpec layout: frontier, claim, status, comments, checkbox ticked on resolve, archive folder ignored
- [ ] A runner test with the fake backend works an OpenSpec change end to end
- [ ] Auto-detection prefers `.scratch/` when both exist, unless `tracker` is set
