import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { classifyError } from "shiftwork-core";
import { execIn } from "./exec.js";
import { runAgent, spawnAgent } from "./spawn-agent.js";

/**
 * Grok Build backend: `grok -m <m> --output-format streaming-json --always-approve -p <prompt>`.
 * Headless mode is `-p/--single`: a positional prompt opens the interactive TUI instead
 * (and crashes without a TTY). Always invoke the binary as `grok`, never `agent`: Grok Build
 * and Cursor both install an `agent` symlink, and which one runs depends on PATH order.
 * Skills are delivered as symlinks in `.agents/skills/` inside the worktree, excluded from git.
 * The worker prompt, preloaded skills and the project instructions (`AGENTS.md`, else
 * `CLAUDE.md`, with one level of `@<path>` imports) go to grok's system prompt with `--rules`,
 * so `-p` is only the ticket: grok's own prompt implements action requests but answers
 * planning-looking requests without edits. `thinking` becomes `--reasoning-effort`, clamped
 * to the levels the model offers in `~/.grok/models_cache.json` (grok rejects other levels).
 * Options: { command?: "grok", args?: string[], env?: object, timeoutMs?: number, modelsCache?: string }
 */
const SAFETY_TIMEOUT_MS = 3 * 60 * 60_000;

export function createGrokBackend(options = {}) {
	const command = options.command ?? "grok";

	return {
		name: "grok",
		capabilities: { inPlaceHandoff: false, skills: "links" },

		async probe(model, { timeoutMs = 60_000 } = {}) {
			if (!(await isOnPath(command, options.env))) return false;
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
			const result = await runAgent(command, args, { env: { ...process.env, ...options.env }, timeoutMs });
			const output = `${result.stdout}\n${result.stderr}`;
			return !result.error && result.code === 0 && classifyError(output) === null;
		},

		async startShift({ cwd, route, prompt, systemPrompt }) {
			if (!(await isOnPath(command, options.env))) {
				return unavailableShift(`${command}: command not found`);
			}

			const preload = await loadPreload(route.skills?.preload ?? []);
			const projectInstructions = await loadProjectInstructions(cwd);
			const rules = [systemPrompt, preload.text, projectInstructions].filter(Boolean).join("\n\n");
			const effort = grokEffort(route.thinking, route.model, options.modelsCache);

			const skillPaths = route.skills?.restricted ? route.skills.paths ?? [] : [];
			const skillsDir = join(cwd, ".agents", "skills");
			const skillLinks = skillPaths.length ? await linkSkills(skillsDir, skillPaths) : [];
			if (skillPaths.length) await excludeSkillsFromGit(cwd);

			const args = ["-m", route.model, "--output-format", "streaming-json", "--always-approve"];
			if (effort) args.push("--reasoning-effort", effort);
			if (rules) args.push("--rules", rules);
			args.push(...(options.args ?? []));
			args.push("-p", prompt);

			const queue = eventQueue();
			let stopping = false;
			const timeoutMs = options.timeoutMs ?? SAFETY_TIMEOUT_MS;
			const map = createGrokMapper();
			let ended = false;
			let sawError = false;

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
						if (mapped.type === "error") sawError = true;
						queue.push(mapped);
					}
				},
				onError: (error) => finish("error", error.message),
				onClose: ({ code, timedOut }) => {
					if (stopping) return;
					// Grok exits 0 even when the stream carried a fatal error (e.g. unknown model).
					const message = timedOut
						? `grok timed out after ${Math.round(timeoutMs / 60_000)} min (safety timeout)`
						: code !== 0 ? agent.stderrTail() || `grok exited with code ${code}` : undefined;
					finish(code === 0 && !sawError ? "stop" : "error", message);
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
 * Map Grok Build `--output-format streaming-json` (ACP session updates) to ShiftEvents.
 *
 * Recorded fixture (`test/fixtures/grok-stream.jsonl`, grok 1.0.44) shows:
 * - `available_commands`: tool/command lists; noise, ignored
 * - `text`: { data } — a streaming chunk of the current assistant message
 * - `tool_call`: { toolName, rawInput } — one `tool` event; `tool_call_update`: its progress, ignored
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
		} else if (event.type === "tool_call") {
			// tool_call_update events follow the same call: only the first is a new call.
			out.push(toolEvent(event.toolName ?? event.kind ?? event.title, event.rawInput));
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

/** Stateless convenience for single events (tests); prefer createGrokMapper for a stream. */
export function mapGrokEvent(event) {
	return createGrokMapper()(event);
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

const EFFORT_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Shiftwork's thinking level as one of the model's reasoning efforts: the same level when
 * offered, else the nearest offered one (off/minimal → the lowest, max → the highest).
 * Undefined when the model or its menu is unknown, so grok keeps its own default.
 */
export function grokEffort(thinking, model, cachePath = join(homedir(), ".grok", "models_cache.json")) {
	if (!thinking || !model) return undefined;
	let offered;
	try {
		const info = JSON.parse(readFileSync(cachePath, "utf8")).models?.[model]?.info;
		if (!info?.supports_reasoning_effort) return undefined;
		offered = (info.reasoning_efforts ?? []).map((e) => e.value ?? e.id).filter((v) => EFFORT_LADDER.includes(v));
	} catch {
		return undefined;
	}
	if (!offered.length) return undefined;
	const want = EFFORT_LADDER.indexOf(thinking);
	if (want < 0) return undefined;
	let best;
	for (const level of offered) {
		const distance = Math.abs(EFFORT_LADDER.indexOf(level) - want);
		if (best === undefined || distance < best.distance) best = { level, distance };
	}
	return best.level;
}
