import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyError } from "shiftwork-core";
import { registerChild } from "./signal-stop.js";
import { runAgent } from "./spawn-agent.js";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Find the pi installation to drive: an explicit root (`pi.root`), the package resolvable
 * from here, the `pi` on PATH (an npm bin, or the managed installer's shell launcher), or
 * a managed install in the pi agent dir. Returns { root, cli, index, version }.
 * `resolvePackage`, `which`, `env` and `home` are injectable for tests.
 */
export function locatePi({
	root,
	env = process.env,
	home = homedir(),
	resolvePackage = () => fileURLToPath(import.meta.resolve(PI_PACKAGE)),
	which = () => execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim(),
} = {}) {
	const candidates = [];
	if (root) candidates.push(root);
	try {
		candidates.push(packageRootOf(resolvePackage()));
	} catch {}
	try {
		const bin = which();
		if (bin) {
			const real = realpathSync(bin);
			// A managed install puts a shell launcher at <agentDir>/bin/pi.
			candidates.push(packageRootOf(real) ?? managedPiRoot(join(dirname(dirname(real)), "install")));
		}
	} catch {}
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
	if (env.PI_MANAGED_INSTALL_ROOT) candidates.push(managedPiRoot(env.PI_MANAGED_INSTALL_ROOT));
	candidates.push(managedPiRoot(join(agentDir, "install")));
	for (const candidate of candidates.filter(Boolean)) {
		const pkg = join(candidate, "package.json");
		if (!existsSync(pkg)) continue;
		const manifest = JSON.parse(readFileSync(pkg, "utf8"));
		if (manifest.name !== PI_PACKAGE) continue;
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
		return { root: candidate, cli: join(candidate, bin), index: join(candidate, "dist", "index.js"), version: manifest.version };
	}
	throw new Error(`pi not found: install it (https://pi.dev or "npm i -g ${PI_PACKAGE}") or set pi.root in .shiftwork/shiftwork.json`);
}

/** The pi package of a managed install's current release: <install>/releases/<current-version>/node_modules/<pi>. */
function managedPiRoot(installRoot) {
	try {
		const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
		if (!version || version.includes("/") || version.startsWith(".")) return undefined;
		return join(installRoot, "releases", version, "node_modules", ...PI_PACKAGE.split("/"));
	} catch {
		return undefined;
	}
}

/** The `provider/model` refs in `pi --list-models` output (a header row, then one model per row). */
export function parseModelList(text) {
	const refs = new Set();
	for (const line of String(text ?? "").split("\n")) {
		const [provider, model] = line.trim().split(/\s+/);
		if (!provider || !model || provider === "provider" || /:$/.test(provider)) continue;
		refs.add(`${provider}/${model}`);
	}
	return refs;
}

function packageRootOf(file) {
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
			if (name === PI_PACKAGE) return dir;
		}
	}
	return undefined;
}

/**
 * The pi backend: every shift is a fresh `pi --mode rpc --no-session` process (ADR-0002).
 * The user's global pi extensions (widgets, MCP, provider add-ons) are not loaded into a shift:
 * pi runs with `--no-extensions`, which keeps explicit `-e <path>` in `args` working. The
 * pi-shiftwork extension is not needed in a worker (the runner already restricts skills per
 * route). With the default `isolateExtensions: "auto"`, a model pi does not list without its
 * extensions (a provider an extension registers) runs with them loaded; `true` always isolates,
 * `false` never does.
 * Options: { root?, args?: string[], env?: object, timeoutMs?, isolateExtensions?: "auto" | boolean = "auto" }
 */
