# OpenCode plugin system: can the ticket runner be an OpenCode plugin?

Raw subagent report, 2026-09-30. Checked against the installed OpenCode v2.0.19. The summary is in `../RESEARCH.md` §8.

## The most important finding: V1 and V2 are different APIs
- The installed `opencode v2.0.19` is OpenCode **V2**. Its source is tag `v2.0.19` of github.com/anomalyco/opencode (packages at version 2.0.19). The `dev` branch is still the 1.18.x line.
- **`https://opencode.ai/docs/plugins` documents the V1 API** (the `plugin` key and `@opencode-ai/plugin`). The V2 docs are at `https://opencode.ai/v2/docs/...`, for example `/v2/docs/build/plugins`. The source for those pages is `services/www/src/docs/content/` in the v2 tag.
- The V2 migration guide says: *"V1 plugin implementations do not run in V2. Moving a file or renaming its config entry is not enough."* (opencode.ai/v2/docs/migrate-v1). **Most ecosystem plugins, including oh-my-opencode, the fallback plugins and beads, are V1-only.** They won't load on this install.
- The npm packages follow the same split. V2: `@opencode/plugin`, `@opencode/client` and `@opencode/sdk`, all at 2.0.20. V1: `@opencode-ai/plugin` and `@opencode-ai/sdk`, at 1.18.33.

## 1. Plugin API (V2)
**Where plugins live** (source: v2/docs/plugins)
- Config key: `plugins` in `opencode.json(c)`. It accepts npm specs, versions, git specs, relative, absolute or `file://` paths, and `{ "package": ..., "options": {...} }`.
- Auto-discovered from `.opencode/plugins/` (and `.opencode/plugin/`) and from `~/.config/opencode/plugins/`.
- Entries can be disabled with a `-id` prefix or wildcards.
- CLI: `opencode plugin add|list|check|update|remove`.
- Plugins hot-reload when watched config directories change.

**Shape**
```ts
import { Plugin } from "@opencode/plugin"
export default Plugin.define({ id: "x", async setup(ctx) { /* register */ return () => {/* cleanup */} } })
```

**Context**
- `ctx` is essentially an OpenCode server client, plus: `ctx.options`, `ctx.location` (`directory`, `workspaceID`, `project`), `ctx.app`, `ctx.storage` (durable JSON `get`/`set`/`remove`/`scan`), `ctx.rpc` and `ctx.generate.text`.
- The V1 `$` Bun shell, `client`, `worktree` and `serverUrl` are gone.
- Every domain has `.transform(editor => …)` and `.reload()`: `agent`, `command`, `integration`, `mcp`, `model`, `provider`, `reference`, `skill`, `tool`, `vcs`, `websearch`, `worktree`.
- Source: `packages/plugin/src/promise/adapter.ts` in the v2 tag.

**Runtime hooks, registered with `ctx.<domain>.hook(name, cb, {providerID?})`**
- `session`: `prompt` (admission; can edit `prompt.text`, `files`, `agents`, `skills`, `delivery`), `context` (edit system, messages, tools and options before every agent-loop call), `compaction` (can set `result` to replace the summary), `generate`, `title`, `model.request`, `http.request`, `http.response`, `experimental.ws.handshake|send|receive`, `retry`.
- `permission`: `evaluate`.
- `shell`: `create.before`.
- `tool`: `execute.before`, `execute.after`.
- Events: `ctx.event.subscribe({signal})`, an async iterable.
- Custom tools: `ctx.tool.transform(e => e.add({name, description, input, execute}))`.
- Slash commands: `ctx.command.transform(e => e.add({name, description, execute}))`.
- Source: v2/docs/build/plugins.

