import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProfileContext, createMeter } from "../src/meter.js";

const turn = (tokens = 100, costUsd = 0.01) => ({
	type: "turn",
	usage: { input: tokens, output: 0, totalTokens: tokens },
	costUsd,
});

const cases = [
	["maxTokens hard after the budget is reached", { maxTokens: 250 }, [turn(100), turn(100), turn(100)], "hard", "maxTokens", 300],
	["maxCostUsd hard after the cost is reached", { maxCostUsd: 0.03 }, [turn(100, 0.02), turn(100, 0.02)], "hard", "maxCostUsd", 0.04],
	["maxTurns hard after N turns", { maxTurns: 2 }, [turn(), turn(), turn()], "hard", "maxTurns", 2],
	["maxContextPct hard at the limit", { maxContextPct: 70 }, [{ type: "context", percent: 80 }], "hard", "maxContextPct", 80],
	["stallTurns hard when diff stat stops changing", { stallTurns: 2 }, [
		{ type: "diffStat", stat: "a.txt | 1 +" },
		turn(),
		{ type: "diffStat", stat: "a.txt | 1 +" },
		turn(),
		{ type: "diffStat", stat: "a.txt | 1 +" },
		turn(),
	], "hard", "stallTurns", 2],
	["maxWallMin hard after elapsed time", { maxWallMin: 1 }, [turn()], "hard", "maxWallMin", 1, { now: advancingNow(0, 60_000) }],
];

for (const [name, budget, events, level, kind, current, options] of cases) {
	test(`meter: ${name}`, () => {
		const meter = createMeter(budget, 80, options ?? {});
		let last = null;
		for (const event of events) {
			const result = meter.observe(event);
			if (result) last = result;
		}
		assert.ok(last, `expected a ${level} limit`);
		assert.equal(last.level, level);
		assert.equal(last.kind, kind);
		assert.equal(last.current, current);
	});
}

test("meter: soft limit fires once per kind before the hard limit", () => {
	const meter = createMeter({ maxTurns: 10 }, 80);
	const results = [];
	for (let i = 0; i < 11; i++) {
		const r = meter.observe(turn());
		if (r) results.push(r);
	}
	assert.equal(results.length, 2);
	assert.equal(results[0].level, "soft");
	assert.equal(results[0].kind, "maxTurns");
	assert.equal(results[1].level, "hard");
	assert.equal(results[1].kind, "maxTurns");
});

test("meter: a changing diff stat resets stall turns", () => {
	const meter = createMeter({ stallTurns: 2 }, 80);
	const events = [
		{ type: "diffStat", stat: "a.txt | 1 +" },
		turn(),
		{ type: "diffStat", stat: "a.txt | 2 +" },
		turn(),
		{ type: "diffStat", stat: "a.txt | 2 +" },
		turn(),
	];
	let last = null;
	for (const event of events) {
		const r = meter.observe(event);
		if (r) last = r;
	}
	assert.equal(last, null, "stall should not trigger because diff stat changed");
});

test("meter: stallTurns hard when failing output stops changing", () => {
	const meter = createMeter({ stallTurns: 2 }, 80);
	const events = [
		{ type: "failingOutput", output: "done.txt: missing" },
		turn(),
		{ type: "failingOutput", output: "done.txt: missing" },
		turn(),
		{ type: "failingOutput", output: "done.txt: missing" },
		turn(),
	];
	let last = null;
	for (const event of events) {
		const r = meter.observe(event);
		if (r) last = r;
	}
	assert.ok(last);
	assert.equal(last.level, "hard");
	assert.equal(last.kind, "stallTurns");
	assert.equal(last.current, 2);
});

test("meter: stallTurns is hard-only, no soft limit", () => {
	const meter = createMeter({ stallTurns: 5 }, 80);
	const results = [];
	for (let i = 0; i < 6; i++) {
		const r = meter.observe({ type: "diffStat", stat: "same" });
		if (r) results.push(r);
	}
	assert.equal(results.length, 1);
	assert.equal(results[0].level, "hard");
	assert.equal(results[0].kind, "stallTurns");
});

test("applyProfileContext: tokens are percent of the profile window", () => {
	const event = { type: "context", percent: 10, tokens: 800, contextWindow: 8000 };
	assert.deepEqual(applyProfileContext(event, 1000), {
		type: "context",
		percent: 80,
		tokens: 800,
		contextWindow: 1000,
	});
});

test("applyProfileContext: leaves backend percent when the profile has no window", () => {
	const event = { type: "context", percent: 10, tokens: 800, contextWindow: 8000 };
	assert.equal(applyProfileContext(event, undefined), event);
});

test("applyProfileContext: leaves backend percent when the event has no tokens", () => {
	const event = { type: "context", percent: 10 };
	assert.equal(applyProfileContext(event, 1000), event);
});

function advancingNow(start, step) {
	let t = start;
	return () => {
		const now = t;
		t += step;
		return now;
	};
}
