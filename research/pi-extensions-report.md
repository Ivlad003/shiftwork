# Reusable pi code and packages for the autonomous ticket runner

Raw subagent report, 2026-09-30. Checked against pi v0.99.1 (commit of 2026-09-29). Paths are relative to `pi/packages/coding-agent/` unless marked otherwise. The summary is in `../RESEARCH.md` §8.

**The short answer:**
- **Nothing on the gallery combines ticket frontier, Verify gate, per-type routing, skill tiers and provider fallback.** We have to write the orchestration ourselves.
- **What we can reuse is mostly pi's own examples and helpers.** The best pieces are the subagent example's process spawning, the `jev-router.ts` virtual-model pattern, and pi-ai's retry-error patterns.
- **Two license limits:** `@mjasnikovs/pi-task` is AGPL-3.0, so we can read it for ideas but not copy code. `pi-model-auto-router` has no license, so we can't copy it either.
- **Main open risk:** no package uses `ctx.modelRegistry.classify`, so the Jev classifier needs a short test first.

---

## A. Official examples

### `examples/extensions/subagent/` (index.ts, agents.ts, agents/*.md, prompts/*.md)

**How it spawns** (`index.ts:300-350`):
```ts
const args = ["--mode","json","-p","--no-session"];
if (model) args.push("--model", model);            // agent.model ?? parent `${provider}/${id}`
if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
args.push("--append-system-prompt", tmpPromptPath); // agent body written to mkdtemp file, mode 0o600
args.push(`Task: ${task}`);
spawn(inv.command, inv.args, { cwd, shell:false, stdio:["ignore","pipe","pipe"] });
```

**Finding the pi binary** (`getPiInvocation`, `index.ts:249`): it uses `process.execPath` plus `process.argv[1]`, falling back to `pi` on PATH. It also handles Bun-compiled binaries.

**Parsing NDJSON:**
- It buffers stdout and splits on `\n`. The partial last line is kept for the next chunk and flushed on `close`.
- On `message_end`, if `role==="assistant"`, it accumulates `usage` and records `stopReason` and `errorMessage`.
- Failure is `exitCode!==0 || stopReason==="error"||"aborted"` (`index.ts:183`).
- **Gotcha (verified):** it also listens for `tool_result_end`, which does not exist anywhere in `src/` or `docs/json.md`. Tool results arrive as `message_end`.
- The event stream is documented in `docs/json.md`. It includes `agent_end{willRetry}`, `agent_settled`, `auto_retry_start/end{finalError}` and `compaction_*`. Use `agent_settled` for "really done".

**Abort:** SIGTERM, then SIGKILL after 5s, wired to the tool's `signal`.

