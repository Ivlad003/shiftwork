import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createOpencodeBackend, createOpencodeMapper } from "../src/opencode-backend.js";

async function withFakeOpencode(script) {
	const binDir = await mkdtemp(join(tmpdir(), "sw-opencode-bin-"));
	const opencodePath = join(binDir, "opencode");
	await writeFile(
		opencodePath,
		`#!/usr/bin/env node
const script = ${JSON.stringify(script)};
for (const line of script) console.log(JSON.stringify(line));
`,
	);
	await chmod(opencodePath, 0o755);
	return { binDir, cleanup: () => rm(binDir, { recursive: true, force: true }) };
}

async function shiftWith({ script, env = {}, route = { model: "opencode-go/kimi-k2.7-code" }, skills = { paths: [], preload: [], restricted: false } } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "sw-opencode-"));
	const { binDir, cleanup } = await withFakeOpencode(script);
	const backend = createOpencodeBackend({ command: "opencode", env: { PATH: `${binDir}:${process.env.PATH}`, ...env } });
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

const recorded = readFileSync(new URL("./fixtures/opencode-stream.jsonl", import.meta.url), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

test("a recorded real OpenCode transcript maps to two turns, the reply text, the cost and a clean end", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({ script: recorded });

	const turns = events.filter((e) => e.type === "turn");
	assert.equal(turns.length, 2, "one turn per assistant message");
	assert.equal(turns[0].usage.input, 10206, "context includes cache reads");
	assert.equal(turns[0].usage.output, 39, "output tokens include reasoning");
	assert.ok(events.some((e) => e.type === "text" && /hello world/i.test(e.text)));
	assert.deepEqual(events.find((e) => e.type === "cost"), { type: "cost", costUsd: 0.004987699999999999 });
	assert.ok(events.some((e) => e.type === "context" && e.tokens === 10206));
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "stop" });
	assert.equal(events.filter((e) => e.type === "end").length, 1);
});

test("a usage-limit error cools opencode and is reported as an error event", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		script: [{ type: "error", error: { type: "provider.quota", message: "GoUsageLimitError: usage limit reached" } }],
	});

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /usage limit reached/i);
	const { classifyError } = await import("shiftwork-core");
	assert.equal(classifyError(error.message)?.kind, "usage");
	assert.equal(events.at(-1).type, "end");
});

test("a missing opencode binary returns an error shift that ends immediately", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-opencode-missing-"));
	const emptyBin = await mkdtemp(join(tmpdir(), "sw-empty-bin-"));
	const backend = createOpencodeBackend({ command: "opencode", env: { PATH: emptyBin } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "opencode-go/kimi-k2.7-code", skills: { paths: [], preload: [], restricted: false } },
		prompt: "Do the ticket.",
		systemPrompt: "You are a test worker.",
	});
	const events = [];
	for await (const event of shift.events) {
		events.push(event);
		if (event.type === "end") break;
	}

	assert.ok(events.some((e) => e.type === "error" && /command not found/.test(e.message)));
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "error" });
	assert.ok(shift.warnings.some((w) => /not available/.test(w)));
});

test("preloaded skills are prepended to the prompt passed to opencode", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-opencode-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "---\nname: alpha\n---\nAlpha preloaded body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-opencode-preload-"));
	const binDir = await mkdtemp(join(tmpdir(), "sw-opencode-bin-"));
	const opencodePath = join(binDir, "opencode");
	await writeFile(
		opencodePath,
		`#!/usr/bin/env node
const args = process.argv.slice(2);
const promptIdx = args.findIndex((a) => !a.startsWith("-"));
const prompt = args.slice(promptIdx).join(" ");
require("fs").writeFileSync(process.env.SHIFTWORK_RECORD_PROMPT ?? "missing", prompt);
console.log(JSON.stringify({ type: "step_finish", part: { type: "step-finish", messageID: "m1", reason: "done", tokens: { input: 1, output: 1 } } }));
`,
	);
	await chmod(opencodePath, 0o755);

	const record = join(cwd, "shiftwork-prompt.txt");
	const backend = createOpencodeBackend({ command: "opencode", env: { PATH: `${binDir}:${process.env.PATH}`, SHIFTWORK_RECORD_PROMPT: record } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "opencode-go/kimi-k2.7-code", skills: { paths: [skill], preload: [skill], restricted: true } },
		prompt: "Do the ticket.",
		systemPrompt: "Worker prompt.",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();

	const prompt = await readFile(record, "utf8");
	assert.match(prompt, /Worker prompt\./);
	assert.match(prompt, /Alpha preloaded body\./);
	assert.match(prompt, /Do the ticket\./);
});

