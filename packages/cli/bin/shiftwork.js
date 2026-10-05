#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { formatTicketsTable, LIMIT_NAMES, loadConfig, openCooldowns, openRepoTracker, openRunState, runFrontier, shiftworkPath, validateConfig, VERSION } from "shiftwork-core";
import { ensureShiftworkOnPath } from "../src/cli-path.js";

ensureShiftworkOnPath();

const HELP = `shiftwork ${VERSION} — autonomous agents working in shifts

Usage:
  shiftwork init [--model <provider/id>] [--ollama] [--force]
                                Create .shiftwork/shiftwork.json, the worker prompt and pi settings
                                --ollama: also discover local Ollama models (OLLAMA_HOST),
                                add an ollama provider to ~/.pi/agent/models.json and a
                                local tier to .shiftwork/shiftwork.json
  shiftwork status [dir] [--dir <path>]
                                List tickets and the frontier of ready ones
  shiftwork feature pause <feature> [--dir <path>]
                                Freeze a feature: "paused" in its spec's Status line (added
                                under the title when the spec has none; the tickets untouched),
                                so none of its tickets stays on the frontier
  shiftwork feature resume <feature> [--dir <path>]
                                Thaw a paused feature back to "ready-for-agent"
  shiftwork run [options]       Work the frontier until nothing is left
  shiftwork tui [--once] [--dir <path>]
                                Full-screen dashboard: Queue, Agents, Cooldowns, Log, Resolved,
                                GitHub (1–6, tab); n runs the selected ticket, r runs, s stops,
                                d dry-runs, p pauses a feature, / searches, g dark-factory
  shiftwork logs [<feature>/<NN>] [-f|--follow] [--raw] [--all] [--dir <path>]
                                Read the agents' shift logs: the live runner's workers (else
                                the latest log), or one ticket's current attempt (--all: every
                                attempt); -f follows them as they are written (Ctrl-C stops)
  shiftwork reflect [--since <days>] [--min <n>] [--write] [--dir <path>]
                                Find shell steps agents repeated in at least n (default 3)
                                shifts and suggest a script for each; --write saves the
                                report to .scratch/reflections/ and files an automate-* feature
  shiftwork stop [--dark-factory] [--wait [sec]] [--force] [--dir <path>]
                                Stop the live runner: write STOP so its shifts hand off and
                                it exits (nothing written when no runner is live);
                                --dark-factory only stops a dark-factory runner (exit 1 while
                                a plain run is live); --wait polls until it has stopped
                                (default 120 s, exit 1 on timeout) and removes the STOP file;
                                --force also sends it SIGTERM
  shiftwork tickets check <feature> [--min <n>] [--except NN] [--dir <path>]
                                Planning gate: exit 0 when at least n (default 1) tickets
                                besides the excepted ones (default 01) are ready-for-agent
                                or later, each with checkboxes and a Verify line, and every
                                Blocked-by number exists in the feature, with no Blocked-by cycle
  shiftwork graph <feature> [--dir <path>]
                                Print the feature's tickets and Blocked-by edges as a Mermaid
                                flowchart (status in each label, cycles dashed); read-only
  shiftwork jobs <list|run|watch|status> [name...] [--force] [--retry-failed] [--dry-run] [--dir <path>]
                                Deterministic scripts from .shiftwork/jobs.json, item by item,
                                resumable; watch runs scheduled ones (see docs/guide.md "Jobs")
  shiftwork github labels [--create] [--dir <path>]
                                Check the dark-factory labels (github.labels) exist in the
                                GitHub repo: ✔ exists / ✖ missing per label, exit 1 when any
                                is missing; --create creates the missing ones with a colour
                                and a description, never edits or deletes one
                                (see docs/guide.md "Dark-factory: labels")
  shiftwork migrate [--dry-run] [--dir <path>]
                                Move Shiftwork's files (shiftwork.json, the worker prompt, run
                                state, cooldowns, locks) from the legacy .pi/ to .shiftwork/;
                                pi's own files stay in .pi/; refused while a runner is live
  shiftwork --version

Run options:
  --once                 Work exactly one ticket
  --dark-factory         Watch the repo's GitHub issues (the "github" config block):
                        every github.pollMin minutes import collaborators' issues,
                        report back on them, and work the frontier; STOP or a signal
                        ends it after the current shift; --once is one poll + one pass
                        (see docs/guide.md "Dark-factory mode")
  --ticket <feature>/<NN>
                        Work exactly that ticket (implies --once; refused with the reason
                        when it is not on the frontier; not with --feature or --parallel)
  --dry-run              Print the route of each frontier ticket; spend nothing
  --feature <slug>       Only tickets of this feature
  --model <provider/id>  Default model (else "model" in .shiftwork/shiftwork.json)
  --thinking <level>     Default thinking level (default: medium)
  --max-attempts <n>     Attempts per ticket before needs-info (default: 3)
  --parallel <n>         Work up to n frontier tickets at once (default: 1, or "parallel"
                        in .shiftwork/shiftwork.json; > 1 needs worktree.enabled and one worktree
                        per ticket; "concurrency" caps the shifts per provider)
  --no-worktree          Work in the main checkout instead of a git worktree per ticket
  --no-budget            Lift every budget limit (turns, tokens, cost, time, context, stall),
                        for shifts and tickets, including tickets' Budget: lines
  --no-limit <limits>    Lift only these limits: tokens, cost, turns, time, context, stall
                        (comma-separated or repeated; adds to "unlimited" in the config)
  --no-review            Turn review shifts off for this run (they are on by default:
                        every ticket is reviewed once on the strongest configured
                        tier, on its branch before it lands — see "review" in
                        .shiftwork/shiftwork.json)
  --dir <path>           Repo root (default: current directory)
  -h, --help             Show this help

Exit codes: 0 all resolved or nothing to do · 2 some tickets need info or a review reopened one · 3 stopped · 1 error`;

