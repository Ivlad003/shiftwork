import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createCursorBackend, createCursorMapper } from "../src/cursor-backend.js";

function fakeScript({ script = [], status = "✓ Logged in as test@example.com", exitCode = 0, stderr = "" }) {
	return `#!/usr/bin/env node
const status = ${JSON.stringify(status)};
const script = ${JSON.stringify(script)};
const stderr = ${JSON.stringify(stderr)};
const args = process.argv.slice(2);
if (args.includes("status")) { console.log(status); process.exit(0); }
if (args.includes("--list-models")) { console.log("auto - Auto (default)"); process.exit(0); }
if (process.env.SHIFTWORK_RECORD_PROMPT) {
	require("node:fs").writeFileSync(process.env.SHIFTWORK_RECORD_PROMPT, args[args.length - 1]);
}
if (process.env.SHIFTWORK_RECORD_ARGS) {
	const fs = require("node:fs");
	const record = { args };
	const pluginIndex = args.indexOf("--plugin-dir");
	if (pluginIndex >= 0) {
		const skillsDir = require("node:path").join(args[pluginIndex + 1], "skills");
		try {
			record.pluginSkills = fs.readdirSync(skillsDir);
			record.pluginBodies = record.pluginSkills.map((name) => fs.readFileSync(require("node:path").join(skillsDir, name, "SKILL.md"), "utf8"));
		} catch (error) {
			record.pluginSkills = "ERR:" + error.message;
		}
	}
	fs.writeFileSync(process.env.SHIFTWORK_RECORD_ARGS, JSON.stringify(record));
}
if (stderr) process.stderr.write(stderr + "\\n");
for (const line of script) console.log(JSON.stringify(line));
process.exit(${exitCode});
`;
}

async function withFakeCursorAgent(scriptOptions) {
	const binDir = await mkdtemp(join(tmpdir(), "sw-cursor-bin-"));
	const agentPath = join(binDir, "cursor-agent");
	await writeFile(agentPath, fakeScript(scriptOptions));
	await chmod(agentPath, 0o755);
	return { binDir, cleanup: () => rm(binDir, { recursive: true, force: true }) };
}

async function shiftWith({ fake = {}, env = {}, route = { model: "auto" }, skills = { paths: [], preload: [], restricted: false } } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "sw-cursor-"));
	const { binDir, cleanup } = await withFakeCursorAgent(fake);
	const backend = createCursorBackend({ command: "cursor-agent", env: { PATH: `${binDir}:${process.env.PATH}`, CURSOR_API_KEY: "", ...env } });
	const shift = await backend.startShift({
		cwd,
		route: { ...route, skills },
		prompt: "Do the ticket.",
		systemPrompt: "You are a test worker.",
	});
	const events = [];
	for await (const event of shift.events) {
		events.push(event);
		if (event.type === "end") break;
	}
	await shift.close?.();
	await cleanup();
	return { cwd, events, shift };
}

const recorded = readFileSync(new URL("./fixtures/cursor-stream.jsonl", import.meta.url), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

test("a recorded real cursor-agent transcript maps to two turns, the reply text, the end usage and a clean end", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({ fake: { script: recorded } });

	const turns = events.filter((e) => e.type === "turn");
	assert.equal(turns.length, 2, "one turn per assistant message, not per line");
	assert.deepEqual(turns[0].usage, { input: 0, output: 0, totalTokens: 0 }, "usage is not on assistant events");
	assert.deepEqual(turns[1].usage, { input: 27459, output: 135, totalTokens: 27594 }, "the final turn carries the result's usage, cache included");
	assert.equal(turns[0].model, "Auto", "model comes from the init event");
	assert.ok(events.some((e) => e.type === "text" && /creating `hello\.txt`/i.test(e.text)), "first assistant message");
	assert.ok(events.some((e) => e.type === "text" && /DONE/.test(e.text)));
	assert.ok(!events.some((e) => e.type === "text" && /I will create/.test(e.text)), "thinking chunks are not reply text");
	assert.deepEqual(events.find((e) => e.type === "context"), { type: "context", tokens: 27459 });
	assert.ok(!events.some((e) => e.type === "cost"), "cursor-agent does not report cost in this transcript");
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "stop" });
	assert.equal(events.filter((e) => e.type === "end").length, 1);
});

