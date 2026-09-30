import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTicket } from "../src/index.js";

const withVerify = (line) => parseTicket(`# 01: A\n\n**Status:** ready-for-agent\n**Verify:** ${line}\n`);

test("Verify commands are the backtick-quoted spans, commas inside them included", () => {
	const t = withVerify("`node -e \"if(f('Ann')!=='Hello, Ann!')process.exit(1)\"` · `npm run lint`");
	assert.deepEqual(t.verify, ["node -e \"if(f('Ann')!=='Hello, Ann!')process.exit(1)\"", "npm run lint"]);
});

test("Verify without backticks splits on the middle dot only", () => {
	assert.deepEqual(withVerify("npm test · npm run build, then lint").verify, ["npm test", "npm run build, then lint"]);
});

test("Blocked by, Type, Model and Skills are parsed", () => {
	const t = parseTicket("# 07: B\n\n**Blocked by:** 03, 05\n\n**Status:** claimed\n**Type:** git\n**Model:** xai/grok-4.7\n**Skills:** +design -git\n");
	assert.deepEqual([t.number, t.status, t.blockedBy, t.type, t.model, t.skills], ["07", "claimed", ["03", "05"], "git", "xai/grok-4.7", ["+design", "-git"]]);
});
