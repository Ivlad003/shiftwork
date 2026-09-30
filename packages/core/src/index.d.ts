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

export declare function parseTicket(markdown: string, path?: string): Ticket;
export declare function frontier<T extends Ticket>(tickets: T[]): T[];
export declare function loadTickets(root?: string): Promise<(Ticket & { feature: string })[]>;