const [command = "help", ...rest] = process.argv.slice(2);

try {
	switch (command) {
		case "status":
			await status(rest);
			break;
		case "feature":
			process.exitCode = await feature(rest);
			break;
		case "tickets":
			process.exitCode = await tickets(rest);
			break;
		case "graph": {
			const { graph } = await import("../src/graph.js");
			process.exitCode = await graph(rest);
			break;
		}
		case "init": {
			const { init } = await import("../src/init.js");
			await init(rest);
			break;
		}
		case "run":
			process.exitCode = await run(rest);
			break;
		case "github":
			process.exitCode = await github(rest);
			break;
		case "stop": {
			const { stop } = await import("../src/stop.js");
			process.exitCode = await stop(rest);
			break;
		}
		case "logs": {
			const { logs } = await import("../src/logs.js");
			process.exitCode = await logs(rest);
			break;
		}
		case "reflect": {
			const { reflect } = await import("../src/reflect.js");
			process.exitCode = await reflect(rest);
			break;
		}
		case "migrate": {
			const { migrate } = await import("../src/migrate.js");
			process.exitCode = await migrate(rest);
			break;
		}
		case "jobs": {
			const { jobsCommand } = await import("../src/jobs.js");
			process.exitCode = await jobsCommand(rest);
			break;
		}
		case "tui": {
			const { tui } = await import("../src/tui.js");
			process.exitCode = await tui(rest);
			break;
		}
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

async function status(argv) {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { dir: { type: "string" } },
	});
	const dir = values.dir ?? positionals[0] ?? process.cwd();
	const tracker = await openRepoTracker(dir);
	const tickets = await tracker.list();
	const frontier = await tracker.frontier();
	// Key tickets by feature/number: OpenSpec tasks of one change share a tasks.md path.
	const keyOf = (t) => `${t.feature}/${t.number}`;
	const ready = new Set(frontier.map(keyOf));
	const claims = await tracker.activeClaims();

	if (tickets.length === 0) {
		console.log("No tickets found in .scratch/<feature>/issues/*.md");
	} else {
		for (const t of tickets) {
			const mark = ready.has(keyOf(t)) ? "→" : " ";
			const claim = claims.find((c) => keyOf(c.ticket) === keyOf(t));
			const claimInfo = claim ? `  pid ${claim.pid}  age ${formatAge(Date.now() - new Date(claim.at).getTime())}` : "";
			const blocked = t.blockedBy.length ? `  blocked by ${t.blockedBy.join(", ")}` : "";
			console.log(`${mark} ${t.feature}/${t.number}  [${t.status ?? "?"}]  ${t.title ?? ""}${claimInfo}${blocked}`);
		}
		console.log(`\n${ready.size} ready of ${tickets.length} tickets (→ = frontier)`);
		const paused = new Set(tickets.filter((t) => t.featurePaused).map((t) => t.feature));
		const features = [...new Set(tickets.map((t) => t.feature))].sort();
		for (const feature of features) {
			console.log(`\n${feature}${paused.has(feature) ? "  ⏸ paused" : ""}`);
			console.log(formatTicketsTable(tickets.filter((t) => t.feature === feature)));
		}
	}

	if (claims.length === 0) {
		console.log("\nActive claims: none");
	} else {
		console.log("\nActive claims:");
		for (const c of claims) {
			console.log(`  ${c.ticket.feature}/${c.ticket.number}  pid ${c.pid}  age ${formatAge(Date.now() - new Date(c.at).getTime())}`);
		}
	}

	// Every running shift, across parallel workers and second runner processes.
	const run = await openRunState(dir).read();
	if (run?.live) {
		const workers = run.workers ?? [];
		console.log("\nRunning shifts:");
		if (!workers.length) console.log(`  runner pid ${run.pid} · between tickets`);
		for (const w of workers) {
			const t = w.ticket ?? {};
			console.log(
				`  ${t.feature ?? "?"}/${t.number ?? "?"}  pid ${run.pid}  shift ${w.shift ?? "?"} · attempt ${w.attempt ?? "?"} · ${w.model ?? "?"}`,
		);
		}
	}

	const cooldowns = (await openCooldowns(dir).active()).sort((a, b) => new Date(a.until) - new Date(b.until));
	if (cooldowns.length === 0) {
		console.log("Cooldowns: none");
	} else {
		console.log("Cooldowns:");
		const now = Date.now();
		for (const c of cooldowns) {
			const remaining = Math.max(0, new Date(c.until).getTime() - now);
			console.log(`  ${c.provider} (${c.kind ?? "limit"})  ${remaining > 0 ? `${formatAge(remaining)} remaining` : "expiring"}`);
		}
	}
}

