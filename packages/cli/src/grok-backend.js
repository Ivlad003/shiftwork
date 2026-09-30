import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { classifyError } from "shiftwork-core";

/**
 * Grok Build backend: `grok -m <m> --output-format streaming-json --always-approve -p <prompt>`.
 * Headless mode is `-p/--single`: a positional prompt opens the interactive TUI instead
 * (and crashes without a TTY). Always invoke the binary as `grok`, never `agent`: Grok Build
 * and Cursor both install an `agent` symlink, and which one runs depends on PATH order.
 * Skills are delivered as symlinks in `.agents/skills/` inside the worktree, excluded from git.
 * The worker prompt, preloaded skills and the project instructions (`AGENTS.md`, else
 * `CLAUDE.md`, with one level of `@<path>` imports) are prepended to the prompt.
 * Options: { command?: "grok", args?: string[], env?: object, timeoutMs?: number }
 */
const SAFETY_TIMEOUT_MS = 3 * 60 * 60_000;

export function createGrokBackend(options = {}) {
	const command = options.command ?? "grok";

	return {
		name: "grok",
		capabilities: { inPlaceHandoff: false, skills: "links" },

		async probe(model, { timeoutMs = 60_000 } = {}) {
			if (!(await isOnPath(command, options.env))) return false;
			return new Promise((resolve) => {
				const args = [
					"-m",
					model,
					"--output-format",
					"streaming-json",
					"--always-approve",
					...(options.args ?? []),
					"-p",
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

			const preload = await loadPreload(route.skills?.preload ?? []);
			const projectInstructions = await loadProjectInstructions(cwd);
			const fullPrompt = [systemPrompt, preload.text, projectInstructions, prompt].filter(Boolean).join("\n\n");

			const skillPaths = route.skills?.restricted ? route.skills.paths ?? [] : [];
			const skillsDir = join(cwd, ".agents", "skills");
			const skillLinks = [];
			if (skillPaths.length) {
				await mkdir(skillsDir, { recursive: true });
				for (const skillPath of skillPaths) {
					const target = join(skillsDir, basename(skillPath));
					await rm(target, { force: true }).catch(() => {});
					await symlink(skillPath, target).catch(() => {});
					skillLinks.push(target);
				}
				await excludeSkillsFromGit(cwd);
			}

			const args = ["-m", route.model, "--output-format", "streaming-json", "--always-approve"];
			args.push(...(options.args ?? []));
			args.push("-p", fullPrompt);

			const queue = eventQueue();
			let stderr = "";
			let buffer = "";
			const map = createGrokMapper();
			let ended = false;
			let sawError = false;

			const cleanup = async () => {
				for (const link of skillLinks) await rm(link, { force: true }).catch(() => {});
			};

			const finish = async (stopReason, errorMessage) => {
				if (queue.closed) return;
				for (const mapped of map.flush()) queue.push(mapped);
				if (errorMessage) queue.push({ type: "error", message: errorMessage });
				if (!ended) queue.push({ type: "end", stopReason });
				queue.close();
				await cleanup();
			};

			const child = execFile(command, args, {
				cwd,
				env: { ...process.env, ...options.env },
				// A safety net only: budgets (maxWallMin) end shifts with a handoff long before this.
				timeout: options.timeoutMs ?? SAFETY_TIMEOUT_MS,
				maxBuffer: 256 * 1024 * 1024,
			});
			// A piped stdin must not be read as extra prompt: close it.
			child.stdin?.end();

			child.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});

			child.stdout?.on("data", (chunk) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop();
				for (const line of lines) {
					if (!line.trim()) continue;
					const event = parseJsonLine(line);
					if (!event) continue;
					for (const mapped of map(event)) {
						if (mapped.type === "end") ended = true;
						if (mapped.type === "error") sawError = true;
						queue.push(mapped);
					}
				}
			});

			child.on("error", (error) => finish("error", error.message));
			child.on("close", (code) => {
				// Grok exits 0 even when the stream carried a fatal error (e.g. unknown model).
				const message = code !== 0 ? stderr || `grok exited with code ${code}` : undefined;
				finish(code === 0 && !sawError ? "stop" : "error", message);
			});

			return {
				capabilities: { inPlaceHandoff: false, skills: "links" },
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

function parseJsonLine(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/**
 * Map Grok Build `--output-format streaming-json` (ACP session updates) to ShiftEvents.
 *
 * Recorded fixture (`test/fixtures/grok-stream.jsonl`, grok 1.0.44) shows:
 * - `available_commands`: tool/command lists; noise, ignored
 * - `text`: { data } — a streaming chunk of the current assistant message
 * - `tool_call` / `tool_call_update`: tool lifecycle; ignored
 * - `usage`: per assistant message { input_tokens, output_tokens, cache_read_input_tokens,
 *   cache_creation_input_tokens, reasoning_tokens } — one per model call, so one turn each
 * - `error`: { message } — failures such as plan limits; grok may still exit 0
 * - `end`: { stopReason, usage (totals), num_turns, total_cost_usd } — cost is reported
 *   only here, at the end of the run
 */
export function createGrokMapper() {
	let pendingText = [];
	function flushText(out) {
		if (pendingText.length) {
			out.push({ type: "text", text: pendingText.join("") });
			pendingText = [];
		}
	}
	function map(event) {
		if (!event || typeof event !== "object") return [];
		const out = [];
		if (event.type === "text" && typeof event.data === "string") {
			pendingText.push(event.data);
		} else if (event.type === "usage" && event.usage) {
			flushText(out);
			const u = event.usage;
			const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
			const output = (u.output_tokens ?? 0) + (u.reasoning_tokens ?? 0);
			out.push({ type: "turn", model: undefined, usage: { input, output, totalTokens: input + output }, costUsd: 0 });
			out.push({ type: "context", tokens: input });
		} else if (event.type === "error") {
			flushText(out);
			out.push({ type: "error", message: event.message ?? "grok error" });
		} else if (event.type === "end") {
			flushText(out);
			if (typeof event.total_cost_usd === "number") out.push({ type: "cost", costUsd: event.total_cost_usd });
			const reason = event.stopReason;
			out.push({ type: "end", stopReason: reason === "cancelled" ? "aborted" : reason === "error" ? "error" : "stop" });
		}
		return out;
	}
	map.flush = () => {
		const out = [];
		flushText(out);
		return out;
	};
	return map;
}

/** Stateless convenience for single events (tests); prefer createGrokMapper for a stream. */
export function mapGrokEvent(event) {
	return createGrokMapper()(event);
}

async function excludeSkillsFromGit(cwd) {
	const excludeFile = join(cwd, ".git", "info", "exclude");
	if (!existsSync(excludeFile)) return;
	const pattern = ".agents/skills/";
	const text = await readFile(excludeFile, "utf8").catch(() => "");
	if (text.split("\n").some((line) => line.trim() === pattern)) return;
	await writeFile(excludeFile, text.endsWith("\n") ? `${text}${pattern}\n` : `${text}\n${pattern}\n`);
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
		capabilities: { inPlaceHandoff: false, skills: "links" },
		events: events.iterate(),
		warnings: [`Grok Build backend not available: ${reason}`],
		async abort() {},
		async close() {},
	};
}

const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/**
 * The project instructions grok itself never loads: `AGENTS.md`, else `CLAUDE.md`, from the
 * shift's cwd (pi's file choice). A line that is exactly `@<path>` (as in this repo's
 * `CLAUDE.md`) is replaced by that file's content, one level deep, paths relative to the
 * instruction file. Missing files add nothing.
 */
async function loadProjectInstructions(cwd) {
	for (const name of PROJECT_INSTRUCTION_FILES) {
		const text = await readFile(join(cwd, name), "utf8").catch(() => null);
		if (text === null) continue;
		const lines = [];
		for (const line of text.split("\n")) {
			const imported = line.startsWith("@") && line.length > 1 ? await readFile(join(cwd, line.slice(1)), "utf8").catch(() => null) : null;
			lines.push(imported ?? line);
		}
		return `# Project instructions (${name})\n\n${lines.join("\n")}`;
	}
	return "";
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
