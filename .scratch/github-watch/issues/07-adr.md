# 07: ADR — GitHub is an import source, not a tracker

**What to build:** Write `docs/adr/0006-github-is-an-import-source.md` in the style of the existing ADRs: context (work arrives as GitHub issues; the runner, frontier and verify gate are built on `.scratch/` files — ADR-0001; core has no backend deps — ADR-0004), decision (dark-factory imports collaborators' issues into `.scratch/gh-<N>-<slug>/`, a planning ticket splits them, a reconcile step reports back with comments, labels and closing — never deleting; `gh` stays in `packages/cli`), consequences (issue edits after import are not re-synced except collaborator replies to needs-info; only collaborators are trusted; the Projects board is not a source yet). Add the new terms (dark-factory mode, planning ticket) to `CONTEXT.md`.

**Blocked by:** 05

**Status:** resolved
**Type:** docs
**Verify:** `test -f docs/adr/0006-github-is-an-import-source.md` · `grep -qi "dark-factory" CONTEXT.md` · `npm test`

- [x] The ADR exists, names ADR-0001 and ADR-0004, and states the collaborators-only rule and the no-delete rule
- [x] `CONTEXT.md` defines dark-factory mode and planning ticket

### Notes

- ADR written in the style of 0001/0004 (title, decision paragraph, `## Considered Options`, `## Consequences`). It names ADR-0001 (`.scratch/` tracker), ADR-0004 (no backend deps in core, `gh` in `packages/cli`), the collaborators-only rule and the no-delete rule, the needs-info reply as the only re-sync, and the Projects board not being a source yet.
- `CONTEXT.md` gains a `### GitHub watch` language section: dark-factory mode, planning ticket, reconcile step.

## Comments

### Shift 1 — pi opencode-go/space-bunny-free (low)
- Ended: stop
- Usage: 10577 in / 1662 out tokens, $0.0000, 10 turns
- Time: 57s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/github-watch-07 into main
