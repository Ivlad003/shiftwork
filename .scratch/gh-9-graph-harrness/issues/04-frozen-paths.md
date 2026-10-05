# 04: Frozen paths: a resolving shift may not edit what its gate measures

**What to build:** An anchor against Goodhart (research.md, idea 2). A ticket may carry `**Frozen:**` globs, and the config may set a default `frozen` list. When a shift's Verify gate passes but the ticket's branch changed a frozen path, the runner does not resolve. The attempt fails with a note naming the files, the same way a failed gate does.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/parse-ticket.test.js` · `node --test packages/core/test/runner.test.js` · `node --test packages/cli/test/git.test.js` · `node --test packages/core/test/config.test.js`

- [x] `parseTicket` (packages/core/src/index.js) parses `**Frozen:**` into `frozen: string[]` (backtick-quoted globs, else split on `·`/`,`), and an absent line gives `[]`. `index.d.ts` gains the field
- [x] Config accepts an optional top-level `"frozen": ["glob", …]` (default `[]`) validated in packages/core/src/config.js; the ticket's list is added to it
- [x] The git workspace (packages/cli/src/git.js) exposes `changedFiles(t)`: paths changed on the ticket's branch versus the target, committed and uncommitted, excluding `.scratch/` and setup output (same exclusions as `hasChanges`)
- [x] In runner.js, when the decision is `resolve` and the frozen globs match any changed file, the decision becomes `retry` (counts as a failed attempt, so `maxAttempts` still ends in needs-info). The shift report gets `- Frozen paths changed: <files>`, and the next shift's prompt (`buildShiftPrompt`) says the frozen globs must not be edited
- [x] Glob matching supports `*`, `**` and `?` with no new dependency: `path.matchesGlob` where the Node version has it, else a small in-repo glob-to-RegExp helper (the repo supports Node ≥ 22.0, and `matchesGlob` arrived in 22.5)
- [x] Without a worktree (worktree disabled) the check is skipped, with no error
- [x] Plan and research tickets (`trackerOnly`) are not checked
- [x] Tests: parse-ticket (line present, absent, both separators), config (valid, invalid type), git `changedFiles`, runner (frozen touched → retry with note; untouched → resolve; config default applies)
- [x] `skills/shiftwork/references/tickets.md` (and the copy under packages/pi/skills/shiftwork/references/), the Shiftwork lines table, and docs/guide.md §4 document `**Frozen:**`

## Comments

### Notes

- Typical use: a Frozen line listing the globs `packages/*/test/fixtures/**` and `package.json`. A ticket that is meant to change tests simply does not freeze them.
- Keep the vocabulary: add **Frozen path** to CONTEXT.md under Work ("a path a ticket's shifts may not change, so its verify gate measures what it measured before"; avoid: protected file, locked path).

### Shift — manual (claude)
- Outcome: resolved
- Core: `parseTicket` reads `**Frozen:**` into `frozen` (backtick spans, else `·`/`,`); config `frozen` (default `[]`, validated); `packages/core/src/glob.js` (`matchesGlob`: `path.matchesGlob` when present, else `globToRegExp`); runner `frozenOf`/`frozenChanges`: a resolve whose branch changed a frozen path becomes a failed attempt (`- Frozen paths changed: …`, needs-info with the branch kept at `maxAttempts`); `buildShiftPrompt` names the frozen globs.
- CLI: `changedFiles(t)` in `packages/cli/src/git.js` (`git diff <target>...HEAD`, uncommitted and untracked; tracker copy and setup output excluded).
- Docs: tickets reference (+ synced copies), config reference, issue-tracker lines, guide §4/§7/config table (en, uk), CONTEXT "Frozen path".
- Verify: `node --test packages/core/test/parse-ticket.test.js` · `node --test packages/core/test/runner.test.js` · `node --test packages/cli/test/git.test.js` · `node --test packages/core/test/config.test.js` passed; `npm test` passed.
