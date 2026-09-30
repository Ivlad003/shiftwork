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

export interface TicketClassification {
	type: string;
	complexity?: string;
}

export interface Route {
	backend: string;
	type: string;
	typeSource?: "ticket" | "jev" | "default";
	tier?: string;
	model: string;
	thinking: string;
	skills: { paths: string[]; preload: string[]; warnings: string[]; restricted: boolean };
	budget: Budget;
	onExceed: Record<string, { to?: string; mode?: string }>;
}

export declare function parseTicket(markdown: string, path?: string): Ticket;
export declare function frontier<T extends Ticket>(tickets: T[]): T[];
export declare function loadTickets(root?: string): Promise<(Ticket & { feature: string })[]>;
export type Plan =
	| Route
	| { wait: Date }
	| { stop: string };

export declare function planShift(options: {
	ticket: Ticket;
	config: Record<string, unknown>;
	history?: Record<string, unknown>;
	cooldowns?: Cooldown[];
	now?: Date | number;
	classification?: TicketClassification | null;
}): Plan;
export declare const TIER_ORDER: readonly string[];

export type LimitKind = "rate" | "usage" | "quota" | "server";

export declare function classifyError(
	message: string,
	headers?: Record<string, string | number>,
	now?: Date | number,
): null | { kind: LimitKind; resetAt?: Date };

export declare function cooldownMs(config: Record<string, unknown> | undefined, kind: LimitKind): number;
export declare const DEFAULT_COOLDOWN_MS: Record<LimitKind, number>;
export declare function chooseHandoffMode(options: {
	mode?: "same-process" | "new-process" | "auto";
	kind: string;
	inPlaceHandoff?: boolean;
	contextTokens?: number;
	targetContextWindow?: number;
}): { mode: "same-process" | "new-process"; compact: boolean };
export declare function resolveTicketBudget(ticket: Ticket, config: Record<string, unknown>): Budget;
export declare function validateConfig(input: Record<string, unknown>): Record<string, unknown>;
export declare const THINKING_LEVELS: readonly string[];

export interface Budget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxTurns?: number;
  maxWallMin?: number;
  maxContextPct?: number;
  stallTurns?: number;
}

export interface Limit {
  level: "soft" | "hard";
  kind: keyof Budget;
  reason: string;
  current: number;
  limit: number;
}

export declare function createMeter(
  budget: Budget,
  softLimitPct?: number,
  options?: { now?: () => number }
): {
  observe(event: { type: string } & Record<string, unknown>): Limit | null;
  snapshot(): {
    tokens: number;
    costUsd: number;
    turns: number;
    wallMin: number;
    contextPct: number;
    stallTurns: number;
    lastDiffStat: string | null;
    lastFailingOutput: string | null;
    softFired: Set<string>;
    hardFired: Set<string>;
  };
};

export interface Claim {
	ticket: Ticket;
	pid: number;
	token: string;
	at: string;
}

export interface Cooldown {
	provider: string;
	until: string;
	kind?: string;
}

export declare function openTracker(root: string): {
	list(): Promise<(Ticket & { feature: string })[]>;
	frontier(): Promise<(Ticket & { feature: string })[]>;
	claim(ticket: Ticket, options?: { pid?: number }): Promise<Claim | null>;
	release(claim: Claim): Promise<void>;
	activeClaims(): Promise<Claim[]>;
	setStatus(ticketOrClaim: Ticket | Claim, status: string): Promise<void>;
	appendComment(ticketOrClaim: Ticket | Claim, markdown: string): Promise<void>;
};

export declare function openCooldowns(root: string): {
	path: string;
	active(now?: Date): Promise<Cooldown[]>;
	add(provider: string, until: Date | string, kind?: string): Promise<void>;
};
