#!/usr/bin/env node
import { frontier, loadTickets, VERSION } from "shiftwork-core";

const [command = "help", dir = process.cwd()] = process.argv.slice(2);

async function status() {
	const tickets = await loadTickets(dir);
	if (tickets.length === 0) {
		console.log("No tickets found in .scratch/<feature>/issues/*.md");
		return;
	}
	const ready = new Set(frontier(tickets).map((t) => t.path));
	for (const t of tickets) {
		const mark = ready.has(t.path) ? "→" : " ";
		const blocked = t.blockedBy.length ? `  blocked by ${t.blockedBy.join(", ")}` : "";
		console.log(`${mark} ${t.feature}/${t.number}  [${t.status ?? "?"}]  ${t.title ?? ""}${blocked}`);
	}
	console.log(`\n${ready.size} ready of ${tickets.length} tickets (→ = frontier)`);
}

switch (command) {
	case "status":
		await status();
		break;
	case "-v":
	case "--version":
		console.log(VERSION);
		break;
	default:
		console.log(`shiftwork ${VERSION} — autonomous agents working in shifts

Usage:
  shiftwork status [dir]   List tickets and the frontier of ready ones
  shiftwork --version

The ticket runner (shiftwork run) is in development: https://github.com/Ivlad003/shiftwork`);
}
