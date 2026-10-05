import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { classifyError } from "shiftwork-core";
import { runAgent, spawnAgent } from "./spawn-agent.js";

/**
 * Cursor CLI backend: `cursor-agent -p --output-format stream-json --model <m> --force --trust
 * --workspace <worktree> [--plugin-dir <generated>] <prompt>`.
 * Always invoke the binary as `cursor-agent`, never `agent`: the Cursor installer also links
 * `~/.local/bin/agent`, but Grok Build installs its own `agent` and which one runs depends on
 * PATH order. Do not use cursor-agent's own `--worktree`: Shiftwork already gives the shift a
 * worktree. Skills are delivered as a generated plugin directory (`skills/` of symlinks) passed
 * with `--plugin-dir`; preloaded skills and the worker prompt are prepended to the prompt.
 * Not logged in (`cursor-agent status` → "Not logged in", or an auth error on stderr) makes the
 * backend unavailable with a warning, like a missing binary — it is never a provider cooldown.
 * Options: { command?: "cursor-agent", args?: string[], env?: object, timeoutMs?: number }
 */
const SAFETY_TIMEOUT_MS = 3 * 60 * 60_000;

const AUTH_ERROR = /authentication required|not logged in|api key is invalid|invalid (?:api )?key/i;

export function createCursorBackend(options = {}) {
	const command = options.command ?? "cursor-agent";

	return {
		name: "cursor",
		capabilities: { inPlaceHandoff: false, skills: "plugin" },

		async probe(model, { timeoutMs = 60_000 } = {}) {
			if (!(await isOnPath(command, options.env))) return false;
			if (!(await isAuthenticated(command, options.env))) return false;
			const args = [
				"-p",
				"--output-format",
				"stream-json",
				"--model",
				model,
				"--force",
				"--trust",
				...(options.args ?? []),
				"Reply with exactly: OK",
			];
			const result = await runAgent(command, args, { env: { ...process.env, ...options.env }, timeoutMs });
			const output = `${result.stdout}\n${result.stderr}`;
			return !result.error && result.code === 0 && classifyError(output) === null && !AUTH_ERROR.test(output);
		},

		async startShift({ cwd, route, prompt, systemPrompt }) {
			if (!(await isOnPath(command, options.env))) {
				return unavailableShift(`${command}: command not found`);
			}
			if (!(await isAuthenticated(command, options.env))) {
				return unavailableShift(`${command} backend not available: not logged in (run \`cursor-agent login\`)`);
			}

			const dir = await mkdtemp(join(tmpdir(), "shiftwork-cursor-"));
			const pluginDir = join(dir, "plugin");

			const preload = await loadPreload(route.skills?.preload ?? []);
			const fullPrompt = [systemPrompt, preload.text, prompt].filter(Boolean).join("\n\n");

			const skillPaths = route.skills?.restricted ? route.skills.paths ?? [] : [];
			if (skillPaths.length) {
				await mkdir(join(pluginDir, "skills"), { recursive: true });
				for (const skillPath of skillPaths) {
					const target = join(pluginDir, "skills", basename(skillPath));
					await symlink(skillPath, target).catch(() => {});
				}
			}

			const args = [
				"-p",
				"--output-format",
				"stream-json",
				"--model",
				route.model,
				"--force",
				"--trust",
				"--workspace",
				cwd,
			];
			if (skillPaths.length) args.push("--plugin-dir", pluginDir);
			args.push(...(options.args ?? []));
			args.push(fullPrompt);

			const queue = eventQueue();
			let stopping = false;
			const timeoutMs = options.timeoutMs ?? SAFETY_TIMEOUT_MS;
			const map = createCursorMapper();
			let ended = false;

			const cleanup = async () => {
				await rm(dir, { recursive: true, force: true });
			};

			let cleanupDone = null;
			const finish = (stopReason, errorMessage) => {
				if (queue.closed) return cleanupDone ?? Promise.resolve();
				for (const mapped of map.flush()) queue.push(mapped);
				if (errorMessage) queue.push({ type: "error", message: errorMessage });
				if (!ended) queue.push({ type: "end", stopReason });
				queue.close();
				cleanupDone = cleanup();
				return cleanupDone;
			};

			const agent = spawnAgent(command, args, {
				cwd,
				env: { ...process.env, ...options.env },
				// A safety net only: budgets (maxWallMin) end shifts with a handoff long before this.
				timeoutMs,
				onLine(line) {
					if (!line.trim()) return;
					const event = parseJsonLine(line);
					if (!event) return;
					for (const mapped of map(event)) {
						if (mapped.type === "end") ended = true;
						queue.push(mapped);
					}
				},
				onError: (error) => finish("error", error.message),
				onClose: ({ code, timedOut }) => {
					if (stopping) return;
					let message = timedOut
						? `cursor-agent timed out after ${Math.round(timeoutMs / 60_000)} min (safety timeout)`
						: code !== 0 ? agent.stderrTail().trim() || `cursor-agent exited with code ${code}` : undefined;
					// An auth failure means the backend is unavailable (like a missing binary), not cooling.
					if (message && AUTH_ERROR.test(`${agent.stderrTail()}\n${agent.stdoutTail()}`)) {
						message = `${command} backend not available: ${message}`;
					}
					// When the stream already ended itself (a `result` line), finish() keeps that ending.
					finish(code === 0 ? "stop" : "error", message);
				},
			});

			return {
				capabilities: { inPlaceHandoff: false, skills: "plugin" },
				events: queue.iterate(),
				warnings: preload.warnings,
				async abort() {
					stopping = true;
					await agent.kill();
					await finish("aborted").catch(() => {});
				},
				async close() {
					stopping = true;
					await agent.kill();
					await finish("stop").catch(() => {});
				},
			};
		},
	};
}

