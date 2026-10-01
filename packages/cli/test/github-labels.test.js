import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHub, ghAuthMessage, ghInstallMessage } from "../src/github.js";
import { checkLabels, configuredLabels, githubLabelsCommand, LABELS_COMMAND, missingLabelsMessage } from "../src/github-labels.js";

const CONFIG = {
	github: {
		repo: "owner/name",
		labels: { in: "sw", working: "sw:working", needsInfo: "sw:needs-info", done: "sw:done" },
	},
};

/**
 * A stub `exec`: records every argv it is handed and answers from `reply(argv)`.
 * No real `gh`, `git` or network is ever invoked.
 */
function stubExec(reply) {
	const calls = [];
	const exec = async (args) => {
		calls.push(args);
		const out = reply(args);
		if (out === undefined) throw new Error(`unexpected exec: ${args.join(" ")}`);
		return out;
	};
	return { exec, calls };
}

/** Reply to `gh auth status` with "", to `gh label list` with the names, and to `gh label create` with "". */
function labelExec(names) {
	return stubExec((args) => {
		if (args[1] === "auth") return "";
		if (args.includes("list")) return JSON.stringify(names.map((name) => ({ name })));
		if (args.includes("create")) return "";
		return undefined;
	});
}

test("configuredLabels returns the four configured names and requires labels.in", () => {
	assert.deepEqual(configuredLabels(CONFIG), CONFIG.github.labels);
	assert.deepEqual(configuredLabels({ github: { labels: { in: "sw" } } }), {
		in: "sw",
		working: undefined,
		needsInfo: undefined,
		done: undefined,
	});
	assert.throws(
		() => configuredLabels({ github: {} }),
		/github\.labels\.in: required: the label that hands an issue to Shiftwork \(see docs\/guide\.md "Dark-factory: labels"\)/,
	);
	assert.throws(() => configuredLabels({}), /github\.labels\.in: required/);
});

test("checkLabels lists the repo's labels and returns all present as missing: []", async () => {
	const { exec, calls } = labelExec(["sw", "sw:working", "sw:needs-info", "sw:done", "bug"]);
	const github = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.deepEqual(await checkLabels({ github, config: CONFIG }), { missing: [] });
	assert.deepEqual(calls, [["gh", "label", "list", "--repo", "owner/name", "--json", "name", "--limit", "500"]]);
});

test("checkLabels returns the absent names, in configured order", async () => {
	const github = createGitHub({ root: "/repo", repo: "owner/name", exec: labelExec(["bug", "sw:working", "sw:done"]).exec });

	assert.deepEqual(await checkLabels({ github, config: CONFIG }), { missing: ["sw", "sw:needs-info"] });
});

test("missingLabelsMessage names the repo, the labels, the --create command and the guide section, under the command's prefix", () => {
	assert.equal(
		missingLabelsMessage("owner/name", ["sw", "sw:done"]),
		'dark-factory: missing GitHub labels in owner/name: sw, sw:done. '
			+ 'Create them: shiftwork github labels --create (see docs/guide.md "Dark-factory: labels")',
	);
	assert.equal(
		missingLabelsMessage("owner/name", ["sw"], LABELS_COMMAND),
		'shiftwork github labels: missing GitHub labels in owner/name: sw. '
			+ 'Create them: shiftwork github labels --create (see docs/guide.md "Dark-factory: labels")',
	);
});

test("github labels prints ✔/✖ per label and exits 1 when one is missing", async () => {
	const { exec, calls } = labelExec(["sw:working", "sw:needs-info", "sw:done"]);
	const lines = [];
	const code = await githubLabelsCommand({ root: "/repo", config: CONFIG, exec, log: (line) => lines.push(line) });

	assert.equal(code, 1);
	assert.deepEqual(lines, [
		"✖ sw missing",
		"✔ sw:working exists",
		"✔ sw:needs-info exists",
		"✔ sw:done exists",
		missingLabelsMessage("owner/name", ["sw"], LABELS_COMMAND),
	]);
	assert.ok(calls.every((args) => !args.includes("create")), "no label is created without --create");
});

