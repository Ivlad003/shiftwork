import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { classifyError } from "shiftwork-core";

/**
 * Claude Code backend: `claude -p` with `--output-format stream-json`.
 * Options: { command?: "claude", args?: string[], env?: object, timeoutMs?: number }
 */
export function createClaudeBackend(options = {}) {
	const command = options.command ?? "claude";

	return {
		name: "claude",
		capabilities: { inPlaceHandoff: false, skills: "plugin" },

		async probe(model, { timeoutMs = 60_000 } = {}) {
			if (!(await isOnPath(command, options.env))) return false;
			return new Promise((resolve) => {
				const args = [
					"-p",
					"--model",
					model,
					"--output-format",
					"stream-json",
					"--dangerously-skip-permissions",
					...(options.args ?? []),
					"Reply with exactly: OK",
				];
				const child = execFile(
					command,
					args,
					{ env: { ...process.env, ...options.env }, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
					(error, stdout, stderr) => {
						const output = `${stdout}\n${stderr}`;
						resolve(!error && classifyError(output) === null);
					},
				);
				child.stdin?.end();
			});
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
				"--append-system-prompt",
				workerFile,
				"--dangerously-skip-permissions",
			];
			if (skillPaths.length) args.push("--plugin-dir", pluginDir);
			args.push(...(options.args ?? []));
			args.push(prompt);

			const queue = eventQueue();
			let stderr = "";
			let buffer = "";
			const map = createClaudeMapper();
			let ended = false;

			const cleanup = async () => {
				await rm(dir, { recursive: true, force: true });
			};

			const finish = async (stopReason, errorMessage) => {
				if (queue.closed) return;
				if (errorMessage) queue.push({ type: "error", message: errorMessage });
				if (!ended) queue.push({ type: "end", stopReason });
				queue.close();
				await cleanup();
			};

			const child = execFile(command, args, {
				cwd,
				env: { ...process.env, ...options.env },
				timeout: options.timeoutMs ?? 60 * 60_000,
				maxBuffer: 256 * 1024 * 1024,
			});

			child.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});

			child.stdout?.on("data", (chunk) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop();
				for (const line of lines) {
					if (!line.trim()) continue;
					const event = parseStreamJsonLine(line);
					if (!event) continue;
					for (const mapped of map(event)) {
						if (mapped.type === "end") ended = true;
						queue.push(mapped);
					}
				}
			});

			child.on("error", (error) => finish("error", error.message));
			child.on("close", (code) => {
				const message = code !== 0 ? stderr || `claude exited with code ${code}` : undefined;
				finish(code === 0 ? "stop" : "error", message);
			});

			return {
				capabilities: { inPlaceHandoff: false, skills: "plugin" },
				events: queue.iterate(),
				warnings: preload.warnings,
				async abort() {
					child.kill("SIGTERM");
					await finish("aborted").catch(() => {});
				},
				async close() {
					if (!child.killed) child.kill("SIGTERM");
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
 * - `rate_limit_event`: rate_limit_info { status: "allowed" | …, rateLimitType, resetsAt (epoch s) }
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
			}
		} else if (event.type === "rate_limit_event") {
			const info = event.rate_limit_info ?? {};
			if (info.status && info.status !== "allowed") {
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
