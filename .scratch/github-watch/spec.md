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
4. **Report back, never delete.** The watcher syncs ticket state to the issue: a comment when work starts, a comment per resolved ticket with its shift report and links to the landed commits (`https://github.com/<repo>/commit/<sha>`, found by `git log --grep "shiftwork: <feature>/<NN>"`), the needs-info question, labels `shiftwork:planning` / `shiftwork:working` / `shiftwork:needs-info` / `shiftwork:done`. When every ticket of the issue is resolved the issue is **closed** with a summary comment (`github.autoClose`, default true). Nothing on GitHub is deleted.
5. **TUI.** A **GitHub** tab lists watched issues (number, title, feature, state, last sync); a key toggles a detached dark-factory runner.

## Implementation Decisions

- **Source of truth: issue labels and comments**, not the Projects v2 board (the board's Status column needs the `read:project` / `project` token scopes). The board is a later, optional ticket.
- **No runner core changes for GitHub.** `gh` calls live in `packages/cli/src/github.js` behind an injectable `exec` (ADR-0004: core has no backend dependencies). Write-back is a reconcile step run every poll: compare tickets on disk and `.pi/shiftwork-github.json` with what was posted, post the difference.
- **Planning is an ordinary ticket.** Its Verify gate is `shiftwork tickets check <feature> --min 1` (new): passes when the feature has at least one ticket besides `01-plan` that is `ready-for-agent`, has acceptance checkboxes and a `**Verify:**` line.
- **Config:** `github: { repo, authors, labels: { in }, pollMin (default 5), autoClose (default true), planTier }`, validated in `packages/core/src/config.js`; `repo` defaults to the `origin` remote.
- **Commit links need the commits on GitHub.** The runner lands on local `main`; `github.push: true` (default false) lets dark-factory mode `git push` main after a landing so the links resolve. Without it the comment shows the sha only.
- An ADR records "GitHub is an import source, not a tracker".

## Out of Scope

- The Projects v2 board as a source (later ticket).
- Pull requests per ticket (the runner keeps landing on `main`).