test("a usage-limit result is reported as an error event that classifies as a usage limit", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		fake: {
			script: [
				{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] } },
				{ type: "result", subtype: "error", is_error: true, result: "You've hit your usage limit. Upgrade to a higher plan for more usage." },
			],
		},
	});

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /usage limit/i);
	const { classifyError } = await import("shiftwork-core");
	assert.equal(classifyError(error.message)?.kind, "usage");
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "error" });
	assert.equal(events.filter((e) => e.type === "turn").length, 1, "the assistant message before the failure still counts");
});

test("a missing cursor-agent binary returns an error shift that ends immediately", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-cursor-missing-"));
	const emptyBin = await mkdtemp(join(tmpdir(), "sw-empty-bin-"));
	const backend = createCursorBackend({ command: "cursor-agent", env: { PATH: emptyBin } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "auto", skills: { paths: [], preload: [], restricted: false } },
		prompt: "Do the ticket.",
		systemPrompt: "You are a test worker.",
	});
	const events = [];
	for await (const event of shift.events) {
		events.push(event);
		if (event.type === "end") break;
	}

	const error = events.find((e) => e.type === "error");
	assert.ok(error && /cursor-agent: command not found/.test(error.message));
	const { classifyError } = await import("shiftwork-core");
	assert.equal(classifyError(error.message), null, "a missing binary is not a provider limit");
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "error" });
	assert.ok(shift.warnings.some((w) => /not available/.test(w) && /cursor-agent/.test(w)));
});

test("a logged-out cursor-agent ('Not logged in') makes the backend unavailable with a warning, not a cooldown", { timeout: 30_000 }, async () => {
	const { events, shift } = await shiftWith({ fake: { status: "Not logged in" } });

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /backend not available/i);
	assert.match(error.message, /not logged in/i);
	const { classifyError } = await import("shiftwork-core");
	assert.equal(classifyError(error.message), null, "an auth failure must not classify as a provider limit");
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "error" });
	assert.ok(shift.warnings.some((w) => /not available/.test(w)));
});

test("an 'Authentication required' failure at run time is also reported as unavailable, not a cooldown", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		fake: {
			exitCode: 1,
			stderr: "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.",
		},
	});

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /backend not available/i);
	assert.match(error.message, /Authentication required/);
	const { classifyError } = await import("shiftwork-core");
	assert.equal(classifyError(error.message), null, "an auth failure must not classify as a provider limit");
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "error" });
});

test("preloaded skills and the worker prompt are prepended to the prompt passed to cursor-agent", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-cursor-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "---\nname: alpha\n---\nAlpha preloaded body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-cursor-preload-"));
	const record = join(cwd, "shiftwork-prompt.txt");
	const { binDir, cleanup } = await withFakeCursorAgent({ script: [] });
	const backend = createCursorBackend({
		command: "cursor-agent",
		env: { PATH: `${binDir}:${process.env.PATH}`, CURSOR_API_KEY: "", SHIFTWORK_RECORD_PROMPT: record },
	});
	const shift = await backend.startShift({
		cwd,
		route: { model: "auto", skills: { paths: [], preload: [skill], restricted: false } },
		prompt: "Do the ticket.",
		systemPrompt: "Worker prompt.",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();
	await cleanup();

	const prompt = await readFile(record, "utf8");
	assert.match(prompt, /Worker prompt\./);
	assert.match(prompt, /Alpha preloaded body\./);
	assert.match(prompt, /Do the ticket\./);
});

test("restricted skills are delivered as a generated plugin passed with --plugin-dir", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-cursor-plugin-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "Skill body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-cursor-plugin-"));
	const record = join(cwd, "shiftwork-args.json");
	const { binDir, cleanup } = await withFakeCursorAgent({ script: [] });
	const backend = createCursorBackend({
		command: "cursor-agent",
		env: { PATH: `${binDir}:${process.env.PATH}`, CURSOR_API_KEY: "", SHIFTWORK_RECORD_ARGS: record },
	});
	const shift = await backend.startShift({
		cwd,
		route: { model: "auto", skills: { paths: [skill], preload: [], restricted: true } },
		prompt: "Do the ticket.",
		systemPrompt: "sys",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();
	await cleanup();

	const { args, pluginSkills, pluginBodies } = JSON.parse(await readFile(record, "utf8"));
	const pluginIndex = args.indexOf("--plugin-dir");
	assert.ok(pluginIndex > 0, "--plugin-dir is passed");
	assert.deepEqual(pluginSkills, [basename(skill)], "the generated plugin holds a symlink to the granted skill");
	assert.deepEqual(pluginBodies, ["Skill body."], "the symlink resolves inside the plugin");
	assert.ok(!existsSync(args[pluginIndex + 1]), "the temp plugin is cleaned up after the shift");
	assert.ok(args.includes("--force") && args.includes("--trust"), "autonomy flags");
	const workspaceIndex = args.indexOf("--workspace");
	assert.ok(workspaceIndex > 0 && args[workspaceIndex + 1] === cwd, "the shift worktree is the workspace");
	assert.equal(args[args.indexOf("--model") + 1], "auto");
	assert.ok(!args.includes("--worktree"), "cursor-agent's own --worktree is never used");
});

