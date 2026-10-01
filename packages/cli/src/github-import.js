import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Import collaborators' GitHub issues into `.scratch/` (spec: github-watch).
 *
 * Each new issue becomes the feature `.scratch/gh-<N>-<slug>/`: a `spec.md`
 * (the issue itself, marked ready) and the planning ticket `issues/01-plan.md`
 * that splits it into implementation tickets. What has been imported lives in
 * `.pi/shiftwork-github.json` — `{ issues: { "<N>": { number, feature,
 * importedAt, lastCommentId, posted } } }` — so polling is idempotent.
 */

const STATE_FILE = join(".pi", "shiftwork-github.json");

/** The issue title as a feature slug: lower-cased, ASCII-folded, 40 characters max. */
export function slugifyTitle(title) {
	return (
		String(title ?? "")
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/g, "") || "issue"
	);
}

/** The import state under `root`, `{ issues: {} }` when there is no file yet. */
export async function readIssueState(root) {
	const path = join(root, STATE_FILE);
	const text = await readFile(path, "utf8").catch((error) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (text === null) return { issues: {} };
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${path}: not valid JSON`);
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path}: expected an object`);
	if (data.issues === null || typeof data.issues !== "object" || Array.isArray(data.issues)) {
		throw new Error(`${path}: expected an "issues" object`);
	}
	return data.issues === undefined ? { ...data, issues: {} } : data;
}

/** Write the import state under `root` (creating `.pi/` when needed). */
export async function writeIssueState(root, state) {
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Import the open issues of `github` whose author is a collaborator or one of
 * `config.github.authors`. Issues already in `.pi/shiftwork-github.json` are
 * left alone; non-collaborators are not imported and not recorded.
 *
 * When `config.github.planTier` is set, plan tickets route to it: `routing.plan.tier`
 * is set on `config` in place (the caller passes the config on to the runner),
 * unless the config already routes `plan`.
 *
 * @returns {Promise<{ imported: { number, title, url, author, feature }[], skipped: { number, login }[] }>}
 */
export async function importIssues({ root, github, config, now }) {
	const githubConfig = config?.github ?? {};
	const label = githubConfig.labels?.in;
	const issues = await github.listIssues({ ...(label !== undefined && { label }) });
	const allowed = new Set([...(await github.collaborators()), ...(githubConfig.authors ?? [])]);
	const state = await readIssueState(root);

	const imported = [];
	const skipped = [];
	for (const issue of issues) {
		if (!allowed.has(issue.author)) {
			skipped.push({ number: issue.number, login: issue.author });
			continue;
		}
		if (state.issues[String(issue.number)]) continue;

		const feature = `gh-${issue.number}-${slugifyTitle(issue.title)}`;
		await writeFeature(root, feature, issue);
		const importedAt = new Date(typeof now === "function" ? now() : (now ?? new Date())).toISOString();
		state.issues[String(issue.number)] = { number: issue.number, feature, importedAt, lastCommentId: null, posted: [] };
		imported.push({ number: issue.number, title: issue.title, url: issue.url, author: issue.author, feature });
	}

	if (imported.length) await writeIssueState(root, state);
	routePlans(config);
	return { imported, skipped };
}

/** `github.planTier` routes plan tickets (`routing.plan.tier`) unless the config already routes `plan`. */
function routePlans(config) {
	if (!config?.github?.planTier || config.routing?.plan) return;
	config.routing = { ...config.routing, plan: { tier: config.github.planTier } };
}

/** Write the feature's `spec.md` (the issue) and `issues/01-plan.md` (the planning ticket). */
async function writeFeature(root, feature, issue) {
	const dir = join(root, ".scratch", feature);
	await mkdir(join(dir, "issues"), { recursive: true });
	await writeFile(join(dir, "spec.md"), formatSpec(issue));
	await writeFile(join(dir, "issues", "01-plan.md"), formatPlanTicket(feature, issue));
}

function formatSpec(issue) {
	return [
		`# Spec: ${String(issue.title ?? "").trim()}`,
		"",
		"**Status:** ready-for-agent",
		"",
		`Source: github#${issue.number} ${issue.url ?? ""}`.trimEnd(),
		`Author: ${issue.author ?? ""}`.trimEnd(),
		"",
		"## Issue",
		"",
		String(issue.body ?? "").trim(),
		"",
	].join("\n");
}

function formatPlanTicket(feature, issue) {
	return [
		`# 01: Plan the work for github#${issue.number}`,
		"",
		`**What to build:** Turn GitHub issue #${issue.number} into implementation tickets for the feature \`${feature}\`.`,
		"",
		"**Blocked by:** None (can start immediately)",
		"",
		"**Status:** ready-for-agent",
		"**Type:** plan",
		`**Verify:** \`shiftwork tickets check ${feature}\``,
		"",
		`- [ ] Read \`.scratch/${feature}/spec.md\` — the issue itself, from \`Source: github#${issue.number}\``,
		"- [ ] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches",
		`- [ ] Write the implementation tickets \`02…\` under \`.scratch/${feature}/issues/\`, following the \`shiftwork\` skill's ticket format — one ticket or several, as the issue needs, each \`ready-for-agent\` with acceptance checkboxes and \`**Verify:**\` commands`,
		'- [ ] When the issue is unclear, end with `<shiftwork:needs-info reason="…"/>` instead of writing tickets',
		"",
	].join("\n");
}
