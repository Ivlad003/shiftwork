import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openRunState } from "shiftwork-core";
import { formatEvent, listShiftLogs, logs, readFrom } from "../src/logs.js";

const AT = "2026-10-03T17:31:15.086Z";
const plain = (event, options = {}) => formatEvent({ at: AT, ...event }, { color: false, width: 80, ...options });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function repo() {
	return mkdtemp(join(tmpdir(), "sw-logs-"));
}

async function writeLog(root, feature, number, name, events, mtime) {
	const dir = join(root, "logs", feature, number);
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, events.map((e) => `${JSON.stringify({ at: AT, ...e })}\n`).join(""));
	if (mtime) await utimes(file, mtime, mtime);
	return file;
}

const line = (event) => `${JSON.stringify({ at: AT, ...event })}\n`;

function sink() {
	const lines = [];
	return { lines, out: (l) => lines.push(l), text: () => lines.join("\n") };
}

async function until(predicate, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (predicate()) return;
		await delay(10);
	}
	throw new Error("timed out waiting");
}

// formatEvent

test("formatEvent: start is a header with backend, model, tier and attempt", () => {
	const [l] = plain({ type: "start", backend: "claude", model: "claude/sonnet", tier: "default", attempt: 2, shift: 3 });
	assert.equal(l, "17:31:15 ▶ start · claude · claude/sonnet · default · attempt 2 · shift 3");
});

test("formatEvent: text is wrapped to the width, continuation lines indented", () => {
	const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
	const lines = plain({ type: "text", text: words }, { width: 40 });
	assert.ok(lines.length > 1);
	assert.ok(lines[0].startsWith("17:31:15 word0"));
	for (const l of lines) assert.ok(l.length <= 40, l);
	for (const l of lines.slice(1)) assert.ok(l.startsWith("         "), l);
	assert.equal(lines.join(" ").replace(/\s+/g, " ").replace("17:31:15 ", ""), words);
});

test("formatEvent: text keeps its own line breaks", () => {
	const lines = plain({ type: "text", text: "one\ntwo" });
	assert.deepEqual(lines, ["17:31:15 one", "         two"]);
});

test("formatEvent: a shell tool is `$ cmd`, an edit is `✎ path`, others name and input", () => {
	assert.deepEqual(plain({ type: "tool", name: "Bash", input: { command: "npm test" } }), ["17:31:15 $ npm test"]);
	assert.deepEqual(plain({ type: "tool", name: "shell", input: { cmd: "ls -la\necho hi" } }), ["17:31:15 $ ls -la …"]);
	assert.deepEqual(plain({ type: "tool", name: "Edit", input: { file_path: "src/a.js", old_string: "x" } }), ["17:31:15 ✎ src/a.js"]);
	assert.deepEqual(plain({ type: "tool", name: "write", input: { path: "b.md" } }), ["17:31:15 ✎ b.md"]);
	assert.deepEqual(plain({ type: "tool", name: "Grep", input: { pattern: "foo" } }), ['17:31:15 ⚙ Grep {"pattern":"foo"}']);
	assert.deepEqual(plain({ type: "tool", name: "Read" }), ["17:31:15 ⚙ Read"]);
});

test("formatEvent: turn shows tokens and cost, dim when coloured", () => {
	assert.deepEqual(plain({ type: "turn", usage: { totalTokens: 25489 }, costUsd: 0 }), ["17:31:15 · turn 25,489 tokens"]);
	assert.deepEqual(plain({ type: "turn", usage: { totalTokens: 10 }, costUsd: 0.1234 }), ["17:31:15 · turn 10 tokens · $0.12"]);
	const [coloured] = formatEvent({ at: AT, type: "turn", usage: { totalTokens: 1 } }, { color: true });
	assert.ok(coloured.startsWith("\x1b[2m"));
});

test("formatEvent: context is skipped unless raw", () => {
	assert.deepEqual(plain({ type: "context", tokens: 1, percent: 5.04 }), []);
	assert.deepEqual(plain({ type: "context", tokens: 1, percent: 5.04 }, { raw: true }), ["17:31:15 · ctx 5%"]);
});