**Concurrency:** `MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, and a `mapWithConcurrencyLimit` worker pool of about 15 lines (`index.ts:219`).

**Streaming render:**
- `onUpdate({content, details})` is called after every event.
- In parallel mode, results start with `exitCode:-1` to mean "running".
- `renderCall` and `renderResult` show ✓/✗, tool calls and usage.
- Modes are single, parallel `tasks[]`, and chain (`{previous}` substitution).

**Agent discovery** (`agents.ts`):
- Reads `*.md` from `getAgentDir()/agents` and the nearest `.pi/agents` found walking up from cwd.
- Frontmatter is parsed with `parseFrontmatter`, fields `name, description, tools (string|array), model`. The body is the system prompt.
- Project agents override user agents by name.
- Project agents need `ctx.ui.confirm` unless `ctx.isProjectTrusted()`.

### `jev-router.ts`
- `pi.registerVirtualModel<State>({provider,id,thinkingLevels,contextWindow,maxTokens, route(request,ctx)})` returns `{model, thinkingLevel, state}`.
- `state` is stored on the session branch, so it survives compaction.
- Route reasons (`docs/virtual-models.md:77-84`):
  - `direct`: requests outside the agent loop, such as compaction.
  - `user` and `continuation`.
  - `retry`: comes with `request.failed.message.{stopReason,errorMessage}`. The docs explicitly allow switching model on retry.
- Classifier call:
  ```ts
  const jev = ctx.modelRegistry.findOfType("classifier","typesafe","jev-latest");
  const r = await ctx.modelRegistry.classify(jev, { state:{prompt}, questions:{ complexity:{ type:"choice", instructions, criteria:{standard:"…",complex:"…"} } } }, {signal});
  r.stopReason==="stop" && r.answers.complexity.probabilities.complex >= 0.5
  ```
  This needs `TYPESAFE_API_KEY`. `classify` "never rejects" (`src/core/model-registry.ts:168`).
- It keeps the previous model on the first route to avoid a prompt-cache miss.

### Fresh session in-process
The API exists (`src/core/extensions/types.ts:401-455`). It is command-only: `ExtensionCommandContext.newSession({parentSession?, setup?, withSession?})` returns `{cancelled}`. `ReplacedSessionContext` adds an async `sendUserMessage`.

**Examples:**
- `handoff.ts:175` is the only one using `withSession`. It only calls `setEditorText`; it does not send a message.
- `test/suite/regressions/2860-replaced-session-context.test.ts:147-199` shows `await replacedCtx.sendUserMessage(...)` inside `withSession`, and confirms that the old `ctx` and `pi` throw afterwards.
- The pattern we want, used by rahulmutt/pi-ralph and pi-task:
  ```ts
  await ctx.newSession({ parentSession, withSession: async (rctx) => { active = rctx; await rctx.sendUserMessage(prompt); await rctx.waitForIdle(); } });
  ```

**Behaviour:**
- `sendUserMessage` → `AgentSession.prompt()` → `await this._runAgentPrompt()` (`src/core/agent-session.ts:1883-2026, 2280`). It appears to resolve when the run ends; this hasn't been confirmed at runtime.
- If it is called while `agent_settled` handlers are running, the prompt is deferred (`agent-session.ts:1884`).

**Gotchas (from the third-party packages):**
- **The extension module reloads on every newSession,** so state kept in closures is lost. rahulmutt keeps it on `globalThis[Symbol.for(...)]`.
- **`waitForIdle` is not the same as the ticket being done.** Threshold compaction can leave the agent idle, so pi-task re-sends "continue" up to N times.

### Other examples
- **`todo.ts`:** state lives in the tool result `details`. It is rebuilt from `ctx.sessionManager.getBranch()` on `session_start` and `session_tree`. Use this for per-branch state; use `pi.appendEntry()` for data the model shouldn't see (`docs/extensions.md` State table).
- **`plan-mode/`:**
  - `pi.setActiveTools()` / `getActiveTools()`, and a `tool_call` bash allowlist returning `{block:true, reason}`.
  - `before_agent_start` returns `{message:{customType, content, display:false}}` to inject hidden context.
  - The `context` hook filters those messages out afterwards.
  - Progress markers `[DONE:n]` are parsed on `turn_end` (`utils.ts:154`). `pi.registerFlag("plan")` adds a CLI flag.
- **`send-user-message.ts`:** checks `ctx.isIdle()`; otherwise uses `pi.sendUserMessage(t, {deliverAs:"steer"|"followUp"})`.
- **`trigger-compact.ts`:** on `turn_end`, `ctx.getContextUsage().tokens` is compared with a threshold, then `ctx.compact({customInstructions,onComplete,onError})`.
- **`custom-compaction.ts`:**
  - `session_before_compact` gets `preparation.{messagesToSummarize,turnPrefixMessages,firstKeptEntryId,previousSummary}`.
  - Summarises with a cheap model through `ctx.modelRegistry.complete`.
  - Returns `{compaction:{summary,firstKeptEntryId,tokensBefore,usage}}`, or `undefined` to use the default compaction.
- **Per-model compaction is built in:** `compaction.modelOverrides` keyed by exact `provider/modelId` (`docs/settings.md:71`, `docs/compaction.md:439-457`). No code needed.
- **`file-trigger.ts`:** `fs.watch` plus `pi.sendMessage({customType,content,display}, {triggerTurn:true})`. This is a pattern for an external kick, for example touching a file to stop the runner.
- **`git-checkpoint.ts`:** on `turn_start`, `pi.exec("git",["stash","create"])` returns a ref for a snapshot that leaves the working tree alone. It is restored on `session_before_fork`. Useful for rolling back a ticket that failed Verify.
- **`model-status.ts` / `status-line.ts`:** `model_select{model,previousModel,source}` and `ctx.ui.setStatus(key, theme.fg(...))`.
- **`dynamic-resources/`:** `pi.on("resources_discover", () => ({skillPaths, promptPaths, themePaths}))`. This lets an extension add skills at runtime.
- **`permission-gate.ts` / `protected-paths.ts`:** `tool_call` returns `{block:true,reason}`. Guard on `ctx.hasUI`: without a UI, auto-deny. That matters for an unattended runner.
- **`sandbox/`:**
  - Replaces `bash` with `createBashTool(cwd, {operations})` using `@anthropic-ai/sandbox-runtime`.
  - `user_bash` returns operations; `session_shutdown` cleans up.
  - Its `package.json` has `"pi":{"extensions":["./index.ts"]}`.
- **`preset.ts`:**
  - Merges `~/.pi/agent/presets.json` and `.pi/presets.json`.
  - Applies `ctx.modelRegistry.find(provider,model)` → `await pi.setModel()`, `pi.setThinkingLevel()`, `pi.setActiveTools()`.
  - Adds instructions in `before_agent_start`. Supports `--preset` and `/preset`.
  - A good template for a Type → model/tools/instructions table.
- **Skill filtering:**
  - `before_agent_start.systemPromptOptions` is "Mutable prompt sections" (`types.ts:903`) and has `skills: Skill[]`.
  - `examples/sdk/04-skills.ts:31` filters it: `current.skills.filter(...)`.
  - For spawned children, `-ns --skill <path>` (repeatable) keeps only the explicit skills (`docs/cli.md:198-201`).

### `docs/packages.md`
- `package.json` needs `"keywords":["pi-package"]` for the pi.dev gallery.
- Declare resources as `"pi":{"extensions":[...],"skills":[...],"prompts":[...],"themes":[...]}` (globs allowed). Without it, pi uses the conventional `extensions/ skills/ prompts/ themes/` directories.
- Host packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) go in `peerDependencies: "*"`, **never** in `dependencies`.
- Install with `pi install npm:…|git:…|./local`, add `-l` for a project-scoped install, or try once with `pi -e`.

---

## B. Third-party packages

### Ralph loops and orchestrators

| Package | License / updated | Fresh context | Completion | Limit handling | What to take |
|---|---|---|---|---|---|
| @lnilluv/pi-ralph-loop v2.1.0 — github.com/lnilluv/pi-ralph-loop | MIT / 2026-09-08 | New `pi --mode rpc --no-session --no-extensions -e <ext>` child each iteration (`src/runner-rpc.ts:183`); waits for `set_model` and `set_thinking_level` acks before `prompt` | Exact `<promise>` match (`src/ralph.ts:1669`), then acceptance commands (`src/runner.ts:1052-1090`); a failed check keeps looping | None (only RPC failures, timeouts, stdout line cap) | Closest to what we're building. RPC handshake state machine, stop/cancel signal files, `iterations.jsonl`/`events.jsonl` logs |
| @rahulmutt/pi-ralph v0.4.0 — github.com/rahulmutt/pi-ralph | Apache-2.0 / 2026-04 (stale) | `ctx.newSession({withSession})` + `sendUserMessage`; waits on a promise resolved in `agent_end` | Fixed N iterations | None | Smallest newSession reference; the `globalThis` state trick (`extensions/index.ts:124-175`) |
| @pi-unipi/ralph v2.20.5 — Neuron-Mr-White/unipi `packages/ralph` | MIT / 2026-09-19 | Same session; `ralph_done` tool queues `followUp` (`tools.ts:144`) | `<promise>COMPLETE</promise>` on `agent_end` (`index.ts:136`) | None | Per-iteration reminder as a hidden `customType` message, keeping the cached prompt prefix stable (`index.ts:141-160`) |
| pi-ralph (samfoy, hat-based) v1.0.1 — github.com/samfoy/pi-ralph | MIT / 2026-09-24, **deprecated** | Calls a saved `ctx.newSession` from `agent_end` — likely a stale-context bug (untested) | Hat events plus `LOOP_COMPLETE` | None | Pure `determineNextAction` in `lib.ts:575-645`: max iterations, max runtime, stall and cycle detection |
| @mjasnikovs/pi-task | **AGPL-3.0** / 2026-09-30 | `newSession` per task (`src/task/orchestrator.ts:804`); verify workers are `pi --mode json` children | Separate read+bash verify child returns PASS/FAIL/UNOBSERVED; FAIL means a re-run (`src/task/verify-work.ts`) | `turnErrorMessage`: last `stopReason==="error"` and not aborted (`src/task/implementation-turn.ts`) | **Ideas only, no code.** A child with a provider error exits 0 with empty text; continue across compactions |
| pi-subagents (nicobailon) v0.73.1 — github.com/nicobailon/pi-subagents | MIT / 2026-09-27 | Child processes; background runs use `--no-extensions --no-skills --no-prompt-templates --no-session --mode rpc --extension <bootstrap>` (`src/runs/background/async-execution.ts:726`) | Acceptance levels plus `verify` commands (`src/runs/shared/acceptance.ts`) | Per-event `stopReason`/`errorMessage` check | `getPiSpawnCommand` (`src/runs/shared/pi-spawn.ts:169`); `git worktree` code (`src/runs/shared/worktree.ts`); **removed in-launch `fallbackModels` in favour of a fresh launch on another model** (CHANGELOG ~281) |
| @tintinweb/pi-tasks — github.com/tintinweb/pi-tasks | MIT / 2026-08-24 | Delegates to `@tintinweb/pi-subagents` over `pi.events` RPC | `blockedBy` all completed → auto-cascade (`src/index.ts:310`) | On failure, back to pending | O_EXCL lockfile with pid+uuid and stale-pid reclaim (`src/task-store.ts:27-58`) — the model for `claimed` |
| pi-herdr-agents (giuseppecrj) | MIT / 2026-09-28 | `pi --session <file>` in Herdr panes | `subagent_done` tool writes `${session}.exit` then `ctx.shutdown()`; finishes on `agent_settled` | `findLatestAssistantError` | "Done" tool plus exit-file pattern; worktrees are Herdr-only, not portable |

### Fallback and routing packages

| Package | Detects limits by | Resumes by | Notes |
|---|---|---|---|
| pi-provider-fallback — github.com/37/pi-provider-fallback (MIT, 2026-08) | `agent_end` `stopReason==="error"` + three regex groups (`provider-fallback.ts:58-65`) | `setModel` then re-send the last user message | Worth copying: compact before switching to a smaller context window (`:233-243`). Re-sending duplicates the turn and races pi's auto-retry |
| pi-model-fallback — github.com/eiei114/pi-model-fallback (MIT, v0.5.0, 2026-09-27) | `after_provider_response` status/headers; status parser (`lib/error-status.ts`) | `followUp` with the last prompt | Worth copying: persistent cooldown from `retry-after`/`x-ratelimit-reset*` (`extensions/index.ts:449-465`), loop guard, reset on manual `model_select`. Misses text-only quota errors |
| pi-auto-models — github.com/Fatpandac/pi-auto-models (MIT) | 429/529 or `/rate_limit/` | Model switch only, no resume | Status-bar quota display |
| pi-failover — github.com/gooyoung/pi-failover (MIT in package.json, no LICENSE file) | Status code, then text (`src/index.ts:39-55`) | **Best resume found:** in `message_end`, rewrite the error to `stopReason:"stop"` and send a hidden `sendMessage(…,{triggerTurn:true,deliverAs:"followUp"})` (`:272-281`) | Also calls private `runtime.setRuntimeApiKey` — avoid that part |
| pi-fallback-models — github.com/dev-willbird1936/pi-fallback-models (MIT) | Adds `usage limit`, `credit balance`, `plan limit`; excludes context-overflow errors | Switches on `agent_settled` after 3 failures | Bug: reads `willRetry`, which extension `agent_end` events don't have |
| win4r/pi-jev-router, mejiasd3v/pi-jev-router, da-vinci-noob/pi-jev-model-router (MIT) | — | — | All three call TypeSafe over HTTP, not `modelRegistry.classify`. mejiasd3v injects skill bodies through the `context` hook (`index.ts:363-432`) |

The npm name `pi-fallback` belongs to someone else and has no repo. No package was found that filters skills by model tier.

**Key pi facts for fallback:**
- **Quota and usage errors are never auto-retried.** `packages/ai/src/utils/retry.ts` defines `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` and `RETRYABLE_PROVIDER_ERROR_PATTERN`, and exports `isRetryableAssistantError` (`:246`).
- **So the virtual-model `retry` route only sees transient errors** (429 rate limits, 5xx). Quota errors need handling in `message_end`, `agent_before_settle` or `agent_settled`.
- **Extension `agent_end` events have no `willRetry`** (`types.ts:912`). RPC and JSON children do get it.
- **`agent_before_settle` returning `{continue:true}` exists** (`types.ts:960-976`), but no package uses it and it hasn't been tested.

---

## C. Recommendations

**Write ourselves (the core):**
- **Ticket parsing and frontier:** status plus `Blocked by`, same logic as tintinweb's `blockedBy` check.
- **Claim lock:** adapt tintinweb's O_EXCL lock (MIT, credit it).
- **Runner loop and stop rules:** a pure `decideNext(state)` in the style of samfoy (max attempts, runtime, stall detection).
- **Verify gate:** Verify commands decide; a `<promise>` token is advisory only.
- **Type → {model, thinking, tools, skills} routing table:** in the style of `preset.ts`.

**Fresh context, primary path:** a child process per ticket, spawned with:
```
pi --mode json -p --no-session --model <m> -ns --skill <s>… --append-system-prompt <file> "<ticket>"
```
- Copy `getPiInvocation`, the NDJSON parser, `mapWithConcurrencyLimit` and the abort handling from `subagent/index.ts` (MIT, pi repo).
- Treat `agent_settled` as the end. Treat `stopReason:"error"` as failure even when the exit code is 0.
- If mid-run control is needed (model acks, steering), use `--mode rpc` like lnilluv.
- Skill filtering comes free through `-ns --skill`, and a fresh launch per ticket makes a provider switch clean. This matches the pi-subagents lesson.

**Fresh context, secondary path:** an interactive `/run-tickets` command using `ctx.newSession({withSession})`.
- Keep state on `globalThis[Symbol.for(...)]`.
- Continue the ticket when `waitForIdle` returns without Verify passing.

**Fallback:** two layers.
1. A `registerVirtualModel` router that switches provider on `reason:"retry"`, pattern taken from `jev-router.ts`.
2. For quota errors, use pi-ai's pattern lists plus eiei114's cooldown file. In the runner, relaunch the ticket on the next provider. In-session, use gooyoung's `message_end` rewrite and hidden follow-up.

**Depend on nothing third-party at runtime.** The orchestrator packages are huge (pi-subagents ~240k LOC) or deprecated, and none do what we need.

**Skills filtering:** a `before_agent_start` handler filters `event.systemPromptOptions.skills` in place, keyed on the routed tier. That covers the in-session path; children use `-ns --skill`.

**Compaction:** ship recommended `compaction.modelOverrides` settings in the README; no code needed.

**Jev classifier:** wrap `ctx.modelRegistry.classify` with a fallback to the ticket's `**Model:**` or `**Type:**` field. Test it first — no package uses it.

**Unverified:**
- Whether `sendUserMessage` in `withSession` resolves only when the run completes.
- Whether `agent_before_settle {continue:true}` works for resuming.
- Whether `classify` works in practice.
- The exact foreground spawn arguments in pi-subagents.
- The fallback logic in pi-jev-model-router.
