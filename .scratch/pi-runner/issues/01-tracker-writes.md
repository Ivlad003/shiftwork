# 01: Tracker: claim, status and comments

**What to build:** The tracker can take a claim on a frontier ticket, change its status and append to its `## Comments`. Two runners in the same repo can never claim the same ticket, and a claim left by a dead process is taken over. Rewriting a ticket keeps every line it doesn't own byte-for-byte. This is the prefactor the runner builds on (spec: Tracker module; ADR-0001).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] `claim` returns a claim for a free frontier ticket and nothing when it's already claimed by a live process
- [x] A claim whose owner pid is dead is taken over
- [x] `setStatus` changes only the `Status:` line; all other bytes are unchanged (tested on a ticket with Shiftwork lines, HTML comments and checkboxes)
- [x] `appendComment` creates `## Comments` when it's missing and appends otherwise
- [x] Writes are atomic (tmp + rename); a failed write leaves the original intact
- [x] The root `npm test` runs all workspace tests with `node --test`

## Comments

### Shift 1 — Claude Code (claude-opus-5-5), manual (pre-runner)
- Verify: `npm test` → 8 passed, 0 failed
- Tracker module: `openTracker(root)` with `list`, `frontier` (includes claimed tickets whose owner pid is dead), `claim` (O_EXCL lock in `.scratch/.claims/<feature>--<NN>.lock` with pid+token, stale takeover), `release` (token-checked), `setStatus`, `appendComment`; atomic tmp+rename writes
- Note: a ticket status `claimed` without a live lock is treated as frontier again
