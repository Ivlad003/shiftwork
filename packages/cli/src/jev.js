import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { locatePi } from "./pi-backend.js";

const TYPE_CRITERIA = {
	git: "Git chores: commits, branches, rebases, merges, worktrees",
	docs: "Documentation, comments, README, or other prose",
	test: "Adding or fixing tests only",
	code: "Implementation, features, or bug fixes in application code",
	refactor: "Restructuring existing code without changing behaviour",
};

/** Models to try, in order. `jev.model` may be a string or a list. */
export function jevModels(config) {
	const model = config?.jev?.model ?? "typesafe/jev-latest";
	return (Array.isArray(model) ? model : [model]).filter((id) => typeof id === "string" && id.includes("/"));
}

/**
 * Classifier adapter: `classify(ticket) → { type, complexity } | null`.
 * `null` on any failure. Inject `classify(modelId, context)` so tests stay offline.
 */
export function createJevClassifier(options = {}) {
	let runtimePromise;
	return async function classifyTicket(ticket) {
		if (options.config?.jev?.enabled === false) return null;
		const models = jevModels(options.config);
		if (models.length === 0) return null;
		const context = await buildContext(ticket, options.config);
		for (const modelId of models) {
			try {
				const result = options.classify
					? await options.classify(modelId, context)
					: await classifyLive(await loadRuntime(), modelId, context);
				const parsed = parseClassification(result);
				if (parsed) return parsed;
			} catch {
				// try the next configured model
			}
		}
		return null;
	};

	function loadRuntime() {
		runtimePromise ??= createRuntime(options);
		return runtimePromise;
	}
}

async function createRuntime(options) {
	const pi = locatePi({ root: options.piRoot ?? options.config?.pi?.root });
	const { ModelRuntime } = await import(pathToFileURL(pi.index).href);
	const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return ModelRuntime.create({
		refreshOnCreate: false,
		allowModelNetwork: false,
		authPath: join(agentDir, "auth.json"),
	});
}

async function classifyLive(runtime, modelId, context) {
	const slash = modelId.indexOf("/");
	const provider = slash === -1 ? modelId : modelId.slice(0, slash);
	const id = slash === -1 ? modelId : modelId.slice(slash + 1);
	const model = runtime.getModelOfType("classifier", provider, id);
	if (!model) return { stopReason: "error", errorMessage: `classifier ${modelId} not in catalog` };
	return runtime.classify(model, context);
}

export function parseClassification(result) {
	if (!result || result.stopReason !== "stop" || !result.answers) return null;
	const type = choice(result.answers.type);
	if (!type) return null;
	return { type, complexity: choice(result.answers.complexity) ?? "standard" };
}

function choice(answer) {
	return answer?.type === "choice" && typeof answer.choice === "string" ? answer.choice : undefined;
}

async function buildContext(ticket, config) {
	const task = (await ticketText(ticket)).slice(0, 16_000);
	return {
		state: { task },
		questions: {
			type: {
				type: "choice",
				instructions: "What kind of software work is this ticket?",
				criteria: typeCriteria(config),
			},
			complexity: {
				type: "choice",
				instructions: "How demanding is this ticket?",
				criteria: {
					standard: "Ordinary, well-scoped work",
					complex: "Subtle design, cross-cutting changes, or hard debugging",
				},
			},
		},
	};
}

function typeCriteria(config) {
	const keys = Object.keys(config?.routing ?? {});
	const out = {};
	for (const key of keys.length ? keys : Object.keys(TYPE_CRITERIA)) {
		out[key] = TYPE_CRITERIA[key] ?? `Work of type "${key}"`;
	}
	return out;
}

async function ticketText(ticket) {
	if (ticket?.path) {
		try {
			return await readFile(ticket.path, "utf8");
		} catch {}
	}
	const parts = [ticket?.title, ...(ticket?.checkboxes ?? []).map((c) => c.text)].filter(Boolean);
	return parts.join("\n") || "Untitled ticket";
}
