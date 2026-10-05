# 01: Plan the work for github#10

**What to build:** Turn GitHub issue #10 into implementation tickets for the feature `gh-10-add-before-implementation-step-research`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-10-add-before-implementation-step-research`

- [x] Read `.scratch/gh-10-add-before-implementation-step-research/spec.md` — the issue itself, from `Source: github#10`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-10-add-before-implementation-step-research/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, end with `<shiftwork:needs-info reason="…"/>` instead of writing tickets

## Comments

### Notes

- github#10 is open, labelled `shiftwork:in`, with an empty body and no comments. The spec's `## Issue` is empty; the only text is the title "Add before implementation step research read if needed."
- Current flow is plan (`01-plan.md`) then implementation tickets. `research` exists as a routing Type in RESEARCH.md and `skills/shiftwork/references/tickets.md`, not as a runner step. Skills already advertise name + description and load the full `SKILL.md` when the model reads it (preload is the other path).
- The title fits several designs (planner inserts a `Type: research` ticket; the runner adds a research shift on the same ticket; an advertised research skill for implementation shifts). Choosing one would invent the issue.
- `github-import.js` now marks empty-body issues needs-info at import; this feature was imported before that. No `02…` tickets written.

### Shift 1 — grok grok-4.6 (medium)
- Ended: stop
- Usage: 556034 in / 13711 out tokens, $0.1763, 11 turns
- Time: 2m 33s
- Verify: not run
- Outcome: needs-info: github#10 has no body: should Shiftwork insert a Type: research ticket before implementation, run a research shift on the same ticket, or only advertise a research skill for agents to read if needed?
- Branch kept: shiftwork/gh-10-add-before-implementation-step-research-01

### Notes

- Operator decision: the lightweight design — a `Type: research` ticket written by the plan step when the issue needs reading first, writing `.scratch/<feature>/research.md`; shift prompts point at that file when it exists. See the spec's "Decision (operator)" paragraph. Implemented directly as ticket 02; resolved by the operator.