**V1 for reference** (tag dev, `packages/plugin/src/index.ts`)
- `(input: {client, project, directory, worktree, serverUrl, $, experimental_workspace}) => Promise<Hooks>`.
- Hooks: `event`, `config`, `tool`, `auth`, `provider`, `chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`, `tool.execute.before/after`, `shell.env`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.provider.small_model`, `experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.text.complete`, `tool.definition`.
- **None of these exist in V2.**

## 2. Sessions, looping and commands (V2 `ctx.session`, confirmed in adapter.ts)
Available methods: `create`, `get`, `switchAgent`, `switchModel`, `prompt`, `generate`, `command`, `synthetic`, `interrupt`, `update`, `move`, `wait`, `context`.

- **Fresh context per ticket:** `ctx.session.create({ title, agent, model: {providerID, id, variant?}, permissions, metadata, location })`. `SessionCreateInput` is in `packages/client/src/effect/api/api.ts`.
- **Model per prompt:** `SessionPromptInput` has **no model field** (it takes `sessionID, text, files, agents, skills, metadata, delivery, resume`). Set the model when you create the session, or call `switchModel` before prompting.
- **Preloading skills:** pass `skills: [...]` on `prompt`, or add them in the `prompt` hook.
- **Waiting for completion:** `ctx.session.wait({sessionID})`, or watch the events `session.execution.succeeded|failed|interrupted`, `session.idle` and `session.step.failed`. The event names come from `packages/schema/src/session-event.ts`.
- **Abort:** `ctx.session.interrupt({sessionID, continue:false})`.
- **Read messages:** `ctx.session.context({sessionID})`.
- **Running a loop across sessions** is possible: start a background async loop from `setup`, stop it in the returned cleanup, and persist state in `ctx.storage`. `opencode-ralph-loop-v2` does exactly this.
- **Slash commands:** yes, via `ctx.command.transform`, or with markdown files in `.opencode/commands/*.md`. Their frontmatter takes `agent`, `model: provider/model#variant` and `subagent: true` (runs in a background child session). Source: v2/docs/commands.

## 3. Agents and skills (V2)
**Agents**
- Defined in `.opencode/agents/<name>.md` or `~/.config/opencode/agents/`, or under the `agents` key in config.
- Fields: `description`, `mode: primary|subagent|all`, `model: provider/model#variant`, `system`, `permissions` (an ordered list of `{action, resource, effect}`, last match wins), `steps`, `hidden`, `color`, `disabled`, `request`. The docs warn that `request` is not yet sent.
- The legacy `prompt`, `tools`, `permission`, `maxSteps` and `temperature` fields should not be used.
- The subagent tool is now **`subagent`** (not `task`). Subagents run with fresh context, in the foreground or background.
- Source: v2/docs/agents.

**Skills**
- Format: a `SKILL.md` directory or a root-level `*.md` file.
- Discovery: `~/.config/opencode/skills`, `.opencode/skills`, plus compatibility paths `~/.claude/skills`, `.claude/skills`, `~/.agents/skills` and `.agents/skills`. A `skills` config array adds more paths or HTTP catalogs.
- They are loaded by the model through the `skill` tool, by ID.
- **Per-agent filtering works:** put `{ "action": "skill", "resource": "<glob>", "effect": "allow|ask|deny" }` under `agents.<id>.permissions`. `deny` hides the skill and rejects loading it.
- Filtering can also be done **per session** through `permissions` on `session.create`, or `ctx.permission.rules({sessionID, permissions})`. That fits per-ticket or per-tier skill sets.
- `metadata.opencode/autoinvoke: false` hides a skill from the advertised list.
- A plugin can also edit skills with `ctx.skill.transform`.
- Source: v2/docs/skills and v2/docs/build/plugins#permissions.

## 4. Compaction (V2)
**Config keys**
- `compaction.auto` (default true).
- `compaction.keep.tokens` (default 15000).
- `compaction.buffer` (default 10% of the context limit). Compaction starts at roughly limit minus buffer.
- Schema: `packages/schema/src/config/compaction.ts`.

**Per model:** the only per-model setting is `settings.compaction.type: "summary" | "native"` (`schema/src/provider.ts`). **There is no per-model threshold.** Two ways to get one:
- **Workaround A:** set a lower `limit.context` for each model in the `providers.<id>.models.<id>` config, or with `ctx.model.transform(e => e.update(p, m, d => d.limit.context = N))`.
- **Workaround B:** track token usage from `session.step.*` events and compact manually through the HTTP API `POST /api/session/{id}/compact` (`SessionCompactInput` exists in the client).
- **Caveat for B:** `compact` is **not exposed on the plugin `ctx.session`** (adapter.ts), so a plugin would have to call the HTTP API or the client. How a plugin finds the server URL in V2 hasn't been verified.

**Hooks:** V2 has a `session` `compaction` hook (edit `messages` or `system`, or set `result`). V1's `experimental.session.compacting` does not exist in V2.

Sources: v2/docs/compaction and the V1 plugins docs.

## 5. Errors, retry and fallback (V2)
**How errors surface**
- Events `session.execution.failed`, `session.step.failed` and `session.retry.scheduled` carry `error: {type, message, status?}`.
- Error types are mapped in `core/src/session/to-session-error.ts`: `provider.rate-limit`, `provider.quota`, `provider.auth`, `provider.transport`, `provider.internal`, `provider.timeout`, `provider.invalid-request`, and others.

**Built-in retry** (`core/src/session/runner/retry.ts`)
- Exponential backoff from 2s, capped at 10s per gap, up to 10 retries.
- A provider's `retry-after` is honoured up to 15 minutes.
- Retries apply to `RateLimit` and `ProviderInternal`, some `Transport` errors, and unknown errors (`ai/src/provider-error.ts`). **`QuotaExceeded` is not in the retryable list.**
- Context overflow triggers one compaction and one retry.
- **There is no built-in cross-provider fallback.**

**What a plugin can do**
- The `retry` hook can veto a retry or change the delay (for example `{retry:false}` on a 429 so it fails fast). It **cannot switch the model**.
- Pattern for fallback: on `session.execution.failed` with `error.type` of `provider.rate-limit` or `provider.quota`, call `ctx.session.switchModel({...})`, then `ctx.session.prompt({sessionID, text:"continue", resume:true})` or re-send the original ticket prompt.
- This sequence hasn't been tested end to end. It is assembled from the documented APIs.

## 6. Headless
**`opencode run`** (from local `--help`)
- `run [message...]` with flags `--model/-m provider/model#variant`, `--agent`, `--format default|json`, `--session/-s`, `--continue/-c`, `--fork`, `--file/-f`, `--title`, `--auto` (auto-approve anything not explicitly denied), `--standalone` (private server) and `--server URL`.
- One process per ticket gives a fresh context for free.

**`opencode serve`**
- Flags: `--hostname`, `--port`, `--cors`, `--service`, `--stdio`.
- There is also a background service (`opencode service`) and a CLI escape hatch: `opencode api <operationId | METHOD path> -d …`.

**External runner**
- `@opencode/client`: `OpenCode.make({baseUrl}).session.create/prompt`, plus `client.event.subscribe()`. Events are live only, with no replay or automatic reconnect.
- `@opencode/sdk`: `OpenCode.create()` runs the server in memory, with no HTTP listener.
- Sources: v2/docs/build/client and v2/docs/build/sdk.

## 7. Existing plugins worth studying
1. **PatelUtkarsh/opencode-ralph-loop-v2** (https://github.com/PatelUtkarsh/opencode-ralph-loop-v2). **V2 native** (`@opencode/plugin` 2.0.2). Keeps a session iterating until a `DONE` promise appears. The closest template for the runner. Copy:
   - `src/index.ts`: `Plugin.define`, `ctx.command.transform` for `/ralph-loop`, `/cancel-ralph` and `/ralph-status`, `ctx.rpc.register`, and cleanup via an AbortController.
   - `src/loop.ts`: a `ctx.event.subscribe` loop filtered by `location.directory`, keyed on `session.execution.succeeded`, `interrupted` and `failed`; continues with `ctx.session.synthetic` or `prompt`; reads output with `ctx.session.context`.
   - `src/resume.ts`: `ctx.storage.scan` to resume loops after a restart.
2. **renjfk/opencode-model-fallback** (https://github.com/renjfk/opencode-model-fallback). **V1.** Maps a subscription model to a pay-as-you-go model, with cooldowns. Copy `lib/router.js`:
   - The `event` hook on `session.status` (provider retry status), `session.error` and `message.updated` (assistant `error`).
   - Then abort with `client.session.abort`, replay the last user message or send "continue" on the fallback model, and use `chat.message` to rewrite `output.message.model`.
   - Port it to V2 events plus `switchModel`.
3. **azumag/opencode-rate-limit-fallback** (https://github.com/azumag/opencode-rate-limit-fallback). V1. Same idea, with fallback modes cycle, stop and retry-last, exponential cooldown, and metrics. Other variants (not inspected): https://github.com/youngbinkim0/opencode-fallback, https://github.com/aitsvet/opencode-retry.
4. **code-yeongyu/oh-my-opencode** (https://github.com/code-yeongyu/oh-my-opencode). V1 (`@opencode-ai/plugin` 1.18.31). The most complete harness. Useful references under `packages/omo-opencode/src/`:
   - `hooks/runtime-fallback/` (error-classifier.ts, fallback-models.ts, auto-retry-dispatch.ts)
   - `hooks/model-fallback/`
   - `hooks/ralph-loop/` (completion-promise-detector.ts, continuation-prompt-injector.ts)
   - `features/background-agent/manager.ts` (`client.session.create` for children, concurrency, circuit breaker)
   - `hooks/todo-continuation-enforcer`, `hooks/compaction-todo-preserver`
5. **kdcokenny/opencode-background-agents** (https://github.com/kdcokenny/opencode-background-agents). Retired and V1-only. The README says to use V2's native background subagents instead.
6. **joshuadavidthomas/opencode-agent-skills** (https://github.com/joshuadavidthomas/opencode-agent-skills). V1, maintenance mode because skills are now native. Its README describes a pattern worth copying: re-injecting skills after compaction.
7. **joshuadavidthomas/opencode-beads** (https://github.com/joshuadavidthomas/opencode-beads). V1 integration with an issue tracker. `src/plugin.ts` uses `chat.message` to inject `bd` context and re-injects it on `session.compacted`, via `client.session.messages` and `prompt`. This is the same "tickets as files" idea.
8. **Th0rgal/open-ralph-wiggum** (https://github.com/Th0rgal/open-ralph-wiggum). An external loop CLI, not a plugin. `ralph.ts` spawns `opencode run --model …` for each iteration. This is the simplest fresh-process design.

Index of more community plugins: https://github.com/awesome-opencode/awesome-opencode.

## Verdict
Every requirement is buildable as a **V2** plugin:
- Ticket loop: background loop plus `session.create({agent, model, permissions})`, `prompt({skills})`, then `wait` or events.
- Model routing: model per session, per agent or per command.
- Skill tiers: agent- or session-level `skill` permissions plus `prompt.skills` to preload.
- Fallback: failure events, then `switchModel`, then re-prompt.
- Compaction thresholds: no native per-model setting; use one of the two workarounds in section 4.

An external runner using `@opencode/client` or `opencode run -m … --format json` works equally well and avoids depending on V2's new, fast-changing plugin API. It gets fresh processes for free.

**Unverified:**
- The exact semantics of `session.wait` and of `prompt({resume:true})`.
- How a V2 plugin reaches the compact endpoint.
- Whether switching the model mid-session behaves cleanly after an error.
