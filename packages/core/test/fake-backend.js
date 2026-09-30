import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A scripted backend. Each call to startShift consumes the next script entry:
 * { files?: {relPath: content}, text?: string, error?: string, usage?: {input, output}, costUsd?: number }
 */
export function fakeBackend(script) {
	const shifts = [];
	return {
		name: "fake",
		shifts,
		async startShift(request) {
			const step = script[shifts.length] ?? { text: "Nothing to do." };
			shifts.push({ request, step });
			for (const [rel, content] of Object.entries(step.files ?? {})) {
				await writeFile(join(request.cwd, rel), content);
			}
			const events = [];
			const usage = step.usage ?? { input: 100, output: 20 };
			events.push({ type: "turn", usage: { ...usage, totalTokens: usage.input + usage.output }, costUsd: step.costUsd ?? 0.01 });
			if (step.text) events.push({ type: "text", text: step.text });
			if (step.error) events.push({ type: "error", message: step.error });
			events.push({ type: "end", stopReason: step.error ? "error" : "stop" });
			return {
				capabilities: { inPlaceHandoff: false },
				events: (async function* () {
					yield* events;
				})(),
				warnings: step.warnings ?? [],
				async steer() {},
				async abort() {},
			};
		},
	};
}

/** Verify adapter that treats each command as a file that must exist in cwd. */
export function fileVerify() {
	return async (commands, cwd) => {
		const { access } = await import("node:fs/promises");
		const results = [];
		for (const cmd of commands) {
			const ok = await access(join(cwd, cmd)).then(
				() => true,
				() => false,
			);
			results.push({ cmd, code: ok ? 0 : 1, outputTail: ok ? "" : `${cmd}: missing` });
			if (!ok) return { ok: false, results };
		}
		return { ok: true, results };
	};
}