function parseJsonLine(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/**
 * Map Cursor CLI `-p --output-format stream-json` events to ShiftEvents.
 *
 * Recorded fixture (`test/fixtures/cursor-stream.jsonl`, cursor-agent 2026.09.28) shows:
 * - `system`/`init`: { model, cwd, ... } — metadata; the model name is kept for turn events
 * - `user`: an echo of the prompt; ignored
 * - `connection` / `retry`: reconnect noise; ignored
 * - `thinking` delta/completed: reasoning chunks; ignored (not reply text)
 * - `assistant`: { message: { content: [{ type: "text", text }] } } — one event per assistant
 *   message, so one turn each (not per line). Usage is NOT on these events.
 * - `tool_call` started/completed: { <name>ToolCall: { args } } — `started` becomes one `tool` event
 * - `result`: { subtype, is_error, result, usage? } — the only place usage is reported, as
 *   { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }. The pending turn carries it.
 *
 * Turns stream as messages arrive: each assistant event closes the previous message's turn, and
 * the final turn (closed by `result`) carries the run's whole usage.
 */
export function createCursorMapper() {
	let model;
	let pendingText = [];
	let pendingTurn = false;

	function flushPending(usage) {
		const out = [];
		if (pendingText.length) {
			out.push({ type: "text", text: pendingText.join("") });
			pendingText = [];
		}
		if (pendingTurn) {
			const input = usage ? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0;
			const output = usage?.outputTokens ?? 0;
			out.push({ type: "turn", model, usage: { input, output, totalTokens: input + output }, costUsd: 0 });
			pendingTurn = false;
		}
		return out;
	}

	function map(event) {
		if (!event || typeof event !== "object") return [];
		if (event.type === "system" && event.subtype === "init") {
			model = event.model ?? model;
			return [];
		}
		if (event.type === "assistant" && event.message) {
			const out = flushPending();
			for (const block of event.message.content ?? []) {
				if (block.type === "text" && block.text) pendingText.push(block.text);
			}
			pendingTurn = true;
			return out;
		}
		if (event.type === "tool_call" && event.subtype === "started" && event.tool_call) {
			// { editToolCall: { args } } → "edit"; the completed event repeats the call.
			const [key, call] = Object.entries(event.tool_call)[0] ?? [];
			return key ? [toolEvent(key.replace(/ToolCall$/, ""), call?.args)] : [];
		}
		if (event.type === "error") {
			return [...flushPending(), { type: "error", message: event.message ?? event.error?.message ?? "cursor-agent error" }];
		}
		if (event.type === "result") {
			const out = flushPending(event.usage);
			const usage = event.usage;
			if (usage) {
				const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
				out.push({ type: "context", tokens: input });
			}
			if (typeof event.total_cost_usd === "number") out.push({ type: "cost", costUsd: event.total_cost_usd });
			if (event.is_error) out.push({ type: "error", message: String(event.result ?? event.subtype ?? "cursor-agent error") });
			out.push({ type: "end", stopReason: event.is_error ? "error" : "stop" });
			return out;
		}
		return [];
	}
	map.flush = () => flushPending();
	return map;
}

const TOOL_INPUT_CHARS = 500;

/** A tool call for the shift log: the shell command, else the file path, else the arguments as
 * JSON — at most 500 chars. `shiftwork reflect` mines these for repeated steps. */
function toolEvent(name, args) {
	const input =
		typeof args === "string"
			? args
			: (args?.command ?? args?.cmd ?? args?.file_path ?? args?.filePath ?? args?.path ?? args?.pattern ?? args?.url ?? (args == null ? "" : JSON.stringify(args)));
	return { type: "tool", name: String(name ?? "tool"), input: String(Array.isArray(input) ? input.join(" ") : input).slice(0, TOOL_INPUT_CHARS) };
}

/** Stateless convenience for single events (tests); prefer createCursorMapper for a stream. */
export function mapCursorEvent(event) {
	return createCursorMapper()(event);
}

/**
 * `cursor-agent status` prints "Not logged in" (exit 0) without a login token. When
 * CURSOR_API_KEY is set the run itself decides whether the key is good, so skip the check.
 * A failing `status` must not ground the backend either.
 */
async function isAuthenticated(command, env) {
	const merged = { ...process.env, ...env };
	if (merged.CURSOR_API_KEY) return true;
	try {
		const out = execFileSync(command, ["status"], { encoding: "utf8", timeout: 15_000, env: merged, stdio: ["ignore", "pipe", "ignore"] });
		return !AUTH_ERROR.test(out);
	} catch {
		return true;
	}
}

async function isOnPath(command, env) {
	try {
		execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore", env: env ? { ...process.env, ...env } : process.env });
		return true;
	} catch {
		return false;
	}
}

function unavailableShift(reason) {
	const events = eventQueue();
	events.push({ type: "error", message: reason });
	events.push({ type: "end", stopReason: "error" });
	events.close();
	return {
		capabilities: { inPlaceHandoff: false, skills: "plugin" },
		events: events.iterate(),
		warnings: [`Cursor backend not available: ${reason}`],
		async abort() {},
		async close() {},
	};
}

async function loadPreload(preloadPaths) {
	const warnings = [];
	const bodies = [];
	for (const skillPath of preloadPaths) {
		const file = await skillFile(skillPath).catch(() => {
			warnings.push(`missing skill path: ${skillPath}`);
			return null;
		});
		if (!file) continue;
		try {
			bodies.push(`<!-- Preloaded skill: ${file} -->\n${await readFile(file, "utf8")}`);
		} catch {
			warnings.push(`missing skill path: ${skillPath}`);
		}
	}
	return { text: bodies.join("\n\n"), warnings };
}

async function skillFile(skillPath) {
	const info = await stat(skillPath);
	return info.isDirectory() ? join(skillPath, "SKILL.md") : skillPath;
}

function eventQueue() {
	const items = [];
	let wake = null;
	const q = {
		closed: false,
		push(item) {
			if (q.closed) return;
			items.push(item);
			wake?.();
		},
		close() {
			q.closed = true;
			wake?.();
		},
		async *iterate() {
			for (;;) {
				if (items.length) {
					yield items.shift();
					continue;
				}
				if (q.closed) return;
				await new Promise((resolve) => {
					wake = resolve;
				});
				wake = null;
			}
		},
	};
	return q;
}
