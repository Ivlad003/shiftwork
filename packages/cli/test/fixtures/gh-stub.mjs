#!/usr/bin/env node
// Test-only stub `gh` for dark-factory e2e tests (github-watch ticket 05): it
// answers from the JSON state in $SHIFTWORK_GH_STATE and records every write
// (comments, labels, closing) back into it, so a run is observable end to end.
// It implements exactly the calls createGitHub makes — nothing else.
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.SHIFTWORK_GH_STATE;
if (!statePath) {
	console.error("gh-stub: $SHIFTWORK_GH_STATE is not set");
	process.exit(1);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
const [cmd, ...rest] = process.argv.slice(2);

/** The value of one flag, e.g. `--repo`; every value of a repeatable flag, e.g. `--add-label`. */
const flag = (name) => rest[rest.indexOf(name) + 1];
const flags = (name) => rest.filter((_, i) => rest[i - 1] === name).filter((value) => !value.startsWith("--"));

const issue = (n) => state.issues.find((i) => i.number === Number(n));
const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const comment = (n, body) => {
	const i = issue(n);
	state.commentId = (state.commentId ?? 1000) + 1;
	i.comments.push({ id: state.commentId, author: state.login ?? "octocat", body, createdAt: new Date().toISOString() });
	save();
	return state.commentId;
};

if (cmd === "auth" && rest[0] === "status") {
	if (state.noAuth) {
		console.error("not logged in");
		process.exit(1);
	}
	process.exit(0);
}
if (cmd === "label" && rest[0] === "list") {
	console.log(JSON.stringify(state.labels.map((name) => ({ name }))));
	process.exit(0);
}
if (cmd === "api" && rest[0] === `repos/${state.repo}/collaborators`) {
	// --paginate --jq .[].login: one login per line.
	console.log(state.collaborators.join("\n"));
	process.exit(0);
}
if (cmd === "api" && rest[0]?.startsWith(`repos/${state.repo}/issues/`) && rest[0]?.endsWith("/comments")) {
	const n = rest[0].split("/")[4];
	const body = flag("-f")?.slice("body=".length);
	if (body !== undefined) {
		// POST: record the comment, answer with the created comment's JSON.
		console.log(JSON.stringify({ id: comment(n, body) }));
		process.exit(0);
	}
	// GET --paginate --jq: one normalized comment per line, oldest first.
	for (const c of issue(n).comments) console.log(JSON.stringify({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt }));
	process.exit(0);
}
if (cmd === "issue" && rest[0] === "list") {
	let issues = state.issues.filter((i) => i.state !== "closed");
	if (flag("--label")) issues = issues.filter((i) => i.labels.includes(flag("--label")));
	console.log(
		JSON.stringify(
			issues.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, author: { login: i.author }, labels: i.labels.map((name) => ({ name })), url: i.url })),
		),
	);
	process.exit(0);
}
if (cmd === "issue" && rest[0] === "edit") {
	const i = issue(rest[1]);
	for (const label of flags("--add-label")) if (!i.labels.includes(label)) i.labels.push(label);
	for (const label of flags("--remove-label")) i.labels = i.labels.filter((name) => name !== label);
	save();
	process.exit(0);
}
if (cmd === "issue" && rest[0] === "close") {
	const i = issue(rest[1]);
	i.state = "closed";
	save();
	console.log(`closed ${i.number}`);
	process.exit(0);
}

console.error(`gh-stub: unknown command: ${process.argv.slice(2).join(" ")}`);
process.exit(1);
