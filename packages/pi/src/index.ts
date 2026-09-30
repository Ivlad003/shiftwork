import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { frontier, loadConfig, loadTickets, openRunState, skillsForModel, type RunState, type RunStateWorker } from "shiftwork-core";

const WIDGET = "shiftwork";
const POLL_MS = 1000;
const SUBCOMMANDS = [
	{ value: "run", label: "run", description: "Start the runner detached; a widget shows its progress" },
	{ value: "stop", label: "stop", description: "Write the STOP file: the runner finishes the shift and exits" },
	{ value: "status", label: "status", description: "Show the frontier of ready tickets (the default)" },
];

export default function (pi: ExtensionAPI) {
	/** One poller per session: it reads the runner state and keeps the widget in sync. */
	let poller: NodeJS.Timeout | undefined;
	/** Models already told they have no tier, so the notice is once per session. */
	const noticed = new Set<string>();

	function stopWatching(ctx: ExtensionContext, clearWidget = false) {
		if (poller) clearInterval(poller);
		poller = undefined;
		if (clearWidget && ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
	}

	async function refresh(ctx: ExtensionContext) {
		const state = await openRunState(ctx.cwd).read();
		if (!state) {
			stopWatching(ctx, true);
			return;
		}
		ctx.ui.setWidget(WIDGET, widgetLines(state));
		if (!state.live) stopWatching(ctx);
	}

	function watch(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (poller) clearInterval(poller);
		poller = setInterval(() => {
			void refresh(ctx).catch(() => {});
		}, POLL_MS);
		poller.unref?.();
		void refresh(ctx).catch(() => {});
	}

	pi.on("session_start", (_event, ctx) => {
		// A runner started by an earlier session keeps its widget in this one.
		void openRunState(ctx.cwd)
			.read()
			.then((state) => {
				if (state?.live) watch(ctx);
			})
			.catch(() => {});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopWatching(ctx, true);
	});

	pi.on("before_agent_start", (event, ctx) => applyTierSkills(event, ctx, noticed).catch(() => {}));

	pi.registerCommand("shift", {
		description: "Shiftwork: /shift shows the frontier · /shift run [--feature <slug>] · /shift stop",
		getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (subcommand === "run") return startRunner(ctx, rest, watch);
			if (subcommand === "stop") return stopRunner(ctx);
			if (subcommand === "status" || subcommand === "") return showFrontier(ctx);
			ctx.ui.notify(`Shiftwork: unknown subcommand "${subcommand}". Use /shift, /shift run or /shift stop.`, "warning");
		},
	});
}

/**
 * Narrow advertised skills to the current model's tier, using the same config as the runner.
 * Follows `/model` because `ctx.model` is the live model. No tier → leave skills as they are.
 */
