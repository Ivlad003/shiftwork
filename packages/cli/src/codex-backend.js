import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { classifyError } from "shiftwork-core";

/**
 * Codex backend: `codex exec -m <m> --json --approve-for-me -o <last> <prompt>`.
 * Skills are delivered as symlinks in `.agents/skills/` inside the worktree, excluded from git.
 * The worker prompt is prepended to the prompt.
 * Options: { command?: "codex", args?: string[], env?: object, timeoutMs?: number }
 */
const SAFETY_TIMEOUT_MS = 3 * 60 * 60_000;

export function createCodexBackend(options = {}) {
	const command = options.command ?? "codex";

	return {
		name: "codex",
		capabilities: { inPlaceHandoff: false, skills: "links" },

		async probe(model, { timeoutMs = 60_000 } = {}) {
			if (!(await isOnPath(command, options.env))) return false;
			const lastFile = join(tmpdir(), `shiftwork-codex-probe-${Date.now()}`);
			return new Promise((resolve) => {
				const args = [
					"exec",
					"-m",
					model,
					"--json",
					"--approve-for-me",
					...(options.args ?? []),
					"-o",
					lastFile,
					"Reply with exactly: OK",
				];
				const child = execFile(
					command,
					args,
					{ env: { ...process.env, ...options.env }, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
					(error, stdout, stderr) => {
						rm(lastFile).catch(() => {});
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
			const fullPrompt = [systemPrompt, preload.text, prompt].filter(Boolean).join("\n\n");

			const skillPaths = route.skills?.restricted ? route.skills.paths ?? [] : [];
			// Deliver granted skills as symlinks in the worktree's .agents/skills/.
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

			const dir = await mkdtemp(join(tmpdir(), "shiftwork-codex-"));
			const lastFile = join(dir, "last-message.txt");

			// Sandbox: "approve-for-me" (default; codex's workspace-write sandbox with automatic review),
			// "workspace-write", or "bypass" for environments that are already isolated (the ticket's worktree
			// is), e.g. where bwrap can't create a sandbox.
			const sandbox = options.sandbox ?? "approve-for-me";
			const sandboxArgs =
				sandbox === "bypass" ? ["--dangerously-bypass-approvals-and-sandbox"] : sandbox === "workspace-write" ? ["--sandbox", "workspace-write"] : ["--approve-for-me"];
			const args = ["exec", "-m", route.model, "--json", ...sandboxArgs];
			args.push(...(options.args ?? []));
			args.push("-o", lastFile);
			args.push(fullPrompt);

			const queue = eventQueue();
			let stderr = "";
			let buffer = "";
			const map = createCodexMapper();
			let ended = false;
			let lastText = "";

			const cleanup = async () => {
				for (const link of skillLinks) await rm(link, { force: true }).catch(() => {});
				await rm(dir, { recursive: true, force: true });
			};

			const finish = async (stopReason, errorMessage) => {
				if (queue.closed) return;
				if (errorMessage) queue.push({ type: "error", message: errorMessage });
				// Fallback: if stdout produced no text but the -o file did, emit it.
				if (!ended) {
					if (lastText) queue.push({ type: "text", text: lastText });
					queue.push({ type: "end", stopReason });
				}
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
			// CLIs such as `opencode run` read piped stdin as extra prompt and wait for EOF: close it.
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
						if (mapped.type === "text") lastText = mapped.text;
						if (mapped.type === "end") ended = true;
						queue.push(mapped);
					}
				}
			});

			child.on("error", (error) => finish("error", error.message));
			child.on("close", (code) => {
				const message = code !== 0 ? stderr || `codex exited with code ${code}` : undefined;
				finish(code === 0 ? "stop" : "error", message);
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
 * Map Codex `--json` events to ShiftEvents. Stateful: one assistant turn is composed of
 * multiple `item.completed` events (agent_message, file_change, ...) between `turn.started`
 * and `turn.completed`. We count one turn per completed turn and emit accumulated text.
 *
 * Recorded fixture (`test/fixtures/codex-stream.jsonl`) shows:
 * - `thread.started`
 * - `turn.started`
 * - `item.completed` { type: "agent_message", text }
 * - `item.completed` { type: "file_change", changes, status }
 * - `turn.completed` { usage }
 * - `turn.failed` / `error` on limits
 */
export function createCodexMapper() {
	let currentTurnText = [];
	let sawTurn = false;
	return function map(event) {
		if (!event || typeof event !== "object") return [];
		const out = [];
		if (event.type === "turn.started") {
			currentTurnText = [];
			sawTurn = true;
		} else if (event.type === "item.completed" && event.item) {
			const item = event.item;
			if (item.type === "agent_message" && item.text) {
				currentTurnText.push(item.text);
			}
		} else if (event.type === "turn.completed") {
			const usage = event.usage ?? {};
			const input = usage.input_tokens ?? 0;
			const output = usage.output_tokens ?? 0;
			out.push({ type: "turn", model: event.model, usage: { input, output, totalTokens: input + output }, costUsd: 0 });
			out.push({ type: "context", tokens: input });
			if (currentTurnText.length) {
				out.push({ type: "text", text: currentTurnText.join("\n") });
			}
			currentTurnText = [];
		} else if (event.type === "error" || event.type === "turn.failed") {
			const message = event.message ?? event.error?.message ?? "codex error";
			out.push({ type: "error", message });
		}
		return out;
	};
}

/** Stateless convenience for single events (tests); prefer createCodexMapper for a stream. */
export function mapCodexEvent(event) {
	return createCodexMapper()(event);
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
		warnings: [`Codex backend not available: ${reason}`],
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
