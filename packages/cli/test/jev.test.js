import assert from "node:assert/strict";
import { test } from "node:test";
import { createJevClassifier, parseClassification } from "../src/jev.js";

const ticket = { title: "Fix a TypeError in the planner", checkboxes: [{ text: "It works" }] };

test("the classifier adapter returns null on any failure", async () => {
	const classifyTicket = createJevClassifier({
		config: { jev: { model: "typesafe/jev-latest" } },
		classify: async () => {
			throw new Error("network down");
		},
	});
	assert.equal(await classifyTicket(ticket), null);
});

test("the classifier adapter returns null when the classify call errors without throwing", async () => {
	const classifyTicket = createJevClassifier({
		config: { jev: { model: "typesafe/jev-latest" } },
		classify: async () => ({ stopReason: "error", errorMessage: "no key" }),
	});
	assert.equal(await classifyTicket(ticket), null);
});

test("the classifier adapter returns type and complexity from a successful call", async () => {
	const classifyTicket = createJevClassifier({
		config: { routing: { git: {}, code: {} }, jev: { model: "typesafe/jev-latest" } },
		classify: async (_model, context) => {
			assert.equal(context.questions.type.type, "choice");
			assert.ok(context.questions.type.criteria.code);
			return {
				stopReason: "stop",
				answers: {
					type: { type: "choice", choice: "git", probabilities: { git: 1 }, confidence: 1 },
					complexity: { type: "choice", choice: "complex", probabilities: { complex: 1 }, confidence: 1 },
				},
			};
		},
	});
	assert.deepEqual(await classifyTicket(ticket), { type: "git", complexity: "complex" });
});

test("the classifier adapter falls through the configured model list", async () => {
	const tried = [];
	const classifyTicket = createJevClassifier({
		config: { jev: { model: ["typesafe/jev-latest", "openrouter/typesafe/jev-1.13"] } },
		classify: async (modelId) => {
			tried.push(modelId);
			if (modelId.startsWith("typesafe/")) throw new Error("no typesafe key");
			return {
				stopReason: "stop",
				answers: {
					type: { type: "choice", choice: "code", probabilities: { code: 1 }, confidence: 1 },
					complexity: { type: "choice", choice: "standard", probabilities: { standard: 1 }, confidence: 1 },
				},
			};
		},
	});
	assert.deepEqual(await classifyTicket(ticket), { type: "code", complexity: "standard" });
	assert.deepEqual(tried, ["typesafe/jev-latest", "openrouter/typesafe/jev-1.13"]);
});

test("parseClassification ignores non-stop results", () => {
	assert.equal(parseClassification({ stopReason: "error", answers: {} }), null);
	assert.equal(parseClassification(undefined), null);
});

const live = process.env.SHIFTWORK_LIVE_JEV === "1";
test("live Jev classify (SHIFTWORK_LIVE_JEV=1)", { skip: !live }, async () => {
	const classifyTicket = createJevClassifier({
		config: { jev: { model: ["openrouter/typesafe/jev-1.13", "typesafe/jev-latest"] } },
	});
	const result = await classifyTicket({
		title: "Fix a TypeError in the planner when Type is missing from a ticket",
		checkboxes: [{ text: "Planner uses the classified type" }],
	});
	assert.ok(result, "expected a classification, got null");
	assert.equal(typeof result.type, "string");
	assert.match(result.complexity, /^(standard|complex)$/);
});
