# 02: Research step before implementation, read if needed

**What to build:** A `Type: research` ticket that writes the feature's `research.md`, and shift prompts that point at that file when it exists (see the spec's "Decision (operator)").

**Blocked by:** 01

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/core/test/prompt.test.js` · `node --test packages/cli/test/github-import.test.js`

- [x] `buildShiftPrompt` (packages/core/src/prompt.js) adds `- Research: <path> (read it if you need background)` to plan and implementation prompts only when `.scratch/<feature>/research.md` exists; the path is absolute when the prompt is absolute, like the spec path
- [x] A `research`-type ticket's prompt opens "Research for Shiftwork ticket …", tells the agent to write sources, facts, decisions and open questions to `- Write findings to: <research.md>` (the tracker's copy by absolute path in a worktree) and not to edit product code
- [x] The plan ticket written by github-import (`formatPlanTicket`) asks for a `**Type:** research` ticket `02` when the issue needs reading first, with Verify `test -s .scratch/<feature>/research.md` and the implementation tickets blocked on it, and to skip it otherwise
- [x] The shiftwork skill (`SKILL.md`, `references/tickets.md`) and docs/guide.md section 4 describe the research ticket
- [x] Tests in packages/core/test/prompt.test.js and packages/cli/test/github-import.test.js
- [x] runner.js: treat `research` like `plan` for the unchanged-tree check and the review skip (`trackerOnly`)
