import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createCodexBackend, createCodexMapper } from "../src/codex-backend.js";

async function withFakeCodex(script) {
	const binDir = await mkdtemp(join(tmpdir(), "sw-codex-bin-"));
	const codexPath = join(binDir, "codex");
	await writeFile(
		codexPath,
		`#!/usr/bin/env node
const script = ${JSON.stringify(script)};
for (const line of script) console.log(JSON.stringify(line));
`,
	);
	await chmod(codexPath, 0o755);
	return { binDir, cleanup: () => rm(binDir, { recursive: true, force: true }) };
}

async function shiftWith({ script, env = {}, route = { model: "gpt-5.6-terra" }, skills = { paths: [], preload: [], restricted: false } } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "sw-codex-"));
	const { binDir, cleanup } = await withFakeCodex(script);
	const backend = createCodexBackend({ command: "codex", env: { PATH: `${binDir}:${process.env.PATH}`, ...env } });
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

const recorded = readFileSync(new URL("./fixtures/codex-stream.jsonl", import.meta.url), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

test("a recorded real Codex transcript maps to one turn, the reply text and a clean end", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({ script: recorded });

	const turns = events.filter((e) => e.type === "turn");
	assert.equal(turns.length, 1, "one assistant turn");
	assert.equal(turns[0].usage.input, 30727, "input tokens from usage");
	assert.equal(turns[0].usage.output, 98, "output tokens from usage");
	assert.ok(events.some((e) => e.type === "text" && /created.*hi\.txt/i.test(e.text)));
	assert.ok(events.some((e) => e.type === "context" && e.tokens === 30727));
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "stop" });
	assert.equal(events.filter((e) => e.type === "end").length, 1);
});

test("a rate-limit error cools codex and is reported as an error event", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		script: [
			{ type: "error", message: '{"type":"error","status":429,"error":{"type":"rate_limit_error","message":"Rate limit reached. Please try again later."}}' },
			{ type: "turn.failed", error: { message: "Rate limit reached. Please try again later." } },
		],
	});

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /rate limit/i);
	const { classifyError } = await import("shiftwork-core");
	const classified = classifyError(error.message);
	assert.equal(classified?.kind, "rate");
	assert.equal(events.at(-1).type, "end");
});

test("a usage-limit error cools codex and is reported as an error event", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		script: [
			{ type: "error", message: '{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"usage_limit_reached"}}' },
			{ type: "turn.failed", error: { message: "usage_limit_reached" } },
		],
	});

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /usage_limit_reached/i);
	const { classifyError } = await import("shiftwork-core");
	assert.equal(classifyError(error.message)?.kind, "usage");
	assert.equal(events.at(-1).type, "end");
});