async function applyTierSkills(
	event: { systemPromptOptions: { skills?: { filePath: string }[] } },
	ctx: ExtensionContext,
	noticed: Set<string>,
) {
	if (!ctx.model) return;
	const model = `${ctx.model.provider}/${ctx.model.id}`;
	let config;
	try {
		config = await loadConfig(ctx.cwd, process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	} catch {
		return;
	}
	const { tier, skills } = skillsForModel(model, config);
	if (!tier) {
		if (ctx.hasUI && !noticed.has(model)) {
			noticed.add(model);
			ctx.ui.notify(`Shiftwork: ${model} is not in any tier; keeping all skills`, "info");
		}
		return;
	}
	if (!skills.restricted) return;
	const allowed = new Set(skills.paths.map((path) => resolve(ctx.cwd, path)));
	event.systemPromptOptions.skills = event.systemPromptOptions.skills?.filter((skill) =>
		allowed.has(resolve(dirname(skill.filePath))),
	);
}

/** `/shift` and `/shift status`: the frontier, plus what the runner is doing now. */
async function showFrontier(ctx: ExtensionContext) {
	const tickets = await loadTickets(ctx.cwd);
	const state = await openRunState(ctx.cwd).read();
	const runner = state?.live ? `\nRunner: pid ${state.pid} · ${describeRun(state)}` : "";
	if (tickets.length === 0) {
		ctx.ui.notify(`Shiftwork: no tickets in .scratch/<feature>/issues/*.md${runner}`, "info");
		return;
	}
	const ready = frontier(tickets);
	const lines = ready.map((t) => `→ ${t.feature}/${t.number} ${t.title ?? ""}`);
	ctx.ui.notify(`Shiftwork: ${ready.length} ready of ${tickets.length}\n${lines.join("\n")}${runner}`, "info");
}

/** `/shift run`: start `shiftwork run` detached, log to a file and return at once. */
async function startRunner(ctx: ExtensionContext, args: string[], watch: (ctx: ExtensionContext) => void) {
	const runState = openRunState(ctx.cwd);
	const state = await runState.read();
	if (state?.live) {
		ctx.ui.notify(`Shiftwork: a runner is already working (pid ${state.pid}) · ${describeRun(state)}`, "warning");
		watch(ctx);
		return;
	}

	const cli = locateRunner();
	if (!cli) {
		ctx.ui.notify('Shiftwork: the runner was not found. Install it with "npm i -g shiftwork" or set SHIFTWORK_BIN.', "error");
		return;
	}

	// A STOP file left by an earlier /shift stop would end the new run immediately.
	const stopFile = join(ctx.cwd, "STOP");
	const removedStop = existsSync(stopFile);
	if (removedStop) rmSync(stopFile, { force: true });

	const logFile = join(ctx.cwd, "logs", `runner-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
	mkdirSync(join(ctx.cwd, "logs"), { recursive: true });
	const log = openSync(logFile, "a");
	const child = spawn(process.execPath, [cli, "run", ...args], {
		cwd: ctx.cwd,
		detached: true,
		stdio: ["ignore", log, log],
	});
	child.unref();

	// Claim the state right away so the widget is live before the runner's own first write.
	await runState.update({
		pid: child.pid,
		running: true,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		stoppedReason: null,
		workers: [],
		summary: { resolved: 0, needsInfo: 0 },
		logFile,
	});
	watch(ctx);
	const removed = removedStop ? " · removed the STOP file" : "";
	ctx.ui.notify(`Shiftwork: runner started (pid ${child.pid})${removed} · logs: ${logFile}`, "info");
}

/** `/shift stop`: the STOP file makes the runner finish the current shift and exit. */
async function stopRunner(ctx: ExtensionContext) {
	const stopFile = join(ctx.cwd, "STOP");
	writeFileSync(stopFile, `Stopped from pi at ${new Date().toISOString()}\n`);
	const state = await openRunState(ctx.cwd).read();
	const who = state?.live ? ` · runner pid ${state.pid} finishes the current shift` : "";
	ctx.ui.notify(`Shiftwork: STOP file written${who}`, "info");
}

/** The status widget: every running shift — its ticket, shift, model and budget use. */
function widgetLines(state: RunState): string[] {
	if (!state.live) {
		const counts = state.summary ?? { resolved: 0, needsInfo: 0 };
		const stopped = state.stoppedReason ? ` · stopped: ${state.stoppedReason}` : "";
		return [`Shiftwork: runner finished · ${counts.resolved} resolved, ${counts.needsInfo} need info${stopped}`];
	}
	const feature = state.feature ? ` · feature ${state.feature}` : "";
	const workers = state.workers ?? [];
	if (!workers.length) return [`Shiftwork: runner pid ${state.pid} · looking for work${feature}`];
	const head = `Shiftwork: runner pid ${state.pid} · ${workers.length} worker${workers.length > 1 ? "s" : ""}${feature}`;
	return [head, ...workers.flatMap(workerLines)];
}

function workerLines(worker: RunStateWorker): string[] {
	const t = worker.ticket;
	const head = `  ${t?.feature ?? "?"}/${t?.number ?? "?"} ${t?.title ?? ""}`.trimEnd() + ` · shift ${worker.shift ?? 1} · attempt ${worker.attempt ?? 1}`;
	const usage = worker.usage ?? { tokens: 0, costUsd: 0, turns: 0, contextPct: 0 };
	const parts = [
		worker.model ?? "?",
		`${formatTokens(usage.tokens)} tokens${limit(worker.budget?.maxTokens, usage.tokens, formatTokens)}`,
		`$${usage.costUsd.toFixed(2)}${limit(worker.budget?.maxCostUsd, usage.costUsd, (n) => `$${n.toFixed(2)}`)}`,
		`${usage.turns} turns${limit(worker.budget?.maxTurns, usage.turns, String)}`,
	];
	if (usage.contextPct) parts.push(`${Math.round(usage.contextPct)}% context`);
	return [head, `  ${parts.join(" · ")}`];
}

/** What the runners are doing, for notices: one line naming every running shift. */
function describeRun(state: RunState): string {
	const workers = state?.workers ?? [];
	if (!workers.length) return "looking for work";
	const list = workers.map((w) => `${w.ticket?.feature ?? "?"}/${w.ticket?.number ?? "?"}`).join(", ");
	return workers.length > 1 ? `${workers.length} workers: ${list}` : list;
}

function limit(max: number | undefined, used: number, format: (n: number) => string): string {
	if (!max) return "";
	return ` / ${format(max)} (${Math.round((used / max) * 100)}%)`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * Find the `shiftwork` CLI: an explicit SHIFTWORK_BIN, the `shiftwork` package
 * next to this one, or a project-local install.
 */
function locateRunner(): string | undefined {
	const candidates = [process.env.SHIFTWORK_BIN];
	try {
		candidates.push(createRequire(import.meta.url).resolve("shiftwork/bin/shiftwork.js"));
	} catch {}
	candidates.push(join(process.cwd(), "node_modules", "shiftwork", "bin", "shiftwork.js"));
	return candidates.find((path) => path && existsSync(path));
}
