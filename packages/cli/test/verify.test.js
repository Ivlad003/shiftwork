import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createVerify, runVerify } from "../src/verify.js";

test("all commands passing makes the gate pass", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-verify-"));
	const gate = await runVerify(["true", "echo hi"], cwd);
	assert.equal(gate.ok, true);
	assert.equal(gate.results.length, 2);
});

test("the gate stops at the first failing command and keeps its output tail", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-verify-"));
	const gate = await runVerify(["echo boom >&2; exit 3", "echo never"], cwd);
	assert.equal(gate.ok, false);
	assert.equal(gate.results.length, 1);
	assert.equal(gate.results[0].code, 3);
	assert.match(gate.results[0].outputTail, /boom/);
});

test("a command that runs too long fails the gate", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-verify-"));
	const gate = await runVerify(["sleep 5"], cwd, { timeoutMs: 200 });
	assert.equal(gate.ok, false);
	assert.match(gate.results[0].outputTail, /timed out/);
});

test("a timed-out command is killed with everything it started", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-verify-"));
	const gate = await runVerify(["sh -c 'sleep 1; touch late.txt' & wait"], cwd, { timeoutMs: 200 });
	assert.equal(gate.ok, false);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(existsSync(join(cwd, "late.txt")), false, "the grandchild must not outlive the timeout");
});

test("createVerify takes the timeout from verifyTimeoutMin and names it when it fires", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-verify-"));
	const gate = await createVerify({ verifyTimeoutMin: 0.005 })(["sleep 5"], cwd);
	assert.equal(gate.ok, false);
	assert.match(gate.results[0].outputTail, /timed out after 0\.005 min \(verifyTimeoutMin\)/);
	assert.equal((await createVerify({})(["true"], cwd)).ok, true);
});