test("formatEvent: error is red when coloured, end shows the stop reason", () => {
	assert.deepEqual(plain({ type: "error", message: "boom" }), ["17:31:15 ✖ error: boom"]);
	const [red] = formatEvent({ at: AT, type: "error", message: "boom" }, { color: true });
	assert.ok(red.includes("\x1b[31m"));
	assert.deepEqual(plain({ type: "end", stopReason: "stop" }), ["17:31:15 ■ end · stop"]);
});

test("formatEvent: unknown events are skipped, or JSON with raw", () => {
	assert.deepEqual(plain({ type: "raw", event: { a: 1 } }), []);
	const [json] = plain({ type: "raw", event: { a: 1 } }, { raw: true });
	assert.equal(json, `17:31:15 ${JSON.stringify({ at: AT, type: "raw", event: { a: 1 } })}`);
});

test("formatEvent: a prefix goes in front of every line", () => {
	assert.deepEqual(plain({ type: "text", text: "a\nb" }, { prefix: "f/01" }), ["f/01 17:31:15 a", "f/01          b"]);
});

// readFrom

test("readFrom returns whole lines and the offset after them, leaving a partial line", async () => {
	const root = await repo();
	const file = join(root, "a.jsonl");
	await writeFile(file, "one\ntwo\nthr");
	const first = await readFrom(file, 0);
	assert.deepEqual(first.lines, ["one", "two"]);
	assert.equal(first.offset, 8);
	await appendFile(file, "ee\n");
	const second = await readFrom(file, first.offset);
	assert.deepEqual(second.lines, ["three"]);
	assert.equal(second.offset, 14);
	assert.deepEqual((await readFrom(file, second.offset)).lines, []);
});

test("readFrom: a missing file is no lines; a truncated file starts over", async () => {
	const root = await repo();
	assert.deepEqual(await readFrom(join(root, "missing"), 5), { lines: [], offset: 5 });
	const file = join(root, "a.jsonl");
	await writeFile(file, "x\n");
	assert.deepEqual(await readFrom(file, 100), { lines: ["x"], offset: 2 });
});

// listShiftLogs

test("listShiftLogs orders a ticket's shift logs oldest first", async () => {
	const root = await repo();
	await writeLog(root, "f", "01", "attempt-2.jsonl", [], new Date("2026-01-02"));
	await writeLog(root, "f", "01", "attempt-1.jsonl", [], new Date("2026-01-01"));
	await writeLog(root, "f", "01", "attempt-review.jsonl", [], new Date("2026-01-03"));
	await writeFile(join(root, "logs", "f", "01", "notes.txt"), "");
	const files = await listShiftLogs(root, "f", "01");
	assert.deepEqual(
		files.map((f) => f.split("/").at(-1)),
		["attempt-1.jsonl", "attempt-2.jsonl", "attempt-review.jsonl"],
	);
	assert.deepEqual(await listShiftLogs(root, "f", "99"), []);
});

// logs (one-shot)

test("logs <feature>/<NN> prints the current attempt's log", async () => {
	const root = await repo();
	await writeLog(root, "f", "01", "attempt-1.jsonl", [{ type: "text", text: "old" }], new Date("2026-01-01"));
	await writeLog(root, "f", "01", "attempt-2.jsonl", [{ type: "start", model: "m", attempt: 2 }, { type: "text", text: "new" }], new Date("2026-01-02"));
	const s = sink();
	assert.equal(await logs(["f/01", "--dir", root], { out: s.out, color: false }), 0);
	assert.match(s.text(), /attempt-2\.jsonl/);
	assert.match(s.text(), /new/);
	assert.doesNotMatch(s.text(), /old/);
});

test("logs --all prints every attempt in order; a bare number is padded", async () => {
	const root = await repo();
	await writeLog(root, "f", "01", "attempt-1.jsonl", [{ type: "text", text: "first" }], new Date("2026-01-01"));
	await writeLog(root, "f", "01", "attempt-2.jsonl", [{ type: "text", text: "second" }], new Date("2026-01-02"));
	const s = sink();
	assert.equal(await logs(["f/1", "--all", "--dir", root], { out: s.out, color: false }), 0);
	const text = s.text();
	assert.ok(text.indexOf("first") < text.indexOf("attempt-2.jsonl"));
	assert.ok(text.indexOf("attempt-2.jsonl") < text.indexOf("second"));
});

test("logs for a ticket without logs says so and exits 1", async () => {
	const root = await repo();
	const s = sink();
	const errors = [];
	assert.equal(await logs(["f/01", "--dir", root], { out: s.out, error: (l) => errors.push(l), color: false }), 1);
	assert.match(errors.join("\n"), /no shift logs/i);
});

