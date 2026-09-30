import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectDashboardState, REFRESH_MS, renderDashboard } from "./dashboard.js";

const HELP = `shiftwork tui — read-only dashboard

Usage:
  shiftwork tui [--dir <path>]  Features, tickets, the live runner, cooldowns and logs; refreshes every second
  shiftwork tui --once          Print one frame and exit

The interactive view is built on @earendil-works/pi-tui, resolved from the user's pi
install. Without it a plain-text fallback prints a frame every second. q quits.`;

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

	const kit = await loadPiTui();
	if (kit) return interactive(root, kit);
	return fallback(root);
}

/** Resolve `@earendil-works/pi-tui` from the user's pi install, like RpcClient. Null when unavailable. */
export async function loadPiTui({ piRoot } = {}) {
	try {
		const { locatePi } = await import("./pi-backend.js");
		const pi = locatePi({ root: piRoot });
		const require = createRequire(join(pi.root, "package.json"));
		const entry = require.resolve("@earendil-works/pi-tui");
		return await import(pathToFileURL(entry).href);
	} catch {
		return null;
	}
}

/** Full-screen dashboard on pi-tui: one Text component re-rendered every second. */
async function interactive(root, { ProcessTerminal, TuiMainScreen, Text }) {
	const ui = new TuiMainScreen(new ProcessTerminal(), false);
	const text = new Text("");
	ui.addChild(text);
	const refresh = async () => {
		text.setText(renderDashboard(await collectDashboardState(root)).join("\n"));
		ui.requestRender();
	};
	const quit = new Promise((resolve) => {
		ui.addInputListener((data) => {
			if (data === "q" || data === "\x03") {
				resolve();
				return { consume: true };
			}
		});
	});
	ui.start();
	const timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
	await refresh();
	await quit;
	clearInterval(timer);
	ui.stop();
	return 0;
}

/** Plain-text fallback when pi-tui isn't resolvable: a frame every second, q or Ctrl-C quits. */
async function fallback(root) {
	process.stdout.write("shiftwork tui: pi's TUI library not found, plain-text mode (q or Ctrl-C quits)\n");
	const frame = async () => {
		const state = await collectDashboardState(root);
		process.stdout.write(`\n${renderDashboard(state).join("\n")}\n`);
	};
	const timer = setInterval(() => frame().catch(() => {}), REFRESH_MS);
	await frame();
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		await new Promise((resolve) => {
			process.stdin.on("data", (data) => {
				const key = data.toString();
				if (key === "q" || key === "\x03") resolve();
			});
		});
		process.stdin.setRawMode(false);
		process.stdin.pause();
	} else {
		// Nothing to read keys from: run until the process is killed.
		await new Promise(() => {});
	}
	clearInterval(timer);
	return 0;
}