/** `tickets check <feature>`: the planning ticket's verify gate. */
async function tickets(argv) {
	const [subcommand, ...rest] = argv;
	if (subcommand !== "check") {
		console.log(HELP);
		return 0;
	}
	const { positionals, values } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			min: { type: "string" },
			except: { type: "string", multiple: true },
			dir: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	const feature = positionals[0];
	if (!feature) throw new Error("usage: shiftwork tickets check <feature> [--min <n>] [--except NN] [--dir <path>]");
	const min = values.min === undefined ? 1 : Number(values.min);
	if (!Number.isInteger(min) || min < 1) throw new Error(`--min must be a positive integer, got "${values.min}"`);
	const { checkFeatureTickets, parseExcept, resolveTrackerRoot } = await import("../src/tickets-check.js");
	const except = parseExcept(values.except ?? ["01"]);
	const { ok, problems, ready, asked } = await checkFeatureTickets({
		root: await resolveTrackerRoot({ dir: values.dir }),
		feature,
		min,
		except,
	});
	if (ok && asked) {
		console.log(`${feature}: plan needs information; no implementation tickets required`);
		return 0;
	}
	if (ok) {
		console.log(`${feature}: ${ready} ready ticket${ready === 1 ? "" : "s"} besides ${except.join(", ")} (need ${min})`);
		return 0;
	}
	for (const problem of problems) console.log(problem);
	return 1;
}

/** `feature pause|resume <feature>`: freeze or thaw one feature (see ../src/feature-pause.js). */
async function feature(argv) {
	const [subcommand, ...rest] = argv;
	if (subcommand !== "pause" && subcommand !== "resume") {
		console.log(HELP);
		return subcommand === undefined ? 0 : 1;
	}
	const { positionals, values } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: { dir: { type: "string" }, help: { type: "boolean", short: "h" } },
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	const name = positionals[0];
	if (!name) throw new Error(`usage: shiftwork feature ${subcommand} <feature> [--dir <path>]`);
	const root = values.dir ?? process.cwd();
	const { featurePauseCommand } = await import("../src/feature-pause.js");
	await featurePauseCommand({ root, action: subcommand, feature: name });
	return 0;
}

