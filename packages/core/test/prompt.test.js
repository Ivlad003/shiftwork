import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildShiftPrompt } from "../src/prompt.js";

const ticket = (type) => ({
	feature: "f",
	number: "01",
	title: "Do the thing",
	path: "/repo/.scratch/f/issues/01-do.md",
	type,
	verify: ["npm test"],
});

test("a plan ticket is told to write tickets and leave product code alone", () => {
	const prompt = buildShiftPrompt(ticket("plan"), { root: "/repo", attempt: 1 });

	assert.match(prompt, /^Plan Shiftwork ticket f\/01/);
	assert.match(prompt, /Do not edit product code/);
	assert.match(prompt, /files under \.scratch\/ are the whole change/);
	assert.match(prompt, /A failing verify gate is not a reason to invent a ticket/);
	assert.doesNotMatch(prompt, /implementation task/);
	assert.doesNotMatch(prompt, /Make the code changes/);
});

test("any other ticket is still an implementation task", () => {
	const prompt = buildShiftPrompt(ticket("code"), { root: "/repo", attempt: 1 });

	assert.match(prompt, /^Implement Shiftwork ticket f\/01/);
	assert.match(prompt, /This is an implementation task, not a request for a plan/);
});

test("a plan ticket is told the tracker's absolute issues directory, not the worktree's copy", () => {
	const prompt = buildShiftPrompt(ticket("plan"), { root: "/repo", attempt: 1 });

	assert.match(prompt, /- Write new tickets in: \/repo\/\.scratch\/f\/issues\//);
	assert.doesNotMatch(buildShiftPrompt(ticket("code"), { root: "/repo", attempt: 1 }), /Write new tickets in/);
});

/** A temp repo with feature `f` and, when asked, its `.scratch/f/research.md`. */
function repoWithResearch(withResearch) {
	const root = mkdtempSync(join(tmpdir(), "sw-prompt-"));
	mkdirSync(join(root, ".scratch", "f", "issues"), { recursive: true });
	if (withResearch) writeFileSync(join(root, ".scratch", "f", "research.md"), "# Research\n");
	const at = (type) => ({ ...ticket(type), path: join(root, ".scratch", "f", "issues", "02-do.md") });
	return { root, at };
}

test("an implementation shift is pointed at research.md when the feature has one", () => {
	const { root, at } = repoWithResearch(true);
	const prompt = buildShiftPrompt(at("code"), { root, attempt: 1 });

	assert.match(prompt, /- Research: \.scratch\/f\/research\.md \(read it if you need background\)/);
});

test("the research line follows the spec path: absolute in a worktree", () => {
	const { root, at } = repoWithResearch(true);
	const prompt = buildShiftPrompt(at("code"), { root, attempt: 1, absolute: true });

	assert.ok(prompt.includes(`- Research: ${join(root, ".scratch", "f", "research.md")}`));
});

test("no research line when the feature has no research.md", () => {
	const { root, at } = repoWithResearch(false);

	assert.doesNotMatch(buildShiftPrompt(at("code"), { root, attempt: 1 }), /Research:/);
	assert.doesNotMatch(buildShiftPrompt(at("plan"), { root, attempt: 1 }), /Research:/);
});

test("a plan shift is pointed at research.md too when it exists", () => {
	const { root, at } = repoWithResearch(true);

	assert.match(buildShiftPrompt(at("plan"), { root, attempt: 1 }), /- Research: \.scratch\/f\/research\.md/);
});

test("a research ticket is told to write findings to research.md, not product code", () => {
	const { root, at } = repoWithResearch(false);
	const prompt = buildShiftPrompt(at("research"), { root, attempt: 1 });

	assert.match(prompt, /^Research for Shiftwork ticket f\/01/);
	assert.match(prompt, /- Write findings to: \.scratch\/f\/research\.md/);
	assert.match(prompt, /Do not edit product code/);
	assert.match(prompt, /sources, facts, decisions and open questions/);
	assert.doesNotMatch(prompt, /implementation task/);
	assert.doesNotMatch(prompt, /- Research:/);
});

test("a research ticket in a worktree writes to the tracker's research.md by absolute path", () => {
	const { root, at } = repoWithResearch(true);
	const prompt = buildShiftPrompt(at("research"), { root, attempt: 2, absolute: true });

	assert.ok(prompt.includes(`- Write findings to: ${join(root, ".scratch", "f", "research.md")}`));
	assert.match(prompt, /never the copy of \.scratch\/ inside a worktree/);
});

test("frozen globs are named in the shift prompt as paths not to change", () => {
	const prompt = buildShiftPrompt(ticket("code"), { root: "/repo", attempt: 2, frozen: ["test/**", "package.json"] });
	assert.match(prompt, /- Frozen paths: `test\/\*\*` · `package\.json` — do not change files matching them/);
	assert.doesNotMatch(buildShiftPrompt(ticket("code"), { root: "/repo", attempt: 1 }), /Frozen/);
});

test("the worker prompt documents the needs-research marker beside needs-info", async () => {
	const { WORKER_PROMPT } = await import("../src/prompt.js");
	assert.match(WORKER_PROMPT, /<shiftwork:needs-research reason="[^"]*"\/>/);
	assert.match(WORKER_PROMPT, /reading/);
	assert.match(WORKER_PROMPT, /only a human has/);
	assert.ok(WORKER_PROMPT.indexOf("needs-info") < WORKER_PROMPT.indexOf("needs-research"), "next to needs-info");
});
