# 03: `llms.txt` and `llms-full.txt`

**What to build:** Root `llms.txt` per llmstxt.org (H1 title, `>` summary, sections of links to README, CONTEXT.md, docs/adr, the specs and each package README) and `npm run llms` generating `llms-full.txt` by concatenating those files. A test checks every link in `llms.txt` resolves to a file (spec story 7).

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `npm test`

- [x] `llms.txt` follows the llmstxt.org structure
- [x] Link-check test
- [x] `npm run llms` is deterministic (running it twice gives the same file)

### Notes

- Root `llms.txt`: H1 + `>` summary, then sections Docs (README, guide, CONTEXT, RESEARCH), Decisions (5 ADRs), Specs (all four features), Packages (4 package READMEs) — all links are repo-relative.
- `scripts/llms.mjs` (no deps, no build step): extracts relative links from `llms.txt` (skipping `scheme://` and anchors), errors on missing files, and concatenates each file under a `# <path>` header into `llms-full.txt` in link order. No timestamps/globs, so identical inputs → identical output. `npm run llms` = `node scripts/llms.mjs`.
- `llms-full.txt` is generated, so it is gitignored; the test regenerates it in the worktree.
- Tests in `packages/cli/test/llms.test.js` (picked up by the existing root `npm test` glob): llmstxt.org structure (H1, `>` summary, every `##` section has links), every link resolves to a file, and running `scripts/llms.mjs` twice yields byte-identical `llms-full.txt` (also compared against `buildFullText`).
- New specs need their link added to `llms.txt` by hand (the file is static, per spec story 7).

Verify: `npm test` — 393 tests, 384 pass, 9 skipped (pre-existing skips), 0 fail.

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 17715 in / 9065 out tokens, $0.1091, 15 turns
- Time: 2m 54s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/local-and-skills-03 into main

### Review — pi opencode-go/glm-5.3 (medium)
- Verdict: accept — All three acceptance criteria are met, the change matches the spec's llms.txt decision exactly, and the verify gate passes with 0 failures; only trivial nits remain.
- Time: 42s
- Verify: passed
- Findings:

> The ticket's acceptance criteria and landed diff look consistent. Now let me run the verify gate and sanity-check the linked files exist.
> Verify gate passes (394 tests, 385 pass, 9 pre-existing skips, 0 fail) and every link in `llms.txt` resolves. Let me quickly confirm the uncommitted working-tree changes are just post-landing bookkeeping, not part of the ticket.
> Everything checks out. Here's my review of ticket local-and-skills/03.
> 
> ## Review findings
> 
> **Acceptance criteria — all met:**
> - ✅ `llms.txt` follows the llmstxt.org structure: H1 title, `>` summary blockquote, then `## Docs`, `## Decisions`, `## Specs`, `## Packages` sections — exactly what the spec's llms.txt decision and spec story 7 ask for (README, guide, CONTEXT, RESEARCH, 5 ADRs, all four specs, all four package READMEs).
> - ✅ Link-check test: `packages/cli/test/llms.test.js` asserts every relative link resolves to a file, and I independently verified all 17 linked paths exist in the repo.
> - ✅ `npm run llms` deterministic: `scripts/llms.mjs` has no timestamps or globs — fixed link order, so identical inputs → identical output; the test runs it twice and compares byte-identical output against `buildFullText` as well.
> 
> **Spec compliance:** Matches the "llms.txt" Implementation Decision verbatim (title, summary, sections of links, `npm run llms` concatenating docs into `llms-full.txt`, link-existence test). Per the ticket notes, `llms.txt` is static — new specs need their link added by hand, which is consistent with story 7 (nothing required it to be auto-generated).
> 
> **Repo standards:** No new dependencies, no build step — plain ESM, `node --test` glob picks up the new test, `llms-full.txt` correctly gitignored as a generated artifact.
> 
> **Verify gate:** `npm test` — 394 tests, 385 pass, 9 skipped (pre-existing), 0 fail. (One more test than the ticket's report of 393/384 — the follow-up commit `10eb463` added one.)
> 
> **Minor nits (not blocking):**
> - `buildFullText` computes `extractLinks(llms)` twice (once for the return value, once in the loop) — a harmless duplicate pass over the same text; could reuse the `links` variable.
> - The working tree has uncommitted changes to the ticket file and spec.md, but those are the shift report and the runner's status-table bookkeeping after landing, not ticket code.

### Review — operator (Claude Code), 2026-09-30
- First live review shift: it ran after landing on `standard`, recorded `accept` with findings, and both reports carry the new `- Time:` line. Works as designed.
- `llms.txt` checked by hand: llmstxt.org shape, every link resolves; `npm run llms` → 17 files, 142 KB; `llms-full.txt` is gitignored (generated), so agents reading the repo on GitHub only get `llms.txt`. Fine for now; publish `llms-full.txt` if a docs site appears.
- Verdict: accept.
