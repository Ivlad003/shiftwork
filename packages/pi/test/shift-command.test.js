import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { openRunState } from "shiftwork-core";

const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const stubRunner = fileURLToPath(new URL("./fixtures/stub-runner.js", import.meta.url));
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const piCli = join(piRoot, JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).bin.pi);

const clients = [];
after(async () => {
	for (const client of clients) await client.stop().catch(() => {});
});

/** A real pi in RPC mode with the extension loaded, in a fresh repo root. */
async function startPi({ env = {}, tickets = {} } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "sw-pi-ext-"));
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-home-"));
	for (const [rel, body] of Object.entries(tickets)) {
		const [feature, file] = rel.split("/");
		await mkdir(join(cwd, ".scratch", feature, "issues"), { recursive: true });
		await writeFile(join(cwd, ".scratch", feature, "issues", file), body);
	}
	const client = new RpcClient({
		cliPath: piCli,
		cwd,
		env: { PI_CODING_AGENT_DIR: agentDir, ...env },
		args: ["--no-session", "--offline", "-ns", "-ne", "-e", extension],
	});
	clients.push(client);
	const ui = [];
	client.onEvent((event) => {
		if (event.type === "extension_ui_request") ui.push(event);
	});
	await client.start();
	return { client, cwd, ui };
}

async function waitFor(check, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await check();
		if (found) return found;
		if (Date.now() > deadline) throw new Error("timed out waiting for the extension");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

test("a real pi lists the shift command with its subcommands", { timeout: 90_000 }, async () => {
	const { client } = await startPi();

	const commands = await client.getCommands();
	const shift = commands.find((c) => c.name === "shift");

	assert.ok(shift, `/shift is not registered: ${commands.map((c) => c.name).join(", ")}`);
	assert.equal(shift.source, "extension");
	assert.match(shift.description, /\/shift run/);
	assert.match(shift.description, /\/shift stop/);
});

test("/shift answers with the frontier of ready tickets", { timeout: 90_000 }, async () => {
	const { client, ui } = await startPi({
		tickets: {
			"demo/07-widget.md": "# 07: Widget ticket\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n",
			"demo/08-later.md": "# 08: Later ticket\n\n**Blocked by:** 07\n\n**Status:** ready-for-agent\n",
		},
	});

	assert.equal(await client.prompt("/shift"), "handled");
	const notify = await waitFor(() => ui.find((r) => r.method === "notify"));

	assert.match(notify.message, /1 ready of 2/);
	assert.match(notify.message, /demo\/07 Widget ticket/);
});

test("/shift stop writes the STOP file", { timeout: 90_000 }, async () => {
	const { client, cwd, ui } = await startPi();

	assert.equal(await client.prompt("/shift stop"), "handled");
	await waitFor(() => ui.find((r) => r.method === "notify"));

	assert.ok(existsSync(join(cwd, "STOP")), "the STOP file was not created");
});

test("/shift run starts a detached runner, returns at once and shows a status widget", { timeout: 90_000 }, async () => {
	const { client, cwd, ui } = await startPi({ env: { SHIFTWORK_BIN: stubRunner } });

	const startedAt = Date.now();
	assert.equal(await client.prompt("/shift run --feature demo"), "handled");
	const notify = await waitFor(() => ui.find((r) => r.method === "notify"));
	assert.ok(Date.now() - startedAt < 10_000, "/shift run did not return promptly");
	assert.match(notify.message, /runner started \(pid \d+\)/);
	assert.match(notify.message, /logs:.*runner-.*\.log/);

	// The runner is its own process, and the widget reports what it is doing.
	const widget = await waitFor(() => ui.findLast((r) => r.method === "setWidget" && r.widgetLines?.join("\n").includes("demo/07")));
	const lines = widget.widgetLines.join("\n");
	assert.match(lines, /shift 2/);
	assert.match(lines, /attempt 1/);
	assert.match(lines, /stub\/model-x/);
	assert.match(lines, /12\.0k tokens \/ 100\.0k \(12%\)/);
	assert.match(lines, /\$0\.40 \/ \$2\.00 \(20%\)/);

	const state = await openRunState(cwd).read();
	assert.equal(state.live, true);
	assert.notEqual(state.pid, process.pid);

	// /shift stop ends the detached runner, and the widget reports the outcome.
	assert.equal(await client.prompt("/shift stop"), "handled");
	const finished = await waitFor(() =>
		ui.findLast((r) => r.method === "setWidget" && r.widgetLines?.join("\n").includes("runner finished")),
	);
	assert.match(finished.widgetLines.join("\n"), /1 resolved, 0 need info/);
});

test("/shift run finds the shiftwork CLI and logs its output to a file", { timeout: 90_000 }, async () => {
	const { client, cwd, ui } = await startPi();
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi", "shiftwork.json"), JSON.stringify({ model: "fake/m1" }));

	assert.equal(await client.prompt("/shift run --dry-run"), "handled");
	const notify = await waitFor(() => ui.find((r) => r.method === "notify" && /runner started/.test(r.message)));
	const logFile = notify.message.match(/logs: (\S+)/)[1];

	const output = await waitFor(() => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "") || false, 30_000);
	assert.match(output, /frontier is empty/);
});

test("/shift run refuses to start a second runner", { timeout: 90_000 }, async () => {
	const { client, cwd, ui } = await startPi({ env: { SHIFTWORK_BIN: stubRunner } });

	assert.equal(await client.prompt("/shift run"), "handled");
	await waitFor(() => ui.find((r) => r.method === "notify" && /runner started/.test(r.message)));
	await waitFor(async () => (await openRunState(cwd).read())?.workers?.length);

	assert.equal(await client.prompt("/shift run"), "handled");
	const warning = await waitFor(() => ui.find((r) => r.method === "notify" && r.notifyType === "warning"));

	assert.match(warning.message, /already working \(pid \d+\)/);
	await writeFile(join(cwd, "STOP"), "");
});
