import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createPiBackend, locatePi, mapPiEvent, parseModelList, piRawEvents } from "../src/pi-backend.js";

const fixture = fileURLToPath(new URL("./fixtures/scripted-provider.ts", import.meta.url));

async function shiftWith(script) {
	const cwd = await mkdtemp(join(tmpdir(), "sw-pi-"));
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-home-"));
	const backend = createPiBackend({
		args: ["--offline", "-ns", "-ne", "-e", fixture],
		env: { PI_CODING_AGENT_DIR: agentDir, SHIFTWORK_SCRIPT: JSON.stringify(script) },
		timeoutMs: 60_000,
	});
	const shift = await backend.startShift({
		cwd,
		route: { model: "scripted/s1", thinking: "off" },
		prompt: "Do the ticket.",
		systemPrompt: "You are a test worker.",
	});
	const events = [];
	for await (const event of shift.events) {
		if (event.type !== "raw") events.push(event);
		if (event.type === "end") break;
	}
	await shift.close?.();
	return { cwd, events, shift };
}

test("a real pi shift runs tools and maps events to turns, text and end", { timeout: 90_000 }, async () => {
	const { cwd, events } = await shiftWith([
		{ tool: { name: "write", args: { path: "done.txt", content: "ok\n" } } },
		{ text: "Finished the ticket." },
	]);

	assert.equal(await readFile(join(cwd, "done.txt"), "utf8"), "ok\n");
	assert.equal(events.filter((e) => e.type === "turn").length, 2);
	assert.ok(events.some((e) => e.type === "text" && e.text.includes("Finished the ticket.")));
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "stop" });
	const context = events.filter((e) => e.type === "context");
	assert.ok(context.length >= 1, "context fill is reported for maxContextPct budgets");
	assert.ok(context[0].percent > 0 && context[0].percent < 100);
});

test("a provider error in a real pi shift becomes an error event and ends the shift", { timeout: 90_000 }, async () => {
	const { events } = await shiftWith([{ error: "429 Too Many Requests: rate limit exceeded" }]);

	assert.ok(events.some((e) => e.type === "error" && /429/.test(e.message)));
	assert.equal(events.at(-1).type, "end");
});

