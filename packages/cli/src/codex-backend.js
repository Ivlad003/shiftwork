import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { classifyError } from "shiftwork-core";
import { execIn } from "./exec.js";
import { runAgent, spawnAgent } from "./spawn-agent.js";

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
			const result = await runAgent(command, args, { env: { ...process.env, ...options.env }, timeoutMs });
			rm(lastFile).catch(() => {});
			const output = `${result.stdout}\n${result.stderr}`;
			return !result.error && result.code === 0 && classifyError(output) === null;
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
			const skillLinks = skillPaths.length ? await linkSkills(skillsDir, skillPaths) : [];
			if (skillPaths.length) await excludeSkillsFromGit(cwd);

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
			let stopping = false;
			const timeoutMs = options.timeoutMs ?? SAFETY_TIMEOUT_MS;
			const map = createCodexMapper();
			let ended = false;
			let lastText = "";

			const cleanup = async () => {
				for (const link of skillLinks) await unlink(link).catch(() => {});
				await rm(dir, { recursive: true, force: true });
			};

			// close() after the process already ended waits for that ending's cleanup.
			let cleanupDone = null;
			const finish = async (stopReason, errorMessage) => {
				if (queue.closed) return cleanupDone;
				if (errorMessage) queue.push({ type: "error", message: errorMessage });
				// Fallback: if stdout produced no text but the -o file did, emit it.
				if (!ended) {
					if (lastText) queue.push({ type: "text", text: lastText });
					queue.push({ type: "end", stopReason });
				}
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
					const event = parseJsonLine(line);
					if (!event) return;
					for (const mapped of map(event)) {
						if (mapped.type === "text") lastText = mapped.text;
						if (mapped.type === "end") ended = true;
						queue.push(mapped);
					}
				},
				onError: (error) => finish("error", error.message),
				onClose: ({ code, timedOut }) => {
					if (stopping) return;
					const message = timedOut
						? `codex timed out after ${Math.round(timeoutMs / 60_000)} min (safety timeout)`
						: code !== 0 ? agent.stderrTail() || `codex exited with code ${code}` : undefined;
					finish(code === 0 ? "stop" : "error", message);
				},
			});

			return {
				capabilities: { inPlaceHandoff: false, skills: "links" },
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
	const toolItems = new Set();
	return function map(event) {
		if (!event || typeof event !== "object") return [];
		const out = [];
		if (event.type === "turn.started") {
			currentTurnText = [];
			sawTurn = true;
		} else if ((event.type === "item.started" || event.type === "item.completed") && event.item) {
			const item = event.item;
			if (event.type === "item.completed" && item.type === "agent_message" && item.text) {
				currentTurnText.push(item.text);
			}
			// A tool item arrives started and completed: one tool event per item id.
			const tool = codexTool(item);
			if (tool && !(item.id && toolItems.has(item.id))) {
				if (item.id) toolItems.add(item.id);
				out.push(tool);
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

/** The tool event of a Codex item, or null when the item is not a tool call. */
function codexTool(item) {
	if (item.type === "command_execution") return toolEvent("shell", item.command);
	if (item.type === "file_change") return toolEvent("file_change", (item.changes ?? []).map((c) => c.path).join(" "));
	if (item.type === "mcp_tool_call") return toolEvent(item.tool ?? "mcp", item.arguments);
	if (item.type === "web_search") return toolEvent("web_search", item.query);
	return null;
}

/** Stateless convenience for single events (tests); prefer createCodexMapper for a stream. */
export function mapCodexEvent(event) {
	return createCodexMapper()(event);
}

/**
 * Link granted skills into `skillsDir`. A link of ours left by an earlier shift is reused; any other
 * file already at the path belongs to the repo and is left alone and not recorded, so cleanup
 * never removes it. Returns the links to remove when the shift ends.
 */
async function linkSkills(skillsDir, skillPaths) {
	const links = [];
	await mkdir(skillsDir, { recursive: true });
	for (const skillPath of skillPaths) {
		const target = join(skillsDir, basename(skillPath));
		const existing = await lstat(target).catch(() => null);
		if (existing) {
			if (existing.isSymbolicLink() && (await readlink(target).catch(() => null)) === skillPath) links.push(target);
			continue;
		}
		try {
			await symlink(skillPath, target);
			links.push(target);
		} catch {
			// EEXIST from a race or an unwritable dir: the skill is not delivered, nothing to clean up.
		}
	}
	return links;
}

async function excludeSkillsFromGit(cwd) {
	// In a linked worktree `.git` is a file: ask git where info/exclude really lives (the common dir).
	let excludeFile;
	try {
		excludeFile = resolve(cwd, (await execIn(cwd)(["git", "rev-parse", "--git-path", "info/exclude"])).trim());
	} catch {
		return;
	}
	const pattern = ".agents/skills/";
	const text = await readFile(excludeFile, "utf8").catch(() => "");
	if (text.split("\n").some((line) => line.trim() === pattern)) return;
	await mkdir(dirname(excludeFile), { recursive: true });
	await writeFile(excludeFile, !text || text.endsWith("\n") ? `${text}${pattern}\n` : `${text}\n${pattern}\n`);
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
