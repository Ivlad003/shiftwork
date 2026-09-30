import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPiBackend, mapPiEvent } from "../src/pi-backend.js";

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
