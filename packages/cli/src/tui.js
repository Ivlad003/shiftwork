import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "shiftwork-core";
import { collectDashboardState, dashboardLayout, REFRESH_MS, renderDashboard } from "./dashboard.js";
import { createTuiControls, decodeKeys, mouseAction } from "./tui-controls.js";

const HELP = `shiftwork tui — live dashboard

Usage:
  shiftwork tui [--dir <path>]  Full-screen tabs: Queue, Agents, Cooldowns, Log, Resolved, GitHub; refreshes every second
  shiftwork tui --once          Print one frame and exit

Keys: 1–6 and tab switch tabs · ↑↓/j k move · ←→ fold · enter opens details
(an agent's log, or an issue's feature in the Queue, or on the Resolved tab
if the feature is done) · n runs the selected ticket
· r starts a detached runner (a second r while one is live is refused) · s writes
STOP so the runner hands off and stops · d shows a dry-run · f cycles the feature
filter · g toggles dark-factory (starts run --dark-factory detached when no
runner is live, writes STOP when one is; the header shows dark-factory while it
runs) · / opens a search prompt: on the Queue or Resolved tab it filters the list
to tickets whose number or title contains the query (case-insensitive) — tab
toggles the scope between all features and the feature under the cursor, enter
keeps the filter, esc clears it; with a ticket's details open it highlights the
matches inside the details ([…] brackets, reverse video in colour) and enter
scrolls to the next one. While you type, letters — n, r, s, d, f, q and digits
included — go to the query, not their commands (Ctrl-C still quits); the header
shows the prompt (/ query · scope) and the footer swaps in the search keys ·
q quits. The mouse works in the interactive view: click a tab label to
switch tabs, click a row to move the cursor there (click it again to open it,
like enter), the wheel moves the cursor. The Resolved tab (5) lists the
features whose tickets are all resolved, off the Queue, with the same rows,
cursor, fold and enter → details as the Queue's (n there is refused: status
resolved). The GitHub tab lists the issues run --dark-factory imported:
number, title, feature, state (planning, working, needs-info, done, closed)
and the time of the last sync.

A Queue or Resolved ticket row reads \`<status column>  NN title\`: the column
is fixed-width and comes before the number and title, so on a narrow terminal
the words stay whole and the title is what gets clipped. Its legend:
▶ working glm-5.3 (or pid N when another runner's live claim holds it) — a
live worker or claim holds it · ● next #1 — its place in the order the runner
will take the frontier · ⧗ waits 01, 03 — blocked by unresolved tickets, only
the unresolved ones listed · ? needs you — needs-info; the details view shows
the reason from the last shift report · ✋ for human — ready-for-human ·
○ triage — needs-triage · ✔ done — resolved · ✖ wontfix · ⏸ paused — its feature
is paused (once feature-pause lands; until then never shown). A feature row
counts its tickets: \`2/6 done · 2 next · 1 needs you\`, zero parts omitted. The
details view's first line carries the same label, plus the reason line for a
needs-you ticket. --once and the plain-text fallback print the same words
without colour.

The interactive view is built on @earendil-works/pi-tui (TuiAltScreen), resolved
from the user's pi install. It is in colour: the cursor row is highlighted
across the width, the status column is coloured (done green, working cyan,
next bold, waits dim, needs you yellow), live workers are cyan, cooldowns are
red. Set NO_COLOR to turn colour off; --once and the plain-text fallback stay
colourless (and list every feature, resolved ones included, like --once).
Without pi-tui a plain-text fallback prints a frame every second; the same
keys work there where they make sense.`;

/** The `shiftwork tui` command. `--once` prints one frame and exits (the tests drive this). */
export async function tui(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			once: { type: "boolean" },
			dir: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	const root = values.dir ?? process.cwd();

	if (values.once || !process.stdout.isTTY) {
		const state = await collectDashboardState(root);
		process.stdout.write(`${renderDashboard(state).join("\n")}\n`);
		return 0;
	}

	const loaded = await loadPiTui({ piRoot: await configuredPiRoot(root) });
	if (loaded.kit) return interactive(root, loaded.kit);
	return fallback(root, loaded.error);
}

