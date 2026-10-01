import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WORKER_PROMPT } from "shiftwork-core";
import { discoverOllamaModels, ollamaHost, ollamaUnavailableMessage, writeOllamaProvider } from "./ollama.js";

/** A starter config: every tier gets `model` when given, otherwise CHANGE-ME placeholders. */
export function starterConfig(model) {
	const chain = (tier) => [model ?? `CHANGE-ME/${tier}-model`];
	return {
		defaultType: "code",
		thinking: "medium",
		maxAttempts: 3,
		maxHandoffs: 3,
		softLimitPct: 80,
		worktree: { enabled: true, setup: [] },
		routing: {
			git: { tier: "quick", thinking: "low" },
			docs: { tier: "quick", thinking: "low" },
			test: { tier: "standard" },
			code: { tier: "standard" },
			refactor: { tier: "premium" },
		},
		tiers: {
			quick: { chain: chain("quick"), thinking: "low", budget: { maxTurns: 40, maxContextPct: 60, stallTurns: 5 } },
			standard: { chain: chain("standard"), budget: { maxCostUsd: 1.5, maxTokens: 3_000_000 } },
			premium: { chain: chain("premium"), thinking: "high", budget: { maxCostUsd: 3, maxContextPct: 70 } },
		},
		budgets: {
			default: { maxTurns: 60, maxWallMin: 45, stallTurns: 8 },
			tiers: {},
			models: {},
			ticket: { maxCostUsd: 8, maxWallMin: 120 },
		},
		onExceed: {
			maxCostUsd: { to: "downgrade", mode: "same-process" },
			maxTokens: { to: "downgrade", mode: "same-process" },
			maxTurns: { to: "next", mode: "auto" },
			maxContextPct: { to: "same-tier", mode: "new-process" },
			stallTurns: { to: "escalate", mode: "new-process" },
			verifyFailed: { to: "escalate", mode: "new-process" },
			maxWallMin: { to: "next", mode: "new-process" },
		},
		cooldown: { rate: "15m", usage: "5h", quota: "24h", server: "5m" },
		crossTier: "none",
		allowInPlace: false,
		jev: {
			enabled: true,
			model: ["typesafe/jev-latest", "openrouter/typesafe/jev-1.13", "opencode/jev-1.13-free"],
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

export async function init(argv, { root = process.cwd(), log = console.log, env = process.env, agentDir } = {}) {
	const { values } = parseArgs({
		args: argv,
		options: { model: { type: "string" }, force: { type: "boolean" }, dir: { type: "string" }, ollama: { type: "boolean" } },
	});
	// Discover local models first: an unreachable Ollama explains itself and changes nothing.
	let ollama = null;
	if (values.ollama) {
		const host = ollamaHost(env);
		try {
			const models = await discoverOllamaModels(host);
			if (models.length === 0) {
				log(`Ollama at ${host} has no models installed; pull one with "ollama pull llama3.2", then re-run "shiftwork init --ollama".`);
				log("Nothing was changed.");
				return;
			}
			ollama = { host, models };
		} catch (error) {
			log(ollamaUnavailableMessage(host, error));
			return;
		}
	}
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
	if (ollama) {
		const target = agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		const provider = await writeOllamaProvider(target, ollama.host, ollama.models);
		log(`updated ${provider.path} (ollama provider: ${provider.count} models at ${ollama.host}/v1; other providers kept)`);

		const configPath = join(dir, "shiftwork.json");
		const config = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : starterConfig(values.model);
		config.tiers ??= {};
		config.tiers.local = {
			chain: ollama.models.map((m) => `ollama/${m.id}`),
			thinking: "low",
			// Local models cost nothing: no cost or token budgets, only turns, context fill and stalls.
			budget: { maxTurns: 40, maxContextPct: 60, stallTurns: 5 },
		};
		await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
		log(`updated ${configPath} (local tier: ${ollama.models.length} ollama models)`);
		log('route ticket types to local models with routing.<type>.tier: "local" in .pi/shiftwork.json');
	}
	log("handoffs start a fresh context by default; set allowInPlace: true in .pi/shiftwork.json to restore in-place swaps");
	log('every resolved ticket gets one review shift on the strongest configured tier; turn reviews off with "review": false or "shiftwork run --no-review"');
	if (!values.model) log('\nNext: replace the CHANGE-ME models in .pi/shiftwork.json (see "pi --list-models"), then "shiftwork run --dry-run".');
}
