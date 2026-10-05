import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const exec = (args, env = {}) =>
	promisify(execFile)(process.execPath, [bin, ...args], { env: { ...process.env, ...env } });

const agentDir = () => mkdtemp(join(tmpdir(), "sw-agent-"));
const repo = () => mkdtemp(join(tmpdir(), "sw-cli-"));

/**
 * A fake Ollama HTTP server: `GET /api/tags` lists the model names,
 * `POST /api/show` answers the context length from `model_info`.
 * A null length means "no context_length key" (the entry omits the window).
 */
function fakeOllama(models) {
	const server = createServer((req, res) => {
		const reply = (status, body) => {
			res.statusCode = status;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(body));
		};
		if (req.method === "GET" && req.url === "/api/tags") {
			reply(200, { models: Object.keys(models).map((name) => ({ name })) });
		} else if (req.method === "POST" && req.url === "/api/show") {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				const model = JSON.parse(body).model;
				const contextLength = models[model];
				reply(200, {
					model_info: contextLength
						? { "general.architecture": "llama", "llama.context_length": contextLength }
						: { "general.architecture": "llama" },
				});
			});
		} else {
			reply(404, {});
		}
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

/** A port with nothing listening on it: bind, note the port, close. */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

test("init --ollama writes the ollama provider into models.json with the right context windows, keeping other providers", async () => {
	const { server, port } = await fakeOllama({ "llama3.2:latest": 8192, "qwen2.5-coder:7b": 32768 });
	const dir = await agentDir();
	await writeFile(join(dir, "models.json"), JSON.stringify({
		providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "keep-me" } },
	}));
	const root = await repo();
	try {
		const { stdout } = await exec(["init", "--ollama", "--dir", root], {
			OLLAMA_HOST: `http://127.0.0.1:${port}`,
			PI_CODING_AGENT_DIR: dir,
		});
		assert.match(stdout, new RegExp(`ollama provider: 2 models at http://127\\.0\\.0\\.1:${port}/v1`));

		const modelsJson = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
		assert.deepEqual(modelsJson.providers.openrouter, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "keep-me" }, "other providers are kept");
		const provider = modelsJson.providers.ollama;
		assert.equal(provider.api, "openai-completions");
		assert.equal(provider.baseUrl, `http://127.0.0.1:${port}/v1`);
		assert.equal(provider.apiKey, "ollama");
		assert.deepEqual(provider.models, [
			{ id: "llama3.2:latest", contextWindow: 8192 },
			{ id: "qwen2.5-coder:7b", contextWindow: 32768 },
		]);

		const config = JSON.parse(await readFile(join(root, ".shiftwork", "shiftwork.json"), "utf8"));
		assert.deepEqual(config.tiers.local.chain, ["ollama/llama3.2:latest", "ollama/qwen2.5-coder:7b"]);
		assert.equal(config.tiers.quick.chain[0], "CHANGE-ME/quick-model", "the other tiers are untouched");
	} finally {
		server.close();
	}
});

test("init --ollama re-runs discovery and refreshes the local tier of an existing config", async () => {
	const { server, port } = await fakeOllama({ "llama3.2:latest": 8192 });
	const dir = await agentDir();
	const root = await repo();
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "shiftwork.json"), JSON.stringify({
		model: "mine/kept",
		defaultType: "code",
		tiers: { standard: { chain: ["mine/kept"] }, local: { chain: ["ollama/stale"] } },
	}));
	try {
		await exec(["init", "--ollama", "--dir", root], {
			OLLAMA_HOST: `http://127.0.0.1:${port}`,
			PI_CODING_AGENT_DIR: dir,
		});
		const config = JSON.parse(await readFile(join(root, ".pi", "shiftwork.json"), "utf8"));
		assert.equal(config.model, "mine/kept", "an existing config is kept");
		assert.deepEqual(config.tiers.standard.chain, ["mine/kept"]);
		assert.deepEqual(config.tiers.local.chain, ["ollama/llama3.2:latest"], "the local tier is refreshed");
	} finally {
		server.close();
	}
});

test("without a running server, init --ollama explains how to start Ollama and changes nothing", async () => {
	const port = await freePort();
	const dir = await agentDir();
	const root = await repo();

	const { stdout } = await exec(["init", "--ollama", "--dir", root], {
		OLLAMA_HOST: `http://127.0.0.1:${port}`,
		PI_CODING_AGENT_DIR: dir,
	});

	assert.match(stdout, /Ollama is not reachable at http:\/\/127\.0\.0\.1:\d+/);
	assert.match(stdout, /ollama serve/);
	assert.match(stdout, /Nothing was changed\./);
	assert.equal(existsSync(join(dir, "models.json")), false, "models.json is not created");
	assert.equal(existsSync(join(root, ".pi")), false, "no .pi directory is created");
	assert.equal(existsSync(join(root, ".shiftwork")), false, "no .shiftwork directory is created");
});
