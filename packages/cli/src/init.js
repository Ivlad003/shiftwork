import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WORKER_PROMPT } from "shiftwork-core";

/** A starter config: every tier gets `model` when given, otherwise CHANGE-ME placeholders. */
export function starterConfig(model) {
	const chain = (tier) => [model ?? `CHANGE-ME/${tier}-model`];
	return {
		defaultType: "code",
		thinking: "medium",
		maxAttempts: 3,
		worktree: { enabled: true, setup: [] },
		routing: {
			git: { tier: "quick", thinking: "low" },
			docs: { tier: "quick", thinking: "low" },
			test: { tier: "standard" },
			code: { tier: "standard" },
			refactor: { tier: "premium" },
		},
		tiers: {
			quick: { chain: chain("quick"), thinking: "low" },
			standard: { chain: chain("standard") },
			premium: { chain: chain("premium"), thinking: "high" },
		},
	};
}

/**
 * Recommended pi settings (RESEARCH.md §5). Auto-compaction fires when
 * contextTokens > contextWindow − reserveTokens; per-model thresholds go in modelOverrides,
 * e.g. { "anthropic/<model>": { "reserveTokens": 80000 } } to compact 80k before the window ends.
 */
const PI_SETTINGS = {
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, modelOverrides: {} },
};

export async function init(argv, { root = process.cwd(), log = console.log } = {}) {
	const { values } = parseArgs({
		args: argv,
		options: { model: { type: "string" }, force: { type: "boolean" }, dir: { type: "string" } },
	});
	const dir = join(values.dir ?? root, ".pi");
	await mkdir(dir, { recursive: true });

	const files = [
		[join(dir, "shiftwork.json"), `${JSON.stringify(starterConfig(values.model), null, 2)}\n`],
		[join(dir, "shiftwork-worker.md"), WORKER_PROMPT],
	];
	for (const [path, content] of files) {
		if (existsSync(path) && !values.force) {
			log(`kept    ${path} (use --force to overwrite)`);
			continue;
		}
		await writeFile(path, content);
		log(`wrote   ${path}`);
	}

	const settingsPath = join(dir, "settings.json");
	const settings = existsSync(settingsPath) ? JSON.parse(await readFile(settingsPath, "utf8")) : {};
	if (settings.compaction && !values.force) {
		log(`kept    ${settingsPath} compaction settings`);
	} else {
		settings.compaction = { ...PI_SETTINGS.compaction, ...(values.force ? {} : settings.compaction) };
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		log(`updated ${settingsPath} (compaction; set per-model thresholds in compaction.modelOverrides)`);
	}
	if (!values.model) log('\nNext: replace the CHANGE-ME models in .pi/shiftwork.json (see "pi --list-models"), then "shiftwork run --dry-run".');
}
