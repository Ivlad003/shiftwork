# 03: `llms.txt` and `llms-full.txt`

**What to build:** Root `llms.txt` per llmstxt.org (H1 title, `>` summary, sections of links to README, CONTEXT.md, docs/adr, the specs and each package README) and `npm run llms` generating `llms-full.txt` by concatenating those files. A test checks every link in `llms.txt` resolves to a file (spec story 7).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `npm test`

- [ ] `llms.txt` follows the llmstxt.org structure
- [ ] Link-check test
- [ ] `npm run llms` is deterministic (running it twice gives the same file)
