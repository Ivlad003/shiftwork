# 06: Show live agents on the feature row, also when it is collapsed

**What to build:** Operator report (2026-10-01): with every feature collapsed, the Queue tab doesn't show where an agent is working — the `● model` marker is only on ticket rows, which a collapsed feature hides. In `queueRows` (`packages/cli/src/tui-controls.js`) give each feature row the live workers of its tickets (`workers: [{ number, model }]`, from `dashboard.run.workers` and from live claims in `dashboard.claims`, so a ticket held by a second runner counts too). In `renderQueueRows` (`packages/cli/src/dashboard.js`) append to the feature row `· ● 12 glm-5.3` for one worker, `· ● 2 agents (12 glm-5.3, 03 grok-4.7)` for several — whether the feature is collapsed or expanded — coloured like the ticket row's marker when colour is on. A ticket held by a live claim with no worker entry in the run state (another runner) shows `● <NN> pid <pid>`. Update guides (en + uk) section 7 ("What the TUI does") and run `npm run llms`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/tui-controls.test.js packages/cli/test/tui.test.js` · `npm test`

- [ ] `queueRows` test: a feature row carries its tickets' live workers, collapsed or not; a live claim without a run-state worker is included with its pid
- [ ] Render test: a collapsed feature with one worker shows `● 12 glm-5.3` on its row; two workers show `● 2 agents (…)`; a feature with none shows no marker
- [ ] Guides (en + uk) mention the marker on feature rows
