# Spec: watch GitHub issues and feed them to the runner ("dark factory" mode)

**Status:** needs-triage

Source: GitHub issue #8 (Ivlad003/shiftwork, 2026-10-01): "auto-monitor new GitHub issues in the project, investigate, split into tasks, ready-to-implement; may monitor labels; parameters for this mode; a TUI tab and a toggle; `--dark-factory-mode`". Vocabulary: `CONTEXT.md`. Needs design decisions (below) before tickets are ready.

## Problem Statement

Work arrives as GitHub issues, but Shiftwork only reads `.scratch/`. Today an operator copies each issue into a spec by hand, splits it into tickets and runs the runner. Nothing watches for new issues or reports progress back to GitHub.

## Proposed Solution

1. **Import, don't replace the tracker.** A watcher polls `gh issue list --repo <repo> --label <in-label> --state open --json number,title,body,labels,author,url` every `pollMin` minutes and writes each new issue as `.scratch/gh-<N>-<slug>/spec.md` with `**Status:** needs-triage` and a `Source: github#N <url>` line. The runner, frontier and verify gate stay as they are. `gh` calls live in `packages/cli` (ADR-0004: core has no backend dependencies).
2. **Split shift.** For a `needs-triage` spec from GitHub, the runner starts a planning shift (cheap tier by default) that investigates the repo and writes `issues/NN-*.md` tickets, each with acceptance checkboxes and `**Verify:**`, then marks them `ready-for-agent`. Too vague → `needs-info`, and the question goes back to GitHub as a comment.
3. **Write back.** On claimed / resolved / needs-info: sync labels (`shiftwork:claimed`, `shiftwork:resolved`, `shiftwork:needs-info`), comment with the shift report and branch/commit, and optionally close the issue when every ticket is resolved.
4. **Config.** `github: { repo, labels: { in, claimed, resolved, needsInfo }, pollMin, authors, autoSplit, autoClose, project }`.
5. **CLI and TUI.** `shiftwork watch` (and `run --dark-factory`: watch + run the frontier continuously). A **GitHub** tab in the TUI lists watched issues and their import state; a key toggles a detached watcher, like `r` for the runner.

## Open Questions (for the operator)

- **Trust.** Issue text is untrusted input to an unattended agent that spends money and writes code (prompt injection). Proposed default: import only issues by `authors` (default: the repo owner) or carrying the `in` label set by a maintainer; budgets stay on. Agree?
- **Source of truth.** Labels on repo issues, or the Projects v2 board's Status field (needs `gh auth refresh -s read:project,project`)? Proposed: labels first, the board later.
- **Splitting.** Is a dedicated split/triage shift (with a `to-issues`-style skill) acceptable, or should every GitHub issue become exactly one ticket?
- **Closing.** Close the GitHub issue on resolve, or only comment and label?
- **Mode name.** `--dark-factory` vs `watch --run`.

## Draft tickets (once the questions are answered)

1. `github` config block + validation; `gh` wrapper in `packages/cli/src/github.js` with an injectable runner for tests.
2. Importer: issue → `.scratch/gh-<N>-<slug>/spec.md`, idempotent (state in `.pi/shiftwork-github.json`), filtered by label and author.
3. `shiftwork watch` command (poll loop, STOP-aware, `--once`).
4. Split shift: route `needs-triage` GitHub specs to a planning shift that writes tickets.
5. Write-back: labels and comments on claim / resolve / needs-info; optional close.
6. `run --dark-factory`: watch + run together.
7. TUI GitHub tab and watcher toggle.
8. ADR: GitHub as an import source, not a tracker.