export function createPiBackend(options = {}) {
	const pi = locatePi({ root: options.root });
	const mode = options.isolateExtensions ?? "auto";
	let RpcClient;
	// `pi --no-extensions --list-models`, read once per backend: the models a shift can use isolated.
	let builtin;
	const builtinModels = () =>
		(builtin ??= runAgent(process.execPath, [pi.cli, "--no-extensions", ...(options.args ?? []), "--list-models"], {
			env: { ...process.env, ...options.env },
			timeoutMs: 60_000,
		}).then(
			(result) => (result.code === 0 ? parseModelList(`${result.stdout}\n${result.stderr}`) : null),
			() => null,
		));
	/** The isolation flags for `model`. Unknown (the list failed): extensions load, as pi does by default. */
	const isolation = async (model) => {
		if (mode === false) return [];
		if (mode === true) return ["--no-extensions"];
		const listed = await builtinModels();
		return listed?.has(model) ? ["--no-extensions"] : [];
	};

	return {
		name: "pi",
		pi,

		/**
		 * Availability check before a ticket: one tiny `pi -p` request to `model`.
		 * True when pi exits cleanly and prints no provider limit.
		 */
		async probe(model, { timeoutMs = 60_000 } = {}) {
			const args = [pi.cli, "-p", "--no-session", "-ns", "-nc", ...(await isolation(model)), "--model", model, "--thinking", "off", ...(options.args ?? []), "Reply with exactly: OK"];
			const result = await runAgent(process.execPath, args, { env: { ...process.env, ...options.env }, timeoutMs });
			return !result.error && result.code === 0 && classifyError(`${result.stdout}\n${result.stderr}`) === null;
		},
		async startShift({ cwd, route, prompt, systemPrompt }) {
			RpcClient ??= (await import(pathToFileURL(pi.index).href)).RpcClient;
			const dir = await mkdtemp(join(tmpdir(), "shiftwork-shift-"));
			const promptFile = join(dir, "system.md");
			const preload = await loadPreload(route.skills?.preload ?? []);
			const fullSystemPrompt = [systemPrompt, preload.text].filter(Boolean).join("\n\n");
			await writeFile(promptFile, fullSystemPrompt ?? "");

			const args = ["--no-session", "--approve", ...(await isolation(route.model)), "--append-system-prompt", promptFile];
			if (route.thinking) args.push("--thinking", route.thinking);
			if (route.skills?.restricted) {
				args.push("-ns");
				for (const skillPath of route.skills.paths) args.push("--skill", skillPath);
			}
			args.push(...(options.args ?? []));
			const client = new RpcClient({ cliPath: pi.cli, cwd, env: options.env, model: route.model, args });

			const queue = eventQueue();
			let epoch = 0;
			const finish = async (stopReason) => {
				if (queue.closed) return;
				queue.push({ type: "end", stopReason, epoch });
				queue.close();
				clearTimeout(timer);
				await client.stop().catch(() => {});
				await rm(dir, { recursive: true, force: true });
			};
			// A safety net only: budgets (maxWallMin) end shifts with a handoff long before this.
			const timeoutMs = options.timeoutMs ?? 3 * 60 * 60_000;
			const timer = setTimeout(() => {
				queue.push({ type: "error", message: `shift timed out after ${Math.round(timeoutMs / 60_000)} min (safety timeout)` });
				client.abort().catch(() => {});
				finish("timeout");
			}, timeoutMs);

			let lastStop = null;
			client.onEvent((event) => {
				for (const raw of piRawEvents(event)) queue.push(raw);
				for (const mapped of mapPiEvent(event)) {
					if (mapped.type === "turn") lastStop = mapped.stopReason;
					queue.push(mapped);
				}
				// Context fill for budgets (maxContextPct): pi reports it through session stats.
				if (event.type === "message_end" && event.message?.role === "assistant") {
					client
						.getSessionStats()
						.then((stats) => {
							const usage = stats.contextUsage;
							if (usage?.percent != null) queue.push({ type: "context", percent: usage.percent, tokens: usage.tokens, contextWindow: usage.contextWindow });
						})
						.catch(() => {});
				}
				// Keep the process alive after settle so set_model + follow_up can continue the same shift.
				if (event.type === "agent_settled") {
					queue.push({ type: "end", stopReason: lastStop === "error" ? "error" : (lastStop ?? "stop"), epoch });
				}
			});

			try {
				await client.start();
				// Unexpected exit of the pi process ends the shift instead of hanging it.
				// RpcClient spawns pi itself (not detached): register it so a forced signal stop kills it.
				const unregister = registerChild(client.process?.pid);
				client.process?.once("exit", (code) => {
					unregister();
					if (!queue.closed) queue.push(piError(`pi exited with code ${code}: ${client.getStderr().slice(-500)}`));
					finish("error");
				});
				const disposition = await client.prompt(prompt);
				if (disposition === "handled") finish("stop");
			} catch (error) {
				queue.push(piError(error.message));
				await finish("error");
			}

			return {
				capabilities: { inPlaceHandoff: true },
				events: (async function* () {
					for await (const event of queue.iterate()) {
						if (event.type === "end" && event.epoch < epoch) continue;
						if (event.type === "end") {
							yield { type: "end", stopReason: event.stopReason };
						} else {
							yield event;
						}
					}
				})(),
				warnings: preload.warnings,
				steer: (text) => client.steer(text),
				async abort() {
					await client.abort().catch(() => {});
					await finish("aborted");
				},
				async close() {
					await finish(lastStop === "error" ? "error" : (lastStop ?? "stop"));
				},
				async swapModel(model, thinking) {
					epoch += 1;
					const slash = model.indexOf("/");
					const provider = slash === -1 ? model : model.slice(0, slash);
					const modelId = slash === -1 ? model : model.slice(slash + 1);
					await client.setModel(provider, modelId);
					if (thinking) await client.setThinkingLevel(thinking);
					await client.followUp("Continue the ticket. The model has been swapped; read the ticket's Comments for the handoff.");
				},
				compact: (instructions) => client.compact(instructions),
				async contextWindow(model) {
					const models = await client.getAvailableModels().catch(() => []);
					const slash = model.indexOf("/");
					const provider = slash === -1 ? model : model.slice(0, slash);
					const id = slash === -1 ? model : model.slice(slash + 1);
					return models.find((m) => m.provider === provider && m.id === id)?.contextWindow;
				},
				client,
			};
		},
	};
}

