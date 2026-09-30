import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyError } from "shiftwork-core";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Find the pi installation to drive: an explicit root, the package resolvable from here,
 * or the `pi` on PATH. Returns { root, cli, index }.
 */
export function locatePi({ root } = {}) {
	const candidates = [];
	if (root) candidates.push(root);
	try {
		candidates.push(packageRootOf(fileURLToPath(import.meta.resolve(PI_PACKAGE))));
	} catch {}
	try {
		const bin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
		if (bin) candidates.push(packageRootOf(realpathSync(bin)));
	} catch {}
	for (const candidate of candidates.filter(Boolean)) {
		const pkg = join(candidate, "package.json");
		if (!existsSync(pkg)) continue;
		const manifest = JSON.parse(readFileSync(pkg, "utf8"));
		if (manifest.name !== PI_PACKAGE) continue;
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
		return { root: candidate, cli: join(candidate, bin), index: join(candidate, "dist", "index.js"), version: manifest.version };
	}
	throw new Error(`pi not found: install it with "npm i -g ${PI_PACKAGE}" or set pi.root in .pi/shiftwork.json`);
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
 * Options: { root?, args?: string[], env?: object, timeoutMs? }
 */
export function createPiBackend(options = {}) {
	const pi = locatePi({ root: options.root });
	let RpcClient;

	return {
		name: "pi",
		pi,

		/**
		 * Availability check before a ticket: one tiny `pi -p` request to `model`.
		 * True when pi exits cleanly and prints no provider limit.
		 */
		probe(model, { timeoutMs = 60_000 } = {}) {
			const args = [pi.cli, "-p", "--no-session", "-ns", "-nc", "--model", model, "--thinking", "off", ...(options.args ?? []), "Reply with exactly: OK"];
			return new Promise((resolve) => {
				const child = execFile(process.execPath, args, { env: { ...process.env, ...options.env }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
					const output = `${stdout}\n${stderr}`;
					resolve(!error && classifyError(output) === null);
				});
				// pi -p reads piped stdin as extra prompt text; close it so the probe doesn't wait.
				child.stdin?.end();
			});
		},
		async startShift({ cwd, route, prompt, systemPrompt }) {
			RpcClient ??= (await import(pathToFileURL(pi.index).href)).RpcClient;
			const dir = await mkdtemp(join(tmpdir(), "shiftwork-shift-"));
			const promptFile = join(dir, "system.md");
			const preload = await loadPreload(route.skills?.preload ?? []);
			const fullSystemPrompt = [systemPrompt, preload.text].filter(Boolean).join("\n\n");
			await writeFile(promptFile, fullSystemPrompt ?? "");

			const args = ["--no-session", "--approve", "--append-system-prompt", promptFile];
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
			const timer = setTimeout(() => {
				queue.push({ type: "error", message: `shift timed out after ${options.timeoutMs} ms` });
				client.abort().catch(() => {});
				finish("timeout");
			}, options.timeoutMs ?? 60 * 60_000);

			let lastStop = null;
			client.onEvent((event) => {
				queue.push({ type: "raw", event });
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
				client.process?.once("exit", (code) => {
					if (!queue.closed) queue.push({ type: "error", message: `pi exited with code ${code}: ${client.getStderr().slice(-500)}` });
					finish("error");
				});
				const disposition = await client.prompt(prompt);
				if (disposition === "handled") finish("stop");
			} catch (error) {
				queue.push({ type: "error", message: error.message });
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
	if (message.stopReason === "error") out.push({ type: "error", message: message.errorMessage ?? "provider error" });
	return out;
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
