import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const exec = async (args) => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	return promisify(execFile)(process.execPath, [bin, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
};

/** A temp repo with tickets ({ "feature/01-a.md": markdown }) and specs ({ feature: markdown }). */
async function repo(tickets, specs = {}) {
	const root = await mkdtemp(join(tmpdir(), "sw-pause-"));
	for (const [rel, body] of Object.entries(tickets)) {
		const [feature, file] = rel.split("/");
		await mkdir(join(root, ".scratch", feature, "issues"), { recursive: true });
		await writeFile(join(root, ".scratch", feature, "issues", file), body);
	}
	for (const [feature, body] of Object.entries(specs)) {
		await mkdir(join(root, ".scratch", feature), { recursive: true });
		await writeFile(join(root, ".scratch", feature, "spec.md"), body);
	}
	return root;
}

const t = (n, title) => `# ${n}: ${title}\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n`;
const spec = (status) => `# Spec: A\n\n**Status:** ${status}\n\nSource: operator request.\n`;

test("feature pause sets the spec's Status line and leaves every other byte unchanged", async () => {
	const before = [
		"# Spec: A",
		"",
		"**Status:** ready-for-agent",
		"",
		"Source: operator request.",
		"",
		"<!-- shiftwork:tickets:start -->",
		"| NN | title | status | last route |",
		"| -- | ----- | ------ | ---------- |",
		"| 01 | Do it | ready-for-agent |  |",
		"<!-- shiftwork:tickets:end -->",
	].join("\n");
	const root = await repo({ "a/01-do.md": t("01", "Do it") }, { a: before });

	const { stdout, stderr } = await exec(["feature", "pause", "a", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /⏸ a paused: its tickets leave the frontier/);
	assert.equal(await readFile(join(root, ".scratch", "a", "spec.md"), "utf8"), before.replace("**Status:** ready-for-agent", "**Status:** paused"));
	// Its tickets leave the frontier.
	const status = await exec(["status", "--dir", root]);
	assert.doesNotMatch(status.stdout, /→ a\/01/);
});

test("a spec without a Status line gets one under the title", async () => {
	const root = await repo({ "a/01-do.md": t("01", "Do it") }, { a: "# Spec: A\n\nSource: operator request.\n" });

	const { stdout } = await exec(["feature", "pause", "a", "--dir", root]);

	assert.match(stdout, /⏸ a paused/);
	assert.equal(await readFile(join(root, ".scratch", "a", "spec.md"), "utf8"), "# Spec: A\n\n**Status:** paused\n\nSource: operator request.\n");
});

test("feature resume restores ready-for-agent, byte for byte", async () => {
	const before = spec("ready-for-agent");
	const root = await repo({ "a/01-do.md": t("01", "Do it"), "b/01-go.md": t("01", "Go") }, { a: before, b: spec("ready-for-agent") });
	await exec(["feature", "pause", "a", "--dir", root]);

	const { stdout } = await exec(["feature", "resume", "a", "--dir", root]);

	assert.match(stdout, /▶ a resumed/);
	assert.equal(await readFile(join(root, ".scratch", "a", "spec.md"), "utf8"), before);
	const status = await exec(["status", "--dir", root]);
	assert.match(status.stdout, /→ a\/01/);
});

test("an unknown feature exits 1", async () => {
	const root = await repo({ "a/01-do.md": t("01", "Do it") }, { a: spec("ready-for-agent") });

	await assert.rejects(exec(["feature", "pause", "nope", "--dir", root]), (error) => {
		assert.match(error.stderr, /shiftwork: no feature nope under \.scratch\//);
		assert.equal(error.code, 1);
		return true;
	});
});

test("under the OpenSpec tracker, pause and resume exit 1", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-pause-opspec-"));
	await mkdir(join(root, "openspec", "changes", "c"), { recursive: true });
	await writeFile(join(root, "openspec", "changes", "c", "tasks.md"), "- [ ] 1.1 Do it\n");

	await assert.rejects(exec(["feature", "pause", "c", "--dir", root]), (error) => {
		assert.match(error.stderr, /shiftwork: pause is supported for \.scratch features only/);
		assert.equal(error.code, 1);
		return true;
	});
	await assert.rejects(exec(["feature", "resume", "c", "--dir", root]), /pause is supported for \.scratch features only/);
});

test("run --dry-run prints a paused, skipped line once per paused feature with ready tickets", async () => {
	const root = await repo(
		{ "a/01-do.md": t("01", "Do it"), "b/01-go.md": t("01", "Go") },
		{ a: spec("paused"), b: spec("ready-for-agent") },
	);
	await exec(["init", "--dir", root, "--model", "prov/model-a"]);

	const { stdout } = await exec(["run", "--dry-run", "--dir", root]);

	assert.match(stdout, /a: paused, skipped/);
	assert.doesNotMatch(stdout, /a\/01/);
	assert.match(stdout, /b\/01 {2}type=code/);
});
