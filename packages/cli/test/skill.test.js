import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SKILL_DIR, SKILL_TARGETS, syncSkills } from "../../../scripts/sync-skills.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const skillDir = path.join(repoRoot, SKILL_DIR);

/** Parse a SKILL.md frontmatter block into a flat string map. */
function parseFrontmatter(file) {
	const text = readFileSync(file, "utf8");
	assert.match(text, /^---\n/, `${file}: starts with a frontmatter block`);
	const end = text.indexOf("\n---\n", 4);
	assert.ok(end > 0, `${file}: closed frontmatter`);
	const fields = {};
	for (const line of text.slice(4, end).split("\n")) {
		const match = /^(.+?):\s*(.*)$/.exec(line);
		if (match) fields[match[1].trim()] = match[2].trim();
	}
	return { fields, text };
}

/** Recursively list a directory's files as slash paths relative to it. */
function listFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory()
			? listFiles(file).map((name) => `${entry.name}/${name}`)
			: [entry.name];
	});
}

test("the shiftwork skill has valid frontmatter and existing files", () => {
	const { fields, text } = parseFrontmatter(path.join(skillDir, "SKILL.md"));

	assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "name: lowercase words joined by single hyphens");
	assert.ok(fields.name.length <= 64, "name: at most 64 characters");
	assert.equal(fields.name, path.basename(skillDir), "name matches the skill directory");
	assert.ok(fields.description && fields.description.length <= 1024, "description: non-empty, at most 1024 characters");

	// Every relative file link in the body resolves inside the skill.
	for (const match of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
		const target = match[1];
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue;
		const resolved = path.join(skillDir, target);
		assert.ok(statSync(resolved).isFile(), `linked file exists: ${target}`);
	}
	for (const reference of ["references/tickets.md", "references/config.md"]) {
		assert.ok(statSync(path.join(skillDir, reference)).isFile(), `${reference} exists`);
	}
});

test("pi-shiftwork packages the skill", () => {
	const manifest = JSON.parse(readFileSync(path.join(repoRoot, "packages/pi/package.json"), "utf8"));
	const skills = manifest.pi?.skills ?? [];
	assert.ok(
		skills.includes("./skills/shiftwork"),
		`pi.skills lists ./skills/shiftwork (found: ${skills.join(", ")})`,
	);
	const packaged = path.join(repoRoot, "packages/pi", "skills/shiftwork");
	assert.ok(existsSync(path.join(packaged, "SKILL.md")), "the packaged skill directory contains SKILL.md");
	assert.ok(manifest.files.includes("skills"), 'the npm tarball "files" include skills');
});

test("the Claude Code plugin and marketplace JSON are valid", () => {
	const marketplace = JSON.parse(readFileSync(path.join(repoRoot, ".claude-plugin/marketplace.json"), "utf8"));
	assert.ok(marketplace.name && typeof marketplace.name === "string", "marketplace has a name");
	assert.ok(marketplace.owner?.name, "marketplace names an owner");
	const pluginEntry = marketplace.plugins?.find((p) => p.name === "shiftwork");
	assert.ok(pluginEntry, "the marketplace lists the shiftwork plugin");
	assert.equal(pluginEntry.source, "./plugins/shiftwork", "the plugin's source points at plugins/shiftwork");

	const pluginRoot = path.join(repoRoot, pluginEntry.source);
	const plugin = JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"));
	assert.equal(plugin.name, "shiftwork", "plugin.json name");
	assert.ok(plugin.description, "plugin.json description");
	assert.equal(plugin.name, pluginEntry.name, "plugin name matches its marketplace entry");
	assert.ok(
		existsSync(path.join(pluginRoot, "skills/shiftwork/SKILL.md")),
		"the plugin carries the skill in skills/shiftwork/",
	);
});

test("packaged copies of the skill are in sync", () => {
	// The same command `npm run sync-skills` runs: running it twice is a no-op,
	// and the packaged copies still match the canonical skill byte for byte.
	const run = () => execFileSync("node", ["scripts/sync-skills.mjs"], { cwd: repoRoot, encoding: "utf8" });
	assert.equal(run(), run());
	syncSkills(repoRoot);

	const canonical = listFiles(skillDir);
	assert.deepEqual(canonical, ["SKILL.md", "references/config.md", "references/tickets.md"].sort());
	for (const target of SKILL_TARGETS) {
		const copy = path.join(repoRoot, target);
		assert.deepEqual(listFiles(copy), canonical, `${target}: same files as ${SKILL_DIR}`);
		for (const file of canonical) {
			assert.equal(
				readFileSync(path.join(copy, file), "utf8"),
				readFileSync(path.join(skillDir, file), "utf8"),
				`${target}/${file} matches ${SKILL_DIR}/${file} (run "npm run sync-skills")`,
			);
		}
	}
});

test("the README documents one install command per harness", () => {
	const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
	assert.match(readme, /pi install npm:pi-shiftwork/, "pi: pi install npm:pi-shiftwork");
	assert.match(readme, /\/plugin marketplace add Ivlad003\/shiftwork/, "Claude Code: marketplace add");
	assert.match(readme, /\/plugin install shiftwork@shiftwork/, "Claude Code: plugin install");
	assert.match(readme, /\.agents\/skills\/shiftwork/, "OpenCode/Codex/Cursor: .agents/skills");
});
