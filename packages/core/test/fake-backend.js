import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A scripted backend. Each call to startShift consumes the next script entry:
 * {
 *   files?: {relPath: content},
 *   text?: string,
 *   error?: string,
 *   usage?: {input, output},
 *   costUsd?: number,
 *   events?: event[],     // full event sequence; if omitted, a single turn + optional text/error + end is emitted
 *   steer?: (text) => string | undefined, // text to append when the runner steers
 *   inPlaceHandoff?: boolean,
 *   afterSwap?: { files?, events? }, // consumed by swapModel; remaining queued events are replaced
 *   contextWindows?: { [model]: number },
 * }
 */
export function fakeBackend(script) {
	const shifts = [];
	return {
		name: "fake",
		shifts,
		async startShift(request) {
			const step = script[shifts.length] ?? { text: "Nothing to do." };
			const record = { request, step, aborted: false, swaps: [], compactions: [] };
			shifts.push(record);
			for (const [rel, content] of Object.entries(step.files ?? {})) {
				await writeFile(join(request.cwd, rel), content);
			}
			let queue = [];
			if (step.events) {
				queue = step.events.map((e) => ({ ...e }));
			} else {
				const usage = step.usage ?? { input: 100, output: 20 };
				queue.push({ type: "turn", usage: { ...usage, totalTokens: usage.input + usage.output }, costUsd: step.costUsd ?? 0.01 });
				if (step.text) queue.push({ type: "text", text: step.text });
				if (step.error) queue.push({ type: "error", message: step.error });
				queue.push({ type: "end", stopReason: step.error ? "error" : "stop" });
			}
			let aborted = false;
			const inPlace = Boolean(step.inPlaceHandoff);
			const shift = {
				capabilities: { inPlaceHandoff: inPlace },
				events: (async function* () {
					while (queue.length) {
						if (aborted) break;
						yield queue.shift();
					}
				})(),
				warnings: step.warnings ?? [],
				async steer(text) {
					if (step.steer) {
						const reply = await step.steer(text);
						if (reply) queue.push({ type: "text", text: reply });
					}
				},
				async abort() {
					aborted = true;
					record.aborted = true;
				},
			};
			if (inPlace) {
				shift.swapModel = async (model, thinking) => {
					record.swaps.push({ model, thinking });
					const next = step.afterSwap ?? {};
					for (const [rel, content] of Object.entries(next.files ?? {})) {
						await writeFile(join(request.cwd, rel), content);
					}
					queue = (next.events ?? [{ type: "end", stopReason: "stop" }]).map((e) => ({ ...e }));
				};
				shift.compact = async (instructions) => {
					record.compactions.push(instructions);
				};
				shift.contextWindow = async (model) => step.contextWindows?.[model];
			}
			return shift;
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