test("a skill outside the set is not advertised", { timeout: 90_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-pi-skills-"));
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-home-"));
	const alpha = join(cwd, "alpha");
	const beta = join(cwd, "beta");
	await mkdir(alpha, { recursive: true });
	await mkdir(beta, { recursive: true });
	await writeFile(join(alpha, "SKILL.md"), "---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body.");
	await writeFile(join(beta, "SKILL.md"), "---\nname: beta\ndescription: Beta skill\n---\nBeta body.");

	const backend = createPiBackend({
		args: ["--offline", "-ns", "-ne", "-e", fixture],
		env: { PI_CODING_AGENT_DIR: agentDir, SHIFTWORK_SCRIPT: "[]", SHIFTWORK_RECORD_SKILLS: "1" },
		timeoutMs: 60_000,
	});
	const shift = await backend.startShift({
		cwd,
		route: { model: "scripted/s1", thinking: "off", skills: { paths: [alpha], preload: [], restricted: true } },
		prompt: "hi",
		systemPrompt: "sys",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();

	const recorded = JSON.parse(await readFile(join(cwd, "shiftwork-skills.json"), "utf8"));
	assert.deepEqual(recorded.skills, ["alpha"]);
});

test("preloaded skill bodies appear in the system prompt passed to the backend", { timeout: 90_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-pi-preload-"));
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-home-"));
	const skill = join(cwd, "alpha");
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: Alpha skill\n---\nAlpha preloaded body.");

	const backend = createPiBackend({
		args: ["--offline", "-ns", "-ne", "-e", fixture],
		env: { PI_CODING_AGENT_DIR: agentDir, SHIFTWORK_SCRIPT: "[]", SHIFTWORK_RECORD_SYSTEM: "1" },
		timeoutMs: 60_000,
	});
	const shift = await backend.startShift({
		cwd,
		route: { model: "scripted/s1", thinking: "off", skills: { paths: [skill], preload: [skill], restricted: true } },
		prompt: "hi",
		systemPrompt: "Worker prompt.",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();

	const system = await readFile(join(cwd, "shiftwork-system.md"), "utf8");
	assert.match(system, /Worker prompt\./);
	assert.match(system, /Alpha preloaded body\./);
});

test("a missing skill path does not crash the shift and is reported as a warning", { timeout: 90_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-pi-missing-"));
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-home-"));
	const backend = createPiBackend({
		args: ["--offline", "-ns", "-ne", "-e", fixture],
		env: { PI_CODING_AGENT_DIR: agentDir, SHIFTWORK_SCRIPT: "[]" },
		timeoutMs: 60_000,
	});
	const shift = await backend.startShift({
		cwd,
		route: { model: "scripted/s1", thinking: "off", skills: { paths: [], preload: [join(cwd, "no-such-skill")] } },
		prompt: "hi",
		systemPrompt: "sys",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();

	assert.ok(shift.warnings.some((w) => /missing skill path/.test(w)));
});

test("set_model mid-shift switches the live session", { timeout: 90_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-pi-swap-"));
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-home-"));
	const backend = createPiBackend({
		args: ["--offline", "-ns", "-ne", "-e", fixture],
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			SHIFTWORK_SCRIPT: JSON.stringify([
				{ tool: { name: "write", args: { path: "one.txt", content: "a\n" } } },
				{ text: "continuing after the tool" },
				{ text: "after the swap" },
				{ text: "settled" },
			]),
		},
		timeoutMs: 60_000,
	});
	const shift = await backend.startShift({
		cwd,
		route: { model: "scripted/s1", thinking: "off" },
		prompt: "Do the ticket.",
		systemPrompt: "You are a test worker.",
	});
	const events = [];
	let swapped = false;
	for await (const event of shift.events) {
		if (event.type === "raw") continue;
		events.push(event);
		if (!swapped && event.type === "turn") {
			swapped = true;
			await shift.swapModel("scripted/s2", "off");
		}
		if (event.type === "end") break;
	}
	const state = await shift.client.getState().catch(() => null);
	await shift.close?.();

	assert.equal(await readFile(join(cwd, "one.txt"), "utf8"), "a\n");
	const models = events.filter((e) => e.type === "turn").map((e) => e.model);
	const swappedToS2 = models.some((m) => m === "s2" || m === "scripted/s2") || state?.model?.id === "s2";
	assert.ok(swappedToS2, `set_model mid-shift should land on s2; turns=${JSON.stringify(models)} state=${state?.model?.id ?? "none"}`);
});

test("mapPiEvent ignores everything but finished assistant messages", () => {
	assert.deepEqual(mapPiEvent({ type: "message_end", message: { role: "user", content: "hi" } }), []);
	assert.deepEqual(mapPiEvent({ type: "turn_end" }), []);
	const [turn, text] = mapPiEvent({
		type: "message_end",
		message: {
			role: "assistant",
			model: "m",
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
			usage: { input: 5, output: 2, totalTokens: 7, cost: { total: 0.5 } },
		},
	});
	assert.deepEqual(turn, { type: "turn", model: "m", stopReason: "stop", usage: { input: 5, output: 2, totalTokens: 7 }, costUsd: 0.5 });
	assert.deepEqual(text, { type: "text", text: "done" });
});

test("probe reports a model that answers as available and a limit error as unavailable", { timeout: 120_000 }, async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-probe-"));
	const backendWith = (script) =>
		createPiBackend({
			args: ["--offline", "-ne", "-e", fixture],
			env: { PI_CODING_AGENT_DIR: agentDir, SHIFTWORK_SCRIPT: JSON.stringify(script) },
		});

	assert.equal(await backendWith([{ text: "OK" }]).probe("scripted/s1"), true);
	assert.equal(await backendWith([{ error: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}' }]).probe("scripted/s1"), false);
});

/** A pi managed install like the official installer's: <agentDir>/bin/pi is a shell launcher into install/releases/<v>. */
async function fakeManagedInstall(version = "9.9.9") {
	// The real path: on macOS tmpdir() is /var/… while locatePi resolves symlinks to /private/var/….
	const home = await realpath(await mkdtemp(join(tmpdir(), "sw-pi-managed-")));
	const agentDir = join(home, ".pi", "agent");
	const pkg = join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	await mkdir(join(pkg, "dist", "bundle"), { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/bundle/cli.js" } }));
	await writeFile(join(agentDir, "install", "current-version"), `${version}\n`);
	await mkdir(join(agentDir, "bin"), { recursive: true });
	const launcher = join(agentDir, "bin", "pi");
	await writeFile(launcher, "#!/bin/sh\nexec true\n");
	await chmod(launcher, 0o755);
	await mkdir(join(home, ".local", "bin"), { recursive: true });
	const onPath = join(home, ".local", "bin", "pi");
	await symlink(launcher, onPath);
	return { home, agentDir, pkg, onPath, version };
}

const noPackage = () => {
	throw new Error("not resolvable");
};

test("locatePi follows a managed-install shell launcher on PATH to its current release", async () => {
	const m = await fakeManagedInstall();
	const pi = locatePi({ resolvePackage: noPackage, which: () => m.onPath, env: {} });
	assert.equal(pi.root, m.pkg);
	assert.equal(pi.cli, join(m.pkg, "dist", "bundle", "cli.js"));
	assert.equal(pi.version, m.version);
});

test("locatePi finds a managed install in the pi agent dir when pi is not on PATH", async () => {
	const m = await fakeManagedInstall();
	assert.equal(locatePi({ resolvePackage: noPackage, which: () => "", env: { PI_CODING_AGENT_DIR: m.agentDir } }).root, m.pkg);
	assert.equal(locatePi({ resolvePackage: noPackage, which: () => "", env: { PI_MANAGED_INSTALL_ROOT: join(m.agentDir, "install") } }).root, m.pkg);
	assert.equal(locatePi({ resolvePackage: noPackage, which: () => "", env: {}, home: m.home }).root, m.pkg);
});

test("locatePi takes an explicit root first and names pi.root when nothing is found", async () => {
	const m = await fakeManagedInstall();
	assert.equal(locatePi({ root: m.pkg, resolvePackage: noPackage, which: () => "", env: {} }).root, m.pkg);
	const empty = await mkdtemp(join(tmpdir(), "sw-pi-none-"));
	assert.throws(() => locatePi({ resolvePackage: noPackage, which: () => "", env: {}, home: empty }), /pi\.root/);
});

test("a pi shift does not load the user's global extensions unless isolateExtensions is false", { timeout: 120_000 }, async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-ext-home-"));
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	const marker = join(agentDir, "loaded.txt");
	await writeFile(
		join(agentDir, "extensions", "global.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function () {\n\twriteFileSync(${JSON.stringify(marker)}, "loaded");\n}\n`,
	);
	const runShift = async (extra) => {
		const backend = createPiBackend({
			args: ["--offline", "-ns", "-e", fixture],
			env: { PI_CODING_AGENT_DIR: agentDir, SHIFTWORK_SCRIPT: JSON.stringify([{ text: "done" }]) },
			timeoutMs: 60_000,
			...extra,
		});
		const shift = await backend.startShift({ cwd: await mkdtemp(join(tmpdir(), "sw-pi-ext-")), route: { model: "scripted/s1", thinking: "off" }, prompt: "p", systemPrompt: "s" });
		for await (const event of shift.events) if (event.type === "end") break;
		await shift.close?.();
	};

	await runShift({});
	assert.equal(existsSync(marker), false, "global extensions stay out of a shift; explicit -e still loads");
	await runShift({ isolateExtensions: false });
	assert.equal(existsSync(marker), true, "the opt-out loads them again");
});

test("auto isolation loads the extensions for a model pi only knows through one", { timeout: 120_000 }, async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-ext-home-"));
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	const marker = join(agentDir, "loaded.txt");
	await writeFile(
		join(agentDir, "extensions", "global.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function () {\n\twriteFileSync(${JSON.stringify(marker)}, "loaded");\n}\n`,
	);
	const backend = createPiBackend({
		args: ["--offline", "-ns", "-e", fixture],
		env: { PI_CODING_AGENT_DIR: agentDir, SHIFTWORK_SCRIPT: JSON.stringify([{ text: "done" }]) },
		timeoutMs: 60_000,
	});
	// Not listed without extensions: a provider some extension would register.
	const shift = await backend.startShift({ cwd: await mkdtemp(join(tmpdir(), "sw-pi-ext-")), route: { model: "extprovider/m1", thinking: "off" }, prompt: "p", systemPrompt: "s" });
	for await (const event of shift.events) if (event.type === "end") break;
	await shift.close?.();
	assert.equal(existsSync(marker), true, "a model missing from pi's extension-free list keeps the extensions");
});

test("parseModelList reads provider/model refs from pi --list-models", () => {
	const text = [
		'Warning: No models match pattern "x/y"',
		"provider        model                       context  max-out  thinking  images",
		"anthropic       claude-haiku-4-5            200K     64K      yes       yes",
		"opencode-go     glm-5.3                     200K     64K      yes       no",
		"",
	].join("\n");
	assert.deepEqual([...parseModelList(text)], ["anthropic/claude-haiku-4-5", "opencode-go/glm-5.3"]);
});

test("pi extension UI requests are dropped and an extension error stays a compact raw event", () => {
	assert.deepEqual(piRawEvents({ type: "extension_ui_request", id: "1", method: "setWidget", widgetLines: ["mic"] }), []);
	const [raw] = piRawEvents({ type: "extension_error", extensionPath: "/x/pi-free.ts", event: "session_start", error: "e".repeat(5000) });
	assert.equal(raw.type, "raw");
	assert.equal(raw.event.type, "extension_error");
	assert.equal(raw.event.extensionPath, "/x/pi-free.ts");
	assert.ok(raw.event.error.length <= 500);
	const event = { type: "message_end", message: { role: "assistant" } };
	assert.deepEqual(piRawEvents(event), [{ type: "raw", event }]);
});

test("a missing API key is an error event with kind auth, so the runner can skip that model", () => {
	const events = mapPiEvent({
		type: "message_end",
		message: { role: "assistant", stopReason: "error", errorMessage: 'No API key found for "openrouter"', content: [], usage: {} },
	});
	assert.deepEqual(events.at(-1), { type: "error", message: 'No API key found for "openrouter"', kind: "auth" });
	const other = mapPiEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit", content: [], usage: {} } });
	assert.deepEqual(other.at(-1), { type: "error", message: "429 rate limit" });
});

test("mapPiEvent turns tool_execution_start into a tool event: the command for bash, the path for file tools", () => {
	assert.deepEqual(mapPiEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } }), [
		{ type: "tool", name: "bash", input: "npm test" },
	]);
	assert.deepEqual(mapPiEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "src/a.js" } }), [
		{ type: "tool", name: "read", input: "src/a.js" },
	]);
	assert.deepEqual(mapPiEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" }), []);
});
