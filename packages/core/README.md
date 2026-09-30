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

## OpenSpec tracker

`openRepoTracker(root, config)` opens the repo's tracker: the mattpocock one above, or the OpenSpec tracker when `config.tracker` is `"openspec"` or `openspec/changes/` exists (`.scratch/` wins when both exist). Each change in `openspec/changes/` is a feature; each unchecked `- [ ] N.M` task in its `tasks.md` is a ticket blocked by the previous task. Status, shift reports and comments live in `.shiftwork.md` next to `tasks.md`, one `## N.M` section per task; resolving a task ticks its checkbox. The verify gate is `openspec.verify` (default `openspec validate <change>`) plus a task's own indented `Verify:` line.

```js
import { openRepoTracker } from "shiftwork-core";
const tracker = await openRepoTracker(process.cwd(), { tracker: "openspec" });
const next = (await tracker.frontier())[0];
```

Status: early development.
