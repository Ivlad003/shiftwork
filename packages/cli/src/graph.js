import { parseArgs } from "node:util";
import { loadTickets, READY, RESOLVED } from "shiftwork-core";

import { blockerCycles, resolveTrackerRoot } from "./tickets-check.js";

/** Status → Mermaid class; anything else is `other`. */
const CLASSES = new Map([
	[RESOLVED, "resolved"],
	[READY, "ready"],
	["needs-info", "needsinfo"],
	["claimed", "claimed"],
]);

const CLASS_DEFS = [
	"classDef resolved fill:#d4edda,stroke:#28a745,color:#155724",
	"classDef ready fill:#cce5ff,stroke:#0366d6,color:#004085",
	"classDef needsinfo fill:#fff3cd,stroke:#d39e00,color:#856404",
	"classDef claimed fill:#e2d9f3,stroke:#6f42c1,color:#3d2370",
	"classDef other fill:#f1f3f5,stroke:#6c757d,color:#343a40",
	"classDef missing fill:#ffffff,stroke:#d73a49,color:#d73a49,stroke-dasharray:5 5",
];

/** Mermaid entity codes, so any title renders inside a quoted label. */
const escape = (text) =>
	String(text ?? "").replace(/["[\]<>]/g, (c) => ({ '"': "#quot;", "[": "#91;", "]": "#93;", "<": "#lt;", ">": "#gt;" })[c]);

const byNumber = (a, b) => Number(a) - Number(b);

/**
 * A feature's tickets and `Blocked by` edges as a Mermaid flowchart.
 *
 * One node per ticket (`t03["03 Title · ready"]`, classed by status), one edge
 * per blocker from blocker to blocked (`t02 --> t03`), a missing blocker as a
 * dashed `t07["07 missing"]` node, and edges on a blocker cycle (or a self-block)
 * as `-.->|cycle|`.
 *
 * @param {{ feature?: string, number?: string, title?: string, status?: string, blockedBy: string[] }[]} tickets
 * @param {string} feature
 * @returns {string} Mermaid text (no trailing newline)
 */
export function featureGraph(tickets, feature) {
	const own = tickets.filter((t) => t.feature === feature && t.number).sort((a, b) => byNumber(a.number, b.number));
	const numbers = new Set(own.map((t) => t.number));
	const { selfBlocked, cycles } = blockerCycles(own);
	// Cycle paths run blocked → blocker; mark each such hop.
	const cycleHops = new Set(selfBlocked.map((n) => `${n}>${n}`));
	for (const cycle of cycles) for (let i = 0; i < cycle.length - 1; i++) cycleHops.add(`${cycle[i]}>${cycle[i + 1]}`);

	const rows = ["flowchart TD"];
	for (const t of own) {
		const status = t.status === READY ? "ready" : (t.status ?? "no status");
		rows.push(`  t${t.number}["${t.number} ${escape(t.title)} · ${escape(status)}"]:::${CLASSES.get(t.status) ?? "other"}`);
	}
	const missing = [...new Set(own.flatMap((t) => t.blockedBy).filter((n) => !numbers.has(n)))].sort(byNumber);
	for (const n of missing) rows.push(`  t${n}["${n} missing"]:::missing`);

	const edges = own.flatMap((t) => [...new Set(t.blockedBy)].map((blocker) => ({ blocker, blocked: t.number })));
	edges.sort((a, b) => byNumber(a.blocker, b.blocker) || byNumber(a.blocked, b.blocked));
	for (const { blocker, blocked } of edges) {
		const arrow = cycleHops.has(`${blocked}>${blocker}`) ? "-.->|cycle|" : "-->";
		rows.push(`  t${blocker} ${arrow} t${blocked}`);
	}
	for (const line of CLASS_DEFS) rows.push(`  ${line}`);
	return rows.join("\n");
}

/**
 * `shiftwork graph <feature> [--dir <path>]`: print the feature's graph to
 * stdout, cycle problems to stderr. Read-only.
 *
 * @returns {Promise<number>} exit code: 0, or 1 when the feature has no tickets
 */
export async function graph(argv) {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { dir: { type: "string" } },
	});
	const feature = positionals[0];
	if (!feature) throw new Error("usage: shiftwork graph <feature> [--dir <path>]");
	const tickets = (await loadTickets(await resolveTrackerRoot({ dir: values.dir }))).filter((t) => t.feature === feature);
	if (!tickets.length) {
		console.error(`${feature}: no tickets found`);
		return 1;
	}
	console.log(featureGraph(tickets, feature));
	const { selfBlocked, cycles } = blockerCycles(tickets);
	for (const number of selfBlocked) console.error(`${feature}/${number}: blocked by itself`);
	for (const cycle of cycles) console.error(`${feature}: blocker cycle ${cycle.join(" → ")}`);
	return 0;
}
