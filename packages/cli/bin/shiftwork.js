#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { frontier, loadConfig, loadTickets, openTracker, planShift, runFrontier, validateConfig, VERSION } from "shiftwork-core";

const HELP = `shiftwork ${VERSION} — autonomous agents working in shifts

Usage:
  shiftwork init [--model <provider/id>] [--force]
                                Create .pi/shiftwork.json, the worker prompt and pi settings
  shiftwork status [dir]        List tickets and the frontier of ready ones
  shiftwork run [options]       Work the frontier until nothing is left
  shiftwork --version

Run options:
  --once                 Work exactly one ticket
  --dry-run              Print the route of each frontier ticket; spend nothing
  --feature <slug>       Only tickets of this feature
  --model <provider/id>  Default model (else "model" in .pi/shiftwork.json)
  --thinking <level>     Default thinking level (default: medium)
  --max-attempts <n>     Attempts per ticket before needs-info (default: 3)
  --no-worktree          Work in the main checkout instead of a git worktree per ticket
  --dir <path>           Repo root (default: current directory)
  -h, --help             Show this help

Exit codes: 0 all resolved or nothing to do · 2 some tickets need info · 1 error`;

const [command = "help", ...rest] = process.argv.slice(2);

try {
	switch (command) {
		case "status":
			await status(rest[0] ?? process.cwd());
			break;
		case "init": {
			const { init } = await import("../src/init.js");
			await init(rest);
			break;
		}
		case "run":
			process.exitCode = await run(rest);
			break;
		case "-v":
		case "--version":
			console.log(VERSION);
			break;
		default:
			console.log(HELP);
	}
} catch (error) {
	console.error(`shiftwork: ${error.message}`);
	process.exitCode = 1;
}

async function status(dir) {
	const tickets = await loadTickets(dir);
	if (tickets.length === 0) {
		console.log("No tickets found in .scratch/<feature>/issues/*.md");
		return;
	}
	const ready = new Set(frontier(tickets).map((t) => t.path));
	for (const t of tickets) {
		const mark = ready.has(t.path) ? "→" : " ";
		const blocked = t.blockedBy.length ? `  blocked by ${t.blockedBy.join(", ")}` : "";
		console.log(`${mark} ${t.feature}/${t.number}  [${t.status ?? "?"}]  ${t.title ?? ""}${blocked}`);
	}
	console.log(`\n${ready.size} ready of ${tickets.length} tickets (→ = frontier)`);
}

async function run(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			once: { type: "boolean" },
			"dry-run": { type: "boolean" },
			feature: { type: "string" },
			model: { type: "string" },
			thinking: { type: "string" },
			"max-attempts": { type: "string" },
			"no-worktree": { type: "boolean" },
			dir: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	const root = values.dir ?? process.cwd();
	const loaded = await loadConfig(root, process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const config = validateConfig({
		...loaded,
		model: values.model ?? loaded.model,
		thinking: values.thinking ?? loaded.thinking,
		maxAttempts: values["max-attempts"] ? Number(values["max-attempts"]) : loaded.maxAttempts,
		workerPrompt: readOptional(join(root, ".pi", "shiftwork-worker.md")),
	});

	if (values["dry-run"]) {
		const tickets = (await openTracker(root).frontier()).filter((t) => !values.feature || t.feature === values.feature);
		if (!tickets.length) console.log("Nothing to do: the frontier is empty.");
		for (const t of tickets) {
			const r = planShift({ ticket: t, config });
			console.log(`${t.feature}/${t.number}  type=${r.type}${t.type ? "" : " (default)"}  tier=${r.tier ?? "-"}  model=${r.model}  thinking=${r.thinking}  ${t.title ?? ""}`);
		}
		return 0;
	}

	const { createPiBackend } = await import("../src/pi-backend.js");
	const { runVerify } = await import("../src/verify.js");
	const backend = createPiBackend(config.pi ?? {});
	const workspace = await createWorkspace(root, config, values["no-worktree"]);
	console.log(`shiftwork: pi ${backend.pi.version} · max ${config.maxAttempts} attempts per ticket`);

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: (commands, cwd) => runVerify(commands, cwd),
		config,
		workspace,
		log: shiftLogger(root),
		options: { once: values.once, feature: values.feature },
	});

	for (const t of summary.resolved) console.log(`✔ ${t.feature}/${t.number} resolved  ${t.title ?? ""}`);
	for (const t of summary.needsInfo) console.log(`✖ ${t.feature}/${t.number} needs-info: ${t.reason}`);
	if (!summary.resolved.length && !summary.needsInfo.length) console.log("Nothing to do: the frontier is empty.");
	return summary.exitCode;
}

/** A git worktree per ticket when root is a git repo, unless disabled (ticket 06). */
async function createWorkspace(root, config, disabled) {
	const settings = config.worktree ?? {};
	if (disabled || settings.enabled === false) return undefined;
	const { execFileSync } = await import("node:child_process");
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
	} catch {
		if (settings.enabled === true) throw new Error(`worktree.enabled is true but ${root} is not a git repository`);
		return undefined;
	}
	const { createGitWorkspace } = await import("../src/git.js");
	return createGitWorkspace({ root, target: settings.target, setup: settings.setup, dir: settings.dir });
}

function readOptional(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Append every shift event as NDJSON to logs/<feature>/<NN>/attempt-<n>.jsonl. */
function shiftLogger(root) {
	return ({ ticket, attempt, event }) => {
		const dir = join(root, "logs", ticket.feature, ticket.number);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, `attempt-${attempt}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
		if (event.type === "turn") process.stdout.write(`  · ${ticket.feature}/${ticket.number} turn (${event.usage.totalTokens} tokens)\n`);
	};
}
