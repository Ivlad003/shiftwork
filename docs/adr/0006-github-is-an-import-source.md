# GitHub is an import source, not the tracker

Work arrives as GitHub issues. The tracker itself stays local: per ADR-0001, tickets are Markdown files in `.scratch/<feature>/issues/NN-slug.md`, and the runner, the frontier and the verify gate are all built on those files. Per ADR-0004, `shiftwork-core` has no backend dependencies, and the same goes for GitHub: `gh` and the network stay in `packages/cli`, never in core.

GitHub is therefore an **import source** and a **report-back** channel, not a tracker.

## Decision

In dark-factory mode Shiftwork imports collaborators' issues into `.scratch/gh-<N>-<slug>/`, each with a spec naming the issue URL and one **planning ticket** that splits the issue into tickets `02…`. A **reconcile step** (`syncIssues`) reports progress back to the issue with comments, labels and closing — and never deletes. Nothing is ever deleted on GitHub: no issue, no comment. The only label ever removed is `labels.needsInfo` (and `labels.working` when `labels.done` is added), and labels are never created, only added, because they must already exist. Every post is recorded before the next one, so a crash re-posts at most one comment.

## Considered Options

- **Make GitHub Issues the tracker.** Tickets would live remotely and every shift would need network and auth, breaking the offline, fresh-clone property that ADR-0001 bought, and forcing core to know about a backend (ADR-0004).
- **Import once and never write back.** The issue would go silent for the whole run; the collaborator would not know work had started or finished.

## Consequences

- Edits to an issue after import are not re-synced. The one exception is a collaborator's reply to a needs-info question, which is appended to the ticket under `## Comments` and puts the ticket back on the frontier.
- Only collaborators are trusted as issue authors and as repliers. Anyone else is skipped at import and their replies ignored.
- GitHub state lives in `.pi/shiftwork-github.json` (git-ignored), so imports are idempotent and the local files remain the record of truth.
- The Projects v2 board is not a source yet; if it becomes one, it is another import source layered on the same local tracker.
