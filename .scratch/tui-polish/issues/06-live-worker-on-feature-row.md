# 06: Show live agents on the feature row, also when it is collapsed

**What to build:** Operator report (2026-10-01): with every feature collapsed, the Queue tab doesn't show where an agent is working — the `● model` marker is only on ticket rows, which a collapsed feature hides. In `queueRows` (`packages/cli/src/tui-controls.js`) give each feature row the live workers of its tickets (`workers: [{ number, model }]`, from `dashboard.run.workers` and from live claims in `dashboard.claims`, so a ticket held by a second runner counts too). In `renderQueueRows` (`packages/cli/src/dashboard.js`) append to the feature row `· ● 12 glm-5.3` for one worker, `· ● 2 agents (12 glm-5.3, 03 grok-4.7)` for several — whether the feature is collapsed or expanded — coloured like the ticket row's marker when colour is on. A ticket held by a live claim with no worker entry in the run state (another runner) shows `● <NN> pid <pid>`. Update guides (en + uk) section 7 ("What the TUI does") and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/tui-controls.test.js packages/cli/test/tui.test.js` · `npm test`

- [x] `queueRows` test: a feature row carries its tickets' live workers, collapsed or not; a live claim without a run-state worker is included with its pid
- [x] Render test: a collapsed feature with one worker shows `● 12 glm-5.3` on its row; two workers show `● 2 agents (…)`; a feature with none shows no marker
- [x] Guides (en + uk) mention the marker on feature rows

### Notes

- `queueRows` builds a `claimOf` map from `dashboard.claims` next to the existing `workerOf`; each feature row gets `workers: [{ number, model }]` from its tickets — a run-state worker entry wins over a live claim, a claim without one gets `model: null` plus the claiming pid. Computed from the feature's whole ticket list (`own`), so a search filter still shows the feature's live workers.
- `renderQueueRows` appends the marker via a new `workerMarker` helper: one worker `· ● 12 glm-5.3`, several `· ● 2 agents (12 glm-5.3, 03 grok-4.7)`, a claim-only worker `· ● 12 pid 4242`. The existing `paintTokens` cyan rule (` · ● …`) colours it like the ticket row's marker — no paint change needed.
- The plain frame (`renderQueueSection`) and the Resolved tab get the marker too, since both reuse `queueRows`/`renderQueueRows`.
- `npm run llms` rerun (18 files); guides' Queue rows updated in both languages.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 37015 in / 12118 out tokens, $0.3356, 35 turns
- Time: 4m 21s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-06 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — The feature-row marker shows live workers when collapsed or expanded, including a claim-only pid, and both guides and the verify gate match the ticket.
- Time: 4m 46s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the feature spec, starting with the ticket, spec, and the landed diff.
> The landed commit is `805751c`. I'll read that diff, the domain docs, and the queue-row code next.
> The commit is small. I'll check how claims, colouring, and the generated docs are wired so the marker matches the ticket.
> The landed change in `805751c` does what the ticket asks. A collapsed feature row now shows who is working, and the verify gate is green.
> 
> `queueRows` puts `workers` on every feature row from `dashboard.run.workers`, and from a live claim when that ticket has no run-state worker (`model: null`, plus `pid`). A run-state entry wins, so the same ticket is not counted twice. The list is the feature's full ticket list, so collapse and search still keep the marker. `renderQueueRows` appends `· ● 12 glm-5.3`, `· ● 2 agents (12 glm-5.3, 03 grok-4.7)`, or `· ● 12 pid 4242`, and omits it when there are no workers. The existing cyan rule (` · ● …`) colours it the same way as a ticket row. Section 7 of both guides describes those three forms.
> 
> `node --test packages/cli/test/tui-controls.test.js packages/cli/test/tui.test.js` passed (78), and `npm test` passed (625, 10 pre-existing skips).
