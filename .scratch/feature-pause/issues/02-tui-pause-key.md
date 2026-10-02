# 02: Pause and resume a feature from the TUI

**What to build:** In the TUI (`packages/cli/src/tui-controls.js`, `packages/cli/src/dashboard.js`, `packages/cli/src/tui.js`): the Queue's feature row shows `⏸` for a paused feature (from ticket 01's `featurePaused`); `p` on a feature row (or on a ticket row: its feature) emits a `{ type: "toggle-pause", feature }` effect that runs ticket 01's pause/resume function and sets the notice `⏸ <f> paused` / `▶ <f> resumed`; the frame refreshes so the frontier line updates. `n` on a ticket of a paused feature is refused with `feature <f> is paused (p resumes it)`. Footer key hints on the Queue tab include `p pause`. Update `tui --help`, guides (en + uk) section 7 ("What the TUI does") and run `npm run llms`.

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/tui-controls.test.js packages/cli/test/tui.test.js` · `npm test`

- [x] Reducer tests: `p` on a feature row and on a ticket row emits `toggle-pause` for that feature; `n` on a paused feature's ticket is refused with the notice
- [x] Controls test with a stub pause function: the effect runs it and sets the paused/resumed notice
- [x] Render test: a paused feature's row shows `⏸`; the Queue footer lists `p pause`
- [x] Guides (en + uk) and `tui --help` describe `p`

### Notes

- `p` (Queue and Resolved tabs, folder or ticket row under the cursor) emits `{ type: "toggle-pause", feature }`; it works while a runner is live (the current shift finishes and lands), other tabs and an empty queue do nothing.
- The effect executor calls an injectable `togglePause` whose default runs ticket 01's `featurePauseCommand` (action decided from the frame's `featurePaused` flags) and sets the notice `⏸ <f> paused` / `▶ <f> resumed`; the once-a-second frame refresh re-reads the spec, so the frontier line, the `⏸` marker and the `⏸ paused` status column follow.
- `ticketStatusColumn` gained the `⏸ paused` label (a live worker/claim still wins: `▶ working`), feature rows gained `paused` (rendered as a `⏸` part after the counts), and `startSelected` refuses a paused feature's ticket with `feature <f> is paused (p resumes it)` before the frontier check.
- Footer: Queue tab keys are `↑↓ move · ←→ fold · enter open · n run this · p pause · esc back`; the fallback banner and `tui --help` mention `p` too; `npm run llms` regenerated llms-full.txt (untracked).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 88016 in / 29168 out tokens, $0.8789, 43 turns
- Time: 9m 43s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/feature-pause-02 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — Pause and resume from the TUI match the ticket, and both verify commands pass.
- Time: 5m 13s
- Verify: passed
- Findings:

> I'll review the landed pause/resume ticket against its acceptance criteria, starting with the ticket, spec, and the landed diff.
> The landed commit is `da72c22`. Next I’ll read the diff and the domain docs, then run the verify gate.
> The diff covers the TUI and guides. I’ll check whether `npm run llms` output landed, and whether pause behavior matches the spec.
> The focused TUI tests passed. I’ll run the full verify gate next and check one pause-path edge case while that runs.
> The landed change in `da72c22` meets the ticket. `p` on a Queue or Resolved folder or ticket row emits `{ type: "toggle-pause", feature }`, the executor calls ticket 01's `featurePauseCommand`, and the notice is `⏸ <f> paused` or `▶ <f> resumed`. A live worker still shows `▶ working`. `n` on a paused feature's ticket is refused with `feature <f> is paused (p resumes it)` before the frontier check. The feature row shows `⏸`, the Queue footer lists `p pause`, and `tui --help` plus section 7 of both guides describe `p`. The once-a-second refresh re-reads the spec, so the frontier line, the marker, and the status column follow.
> 
> Verify: `node --test packages/cli/test/tui-controls.test.js packages/cli/test/tui.test.js` passed (88/88). `npm test` passed (645 pass, 10 skipped, 0 fail).
