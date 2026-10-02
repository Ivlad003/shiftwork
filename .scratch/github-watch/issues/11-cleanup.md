# 11: Tidy the GitHub code — one exec helper, shared constants and defaults

**What to build:** Clean-ups from the operator's standards review (2026-10-01), no behaviour change:

1. **One exec helper.** The default `execFile` runner with `maxBuffer: 16 * 1024 * 1024` is written four times (`github.js`, twice in `dark-factory.js`, `github-sync.js`). Keep one in `packages/cli/src/github.js` (or a small `exec.js`) and import it.
2. **Statuses from core.** `github-sync.js` redefines `CLAIMED` / `RESOLVED` / `READY`; import them from `shiftwork-core` like `dashboard.js` and `tickets-check.js` do.
3. **Label defaults and messages from core.** Use core's `GITHUB_LABEL_DEFAULTS` instead of `LABEL_DEFAULTS` in `github-sync.js`, and core's `GITHUB_LABELS_IN_REQUIRED` instead of the literal in `github-labels.js`.
4. **Defaults in one place.** `autoClose`, `push`, `pollMin` defaults live in core's `GITHUB_DEFAULTS` (applied by `validateConfig`); remove the `?? true` / `?? false` / `?? 5` re-applications at the call sites (`github-sync.js`, `dark-factory.js`), and make sure every caller gets a validated config.
5. **Posted keys as data.** Build and parse the `posted` keys (`resolved:02`, `needs-info:…`, `done`) through one small module (`postKey(kind, ticket?, n?)` / `parsePostKey(key)`) used by `github-sync.js`, `dark-factory.js` (`describePost`) and `dashboard.js` (`issueState`), instead of string-building and `includes("done")` in three places.
6. **Routing outside the importer.** Move the `routing.plan` ← `github.planTier` step out of `importIssues` (`github-import.js`, `routePlans`) into config validation (`validateConfig`: when `github.planTier` is set and `routing.plan` is not, set `routing.plan = { tier: planTier }`).
7. **`checkGitHub` idiom.** Make it fail through `fail(path, …)` like the other checks in `packages/core/src/config.js`, keeping the guide pointer in the message.
8. **One GitHub row template** in `packages/cli/src/dashboard.js` (the tab body and `renderGithubSection` share a function).
9. **Help.** `tickets check` and `github labels` help lines list `--dir`; an unknown `shiftwork github <sub>` prints help and exits 1.

**Blocked by:** 10

**Status:** resolved
**Type:** refactor
**Verify:** `npm test` · `test "$(grep -c "16 \* 1024 \* 1024" packages/cli/src/*.js | awk -F: '{s+=$2} END {print s}')" -le 1` · `! grep -nE "^(const|let) (CLAIMED|RESOLVED|READY) =" packages/cli/src/github-sync.js`

- [x] The `maxBuffer` exec runner exists once; the other files import it
- [x] `github-sync.js` imports the statuses and label defaults from core; `github-labels.js` uses `GITHUB_LABELS_IN_REQUIRED`
- [x] No `?? true` / `?? false` / `?? 5` github defaults outside core; tests still pass with validated configs
- [x] Posted keys are built and parsed in one module, used in sync, dark-factory and the dashboard
- [x] `routing.plan` comes from `validateConfig`, not from `importIssues` (config test)
- [x] `checkGitHub` uses `fail(path, …)`
- [x] One row template for the GitHub tab; `github <unknown>` exits 1; help shows `--dir`

### Notes

The shared exec runner lives in `packages/cli/src/exec.js` (`execIn`). `git.js` and `github-labels.js` import it too: the verify gate counts `16 * 1024 * 1024` across every `packages/cli/src/*.js`, not only the four call sites named above.

## Comments

### Shift 1 — pi xai/grok-4.7 (high)
- Ended: stop
- Usage: 434168 in / 63258 out tokens, $2.8062, 37 turns
- Time: 12m 52s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/github-watch-11 into main

### Review — pi xai/grok-4.7 (high)
- Verdict: accept — The cleanup meets every acceptance criterion, the verify gate passes, and the validated dark-factory path is unchanged.
- Time: 5m 25s
- Verify: passed
- Findings:

> I'll review the landed ticket against its acceptance criteria and the repo's standards, starting with the ticket, spec, and the landed diff.
> The ticket and spec are loaded. Next I’ll inspect the landed commit and run the verify gate.
> The diff is in. I’ll read the touched modules and tests next, then run the verify gate.
> The landed refactor matches the ticket. The verify gate passes, and the nine clean-ups are in the right places with no behaviour change on the validated path.
> 
> - One `execIn` runner in `packages/cli/src/exec.js` holds the only `16 * 1024 * 1024` buffer. `github.js`, `github-sync.js`, `dark-factory.js`, `git.js`, and `github-labels.js` import it.
> - `github-sync.js` imports `CLAIMED`, `RESOLVED`, `READY`, and `GITHUB_LABEL_DEFAULTS` from core. `github-labels.js` throws `GITHUB_LABELS_IN_REQUIRED`. `checkGitHub` fails through `fail(path, …)` and still points at the guide.
> - `autoClose`, `push`, and `pollMin` are no longer re-applied with `??` outside core. `shiftwork run` validates before `darkFactoryRun`, and the dark-factory end-to-end test still closes the issue on those defaults.
> - Posted keys are built and parsed in `github-post.js`, used by sync, `describePost`, and the dashboard. `done` is still the close key, not `done-label`.
> - `validateConfig` sets `routing.plan` from `github.planTier` unless a plan route already exists. `importIssues` no longer does. A config test covers it.
> - The GitHub tab and the plain frame share `githubIssueRow`. Help lists `--dir` for `tickets check` and `github labels`. An unknown `github` subcommand prints help and exits 1.
> 
> `npm test`: 575 pass, 0 fail, 10 skipped. Both grep gates pass.
