export declare const VERSION: string;
export declare const READY: "ready-for-agent";
export declare const CLAIMED: "claimed";
export declare const RESOLVED: "resolved";

export interface Ticket {
	path: string;
	feature?: string;
	number?: string;
	title?: string;
	status?: string;
	blockedBy: string[];
	type?: string;
	model?: string;
	skills: string[];
	budget?: string;
	verify: string[];
	checkboxes: { done: boolean; text: string }[];
}

export interface Route {
	backend: string;
	type: string;
	tier?: string;
	model: string;
	thinking: string;
	skills: { paths: string[]; preload: string[]; warnings: string[] };
}

export declare function parseTicket(markdown: string, path?: string): Ticket;
export declare function frontier<T extends Ticket>(tickets: T[]): T[];
export declare function loadTickets(root?: string): Promise<(Ticket & { feature: string })[]>;
export declare function planShift(options: { ticket: Ticket; config: Record<string, unknown> }): Route;
export declare function validateConfig(input: Record<string, unknown>): Record<string, unknown>;
export declare const THINKING_LEVELS: readonly string[];