function formatAge(ms) {
	if (ms < 1000) return "0s";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	const remMin = min % 60;
	if (h < 24) return remMin ? `${h}h ${remMin}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const remH = h % 24;
	return remH ? `${d}d ${remH}h` : `${d}d`;
}

/** `github labels [--create]`: check the dark-factory labels exist; `--create` creates the missing ones. */
async function github(argv) {
	const [subcommand, ...rest] = argv;
	if (subcommand !== "labels") {
		console.log(HELP);
		return 1;
	}
	const { values } = parseArgs({
		args: rest,
		options: {
			create: { type: "boolean" },
			dir: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	const root = values.dir ?? process.cwd();
	const config = await loadConfig(root, process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const { githubLabelsCommand } = await import("../src/github-labels.js");
	return githubLabelsCommand({ root, config, create: values.create });
}

/** The review line printed at start: the tier and its scope, or why reviews are off. */
function reviewStartLine(config, noReview) {
	const review = config.review;
	if (review?.enabled) {
		const scope = review.features?.length && review.types?.length
			? `features ${review.features.join(", ")} and types ${review.types.join(", ")}`
			: review.features?.length ? `features ${review.features.join(", ")}` : review.types?.length ? `types ${review.types.join(", ")}` : "every ticket";
		return `shiftwork: review · ${review.tier} for ${scope}`;
	}
	if (noReview) return "shiftwork: review off (--no-review)";
	if (review?.reason) return `shiftwork: review off: ${review.reason}`;
	return "shiftwork: review off (config)";
}

/** `--no-budget` lifts every limit; `--no-limit tokens,time` (repeatable) adds to the config's `unlimited`. */
function unlimitedFrom(values, configured) {
	if (values["no-budget"]) return true;
	const named = (values["no-limit"] ?? []).flatMap((list) => list.split(",")).map((s) => s.trim()).filter(Boolean);
	if (!named.length) return configured;
	if (configured === true) return true;
	return [...(Array.isArray(configured) ? configured : []), ...named];
}

async function run(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			once: { type: "boolean" },
			"dark-factory": { type: "boolean" },
			ticket: { type: "string" },
			"dry-run": { type: "boolean" },
			feature: { type: "string" },
			model: { type: "string" },
			thinking: { type: "string" },
			"max-attempts": { type: "string" },
			parallel: { type: "string" },
			"no-worktree": { type: "boolean" },
			"no-budget": { type: "boolean" },
			"no-limit": { type: "string", multiple: true },
			"no-review": { type: "boolean" },
			dir: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	// --dark-factory watches every issue's feature itself: it cannot work one
	// chosen ticket, one feature, several at once, or only print the route.
	if (values["dark-factory"]) {
		const combined = ["ticket", "feature", "parallel", "dry-run"].find((flag) => values[flag] !== undefined);
		if (combined !== undefined) {
			throw new Error(`--dark-factory cannot be combined with --${combined}`);
		}
	}
	if (values.ticket && (values.feature || values.parallel !== undefined)) {
		throw new Error("--ticket cannot be combined with --feature or --parallel: it works exactly one chosen ticket");
	}
	const root = values.dir ?? process.cwd();
	const loaded = await loadConfig(root, process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const config = validateConfig({
		...loaded,
		model: values.model ?? loaded.model,
		thinking: values.thinking ?? loaded.thinking,
		maxAttempts: values["max-attempts"] ? Number(values["max-attempts"]) : loaded.maxAttempts,
		parallel: values.parallel !== undefined ? Number(values.parallel) : loaded.parallel,
		unlimited: unlimitedFrom(values, loaded.unlimited),
		// `--no-review` turns reviews off for this one run, like `review: false` in the config.
		review: values["no-review"] ? false : loaded.review,
		workerPrompt: readOptional(shiftworkPath(root, "shiftwork-worker.md")),
	});
	if ((config.parallel ?? 1) > 1 && values["no-worktree"]) {
		throw new Error("--no-worktree cannot be combined with parallel > 1: every parallel ticket needs its own worktree");
	}

	if (config.unlimited.length) {
		const lifted = config.unlimited.length === Object.keys(LIMIT_NAMES).length ? "all limits" : config.unlimited.map((field) => Object.keys(LIMIT_NAMES).find((name) => LIMIT_NAMES[name] === field)).join(", ");
		console.error(`shiftwork: no budget for ${lifted}: shifts run until the agent stops${config.unlimited.includes("maxCostUsd") ? ", whatever it costs" : ""}`);
	}
	console.log(reviewStartLine(config, values["no-review"]));

	if (values["dry-run"]) {
		const { collectDryRunLines } = await import("../src/dry-run.js");
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		for (const line of await collectDryRunLines(root, { feature: values.feature, config, agentDir })) console.log(line);
		return 0;
	}

	const { createBackend } = await import("../src/backend-registry.js");
	const { createJevClassifier } = await import("../src/jev.js");
	const { createVerify, killRunningVerify } = await import("../src/verify.js");
	const { installSignalStop, trackShifts } = await import("../src/signal-stop.js");
	const backend = trackShifts(createBackend({ pi: config.pi, claude: config.claude, codex: config.codex, opencode: config.opencode, grok: config.grok, cursor: config.cursor }));
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const classifyTicket = createJevClassifier({ config, agentDir });
	const workspace = await createWorkspace(root, config, values["no-worktree"]);
	console.log(`shiftwork: registry · max ${config.maxAttempts} attempts per ticket`);
	if ((config.parallel ?? 1) > 1) console.log(`shiftwork: parallel · up to ${config.parallel} tickets at once`);

	// A signal stops like a STOP file; a second one aborts the shifts, so no agent outlives the runner.
	const signalStop = installSignalStop({ root, abortShifts: () => backend.abortAll(), killVerify: killRunningVerify });
	let summary;
	try {
		if (values["dark-factory"]) {
			const { darkFactoryRun } = await import("../src/dark-factory.js");
			return await darkFactoryRun({
				root,
				tracker: await openRepoTracker(root, config),
				backend,
				verify: createVerify(config),
				config,
				workspace,
				classifyTicket,
				shiftLog: await shiftLogger(root),
				once: values.once,
			});
		}
		summary = await runFrontier({
			root,
			tracker: await openRepoTracker(root, config),
			backend,
			verify: createVerify(config),
			config,
			workspace,
			classifyTicket,
			log: await shiftLogger(root),
			options: { once: values.once, feature: values.feature, ticket: values.ticket },
		});
	} finally {
		signalStop.dispose();
	}

	for (const t of summary.resolved) {
		console.log(`✔ ${t.feature}/${t.number} resolved: ${t.reason}`);
		if (t.review?.followUp?.created) console.log(`  ↳ follow-up ${t.review.followUp.feature}/${t.review.followUp.number}: ${t.review.followUp.title}`);
	}
	for (const t of summary.reopened ?? []) console.log(`✖ ${t.feature}/${t.number} reopened by review: ${t.reason}`);
	for (const t of summary.needsInfo) console.log(`✖ ${t.feature}/${t.number} needs-info: ${t.reason}`);
	if (summary.stoppedReason) console.log(`⚠ Stopped: ${summary.stoppedReason}`);
	if (!summary.resolved.length && !summary.needsInfo.length && !summary.stoppedReason) console.log("Nothing to do: the frontier is empty.");
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

/**
 * Append every shift event as NDJSON to logs/<feature>/<NN>/attempt-<n>[.<k>].jsonl: a
 * file of this run's own (an earlier run's attempt-<n>.jsonl is left alone), each shift
 * opening with a `start` event that names its backend, model and tier (dashboard.js).
 */
async function shiftLogger(root) {
	const { createShiftLogger } = await import("../src/dashboard.js");
	const log = createShiftLogger(root);
	return (entry) => {
		log(entry);
		const { ticket, event, dual } = entry;
		const who = `${ticket.feature}/${ticket.number}${dual ? `·${dual}` : ""}`;
		if (event.type === "turn") process.stdout.write(`  · ${who} turn (${event.usage.totalTokens} tokens)\n`);
	};
}
