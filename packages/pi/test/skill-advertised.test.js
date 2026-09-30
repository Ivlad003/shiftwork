import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const piPkg = fileURLToPath(new URL("..", import.meta.url)); // the package root: manifest + skills
const scripted = fileURLToPath(new URL("../../cli/test/fixtures/scripted-provider.ts", import.meta.url));
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const piCli = join(piRoot, JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).bin.pi);

const clients = [];
after(async () => {
	for (const client of clients) await client.stop().catch(() => {});
});

test("loading the pi-shiftwork package advertises the shiftwork skill", { timeout: 90_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-pi-skill-"));
	const agentDir = await mkdtemp(join(tmpdir(), "sw-pi-home-"));
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		join(cwd, ".pi", "shiftwork.json"),
		JSON.stringify({ thinking: "off", model: "scripted/s1" }),
		"utf8",
	);

	const client = new RpcClient({
		cliPath: piCli,
		cwd,
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			SHIFTWORK_SCRIPT: JSON.stringify([{ text: "one" }]),
			SHIFTWORK_RECORD_SKILLS: "1",
		},
		model: "scripted/s1",
		args: ["--no-session", "--offline", "--thinking", "off", "-e", piPkg, "-e", scripted],
	});
	clients.push(client);

	await client.start();
	await client.prompt("hello");
	await client.waitForIdle(60_000);

	const recorded = join(cwd, "shiftwork-skills.json");
	assert.ok(existsSync(recorded), "the scripted provider recorded the advertised skills");
	const { skills } = JSON.parse(readFileSync(recorded, "utf8"));
	assert.ok(
		skills.includes("shiftwork"),
		`the pi-shiftwork package advertises the shiftwork skill (advertised: ${skills.join(", ")})`,
	);
});
