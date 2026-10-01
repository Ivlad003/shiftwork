/**
 * The `posted` keys the reconcile step records on an imported issue, built and
 * parsed in one place (github-sync, dark-factory's `describePost`, the
 * dashboard's `issueState`).
 *
 * - kind only: `working`, `summary`, `done`, `done-label`, `working-removed`
 * - kind + ticket: `started:02`, `resolved:02`
 * - kind + ticket + occurrence: `needs-info:02:1`, `replied:02:1`
 */

/** Build one `posted` key. `ticket` and `n` are omitted when not given. */
export function postKey(kind, ticket, n) {
	const parts = [kind];
	if (ticket !== undefined && ticket !== null) parts.push(ticket);
	if (n !== undefined && n !== null) parts.push(n);
	return parts.join(":");
}

/**
 * Read a `posted` key back: `{ kind, ticket?, n? }`. `n` is the occurrence
 * number (`needs-info` / `replied`); absent when the key has none.
 */
export function parsePostKey(key) {
	const [kind, ticket, n] = String(key ?? "").split(":");
	return {
		kind,
		...(ticket !== undefined && { ticket }),
		...(n !== undefined && n !== "" && { n: Number(n) }),
	};
}
