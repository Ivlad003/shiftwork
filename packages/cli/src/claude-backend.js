import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { classifyError } from "shiftwork-core";
import { runAgent, spawnAgent } from "./spawn-agent.js";

/**
 * Claude Code backend: `claude -p` with `--output-format stream-json`.
 * Options: { command?: "claude", args?: string[], env?: object, timeoutMs?: number }
 */
const SAFETY_TIMEOUT_MS = 3 * 60 * 60_000;

export function createClaudeBackend(options = {}) {
	const command = options.command ?? "claude";

	return {
		name: "claude",
		capabilities: { inPlaceHandoff: false, skills: "plugin" },

		async probe(model, { timeoutMs = 60_000 } = {}) {
			if (!(await isOnPath(command, options.env))) return false;
			const args = ["-p", "--model", model, "--output-format", "stream-json", "--dangerously-skip-permissions", ...(options.args ?? []), "Reply with exactly: OK"];
			const result = await runAgent(command, args, { env: { ...process.env, ...options.env }, timeoutMs });
			return !result.error && result.code === 0 && classifyError(`${result.stdout}\n${result.stderr}`) === null;
		},

		async startShift({ cwd, route, prompt, systemPrompt }) {
			if (!(await isOnPath(command, options.env))) {
				return unavailableShift(`${command}: command not found`);
			}

			const dir = await mkdtemp(join(tmpdir(), "shiftwork-claude-"));
			const workerFile = join(dir, "worker.md");
			const pluginDir = join(dir, "plugin");

			const preload = await loadPreload(route.skills?.preload ?? []);
			const fullSystemPrompt = [systemPrompt, preload.text].filter(Boolean).join("\n\n");
			await writeFile(workerFile, fullSystemPrompt);

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
				"--model",
				route.model,
				"--output-format",
				"stream-json",
				"--verbose",
				// --append-system-prompt takes the text itself; the worker prompt is in a file.
				"--append-system-prompt-file",
				workerFile,
				"--dangerously-skip-permissions",
			];
			if (skillPaths.length) args.push("--plugin-dir", pluginDir);
			args.push(...(options.args ?? []));
			args.push(prompt);

			const queue = eventQueue();
			const map = createClaudeMapper();
			let ended = false;
			let stopping = false;
			const timeoutMs = options.timeoutMs ?? SAFETY_TIMEOUT_MS;

			const cleanup = async () => {
				await rm(dir, { recursive: true, force: true });
			};

			// close() after the process already ended waits for that ending's cleanup.
			let cleanupDone = null;
			const finish = async (stopReason, errorMessage) => {
				if (queue.closed) return cleanupDone;
				if (errorMessage) queue.push({ type: "error", message: errorMessage });
				if (!ended) queue.push({ type: "end", stopReason });
				queue.close();
				cleanupDone = cleanup();
				await cleanupDone;
			};

			const agent = spawnAgent(command, args, {
				cwd,
				env: { ...process.env, ...options.env },
				// A safety net only: budgets (maxWallMin) end shifts with a handoff long before this.
				timeoutMs,
				onLine(line) {
					if (!line.trim()) return;
					const event = parseStreamJsonLine(line);
					if (!event) return;
					for (const mapped of map(event)) {
						if (mapped.type === "end") ended = true;
						queue.push(mapped);
					}
				},
				onError: (error) => finish("error", error.message),
				onClose: ({ code, timedOut }) => {
					if (stopping) return;
					const message = timedOut
						? `claude timed out after ${Math.round(timeoutMs / 60_000)} min (safety timeout)`
						: code !== 0
							? agent.stderrTail() || `claude exited with code ${code}`
							: undefined;
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

function parseStreamJsonLine(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/**
 * Map Claude Code `--output-format stream-json --verbose` events to ShiftEvents. Stateful: one
 * assistant message arrives as several lines (thinking, tool_use, text) sharing `message.id`,
 * and counts as one turn. The formats come from a recorded transcript (test/fixtures/claude-stream.jsonl):
 * - `assistant`: message.usage { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }
 * - `rate_limit_event`: rate_limit_info { status: "allowed" | "allowed_warning" | "rejected", rateLimitType, resetsAt (epoch s) }
 * - `result`: { subtype, is_error, result, num_turns, total_cost_usd }
 */
export function createClaudeMapper() {
	const seen = new Set();
	return function map(event) {
		if (!event || typeof event !== "object") return [];
		const out = [];
		if (event.type === "assistant" && event.message) {
			const message = event.message;
			if (message.id && !seen.has(message.id)) {
				seen.add(message.id);
				const u = message.usage ?? {};
				const context = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
				const output = u.output_tokens ?? 0;
				out.push({ type: "turn", model: message.model, usage: { input: context, output, totalTokens: context + output }, costUsd: 0 });
				out.push({ type: "context", tokens: context });
			}
			for (const block of message.content ?? []) {
				if (block.type === "text" && block.text) out.push({ type: "text", text: block.text });
				else if (block.type === "tool_use") out.push(toolEvent(block.name, block.input));
			}
		} else if (event.type === "rate_limit_event") {
			const info = event.rate_limit_info ?? {};
			if (isBlockingRateLimit(info.status)) {
				const resets = info.resetsAt ? ` It resets at ${new Date(info.resetsAt * 1000).toISOString()}` : "";
				out.push({ type: "error", message: `Claude ${info.rateLimitType ?? "plan"} usage limit reached (${info.status}).${resets}` });
			}
		} else if (event.type === "result") {
			if (typeof event.total_cost_usd === "number") out.push({ type: "cost", costUsd: event.total_cost_usd });
			if (event.is_error) out.push({ type: "error", message: String(event.result ?? event.subtype ?? "claude error") });
			out.push({ type: "end", stopReason: event.is_error ? "error" : "stop" });
		}
		return out;
	};
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

/**
 * A rate_limit_event blocks the run only when its status says so ("rejected"). "allowed" and the
 * warnings ("allowed_warning": close to the limit) are informational: cooling the provider for
 * hours on a warning would drop a model that still works.
 */
function isBlockingRateLimit(status) {
	if (!status) return false;
	return !/^allowed|warning/i.test(status);
}

/** Stateless convenience for single events (tests); prefer createClaudeMapper for a stream. */
export function mapClaudeEvent(event) {
	return createClaudeMapper()(event);
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
		warnings: [`Claude Code backend not available: ${reason}`],
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
