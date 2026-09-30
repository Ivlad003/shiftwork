import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
	for await (const event of shift.events) if (event.type !== "raw") events.push(event);
	return { cwd, events };
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
});

test("a provider error in a real pi shift becomes an error event and ends the shift", { timeout: 90_000 }, async () => {
	const { events } = await shiftWith([{ error: "429 Too Many Requests: rate limit exceeded" }]);

	assert.ok(events.some((e) => e.type === "error" && /429/.test(e.message)));
	assert.equal(events.at(-1).type, "end");
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
