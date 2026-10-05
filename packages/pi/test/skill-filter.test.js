import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const scripted = fileURLToPath(new URL("../../cli/test/fixtures/scripted-provider.ts", import.meta.url));
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const piCli = join(piRoot, JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).bin.pi);

const clients = [];
after(async () => {
	for (const client of clients) await client.stop().catch(() => {});
});

async function startPi({ config, model = "scripted/s1" }) {
	const cwd = await mkdtemp(join(tmpdir(), "sw-pi-skills-"));
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-home-"));
	const alpha = join(cwd, "skills", "alpha");
	const beta = join(cwd, "skills", "beta");
	await mkdir(alpha, { recursive: true });
	await mkdir(beta, { recursive: true });
	await writeFile(join(alpha, "SKILL.md"), "---\nname: alpha\ndescription: Alpha skill\n---\nAlpha body.");
	await writeFile(join(beta, "SKILL.md"), "---\nname: beta\ndescription: Beta skill\n---\nBeta body.");
	await mkdir(join(cwd, ".shiftwork"), { recursive: true });
	await writeFile(join(cwd, ".shiftwork", "shiftwork.json"), `${JSON.stringify(config({ alpha, beta }), null, 2)}\n`);

	const client = new RpcClient({
		cliPath: piCli,
		cwd,
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			SHIFTWORK_SCRIPT: JSON.stringify([{ text: "one" }, { text: "two" }]),
			SHIFTWORK_RECORD_SKILLS: "1",
		},
		model,
		args: [
			"--no-session",
			"--offline",
			"--thinking",
			"off",
			"-ne",
			"-ns",
			"--skill",
			alpha,
			"--skill",
			beta,
			"-e",
			extension,
			"-e",
			scripted,
		],
	});
	clients.push(client);
	const ui = [];
	client.onEvent((event) => {
		if (event.type === "extension_ui_request") ui.push(event);
	});
	await client.start();
	return { client, cwd, ui };
}

async function advertised(cwd) {
	const path = join(cwd, "shiftwork-skills.json");
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")).skills;
}

test("switching the model changes the advertised skills", { timeout: 90_000 }, async () => {
	const { client, cwd } = await startPi({
		config: ({ alpha, beta }) => ({
			thinking: "off",
			model: "scripted/s1",
			tiers: {
				quick: { chain: ["scripted/s1"], skills: ["core"] },
				standard: { chain: ["scripted/s2"], skills: ["core", "extra"] },
			},
			skillGroups: { core: ["alpha"], extra: ["beta"] },
			skillSources: { alpha, beta },
		}),
	});

	// Subscribed before the prompt goes out: a fast agent may settle before prompt() returns.
	await client.promptAndWait("hello", undefined, 60_000);
	assert.deepEqual(await advertised(cwd), ["alpha"]);

	await client.setModel("scripted", "s2");
	// Subscribed before the prompt goes out: a fast agent may settle before prompt() returns.
	await client.promptAndWait("again", undefined, 60_000);
	assert.deepEqual(await advertised(cwd), ["alpha", "beta"]);
});

test("a model without a tier leaves skills untouched", { timeout: 90_000 }, async () => {
	const { client, cwd, ui } = await startPi({
		config: () => ({ thinking: "off", model: "scripted/s1" }),
	});

	// Subscribed before the prompt goes out: a fast agent may settle before prompt() returns.
	await client.promptAndWait("hello", undefined, 60_000);
	assert.deepEqual(await advertised(cwd), ["alpha", "beta"]);

	const notify = ui.find((r) => r.method === "notify" && /not in any tier/.test(r.message));
	assert.ok(notify, "expected a one-time notice that the model has no tier");
	assert.match(notify.message, /scripted\/s1/);
});
