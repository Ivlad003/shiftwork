# 12: Classify untyped tickets with Jev

**What to build:** A ticket without `Type` is classified through the Jev classifier model (`typesafe/jev-latest`, or `opencode/jev-1.13-free`) into a routing type and a complexity that can raise the tier. When Jev is unavailable or errors, the default type is used and that's noted in the shift report (RESEARCH.md §4). Start by confirming that `modelRegistry.classify` works from a short-lived pi/SDK call, and record the finding in Comments.

**Blocked by:** 03

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] The classifier adapter returns null on any failure (tested with a failing fake)
- [x] The planner uses the classified type, and complexity=complex raises the tier by one
- [x] A dry run shows `type (jev)` for classified tickets

## Comments

### Note for the shift (operator)
- This repo has no `TYPESAFE_API_KEY`, but OpenRouter is logged in: Jev is available as the classifier model `openrouter/typesafe/jev-1.13` (also `~typesafe/jev-latest`). Make the classifier model configurable (`jev.model`), default `typesafe/jev-latest`, and fall back through the configured list
- Tests must not need the network: inject the classify call; one optional live check may run only when an env var such as `SHIFTWORK_LIVE_JEV=1` is set

### Notes
- Confirmed `ModelRuntime.classify` from a short-lived SDK call (`ModelRuntime.create({ refreshOnCreate: false })`, no agent session). Catalog includes `typesafe/jev-latest` (no key here) and OpenRouter `typesafe/jev-1.13` / `~typesafe/jev-latest` (available). A live classify of a planner bugfix ticket returned `type=code`, `complexity=standard`, `stopReason=stop`. `classify()` does not throw: missing auth is `stopReason: "error"`.
- `jev.model` is a string or list; default `typesafe/jev-latest`; `init` writes the fallback list `typesafe/jev-latest`, `openrouter/typesafe/jev-1.13`, `opencode/jev-1.13-free`. Adapter tries each and returns null on any failure. Inject `classify(modelId, context)` in tests; `SHIFTWORK_LIVE_JEV=1` runs an optional live check.

### Shift 1 — pi xai/grok-4.6 (medium)
- Ended: stop, error: Internal error during token parsing
- Usage: 208371 in / 33893 out tokens, $2.5674, 54 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/pi-runner-12 into main

### Review — Claude Code (claude-opus-5-5), after the Shiftwork shift
- Done by Shiftwork on xai/grok-4.6, 54 turns, landed as d58700d (the shift ended on a transient "Internal error during token parsing" after the work; the gate and the no-change guard both passed)
- Accepted: classifier adapter over pi's `ModelRuntime.classify` with a configurable fallback list, null on any failure, offline tests with an injected classify, optional live check behind `SHIFTWORK_LIVE_JEV=1`
- Finding confirmed live: `ModelRuntime.classify` works without an agent session; Jev through OpenRouter (`typesafe/jev-1.13`)
- Checked by hand with this repo's config on two untyped tickets: "Fix typos in README" → docs (jev) → quick tier, free model; "Redesign the planner…" → refactor (jev) → premium, grok 4.7
- Dogfood config: `jev.model` = OpenRouter Jev first, TypeSafe direct last