/** Map one pi JSON event to Shiftwork ShiftEvents. Exported for tests. */
export function mapPiEvent(event) {
	if (event.type === "tool_execution_start") return [toolEvent(event.toolName, event.args)];
	if (event.type !== "message_end" || event.message?.role !== "assistant") return [];
	const message = event.message;
	const usage = message.usage ?? {};
	const out = [
		{
			type: "turn",
			model: message.model,
			stopReason: message.stopReason,
			usage: { input: usage.input ?? 0, output: usage.output ?? 0, totalTokens: usage.totalTokens ?? 0 },
			costUsd: usage.cost?.total ?? 0,
		},
	];
	const text = (message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (text) out.push({ type: "text", text });
	if (message.stopReason === "error") out.push(piError(message.errorMessage ?? "provider error"));
	return out;
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

const AUTH_ERROR = /no api key found/i;

/**
 * A pi error event. `kind: "auth"` marks a missing credential ("No API key found for <provider>"):
 * not a provider limit to cool down, but a model this machine cannot use, so the runner can skip
 * it. The message is pi's, unchanged.
 */
function piError(message) {
	return AUTH_ERROR.test(message) ? { type: "error", message, kind: "auth" } : { type: "error", message };
}

const EXTENSION_ERROR_CHARS = 500;

/**
 * The `raw` events a pi RPC event becomes. Extension UI requests (widgets, status lines,
 * notifications) are dropped: nobody answers them in a shift and they bloat logs. An extension
 * error is kept, compact. Exported for tests.
 */
export function piRawEvents(event) {
	if (event?.type === "extension_ui_request") return [];
	if (event?.type === "extension_error") {
		const { extensionPath, event: hook, error } = event;
		return [{ type: "raw", event: { type: "extension_error", extensionPath, event: hook, error: String(error ?? "").slice(0, EXTENSION_ERROR_CHARS) } }];
	}
	return [{ type: "raw", event }];
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
