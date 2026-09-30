/**
 * Rescale a context event to a profile window (`percent = tokens / contextWindow * 100`).
 * Leaves the event unchanged when the profile has no window or the event has no token count.
 */
export function applyProfileContext(event, contextWindow) {
	if (event?.type !== "context" || contextWindow == null || !(contextWindow > 0) || event.tokens == null) {
		return event;
	}
	return { ...event, percent: (event.tokens / contextWindow) * 100, contextWindow };
}

/**
 * Observe a shift's events against a budget and report soft/hard limits.
 * Pure: the clock is injected via `options.now`.
 */
export function createMeter(budget, softLimitPct = 80, { now = () => Date.now() } = {}) {
	const startAt = now();
	const state = {
		tokens: 0,
		costUsd: 0,
		turns: 0,
		wallMin: 0,
		contextPct: 0,
		stallTurns: 0,
		lastDiffStat: null,
		lastFailingOutput: null,
		softFired: new Set(),
		hardFired: new Set(),
	};

	const kinds = [
		["maxTokens", "tokens", (v) => v],
		["maxCostUsd", "costUsd", (v) => v],
		["maxTurns", "turns", (v) => v],
		["maxWallMin", "wallMin", (v) => v],
		["maxContextPct", "contextPct", (v) => v],
		["stallTurns", "stallTurns", (v) => v],
	];

	function observe(event) {
		if (event.type === "turn") {
			state.turns++;
			state.tokens += event.usage?.totalTokens ?? 0;
			state.costUsd += event.costUsd ?? 0;
		} else if (event.type === "cost") {
			// Some backends (Claude Code) report cost once, at the end of the shift.
			state.costUsd += event.costUsd ?? 0;
		} else if (event.type === "context") {
			state.contextPct = event.percent ?? 0;
		} else if (event.type === "diffStat" || event.type === "failingOutput") {
			const key = event.type === "diffStat" ? "lastDiffStat" : "lastFailingOutput";
			const snap = event.type === "diffStat" ? event.stat : event.output;
			const changed = snap !== state[key];
			state[key] = snap;
			state.stallTurns = changed ? 0 : state.stallTurns + 1;
		}
		state.wallMin = (now() - startAt) / 60_000;

		for (const [kind, key, read] of kinds) {
			if (state.hardFired.has(kind)) continue;
			const limit = budget?.[kind];
			if (limit === undefined || limit === null) continue;
			const current = read(state[key]);
			if (current >= limit) {
				state.hardFired.add(kind);
				return {
					level: "hard",
					kind,
					reason: `budget.${kind} (${formatCurrent(kind, current)} / ${formatLimit(kind, limit)})`,
					current,
					limit,
				};
			}
			// A stall is a clean break: no soft steer, just a fresh handoff at N.
			if (kind === "stallTurns") continue;
			const soft = (limit * softLimitPct) / 100;
			if (current >= soft && !state.softFired.has(kind)) {
				state.softFired.add(kind);
				return {
					level: "soft",
					kind,
					reason: `budget.${kind} soft limit (${formatCurrent(kind, current)} / ${formatLimit(kind, limit)})`,
					current,
					limit,
				};
			}
		}
		return null;
	}

	function snapshot() {
		return { ...state, softFired: new Set(state.softFired), hardFired: new Set(state.hardFired) };
	}

	return { observe, snapshot };
}

function formatCurrent(kind, value) {
	if (kind === "maxCostUsd") return `$${value.toFixed(4)}`;
	if (kind === "maxContextPct") return `${value.toFixed(1)}%`;
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(2);
}

function formatLimit(kind, value) {
	if (kind === "maxCostUsd") return `$${value}`;
	if (kind === "maxContextPct") return `${value}%`;
	return String(value);
}