test("a missing codex binary returns an error shift that ends immediately", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-codex-missing-"));
	const emptyBin = await mkdtemp(join(tmpdir(), "sw-empty-bin-"));
	const backend = createCodexBackend({ command: "codex", env: { PATH: emptyBin } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "gpt-5.6-terra", skills: { paths: [], preload: [], restricted: false } },
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

test("preloaded skills are prepended to the prompt passed to codex", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-codex-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "---\nname: alpha\n---\nAlpha preloaded body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-codex-preload-"));
	const binDir = await mkdtemp(join(tmpdir(), "sw-codex-bin-"));
	const codexPath = join(binDir, "codex");
	await writeFile(
		codexPath,
		`#!/usr/bin/env node
const args = process.argv.slice(2);
const promptIdx = args.findIndex((a) => !a.startsWith("-"));
const prompt = args.slice(promptIdx).join(" ");
require("fs").writeFileSync(process.env.SHIFTWORK_RECORD_PROMPT ?? "missing", prompt);
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
	);
	await chmod(codexPath, 0o755);

	const record = join(cwd, "shiftwork-prompt.txt");
	const backend = createCodexBackend({ command: "codex", env: { PATH: `${binDir}:${process.env.PATH}`, SHIFTWORK_RECORD_PROMPT: record } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "gpt-5.6-terra", skills: { paths: [skill], preload: [skill], restricted: true } },
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
	const skill = await mkdtemp(join(tmpdir(), "sw-codex-link-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "Skill body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-codex-links-"));
	const binDir = await mkdtemp(join(tmpdir(), "sw-codex-bin-"));
	const codexPath = join(binDir, "codex");
	await writeFile(
		codexPath,
		`#!/usr/bin/env node
const fs = require("fs");
const link = fs.readlinkSync(process.env.SHIFTWORK_RECORD_LINK ?? "missing");
fs.writeFileSync(process.env.SHIFTWORK_RECORD_LINK ?? "missing" + ".out", link);
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
	);
	await chmod(codexPath, 0o755);

	// Initialize a git repo so exclude can be written.
	const { execFileSync } = await import("node:child_process");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });

	const linkRecord = join(cwd, "link");
	const backend = createCodexBackend({ command: "codex", env: { PATH: `${binDir}:${process.env.PATH}`, SHIFTWORK_RECORD_LINK: linkRecord } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "gpt-5.6-terra", skills: { paths: [skill], preload: [], restricted: true } },
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

test("the Codex mapper counts one turn per turn.completed and ignores unknown events", () => {
	const map = createCodexMapper();
	assert.deepEqual(map({ type: "thread.started" }), []);
	assert.deepEqual(map({ type: "turn.started" }), []);
	assert.deepEqual(map({ type: "item.completed", item: { type: "agent_message", text: "hello" } }), []);
	assert.deepEqual(map({ type: "item.completed", item: { type: "file_change", changes: [], status: "completed" } }), []);
	assert.deepEqual(map({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }), [
		{ type: "turn", model: undefined, usage: { input: 10, output: 3, totalTokens: 13 }, costUsd: 0 },
		{ type: "context", tokens: 10 },
		{ type: "text", text: "hello" },
	]);
	assert.deepEqual(map({ type: "error", message: "rate_limit_error" }), [{ type: "error", message: "rate_limit_error" }]);
});

const live = process.env.SHIFTWORK_LIVE_CODEX === "1" ? test : test.skip;

live(
	"a live codex probe reports availability",
	{ timeout: 120_000 },
	async () => {
		const backend = createCodexBackend();
		const available = await backend.probe("gpt-5.6-terra");
		assert.equal(typeof available, "boolean");
	},
);

live(
	"a live codex shift runs a tiny prompt and emits a turn",
	{ timeout: 180_000 },
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sw-codex-live-"));
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
		const backend = createCodexBackend();
		const shift = await backend.startShift({
			cwd,
			route: { model: "gpt-5.6-terra", skills: { paths: [], preload: [], restricted: false } },
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

test("the codex sandbox is configurable: approve-for-me by default, bypass for already isolated worktrees", { timeout: 30_000 }, async () => {
	const { mkdtemp: mk, writeFile: wf, chmod: ch, readFile: rf } = await import("node:fs/promises");
	const { tmpdir: td } = await import("node:os");
	const { join: j } = await import("node:path");
	const { createCodexBackend } = await import("../src/codex-backend.js");
	const binDir = await mk(j(td(), "sw-codex-args-"));
	const record = j(binDir, "args.json");
	await wf(j(binDir, "codex"), `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));\n`);
	await ch(j(binDir, "codex"), 0o755);
	const argsFor = async (options) => {
		const backend = createCodexBackend({ ...options, env: { PATH: `${binDir}:${process.env.PATH}` } });
		const shift = await backend.startShift({ cwd: await mk(j(td(), "sw-codex-cwd-")), route: { model: "gpt-x", skills: { paths: [], preload: [] } }, prompt: "p", systemPrompt: "s" });
		for await (const event of shift.events) if (event.type === "end") break;
		await shift.close?.();
		return JSON.parse(await rf(record, "utf8"));
	};

	assert.ok((await argsFor({})).includes("--approve-for-me"));
	assert.ok((await argsFor({ sandbox: "bypass" })).includes("--dangerously-bypass-approvals-and-sandbox"));
	const ww = await argsFor({ sandbox: "workspace-write" });
	assert.deepEqual(ww.slice(ww.indexOf("--sandbox"), ww.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
});
