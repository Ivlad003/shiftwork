import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectTracker, loadConfig, setSpecStatus } from "shiftwork-core";

/**
 * `shiftwork feature pause|resume <feature>`: the spec's Status line is the
 * feature's pause switch — `paused` keeps every ticket of the feature off the
 * frontier; `resume` sets the spec back to `ready-for-agent`. Only the spec's
 * Status line changes; the tickets are untouched.
 */
export async function featurePauseCommand({ root, action, feature, agentDir, log = console.log }) {
	// The config decides the tracker only: a broken model config doesn't block pausing.
	agentDir ??= process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	let config = {};
	try {
		config = await loadConfig(root, agentDir);
	} catch {}
	if ((await detectTracker(root, config)) !== "scratch") {
		throw new Error("pause is supported for .scratch features only");
	}
	if (!(await featureExists(join(root, ".scratch", feature)))) {
		throw new Error(`no feature ${feature} under .scratch/`);
	}
	await setSpecStatus(root, feature, action === "pause" ? "paused" : "ready-for-agent");
	log(action === "pause" ? `⏸ ${feature} paused: its tickets leave the frontier` : `▶ ${feature} resumed`);
}

/** A feature is known by its spec or its tickets: a bare or missing directory is not one. */
async function featureExists(featureDir) {
	try {
		await readFile(join(featureDir, "spec.md"), "utf8");
		return true;
	} catch {
		try {
			return (await readdir(join(featureDir, "issues"))).some((file) => file.endsWith(".md"));
		} catch {
			return false;
		}
	}
}
