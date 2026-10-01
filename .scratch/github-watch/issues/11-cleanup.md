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

**Status:** ready-for-agent
**Type:** refactor
**Verify:** `npm test` · `test "$(grep -c "16 \* 1024 \* 1024" packages/cli/src/*.js | awk -F: '{s+=$2} END {print s}')" -le 1` · `! grep -nE "^(const|let) (CLAIMED|RESOLVED|READY) =" packages/cli/src/github-sync.js`

- [ ] The `maxBuffer` exec runner exists once; the other files import it
- [ ] `github-sync.js` imports the statuses and label defaults from core; `github-labels.js` uses `GITHUB_LABELS_IN_REQUIRED`
- [ ] No `?? true` / `?? false` / `?? 5` github defaults outside core; tests still pass with validated configs
- [ ] Posted keys are built and parsed in one module, used in sync, dark-factory and the dashboard
- [ ] `routing.plan` comes from `validateConfig`, not from `importIssues` (config test)
- [ ] `checkGitHub` uses `fail(path, …)`
- [ ] One row template for the GitHub tab; `github <unknown>` exits 1; help shows `--dir`