test("logs with no ticket and no live runner prints the most recent shift log", async () => {
	const root = await repo();
	await writeLog(root, "a", "01", "attempt-1.jsonl", [{ type: "text", text: "older" }], new Date("2026-01-01"));
	await writeLog(root, "b", "02", "attempt-1.jsonl", [{ type: "text", text: "newest" }], new Date("2026-01-05"));
	const s = sink();
	assert.equal(await logs(["--dir", root], { out: s.out, color: false }), 0);
	assert.match(s.text(), /b\/02/);
	assert.match(s.text(), /newest/);
	assert.doesNotMatch(s.text(), /older/);
});

test("logs with no ticket and no logs at all says so", async () => {
	const root = await repo();
	const errors = [];
	assert.equal(await logs(["--dir", root], { out: () => {}, error: (l) => errors.push(l), color: false }), 1);
	assert.match(errors.join("\n"), /no shift logs/i);
});

test("logs with a live runner prints each worker's current log, prefixed when there are several", async () => {
	const root = await repo();
	await writeLog(root, "a", "01", "attempt-1.jsonl", [{ type: "text", text: "alpha" }]);
	await writeLog(root, "b", "02", "attempt-3.jsonl", [{ type: "text", text: "beta" }]);
	await openRunState(root).update({
		pid: process.pid,
		running: true,
		workers: [
			{ ticket: { feature: "a", number: "01" }, attempt: 1 },
			{ ticket: { feature: "b", number: "02" }, attempt: 3 },
		],
	});
	const s = sink();
	assert.equal(await logs(["--dir", root], { out: s.out, color: false }), 0);
	assert.ok(s.lines.some((l) => l.startsWith("a/01 ") && l.includes("alpha")), s.text());
	assert.ok(s.lines.some((l) => l.startsWith("b/02 ") && l.includes("beta")), s.text());
});

// logs -f

test("logs -f <ticket> follows new lines and switches to a new attempt file", { timeout: 5000 }, async () => {
	const root = await repo();
	const first = await writeLog(root, "f", "01", "attempt-1.jsonl", [{ type: "text", text: "hello" }]);
	const s = sink();
	const controller = new AbortController();
	const done = logs(["f/01", "-f", "--dir", root], { out: s.out, color: false, pollMs: 20, signal: controller.signal });
	await until(() => s.text().includes("hello"));
	await appendFile(first, line({ type: "text", text: "partial-" }).slice(0, 10));
	await delay(50);
	await appendFile(first, line({ type: "text", text: "partial-" }).slice(10));
	await until(() => s.text().includes("partial-"));
	await delay(20);
	await writeLog(root, "f", "01", "attempt-2.jsonl", [{ type: "text", text: "second attempt" }]);
	await until(() => s.text().includes("second attempt"));
	const text = s.text();
	assert.ok(text.indexOf("attempt-2.jsonl") < text.indexOf("second attempt"));
	controller.abort();
	assert.equal(await done, 0);
	assert.equal(text.match(/partial-/g).length, 1);
});

test("logs -f with a live runner follows across tickets and exits when the runner stops", { timeout: 5000 }, async () => {
	const root = await repo();
	const state = openRunState(root);
	const a = await writeLog(root, "a", "01", "attempt-1.jsonl", [{ type: "text", text: "on a" }]);
	await state.update({ pid: process.pid, running: true, workers: [{ ticket: { feature: "a", number: "01" }, attempt: 1 }] });
	const s = sink();
	const done = logs(["-f", "--dir", root], { out: s.out, color: false, pollMs: 20 });
	await until(() => s.text().includes("on a"));
	await appendFile(a, line({ type: "end", stopReason: "stop" }));
	await until(() => s.text().includes("■ end"));
	await writeLog(root, "b", "02", "attempt-1.jsonl", [{ type: "text", text: "on b" }]);
	await state.update({ pid: process.pid, workers: [{ ticket: { feature: "b", number: "02" }, attempt: 1 }] });
	await until(() => s.text().includes("on b"));
	await state.update({ pid: process.pid, running: false, workers: [] });
	assert.equal(await done, 0);
	assert.ok(s.text().indexOf("b/02") < s.text().indexOf("on b"));
});
