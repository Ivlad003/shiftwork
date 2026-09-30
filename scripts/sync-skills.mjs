#!/usr/bin/env node
// Syncs the canonical skill `skills/shiftwork/` into its two packaged copies:
// `packages/pi/skills/shiftwork/` (the pi-shiftwork npm tarball cannot reach
// outside the package, so the skill must live inside it) and
// `plugins/shiftwork/skills/shiftwork/` (the Claude Code plugin).
// The test in packages/cli/test/skill.test.js fails when they drift;
// run this after editing the skill.

import { cpSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

export const SKILL_DIR = "skills/shiftwork";
export const SKILL_TARGETS = ["packages/pi/skills/shiftwork", "plugins/shiftwork/skills/shiftwork"];

/**
 * Recursively list a directory's files, as slash paths relative to it.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory()
			? listFiles(file).map((name) => `${entry.name}/${name}`)
			: [entry.name];
	});
}

/**
 * Copy the canonical skill into every packaged location, and return
 * the targets and the file list.
 *
 * @param {string} repoRoot
 * @returns {{ targets: string[], files: string[] }}
 */
export function syncSkills(repoRoot) {
	const from = path.join(repoRoot, SKILL_DIR);
	const files = listFiles(from);
	for (const target of SKILL_TARGETS) {
		const to = path.join(repoRoot, target);
		rmSync(to, { recursive: true, force: true });
		cpSync(from, to, { recursive: true });
	}
	return { targets: SKILL_TARGETS, files };
}

const invokedDirectly =
	process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
	const { targets, files } = syncSkills(process.cwd());
	console.log(`skills/shiftwork -> ${targets.join(", ")} (${files.length} files)`);
}
