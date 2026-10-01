# Spec: review before landing

**Status:** ready-for-agent

Source: operator decision, 2026-10-01: "review first, then merge — it's more logical". Vocabulary: `CONTEXT.md`. Builds on `review-default` (on by default, verdict required) and `landing-race` (landing retries).

## Problem Statement

Today a ticket lands first and is reviewed afterwards (`review.when: "resolve"`). A `reopen` verdict leaves the reviewed commit on `main`, and the next shift fixes forward on top of it; `main` carries work a reviewer rejected, and other tickets may already build on it.

## Solution

- **New default `review.when: "before-land"`.** After the verify gate passes in the ticket's worktree, the review shift runs on the branch, before anything lands. The reviewer sees the branch's change against the target (`git diff <target>...HEAD` in the worktree).
  - **accept** → the branch lands (with the landing retries of `landing-race`).
  - **reopen** → nothing lands; the ticket goes back to `ready-for-agent` with the review under `## Comments`; the next shift continues on the **same branch and worktree**, with the review in its prompt, and is reviewed again after its gate passes.
  - **follow-up** → the branch lands and the follow-up ticket is filed, as today.
  - **no verdict** (after `review-default/02`'s retry) → nothing lands; `needs-info`, branch kept.
- **`review.when: "after-land"`** keeps today's behaviour (`"resolve"` stays accepted as an alias for it).
- A landing that needs a rebase after an accepted review re-runs Verify only, not the review. A landing conflict that makes the work be redone gets a fresh review of the redone work.
- `reopen` rounds are bounded: after `review.maxRounds` (default 2) reopen verdicts on one ticket, it goes to `needs-info` ("review rejected it N times"), branch kept.

## Implementation Decisions

- In `packages/core/src/runner.js`, the review moves from after `workspace.land` into the resolve path before it, for both the serial and the parallel landing paths; `runReviewShift` takes the worktree as `cwd` and the target name for the diff.
- `buildReviewPrompt` points at the branch diff (`git diff <target>...HEAD`, `git log <target>..HEAD`) for before-land reviews, and at the landed commits for after-land.
- The workspace keeps the worktree across a `reopen` (like today's reuse after a failed Verify).
- `--dry-run` shows `review=premium (before land)` / `(after land)`.
- Docs: `docs/guide.md` + `docs/guide.uk.md` ("Reviews after each ticket" → "Reviews"), `CONTEXT.md` (review shift), `skills/shiftwork/SKILL.md` "Review landed work" → reviews a branch before it lands, `references/config.md`, then `npm run sync-skills` and `npm run llms`.
