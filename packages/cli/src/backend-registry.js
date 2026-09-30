import { parseModelRef } from "shiftwork-core";
import { createClaudeBackend } from "./claude-backend.js";
import { createCodexBackend } from "./codex-backend.js";
import { createOpencodeBackend } from "./opencode-backend.js";
import { createPiBackend } from "./pi-backend.js";

/**
 * Backend registry: resolves a model reference to the right adapter.
 * Options: { pi?: object, claude?: object, codex?: object, opencode?: object, grok?: object, cursor?: object }
 */
export function createBackend(options = {}) {
	const adapters = {
		pi: createPiBackend(options.pi ?? {}),
		claude: createClaudeBackend(options.claude ?? {}),
		codex: createCodexBackend(options.codex ?? {}),
		opencode: createOpencodeBackend(options.opencode ?? {}),
	};

	return {
		name: "registry",
		adapters,

		probe(model) {
			const ref = parseModelRef(model);
			const adapter = adapters[ref.backend];
			if (!adapter) return false;
			if (typeof adapter.probe !== "function") return true;
			return adapter.probe(ref.model);
		},

		async startShift(request) {
			const backend = request.route.backend;
			const adapter = adapters[backend];
			if (!adapter) {
				return unavailableShift(`unknown backend: ${backend}`);
			}
			return adapter.startShift(request);
		},
	};
}

function unavailableShift(reason) {
	const events = [];
	return {
		capabilities: { inPlaceHandoff: false },
		events: (async function* () {
			yield { type: "error", message: reason };
			yield { type: "end", stopReason: "error" };
		})(),
		warnings: [reason],
		async abort() {},
		async close() {},
	};
}
