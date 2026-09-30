# 12: Classify untyped tickets with Jev

**What to build:** A ticket without `Type` is classified through the Jev classifier model (`typesafe/jev-latest`, or `opencode/jev-1.13-free`) into a routing type and a complexity that can raise the tier. When Jev is unavailable or errors, the default type is used and that's noted in the shift report (RESEARCH.md §4). Start by confirming that `modelRegistry.classify` works from a short-lived pi/SDK call, and record the finding in Comments.

**Blocked by:** 03

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] The classifier adapter returns null on any failure (tested with a failing fake)
- [ ] The planner uses the classified type, and complexity=complex raises the tier by one
- [ ] A dry run shows `type (jev)` for classified tickets

## Comments

### Note for the shift (operator)
- This repo has no `TYPESAFE_API_KEY`, but OpenRouter is logged in: Jev is available as the classifier model `openrouter/typesafe/jev-1.13` (also `~typesafe/jev-latest`). Make the classifier model configurable (`jev.model`), default `typesafe/jev-latest`, and fall back through the configured list
- Tests must not need the network: inject the classify call; one optional live check may run only when an env var such as `SHIFTWORK_LIVE_JEV=1` is set
