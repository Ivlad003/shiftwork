import assert from "node:assert/strict";
import { test } from "node:test";
import { decideNext } from "../src/index.js";

const cases = [
	["resolves when verify passes", { attempt: 1, maxAttempts: 3, needsInfo: null, hasVerify: true, verifyOk: true }, { action: "resolve" }],
	["retries when verify fails with attempts left", { attempt: 1, maxAttempts: 3, needsInfo: null, hasVerify: true, verifyOk: false }, { action: "retry" }],
	["needs info when attempts run out", { attempt: 3, maxAttempts: 3, needsInfo: null, hasVerify: true, verifyOk: false }, { action: "needs-info", reason: "verify gate failed after 3 attempts" }],
	["needs info without verify, even if the agent was happy", { attempt: 1, maxAttempts: 3, needsInfo: null, hasVerify: false, verifyOk: false }, { action: "needs-info", reason: "no Verify commands: a human must check this ticket" }],
	["the agent's marker wins over everything", { attempt: 1, maxAttempts: 3, needsInfo: "Which DB?", hasVerify: true, verifyOk: true }, { action: "needs-info", reason: "Which DB?" }],
	["an empty marker reason still stops", { attempt: 1, maxAttempts: 3, needsInfo: "", hasVerify: true, verifyOk: false }, { action: "needs-info", reason: "agent asked for information" }],
];

for (const [name, input, expected] of cases) {
	test(`decideNext ${name}`, () => assert.deepEqual(decideNext(input), expected));
}
