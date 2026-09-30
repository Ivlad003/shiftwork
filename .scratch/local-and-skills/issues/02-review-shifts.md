# 02: Review shifts in a fresh context

**What to build:** Optional `review: { enabled, tier, when: "resolve", features?, types? }`. After a ticket lands, the runner runs one review shift on that tier with a review prompt (pointers to the ticket, spec and the merge commit's diff) and the ticket's verify gate. The reviewer ends with `<shiftwork:review verdict="accept|reopen|follow-up" reason="…"/>`: accept → nothing more; reopen → ticket back to ready-for-agent with the reason; follow-up → a new ticket appended to the feature. The review is recorded as `### Review` in Comments (spec stories 4–6).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] Runner tests with the fake backend for all three verdicts and for a missing marker (treated as accept with a warning)
- [x] Reviews off by default; `features` / `types` filters respected
- [x] `--dry-run` shows whether a ticket would be reviewed and on which tier

### Notes

Implemented (spec stories 4–6):

- **Config** (`packages/core/src/config.js`): `review: { enabled, tier, when, features?, types? }`, validated (`tier` must exist and is required when enabled; `when` only `"resolve"`; unknown fields fail). Default `{ enabled: false, when: "resolve" }`. `shouldReview` (exported from core) applies the `features`/`types` filters against the ticket's effective type.
- **Runner** (`packages/core/src/runner.js`): after a ticket resolves and lands, one review shift runs on the review tier (planned as an untyped, unrouted ticket pinned to `defaultTier: review.tier`, so chains/budgets/skills of that tier apply), in the main repo (`cwd: root`), with `REVIEWER_PROMPT` + `buildReviewPrompt` (`packages/core/src/prompt.js`) pointing at the ticket, the spec, the landed message/diff (`git show <sha>`) and the verify gate. One shift only (`maxHandoffs: 0`), no handoffs, events logged under `attempt: review`.
- **Verdicts**: the last `<shiftwork:review verdict="…" reason="…"/>` marker in the review output decides. Missing or unknown verdict → accept with a `- Warning:`. Recorded as a `### Review` comment: verdict, reason, verify result (re-run in the main repo), warnings, findings (blockquote, capped at 40 lines). `reopen` sets the ticket back to ready-for-agent (landed commit stays; `summary.reopened`, exit code 2). `follow-up` files a new ready ticket in the feature via the new `tracker.createTicket` (next free number, blocked by nothing); trackers without `createTicket` (OpenSpec) record "not filed, do it manually".
- **CLI**: `run` prints `✖ … reopened by review` and `↳ follow-up …`; exit-code help updated. `run --dry-run` (and the TUI's `d`) shows a `review=<tier>` / `review=no` column for every ticket when reviews are enabled, nothing when off (`packages/cli/src/dry-run.js`).
- **Docs**: `packages/cli/README.md` review section; `CONTEXT.md` gains the "Review shift" term.

Tests: `packages/core/test/runner.test.js` (all three verdicts, missing + unknown marker, off by default, `features`/`types` filters, workspace review in the main repo, all-cooling review tier → `### Review\n- Not run: …`), `config.test.js`, `init-dry-run.test.js`. `npm test`: 379 pass, 9 pre-existing live-backend skips.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop, error: Request timed out.
- Usage: 111347 in / 50005 out tokens, $1.4020, 57 turns
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/local-and-skills-02 into main

### Review — operator (Claude Code), 2026-09-30
- Code read against the spec: config validation, `shouldReview` filters, a single review shift pinned to the review tier with `maxHandoffs: 0`, last-marker-wins parsing, and the reopen/follow-up paths all match stories 4–6.
- **Fixed:** follow-up tickets were filed without a `**Verify:**` line, so nothing could resolve them (recurring lesson: keep Verify meaningful). They now inherit the reviewed ticket's gate; the no-change guard keeps it from passing on an untouched tree. Test extended.
- By design, not changed: a reopened ticket is `seen`, so it waits for the next `run` (this prevents a reopen → fix → reopen loop within one run). A review shift that errors (e.g. a timeout) counts as accept with a warning, and writes no provider cooldown.
- Live check: reviews are enabled in this repo's `.pi/shiftwork.json` (tier `standard`) from ticket 03 on; the first real `### Review` lands there.
- Verdict: accept.
