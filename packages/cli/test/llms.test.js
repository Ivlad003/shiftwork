import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildFullText, extractLinks } from "../../../scripts/llms.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("llms.txt follows the llmstxt.org structure", async () => {
	const llms = await readFile(path.join(repoRoot, "llms.txt"), "utf8");
	const lines = llms.split("\n");
	assert.match(lines[0], /^# \S/); // H1 title
	assert.match(lines.find((l) => l.startsWith("> ")) ?? "", />/); // summary blockquote
	const sections = [...llms.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
	assert.ok(sections.length > 0, "has at least one section");
	for (const section of sections) {
		const body = llms.slice(llms.indexOf(`## ${section}`));
		assert.ok(
			extractLinks(body).length > 0,
			`section "${section}" has at least one link`,
		);
	}
});

test("every link in llms.txt resolves to a file", async () => {
	const llms = await readFile(path.join(repoRoot, "llms.txt"), "utf8");
	const links = extractLinks(llms);
	assert.ok(links.length >= 10, `found links (${links.length})`);
	for (const link of links) {
		const resolved = path.join(repoRoot, link);
		const info = await stat(resolved).catch(() => null);
		assert.ok(info?.isFile(), `link resolves to a file: ${link}`);
	}
});

test("npm run llms is deterministic", async () => {
	// The same command `npm run llms` runs (`node scripts/llms.mjs` from the
	// repo root): running it twice gives the same llms-full.txt.
	const run = () =>
		execFileSync("node", ["scripts/llms.mjs"], { cwd: repoRoot, encoding: "utf8" });
	run();
	const first = await readFile(path.join(repoRoot, "llms-full.txt"), "utf8");
	run();
	const second = await readFile(path.join(repoRoot, "llms-full.txt"), "utf8");
	assert.equal(second, first);

	const { text, links } = await buildFullText(repoRoot);
	assert.equal(text, second, "buildFullText matches the generated file");
	for (const link of links) {
		assert.match(text, new RegExp(`^# ${link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
	}
});