/** `pi.root` from the merged config, or undefined (a broken config must not stop the dashboard). */
async function configuredPiRoot(root) {
	try {
		const config = await loadConfig(root, process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
		return config.pi?.root;
	} catch {
		return undefined;
	}
}

/** Resolve `@earendil-works/pi-tui` from the user's pi install, like RpcClient: { kit } or { error }. */
export async function loadPiTui({ piRoot, locate } = {}) {
	try {
		locate ??= (await import("./pi-backend.js")).locatePi;
		const pi = locate({ root: piRoot });
		const require = createRequire(join(pi.root, "package.json"));
		const entry = require.resolve("@earendil-works/pi-tui");
		return { kit: await import(pathToFileURL(entry).href) };
	} catch (error) {
		return { error };
	}
}

/** Terminal columns/rows, with a floor so a 0×0 stub still yields a frame. */
function terminalSize(terminal) {
	return {
		width: Math.max(1, terminal.columns || 80),
		height: Math.max(1, terminal.rows || 24),
	};
}

/**
 * Re-paint when the terminal reports a resize. TuiAltScreen's own onResize only
 * re-renders the last Text; the dashboard has to be rebuilt at the new size.
 */
function onTerminalResize(terminal, handler) {
	const start = terminal.start.bind(terminal);
	terminal.start = (onInput, onResize) =>
		start(onInput, () => {
			handler();
			onResize?.();
		});
}

/**
 * Full-screen dashboard on pi-tui's alternate screen: sized to the terminal,
 * re-rendered on resize, keys decoded then reduced, mouse events mapped through
 * the last layout's hit map to reducer actions (GitHub #5). `options.terminal`
 * and `options.onKey` are for the stub-terminal tests.
 */
export async function interactive(root, { ProcessTerminal, TuiAltScreen, Text }, options = {}) {
	const terminal = options.terminal ?? new ProcessTerminal();
	const ui = new TuiAltScreen(terminal, false);
	const text = new Text("", 0, 0);
	let last = null; // the last dashboard state
	let layout = null; // the last frame's hit map (rows, tabs) for the mouse layer
	let chain = Promise.resolve(); // keys and mouse run one at a time, in order
	const color = !process.env.NO_COLOR;
	const paint = () => {
		if (!last) return;
		layout = dashboardLayout({ ...last, ...controls.view }, { ...terminalSize(terminal), color });
		text.setText(layout.lines.join("\n"));
		ui.requestRender();
	};
	// The layout root: the Text wrapped so it can take mouse events — each one is
	// mapped through the last layout to a reducer action and fed to the controls.
	const layoutRoot = {
		render: (width) => text.render(width),
		handleMouse: (event) => {
			const action = mouseAction(event, layout);
			if (!action) return undefined;
			chain = chain.then(async () => controls.handleMouse(action)).catch(() => {});
			return { handled: true };
		},
	};
	if (typeof ui.setLayoutRoot === "function") ui.setLayoutRoot(layoutRoot);
	else ui.addChild(layoutRoot);
	const controls = createTuiControls({ root, onChange: paint });
	onTerminalResize(terminal, paint);
	const refresh = async () => {
		last = await collectDashboardState(root, { view: controls.view });
		controls.setDashboard(last);
		paint();
	};
	const quit = new Promise((resolve) => {
		controls.onQuit(resolve);
	});
	ui.addInputListener((data) => {
		const keys = decodeKeys(data);
		if (!keys.length) return;
		chain = chain
			.then(async () => {
				for (const key of keys) {
					options.onKey?.(key);
					await controls.handleKey(key);
				}
			})
			.catch(() => {});
		return { consume: true };
	});
	ui.start();
	const timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
	await refresh();
	await quit;
	clearInterval(timer);
	ui.stop();
	return 0;
}

/** Plain-text fallback when pi-tui isn't resolvable: a frame every second, with the same keys. */
async function fallback(root, error) {
	const reason = error?.message ? ` (${error.message})` : "";
	process.stdout.write(
		`shiftwork tui: pi's TUI library not found${reason}, plain-text mode (1–6 tabs · n run this · r run · s stop · d dry-run · f filter · g dark-factory · q quit)\n`,
	);
	let last = null;
	const paint = () => {
		if (!last) return;
		process.stdout.write(`\n${renderDashboard({ ...last, ...controls.view }).join("\n")}\n`);
	};
	const controls = createTuiControls({ root, onChange: paint });
	const frame = async () => {
		last = await collectDashboardState(root, { view: controls.view });
		controls.setDashboard(last);
		paint();
	};
	const timer = setInterval(() => frame().catch(() => {}), REFRESH_MS);
	await frame();
	const quit = new Promise((resolve) => controls.onQuit(resolve));
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		let chain = Promise.resolve();
		process.stdin.on("data", (data) => {
			chain = chain
				.then(async () => {
					for (const key of decodeKeys(data)) await controls.handleKey(key);
				})
				.catch(() => {});
		});
		await quit;
		process.stdin.setRawMode(false);
		process.stdin.pause();
	} else {
		// Nothing to read keys from: run until the process is killed.
		await new Promise(() => {});
	}
	clearInterval(timer);
	return 0;
}
