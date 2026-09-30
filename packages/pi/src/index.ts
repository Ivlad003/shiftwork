import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { frontier, loadTickets, openRunState, type RunState } from "shiftwork-core";

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

/** `/shift` and `/shift status`: the frontier, plus what the runner is doing now. */
async function showFrontier(ctx: ExtensionContext) {
	const tickets = await loadTickets(ctx.cwd);
	const state = await openRunState(ctx.cwd).read();
	const runner = state?.live ? `\nRunner: pid ${state.pid} · ${describeTicket(state)}` : "";
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
		ctx.ui.notify(`Shiftwork: a runner is already working (pid ${state.pid}) · ${describeTicket(state)}`, "warning");
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
		ticket: null,
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

/** The status widget: current ticket, shift, model and budget use. */
function widgetLines(state: RunState): string[] {
	if (!state.live) {
		const counts = state.summary ?? { resolved: 0, needsInfo: 0 };
		const stopped = state.stoppedReason ? ` · stopped: ${state.stoppedReason}` : "";
		return [`Shiftwork: runner finished · ${counts.resolved} resolved, ${counts.needsInfo} need info${stopped}`];
	}
	const feature = state.feature ? ` · feature ${state.feature}` : "";
	const head = `Shiftwork: ${describeTicket(state)}${feature}`;
	if (!state.ticket) return [head];
	const usage = state.usage ?? { tokens: 0, costUsd: 0, turns: 0, contextPct: 0 };
	const parts = [
		state.model ?? "?",
		`${formatTokens(usage.tokens)} tokens${limit(state.budget?.maxTokens, usage.tokens, formatTokens)}`,
		`$${usage.costUsd.toFixed(2)}${limit(state.budget?.maxCostUsd, usage.costUsd, (n) => `$${n.toFixed(2)}`)}`,
		`${usage.turns} turns${limit(state.budget?.maxTurns, usage.turns, String)}`,
	];
	if (usage.contextPct) parts.push(`${Math.round(usage.contextPct)}% context`);
	return [head, `  ${parts.join(" · ")}`];
}

function describeTicket(state: RunState): string {
	if (!state?.ticket) return state?.live ? "looking for work" : "idle";
	const { feature, number, title } = state.ticket;
	const shift = state.shift ? ` · shift ${state.shift}` : "";
	const attempt = state.attempt ? ` · attempt ${state.attempt}` : "";
	return `${feature}/${number} ${title ?? ""}`.trim() + shift + attempt;
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
