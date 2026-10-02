# Spec: dark-factory mode — take work from GitHub issues, report back

**Status:** ready-for-agent

Source: GitHub issue #8 (Ivlad003/shiftwork, 2026-10-01), operator answers 2026-10-01. Vocabulary: `CONTEXT.md`.

## Problem Statement

Work arrives as GitHub issues, but Shiftwork only reads `.scratch/`. Today an operator copies each issue into a spec by hand, splits it into tickets and starts the runner, and nothing tells the issue what happened.

## Solution

`shiftwork run --dark-factory` watches the repo's GitHub issues and runs the frontier continuously:

1. **Who may give work: collaborators.** Only open issues whose author is a collaborator of the repo (`gh api repos/<repo>/collaborators`, cached per poll) are imported; `github.authors` adds logins, `github.labels.in` (optional) narrows to issues with that label. Anyone else's issue is ignored — issue text is untrusted input to an unattended agent.
2. **Import.** Each new issue becomes `.scratch/gh-<N>-<slug>/spec.md` (title, body, `Source: github#<N> <url>`, author) plus a planning ticket `issues/01-plan.md` (`**Type:** plan`). State lives in `.pi/shiftwork-github.json` (issue → feature, last comment seen, what was posted), so polling is idempotent.
3. **Plan, then build.** The planning shift investigates the repo and writes the implementation tickets `02…` (`ready-for-agent`, with Verify lines), one or several depending on the issue. If the issue is unclear it ends with `<shiftwork:needs-info reason="…"/>` and the question is posted as a GitHub comment; a collaborator's reply is appended to the ticket's `## Comments` and the ticket goes back to `ready-for-agent`.
4. **Report back, never delete.** The watcher syncs ticket state to the issue: a comment when work starts, a comment per resolved ticket with its shift report and links to the landed commits (`https://github.com/<repo>/commit/<sha>`, found by `git log --grep "shiftwork: <feature>/<NN>"`), the needs-info question, labels `working` / `needs-info` / `done` (configurable names, defaults `shiftwork:working` / `shiftwork:needs-info` / `shiftwork:done`). When every ticket of the issue is resolved the issue is **closed** with a summary comment (`github.autoClose`, default true). Nothing on GitHub is deleted.
5. **TUI.** A **GitHub** tab lists watched issues (number, title, feature, state, last sync); a key toggles a detached dark-factory runner.

## Implementation Decisions

- **Source of truth: issue labels and comments** (operator decision 2026-10-01), not the Projects v2 board (the board's Status column needs the `read:project` / `project` token scopes). The board is a later, optional ticket.
- **Labels are checked, never silently created.** `github.labels.in` is required config; at start dark-factory checks every configured label exists in the repo and exits 1 with the missing names, the fix (`shiftwork github labels --create`) and a pointer to the guide's "Dark-factory: labels" section, which explains each label and the setup steps (ticket 09).
- **The operator's own `gh` CLI does all GitHub work** (operator decision 2026-10-01). Shiftwork runs the installed `gh` binary (from `PATH`, or `github.gh` with a path) with the operator's existing `gh auth login` session: no tokens in the config, no `GITHUB_TOKEN` handling, no Octokit or HTTP client, no new dependency. `gh` missing → error with the install link; not logged in → error telling to run `gh auth login`.
- **No runner core changes for GitHub.** `gh` calls live in `packages/cli/src/github.js` behind an injectable `exec` (ADR-0004: core has no backend dependencies). Write-back is a reconcile step run every poll: compare tickets on disk and `.pi/shiftwork-github.json` with what was posted, post the difference.
- **Planning is an ordinary ticket.** Its Verify gate is `shiftwork tickets check <feature> --min 1` (new): passes when the feature has at least one ticket besides `01-plan` that is `ready-for-agent`, has acceptance checkboxes and a `**Verify:**` line.
- **Config:** `github: { repo, authors, labels: { in (required), working, needsInfo, done }, pollMin (default 5), autoClose (default true), push (default false), planTier }`, validated in `packages/core/src/config.js`; `repo` defaults to the `origin` remote.
- **Commit links need the commits on GitHub.** The runner lands on local `main`; `github.push: true` (default false) lets dark-factory mode `git push` main after a landing so the links resolve. Without it the comment shows the sha only.
- An ADR records "GitHub is an import source, not a tracker".

## Out of Scope

- The Projects v2 board as a source (later ticket).
- Pull requests per ticket (the runner keeps landing on `main`).

<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | `github` config block and an injectable `gh` wrapper | resolved | opencode-go/glm-5.3 |
| 02 | `shiftwork tickets check <feature>` — the planning ticket's verify gate | resolved | opencode-go/glm-5.3 |
| 03 | Import collaborators' GitHub issues into `.scratch/` | resolved | opencode-go/glm-5.3 |
| 04 | Report ticket progress back to the GitHub issue | resolved | opencode-go/glm-5.3 |
| 05 | `shiftwork run --dark-factory` | resolved | opencode-go/glm-5.3 |
| 06 | TUI GitHub tab and dark-factory toggle | resolved | opencode-go/glm-5.3 |
| 07 | ADR — GitHub is an import source, not a tracker | resolved | opencode-go/space-bunny-free |
| 09 | Labels — config, startup check with an error, setup command, guide | resolved | opencode-go/glm-5.3 |
| 10 | Fix the review findings in GitHub sync, the gh wrapper and dark-factory | resolved | opencode-go/glm-5.3 |
| 11 | Tidy the GitHub code — one exec helper, shared constants and defaults | resolved | xai/grok-4.7 |
| 12 | Small fixes from the operator's review of ticket 10 | resolved | opencode-go/glm-5.3 |
<!-- shiftwork:tickets:end -->
