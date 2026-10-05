import assert from "node:assert/strict";
import { test } from "node:test";
import { frontier, loadTickets, parseTicket } from "../src/index.js";
import { makeRepo, ticket } from "./helpers.js";

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

test("frontier resolves blockers within the same feature only", async () => {
	const tickets = [
		{ feature: "new", number: "01", status: "ready-for-agent", blockedBy: [], path: "n1" },
		{ feature: "new", number: "02", status: "ready-for-agent", blockedBy: ["01"], path: "n2" },
		{ feature: "old", number: "01", status: "resolved", blockedBy: [], path: "o1" },
	];
	assert.deepEqual(frontier(tickets).map((t) => `${t.feature}/${t.number}`), ["new/01"]);
});

test("a paused feature's spec keeps its tickets off the frontier; another spec status doesn't gate", async () => {
	const root = await makeRepo({
		"paused/01-a.md": ticket("01", "A"),
		"live/01-b.md": ticket("01", "B"),
		"triaged/01-c.md": ticket("01", "C"),
		"bare/01-d.md": ticket("01", "D"),
		"paused/spec.md": "# Spec: paused\n\n**Status:** paused\n",
		"live/spec.md": "# Spec: live\n\n**Status:** ready-for-agent\n",
		"triaged/spec.md": "# Spec: triaged\n\n**Status:** needs-triage\n",
	});

	const tickets = await loadTickets(root);

	assert.equal(tickets.find((t) => t.feature === "paused").featurePaused, true);
	assert.equal(tickets.find((t) => t.feature === "live").featurePaused, undefined);
	assert.deepEqual(frontier(tickets).map((t) => t.feature), ["bare", "live", "triaged"]);
});

test("Frozen globs: backtick-quoted spans, else split on the middle dot or a comma; absent is []", () => {
	const frozen = (line) => parseTicket(`# 01: A\n\n**Status:** ready-for-agent\n**Frozen:** ${line}\n`).frozen;
	assert.deepEqual(frozen("`packages/*/test/fixtures/**` · `package.json`"), ["packages/*/test/fixtures/**", "package.json"]);
	assert.deepEqual(frozen("test/**/*.js · package.json"), ["test/**/*.js", "package.json"]);
	assert.deepEqual(frozen("test/**, scripts/verify.sh"), ["test/**", "scripts/verify.sh"]);
	assert.deepEqual(parseTicket("# 01: A\n\n**Status:** ready-for-agent\n").frozen, []);
});