test("github labels exits 0 when every label exists", async () => {
	const lines = [];
	const code = await githubLabelsCommand({
		root: "/repo",
		config: CONFIG,
		exec: labelExec(["sw", "sw:working", "sw:needs-info", "sw:done"]).exec,
		log: (line) => lines.push(line),
	});

	assert.equal(code, 0);
	assert.deepEqual(lines, ["✔ sw exists", "✔ sw:working exists", "✔ sw:needs-info exists", "✔ sw:done exists"]);
});

test("github labels --create creates only the missing ones, with a colour and a description", async () => {
	const { exec, calls } = labelExec(["sw:working", "sw:done"]);
	const lines = [];
	const code = await githubLabelsCommand({ root: "/repo", config: CONFIG, create: true, exec, log: (line) => lines.push(line) });

	assert.equal(code, 0);
	assert.deepEqual(lines, [
		"✔ sw created",
		"✔ sw:working exists",
		"✔ sw:needs-info created",
		"✔ sw:done exists",
	]);
	const creates = calls.filter((args) => args.includes("create"));
	assert.deepEqual(creates, [
		["gh", "label", "create", "sw", "--repo", "owner/name",
			"--color", "0e8a16",
			"--description", "Shiftwork: hands this issue to Shiftwork (set by a collaborator)"],
		["gh", "label", "create", "sw:needs-info", "--repo", "owner/name",
			"--color", "d93f0b",
			"--description", "Shiftwork: needs information from a collaborator (set by Shiftwork)"],
	]);
	for (const args of calls) {
		assert.ok(!args.includes("edit") && !args.includes("delete"), "never edits or deletes a label");
	}
});

test("createGitHub runs the configured gh binary (github.gh), default gh from PATH", async () => {
	const { exec, calls } = labelExec(["sw", "sw:working", "sw:needs-info", "sw:done"]);
	const github = createGitHub({ root: "/repo", repo: "owner/name", gh: "/x/gh", exec });

	assert.deepEqual(await checkLabels({ github, config: CONFIG }), { missing: [] });
	assert.equal(calls[0][0], "/x/gh", "the stub exec sees the configured binary");
});

test("github labels exits 1 with the install message when gh is missing, before listing anything", async () => {
	const errs = [];
	const code = await githubLabelsCommand({
		root: "/repo",
		config: CONFIG,
		exec: async () => {
			throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
		},
		log: () => {},
		err: (line) => errs.push(line),
	});

	assert.equal(code, 1);
	// The error is the labels command's own, not dark-factory's.
	assert.ok(errs[0].startsWith("shiftwork github labels:"), errs[0]);
	assert.deepEqual(errs, [ghInstallMessage(LABELS_COMMAND)]);
});

test("github labels exits 1 with the login message when gh auth status fails, before listing anything", async () => {
	const errs = [];
	const code = await githubLabelsCommand({
		root: "/repo",
		config: CONFIG,
		exec: async (args) => {
			if (args[1] === "auth") throw Object.assign(new Error("gh: exit status 1"), { code: 1, stderr: "not logged in" });
			throw new Error(`unexpected exec: ${args.join(" ")}`);
		},
		log: () => {},
		err: (line) => errs.push(line),
	});

	assert.equal(code, 1);
	assert.deepEqual(errs, [ghAuthMessage(LABELS_COMMAND)]);
});

test("github labels runs the binary from github.gh, not gh from PATH", async () => {
	const { exec, calls } = labelExec(["sw", "sw:working", "sw:needs-info", "sw:done"]);
	const config = { github: { ...CONFIG.github, gh: "/x/gh" } };
	const code = await githubLabelsCommand({ root: "/repo", config, exec, log: () => {} });

	assert.equal(code, 0);
	assert.ok(calls.every((args) => args[0] === "/x/gh"), "every command runs the configured binary");
});
