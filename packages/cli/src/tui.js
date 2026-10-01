import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "shiftwork-core";
import { collectDashboardState, REFRESH_MS, renderDashboard } from "./dashboard.js";
import { createTuiControls, TUI_KEYS } from "./tui-controls.js";

const HELP = `shiftwork tui — live dashboard

Usage:
  shiftwork tui [--dir <path>]  Features, tickets, the live runner, cooldowns and logs; refreshes every second
  shiftwork tui --once          Print one frame and exit

Keys: r starts a detached runner (a second r while one is live is refused), s writes STOP
so the runner hands off and stops, d shows a dry-run, f cycles the feature filter, q quits.
The interactive view is built on @earendil-works/pi-tui, resolved from the user's pi
install. Without it a plain-text fallback prints a frame every second.`;

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

/** Full-screen dashboard on pi-tui: one Text component re-rendered every second. */
async function interactive(root, { ProcessTerminal, TuiMainScreen, Text }) {
	const ui = new TuiMainScreen(new ProcessTerminal(), false);
	const text = new Text("");
	ui.addChild(text);
	let last = null;
	const paint = () => {
		if (!last) return;
		text.setText(renderDashboard({ ...last, ...controls.view }).join("\n"));
		ui.requestRender();
	};
	const controls = createTuiControls({ root, onChange: paint });
	const refresh = async () => {
		last = await collectDashboardState(root);
		controls.setDashboard(last);
		paint();
	};
	const quit = new Promise((resolve) => {
		controls.onQuit(resolve);
	});
	ui.addInputListener((data) => {
		if (TUI_KEYS.includes(data)) {
			controls.handleKey(data).catch(() => {});
			return { consume: true };
		}
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
	process.stdout.write(`shiftwork tui: pi's TUI library not found${reason}, plain-text mode (r run · s stop · d dry-run · f filter · q quit)\n`);
	let last = null;
	const paint = () => {
		if (!last) return;
		process.stdout.write(`\n${renderDashboard({ ...last, ...controls.view }).join("\n")}\n`);
	};
	const controls = createTuiControls({ root, onChange: paint });
	const frame = async () => {
		last = await collectDashboardState(root);
		controls.setDashboard(last);
		paint();
	};
	const timer = setInterval(() => frame().catch(() => {}), REFRESH_MS);
	await frame();
	const quit = new Promise((resolve) => controls.onQuit(resolve));
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (data) => {
			const key = data.toString();
			if (TUI_KEYS.includes(key)) controls.handleKey(key).catch(() => {});
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
