import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { shiftworkPath } from "shiftwork-core";

/**
 * Import collaborators' GitHub issues into `.scratch/` (spec: github-watch).
 *
 * Each new issue becomes the feature `.scratch/gh-<N>-<slug>/`: a `spec.md`
 * (the issue itself, marked ready) and the planning ticket `issues/01-plan.md`
 * that splits it into implementation tickets. What has been imported lives in
 * `.shiftwork/shiftwork-github.json` — `{ syncedAt, issues: { "<N>": { number, feature,
 * title, importedAt, lastCommentId, ownComments, posted, bodySeen } } }` — so polling is
 * idempotent. `bodySeen` is the issue description with Shiftwork's questions
 * block removed, so a later human edit of that description is visible.
 * `syncedAt` is the time of the last sync (github-sync, ticket 04), shown by the
 * TUI's GitHub tab; `title` is the issue title, captured at import.
 */

const STATE_FILE = "shiftwork-github.json";

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
	const path = shiftworkPath(root, STATE_FILE);
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

/** Write the import state under `root` (creating `.shiftwork/` when needed). */
export async function writeIssueState(root, state) {
	const path = shiftworkPath(root, STATE_FILE);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Logins as a lower-cased set: GitHub logins are case-insensitive. */
export function loginSet(logins) {
	return new Set([...logins].filter(Boolean).map((login) => String(login).toLowerCase()));
}

/**
 * Import the open issues of `github` whose author is a collaborator or one of
 * `config.github.authors` — or, with `labels.in` set, whose `in` label was last
 * added by one (`github.labelActor`, asked only for an outsider's issue).
 * Logins compare case-insensitively. Issues already in
 * `.shiftwork/shiftwork-github.json` are left alone; the rest are not imported and
 * not recorded.
 *
 * Plan-ticket routing (`routing.plan` from `github.planTier`) is applied by
 * `validateConfig`, not here.
 *
 * @returns {Promise<{ imported: { number, title, url, author, feature }[], skipped: { number, login }[] }>}
 */
export async function importIssues({ root, github, config, now }) {
	const githubConfig = config?.github ?? {};
	const label = githubConfig.labels?.in;
	const issues = await github.listIssues({ ...(label !== undefined && { label }) });
	const allowed = loginSet([...(await github.collaborators()), ...(githubConfig.authors ?? [])]);
	const isAllowed = (login) => login != null && allowed.has(String(login).toLowerCase());
	const state = await readIssueState(root);

	const imported = [];
	const skipped = [];
	for (const issue of issues) {
		if (state.issues[String(issue.number)]) continue;
		// An outsider's issue counts when a collaborator handed it over with the `in` label.
		if (!isAllowed(issue.author) && !(label !== undefined && isAllowed(await github.labelActor(issue.number, label)))) {
			skipped.push({ number: issue.number, login: issue.author });
			continue;
		}

		const feature = `gh-${issue.number}-${slugifyTitle(issue.title)}`;
		await writeFeature(root, feature, issue);
		const importedAt = new Date(typeof now === "function" ? now() : (now ?? new Date())).toISOString();
		state.issues[String(issue.number)] = {
			number: issue.number,
			feature,
			title: issue.title,
			importedAt,
			lastCommentId: null,
			ownComments: [],
			posted: [],
			bodySeen: String(issue.body ?? "").trim(),
		};
		imported.push({ number: issue.number, title: issue.title, url: issue.url, author: issue.author, feature });
	}

	if (imported.length) await writeIssueState(root, state);
	return { imported, skipped };
}

/** Write the feature's `spec.md` (the issue) and `issues/01-plan.md` (the planning ticket). */
async function writeFeature(root, feature, issue) {
	const dir = join(root, ".scratch", feature);
	await mkdir(join(dir, "issues"), { recursive: true });
	await writeFile(join(dir, "spec.md"), formatSpec(issue));
	await writeFile(join(dir, "issues", "01-plan.md"), formatPlanTicket(feature, issue));
}

/** An issue with no description has nothing to plan: ticket 01 waits instead of inventing work. */
function issueIsEmpty(issue) {
	return String(issue.body ?? "").trim() === "";
}

function formatSpec(issue) {
	return [
		`# Spec: ${String(issue.title ?? "").trim()}`,
		"",
		`**Status:** ${issueIsEmpty(issue) ? "needs-info" : "ready-for-agent"}`,
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
	const empty = issueIsEmpty(issue);
	return [
		`# 01: Plan the work for github#${issue.number}`,
		"",
		`**What to build:** Turn GitHub issue #${issue.number} into implementation tickets for the feature \`${feature}\`.`,
		"",
		"**Blocked by:** None (can start immediately)",
		"",
		`**Status:** ${empty ? "needs-info" : "ready-for-agent"}`,
		"**Type:** plan",
		`**Verify:** \`shiftwork tickets check ${feature}\``,
		"",
		`- [ ] Read \`.scratch/${feature}/spec.md\` — the issue itself, from \`Source: github#${issue.number}\``,
		"- [ ] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches",
		`- [ ] When the issue needs reading before coding (an unfamiliar API, an external repo or doc, unclear existing code), write a \`**Type:** research\` ticket \`02\` first: it investigates and writes its findings (sources, facts, decisions, open questions) to \`.scratch/${feature}/research.md\`, changes no product code, and its Verify is \`test -s .scratch/${feature}/research.md\`; list it in each implementation ticket's \`**Blocked by:**\`; otherwise skip it and tick this box`,
		`- [ ] Write the implementation tickets \`02…\` (\`03…\` after a research ticket) under \`.scratch/${feature}/issues/\`, following the \`shiftwork\` skill's ticket format — one ticket or several, as the issue needs, each \`ready-for-agent\` with acceptance checkboxes and \`**Verify:**\` commands`,
		"- [ ] When the issue is unclear, write no implementation ticket and end with `<shiftwork:needs-info reason=\"…\"/>`; that is success, and a failing verify gate is not a reason to invent a ticket",
		...(empty
			? ["", "## Comments", "", "### Shift 0 — import", "- Outcome: needs-info: The issue has no description. What should Shiftwork build?"]
			: []),
		"",
	].join("\n");
}
