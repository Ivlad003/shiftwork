import assert from "node:assert/strict";
import { test } from "node:test";
import { createMeter } from "../src/meter.js";

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

function advancingNow(start, step) {
	let t = start;
	return () => {
		const now = t;
		t += step;
		return now;
	};
}