test("restricted skills are delivered as symlinks in .agents/skills and excluded from git", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-opencode-link-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "Skill body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-opencode-links-"));
	const binDir = await mkdtemp(join(tmpdir(), "sw-opencode-bin-"));
	const opencodePath = join(binDir, "opencode");
	await writeFile(
		opencodePath,
		`#!/usr/bin/env node
const fs = require("fs");
const link = fs.readlinkSync(process.env.SHIFTWORK_RECORD_LINK ?? "missing");
fs.writeFileSync(process.env.SHIFTWORK_RECORD_LINK ?? "missing" + ".out", link);
console.log(JSON.stringify({ type: "step_finish", part: { type: "step-finish", messageID: "m1", reason: "done", tokens: { input: 1, output: 1 } } }));
`,
	);
	await chmod(opencodePath, 0o755);

	const { execFileSync } = await import("node:child_process");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });

	const linkRecord = join(cwd, "link");
	const backend = createOpencodeBackend({ command: "opencode", env: { PATH: `${binDir}:${process.env.PATH}`, SHIFTWORK_RECORD_LINK: linkRecord } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "opencode-go/kimi-k2.7-code", skills: { paths: [skill], preload: [], restricted: true } },
		prompt: "Do the ticket.",
		systemPrompt: "sys",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();

	const symlinkPath = join(cwd, ".agents", "skills", basename(skill));
	assert.ok(existsSync(symlinkPath), "symlink exists in .agents/skills");
	assert.equal(await readFile(join(symlinkPath, "SKILL.md"), "utf8"), "Skill body.");
	const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
	assert.match(exclude, /^\.agents\/skills\/$/m);
});

test("the OpenCode mapper counts one assistant message per messageID and ignores unknown events", () => {
	const map = createOpencodeMapper();
	assert.deepEqual(map({ type: "step_start", part: { messageID: "m1", type: "step-start" } }), []);
	assert.deepEqual(map({ type: "tool_use", part: { messageID: "m1", type: "tool", tool: "read" } }), []);
	assert.deepEqual(map({ type: "step_finish", part: { messageID: "m1", type: "step-finish", reason: "tool-calls", cost: 0.01, tokens: { input: 100, output: 5, cache: { read: 50, write: 10 } } } }), [
		{ type: "turn", model: undefined, usage: { input: 160, output: 5, totalTokens: 165 }, costUsd: 0.01 },
		{ type: "context", tokens: 160 },
		{ type: "cost", costUsd: 0.01 },
	]);
	assert.deepEqual(map({ type: "text", part: { messageID: "m2", type: "text", text: "hi" } }), [
		{ type: "turn", model: undefined, usage: { input: 0, output: 0, totalTokens: 0 }, costUsd: 0 },
		{ type: "text", text: "hi" },
	]);
	assert.deepEqual(map({ type: "error", error: { type: "provider.quota", message: "GoUsageLimitError" } }), [{ type: "error", message: "GoUsageLimitError" }]);
});

const live = process.env.SHIFTWORK_LIVE_OPENCODE === "1" ? test : test.skip;

live(
	"a live opencode probe reports availability",
	{ timeout: 120_000 },
	async () => {
		const backend = createOpencodeBackend();
		const available = await backend.probe("opencode-go/kimi-k2.7-code");
		assert.equal(typeof available, "boolean");
	},
);

live(
	"a live opencode shift runs a tiny prompt and emits a turn",
	{ timeout: 180_000 },
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sw-opencode-live-"));
		const backend = createOpencodeBackend();
		const shift = await backend.startShift({
			cwd,
			route: { model: "opencode-go/kimi-k2.7-code", skills: { paths: [], preload: [], restricted: false } },
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
