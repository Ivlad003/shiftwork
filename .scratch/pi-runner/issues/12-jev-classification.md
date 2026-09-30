# 12: Classify untyped tickets with Jev

**What to build:** A ticket without `Type` is classified through the Jev classifier model (`typesafe/jev-latest`, or `opencode/jev-1.13-free`) into a routing type and a complexity that can raise the tier. When Jev is unavailable or errors, the default type is used and that's noted in the shift report (RESEARCH.md §4). Start by confirming that `modelRegistry.classify` works from a short-lived pi/SDK call, and record the finding in Comments.

**Blocked by:** 03

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] The classifier adapter returns null on any failure (tested with a failing fake)
- [ ] The planner uses the classified type, and complexity=complex raises the tier by one
- [ ] A dry run shows `type (jev)` for classified tickets