test("the Cursor mapper counts one turn per assistant message, carries the result's usage and ignores noise", () => {
	const map = createCursorMapper();
	assert.deepEqual(map({ type: "system", subtype: "init", model: "Auto", cwd: "/x" }), []);
	assert.deepEqual(map({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }), []);
	assert.deepEqual(map({ type: "connection", subtype: "reconnecting" }), []);
	assert.deepEqual(map({ type: "thinking", subtype: "delta", text: "hmm" }), []);
	assert.deepEqual(map({ type: "tool_call", subtype: "started", tool_call: {} }), []);
	assert.deepEqual(map({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "First." }] } }), []);
	assert.deepEqual(map({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Second." }] } }), [
		{ type: "text", text: "First." },
		{ type: "turn", model: "Auto", usage: { input: 0, output: 0, totalTokens: 0 }, costUsd: 0 },
	]);
	assert.deepEqual(map({ type: "result", subtype: "success", is_error: false, result: "First.Second.", usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 10 } }), [
		{ type: "text", text: "Second." },
		{ type: "turn", model: "Auto", usage: { input: 150, output: 5, totalTokens: 155 }, costUsd: 0 },
		{ type: "context", tokens: 150 },
		{ type: "end", stopReason: "stop" },
	]);
	assert.deepEqual(map.flush(), []);

	const failing = createCursorMapper();
	assert.deepEqual(failing({ type: "result", subtype: "error", is_error: true, result: "boom" }), [
		{ type: "error", message: "boom" },
		{ type: "end", stopReason: "error" },
	]);

	const costing = createCursorMapper();
	assert.deepEqual(costing({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.02 }), [
		{ type: "cost", costUsd: 0.02 },
		{ type: "end", stopReason: "stop" },
	]);
});

const live = process.env.SHIFTWORK_LIVE_CURSOR === "1" ? test : test.skip;

live(
	"a live cursor-agent probe reports availability",
	{ timeout: 120_000 },
	async () => {
		const backend = createCursorBackend();
		const available = await backend.probe("auto");
		assert.equal(typeof available, "boolean");
	},
);

live(
	"a live cursor-agent shift runs a tiny prompt and emits a turn",
	{ timeout: 180_000 },
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sw-cursor-live-"));
		const backend = createCursorBackend();
		const shift = await backend.startShift({
			cwd,
			route: { model: "auto", skills: { paths: [], preload: [], restricted: false } },
			prompt: "Reply with exactly: OK",
			systemPrompt: "You are a test worker.",
		});
		const events = [];
		for await (const event of shift.events) {
			events.push(event);
			if (event.type === "end") break;
		}
		await shift.close?.();
		assert.ok(events.some((e) => e.type === "turn"), `expected a turn event, got ${JSON.stringify(events)}`);
		assert.deepEqual(events.at(-1), { type: "end", stopReason: "stop" });
	},
);

test("the Cursor mapper turns started tool calls into tool events: the path for edits, the command for shell", () => {
	const map = createCursorMapper();
	const lines = readFileSync(new URL("./fixtures/cursor-stream.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
	const tools = lines.flatMap((line) => map(JSON.parse(line))).filter((e) => e.type === "tool");
	assert.deepEqual(tools, [{ type: "tool", name: "edit", input: "/worktree/hello.txt" }], "a completed tool call is not a second call");

	const shell = createCursorMapper()({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "npm test" } } } });
	assert.deepEqual(shell, [{ type: "tool", name: "shell", input: "npm test" }]);
});
