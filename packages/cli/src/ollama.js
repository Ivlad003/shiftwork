import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Ollama base URL: `OLLAMA_HOST`, default `http://localhost:11434`.
 * A bare `host:port` gets an `http://` scheme; trailing slashes are dropped.
 */
export function ollamaHost(env = process.env) {
	const raw = String(env.OLLAMA_HOST ?? "").trim() || "http://localhost:11434";
	const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
	return withScheme.replace(/\/+$/, "");
}

/**
 * Discover local models through Ollama's HTTP API:
 * `GET /api/tags` for the model list, `POST /api/show` for the context length.
 * @returns {Promise<Array<{id: string, contextWindow?: number}>>} throws when the server is unreachable
 */
export async function discoverOllamaModels(host) {
	const tags = await requestJson("GET", `${host}/api/tags`);
	const models = [];
	for (const model of tags.models ?? []) {
		if (!model?.name) continue;
		// A failed /api/show only costs the context window; the model itself stays.
		const show = await requestJson("POST", `${host}/api/show`, { model: model.name }).catch(() => null);
		const contextWindow = contextLength(show);
		models.push(contextWindow ? { id: model.name, contextWindow } : { id: model.name });
	}
	return models;
}

/** Context length from `/api/show`: the largest `*.context_length` key of `model_info`, or null. */
function contextLength(show) {
	const lengths = Object.entries(show?.model_info ?? {})
		.filter(([key, value]) => key.endsWith(".context_length") && Number.isFinite(Number(value)))
		.map(([, value]) => Number(value));
	return lengths.length ? Math.max(...lengths) : null;
}

async function requestJson(method, url, body) {
	const response = await fetch(url, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status}`);
	return response.json();
}

/**
 * Merge the `ollama` provider into pi's `<agentDir>/models.json` (a compatible endpoint,
 * following pi's docs/models.md example). Existing providers are kept; only `ollama` is replaced.
 * @returns {Promise<{path: string, count: number}>}
 */
export async function writeOllamaProvider(agentDir, host, models) {
	const path = join(agentDir, "models.json");
	const existing = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
	if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
		throw new Error(`${path}: not a JSON object`);
	}
	const config = { ...existing, providers: { ...existing.providers } };
	config.providers.ollama = {
		api: "openai-completions",
		baseUrl: `${host}/v1`,
		apiKey: "ollama",
		models: models.map(({ id, contextWindow }) => (contextWindow ? { id, contextWindow } : { id })),
	};
	await mkdir(agentDir, { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
	return { path, count: models.length };
}

/** The explanation printed when Ollama is unreachable: how to start it, and that nothing changed. */
export function ollamaUnavailableMessage(host, error) {
	const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
	return [
		`Ollama is not reachable at ${host}: ${reason}`,
		'Start it first ("ollama serve" or the Ollama desktop app), then re-run "shiftwork init --ollama".',
		"Nothing was changed.",
	].join("\n");
}
