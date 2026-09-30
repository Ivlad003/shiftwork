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
			let turnEmitted = false;
			let pendingUsage = null;
			let pendingText = "";

			const cleanup = async () => {
				await rm(dir, { recursive: true, force: true });
			};

			const finish = async (stopReason, errorMessage) => {
				if (queue.closed) return;
				if (pendingUsage) {
					queue.push({ ...pendingUsage, text: pendingText });
					pendingUsage = null;
				} else if ((pendingText || !turnEmitted) && !errorMessage) {
					queue.push({
						type: "turn",
						usage: { input: 0, output: 0, totalTokens: 0 },
						costUsd: 0,
						text: pendingText,
					});
				}
				if (errorMessage && !queue.closed) queue.push({ type: "error", message: errorMessage });
				queue.push({ type: "end", stopReason });
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
					for (const mapped of mapClaudeEvent(event)) {
						if (mapped.type === "turn") {
							if (pendingUsage) {
								queue.push({ ...pendingUsage, text: pendingText });
								pendingText = "";
							}
							pendingUsage = mapped;
							turnEmitted = true;
						} else if (mapped.type === "text") {
							pendingText += mapped.text;
							queue.push(mapped);
						} else if (mapped.type === "error" || mapped.type === "context") {
							queue.push(mapped);
						}
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

/** Map one Claude Code stream-json event to Shiftwork ShiftEvents. Exported for tests. */
export function mapClaudeEvent(event) {
	if (!event || typeof event !== "object") return [];
	const out = [];
	if (event.type === "text" && typeof event.text === "string") {
		out.push({ type: "text", text: event.text });
	}
	if (event.type === "usage") {
		const input = event.input_tokens ?? 0;
		const output = event.output_tokens ?? 0;
		out.push({
			type: "turn",
			usage: { input, output, totalTokens: input + output },
			costUsd: event.cost_usd ?? 0,
		});
	}
	if (event.type === "context") {
		out.push({
			type: "context",
			tokens: event.tokens,
			percent: event.percent,
			contextWindow: event.context_window,
		});
	}
	if (event.type === "error" && event.message) {
		out.push({ type: "error", message: event.message });
	}
	if (event.type === "done") {
		out.push({ type: "end", stopReason: event.stop_reason ?? "stop" });
	}
	return out;
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
