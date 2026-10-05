import { GITHUB_LABELS_IN_REQUIRED } from "shiftwork-core";

import { execIn } from "./exec.js";
import { createGitHub, ghPreFlight } from "./github.js";

/** Colour + description for each label kind when `--create` creates it. */
export const LABEL_META = {
	in: {
		color: "0e8a16",
		description: "Shiftwork: hands this issue to Shiftwork (authored or labelled by a collaborator)",
	},
	working: {
		color: "fbca04",
		description: "Shiftwork: work started on this issue (set by Shiftwork)",
	},
	needsInfo: {
		color: "d93f0b",
		description: "Shiftwork: needs information from a collaborator (set by Shiftwork)",
	},
	done: {
		color: "5319e7",
		description: "Shiftwork: every ticket of this issue is resolved (set by Shiftwork)",
	},
};

/** The command's own name, the prefix of every error it prints (`run --dark-factory` keeps `dark-factory:`). */
export const LABELS_COMMAND = "shiftwork github labels";

/** The four configured labels in fixed order: `in` first, then the ones Shiftwork sets. */
export function configuredLabels(config) {
	const labels = config?.github?.labels;
	if (typeof labels?.in !== "string" || labels.in.length === 0) throw new Error(GITHUB_LABELS_IN_REQUIRED);
	return { in: labels.in, working: labels.working, needsInfo: labels.needsInfo, done: labels.done };
}

/**
 * Check the configured dark-factory labels exist in the repo: list the repo's
 * labels (`gh label list --json name --limit 500`) and return
 * `{ missing: [names] }`. A missing label is never silently created.
 */
export async function checkLabels({ github, config }) {
	const labels = configuredLabels(config);
	const existing = new Set(await github.listLabels());
	return { missing: Object.values(labels).filter((name) => !existing.has(name)) };
}

/** The missing-labels error: the repo, the missing labels, the fix and the guide (ticket 05), under the calling command's prefix. */
export function missingLabelsMessage(repo, missing, command = "dark-factory") {
	return `${command}: missing GitHub labels in ${repo}: ${missing.join(", ")}. Create them: shiftwork github labels --create (see docs/guide.md "Dark-factory: labels")`;
}

/**
 * `shiftwork github labels [--create]`: print each configured label with
 * `✔ exists` / `✖ missing` and exit 1 when any is missing. With `--create`,
 * create only the missing ones (a colour and a description); never edit or
 * delete an existing label. Before listing anything, the same gh pre-flight
 * as dark-factory: gh missing, or not logged in, exits 1 with its message.
 */
export async function githubLabelsCommand({ root, config, create = false, exec, log = console.log, err = console.error } = {}) {
	const labels = configuredLabels(config);
	const ghBinary = config?.github?.gh ?? "gh";
	const execFn = exec ?? execIn(root);

	const problem = await ghPreFlight({ gh: ghBinary, exec: execFn, command: LABELS_COMMAND });
	if (problem) {
		err(problem);
		return 1;
	}

	const github = createGitHub({ root, repo: config?.github?.repo, gh: ghBinary, exec: execFn });
	const { missing } = await checkLabels({ github, config });

	if (create) {
		for (const [kind, name] of Object.entries(labels)) {
			if (missing.includes(name)) {
				await github.createLabel(name, LABEL_META[kind]);
				log(`✔ ${name} created`);
			} else {
				log(`✔ ${name} exists`);
			}
		}
		return 0;
	}

	for (const name of Object.values(labels)) {
		log(missing.includes(name) ? `✖ ${name} missing` : `✔ ${name} exists`);
	}
	if (missing.length) {
		log(missingLabelsMessage(await github.repo(), missing, LABELS_COMMAND));
		return 1;
	}
	return 0;
}
