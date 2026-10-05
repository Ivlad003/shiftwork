import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { classifyError } from "shiftwork-core";
import { execIn } from "./exec.js";
import { runAgent, spawnAgent } from "./spawn-agent.js";

/**
 * OpenCode backend: `opencode run -m <provider/model> --format json --auto <prompt>`.
 * Skills are delivered as symlinks in `.agents/skills/` inside the worktree, excluded from git.
 * The worker prompt is prepended to the prompt.
 * Options: { command?: "opencode", args?: string[], env?: object, timeoutMs?: number }
 */
const SAFETY_TIMEOUT_MS = 3 * 60 * 60_000;

export function createOpencodeBackend(options = {}) {
	const command = options.command ?? "opencode";

	return {
		name: "opencode",
		capabilities: { inPlaceHandoff: false, skills: "links" },

		async probe(model, { timeoutMs = 60_000 } = {}) {
			if (!(await isOnPath(command, options.env))) return false;
			const args = [
				"run",
				"-m",
				model,
				"--format",
				"json",
				"--auto",
				...(options.args ?? []),
				"Reply with exactly: OK",
			];
			const result = await runAgent(command, args, { env: { ...process.env, ...options.env }, timeoutMs });
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
			const skillsDir = join(cwd, ".agents", "skills");
			const skillLinks = skillPaths.length ? await linkSkills(skillsDir, skillPaths) : [];
			if (skillPaths.length) await excludeSkillsFromGit(cwd);

			const args = ["run", "-m", route.model, "--format", "json", "--auto"];
			args.push(...(options.args ?? []));
			args.push(fullPrompt);

			const queue = eventQueue();
			let stopping = false;
			const timeoutMs = options.timeoutMs ?? SAFETY_TIMEOUT_MS;
			const map = createOpencodeMapper();
			let ended = false;

			const cleanup = async () => {
				for (const link of skillLinks) await unlink(link).catch(() => {});
			};

			// close() after the process already ended waits for that ending's cleanup.
			let cleanupDone = null;
			const finish = async (stopReason, errorMessage) => {
				if (queue.closed) return cleanupDone;
				for (const mapped of map.flush()) queue.push(mapped);
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
					const message = timedOut
						? `opencode timed out after ${Math.round(timeoutMs / 60_000)} min (safety timeout)`
						: code !== 0 ? agent.stderrTail() || `opencode exited with code ${code}` : undefined;
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
 * Map OpenCode `--format json` events to ShiftEvents.
 *
 * OpenCode emits one JSON line per stream item. A single assistant message is
 * identified by its `messageID`; it may contain several parts (step_start,
 * tool_use, step_finish, text, ...). We count one turn per assistant message.
 *
 * Recorded fixture (`test/fixtures/opencode-stream.jsonl`) shows:
 * - `step_start` / `step_finish` bracketing a message
 * - `tool_use` carrying a completed tool call
 * - `text` carrying assistant text
 * - `step_finish` carrying `cost` and `tokens` (input, output, reasoning, cache)
 * - `error` carrying `{ type, message }` for failures such as provider limits
 */
export function createOpencodeMapper() {
	const seen = new Set();
	const turnEmitted = new Set();
	function map(event) {
		if (!event || typeof event !== "object") return [];
		const out = [];
		const messageID = event.part?.messageID;
		if (messageID) seen.add(messageID);

		if (event.type === "step_finish" && event.part) {
			const part = event.part;
			if (messageID && !turnEmitted.has(messageID)) {
				turnEmitted.add(messageID);
				const tokens = part.tokens ?? {};
				const cache = tokens.cache ?? {};
				const input = (tokens.input ?? 0) + (cache.read ?? 0) + (cache.write ?? 0);
				const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
				out.push({ type: "turn", model: undefined, usage: { input, output, totalTokens: input + output }, costUsd: part.cost ?? 0 });
				out.push({ type: "context", tokens: input });
			}
			if (typeof part.cost === "number") out.push({ type: "cost", costUsd: part.cost });
		} else if (event.type === "text" && event.part?.text) {
			if (messageID && !turnEmitted.has(messageID)) {
				turnEmitted.add(messageID);
				out.push({ type: "turn", model: undefined, usage: { input: 0, output: 0, totalTokens: 0 }, costUsd: 0 });
			}
			out.push({ type: "text", text: event.part.text });
		} else if (event.type === "tool_use" && event.part) {
			out.push(toolEvent(event.part.tool, event.part.state?.input));
		} else if (event.type === "error") {
			const message = event.error?.message ?? event.message ?? "opencode error";
			out.push({ type: "error", message });
		}
		return out;
	}
	map.flush = () => [];
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

/** Emit any pending state (currently none; kept for symmetry with other mappers). */
createOpencodeMapper.flush = function () {
	return [];
};

/** Stateless convenience for single events (tests); prefer createOpencodeMapper for a stream. */
export function mapOpencodeEvent(event) {
	return createOpencodeMapper()(event);
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
		warnings: [`OpenCode backend not available: ${reason}`],
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
