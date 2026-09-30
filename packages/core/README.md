# shiftwork-core

Core of [Shiftwork](https://github.com/Ivlad003/shiftwork). It parses Markdown tickets and computes the **frontier**: tickets with `Status: ready-for-agent` whose blockers are all `resolved`. It has no pi or OpenCode dependencies.

```js
import { loadTickets, frontier } from "shiftwork-core";
const next = frontier(await loadTickets(process.cwd()))[0];
```

## Ticket format

The format is the [mattpocock-skills](https://github.com/mattpocock/skills) local tracker (`.scratch/<feature>/issues/NN-slug.md`), plus optional Shiftwork lines:

```markdown
# 01: Email validation in signup

**Blocked by:** None (can start immediately)
**Status:** ready-for-agent
**Type:** code
**Model:** anthropic/claude-sonnet-4-5
**Skills:** +design
**Budget:** $2 · 50 turns
**Verify:** `npm test -- signup` · `npm run lint`

- [ ] Invalid email → 400
```

Status: early development.
