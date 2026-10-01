# 07: ADR — GitHub is an import source, not a tracker

**What to build:** Write `docs/adr/0006-github-is-an-import-source.md` in the style of the existing ADRs: context (work arrives as GitHub issues; the runner, frontier and verify gate are built on `.scratch/` files — ADR-0001; core has no backend deps — ADR-0004), decision (dark-factory imports collaborators' issues into `.scratch/gh-<N>-<slug>/`, a planning ticket splits them, a reconcile step reports back with comments, labels and closing — never deleting; `gh` stays in `packages/cli`), consequences (issue edits after import are not re-synced except collaborator replies to needs-info; only collaborators are trusted; the Projects board is not a source yet). Add the new terms (dark-factory mode, planning ticket) to `CONTEXT.md`.

**Blocked by:** 05

**Status:** ready-for-agent
**Type:** docs
**Verify:** `test -f docs/adr/0006-github-is-an-import-source.md` · `grep -qi "dark-factory" CONTEXT.md` · `npm test`

- [ ] The ADR exists, names ADR-0001 and ADR-0004, and states the collaborators-only rule and the no-delete rule
- [ ] `CONTEXT.md` defines dark-factory mode and planning ticket
