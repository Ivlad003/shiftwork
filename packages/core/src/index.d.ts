export declare const VERSION: string;
export declare const READY: "ready-for-agent";
export declare const CLAIMED: "claimed";
export declare const RESOLVED: "resolved";

export interface Ticket {
	path: string;
	/** Spec of the feature, when it isn't the sibling spec.md of the mattpocock tracker (OpenSpec: proposal.md). */
	specPath?: string;
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
	/** Model of the latest shift report, when one exists. */
	lastRoute?: string;
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
	contextWindow?: number;
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
export declare function parseModelRef(ref: string): { backend: "pi" | "claude" | "codex" | "opencode" | "grok" | "cursor"; model: string; provider: string };
export declare function skillsForModel(
	model: string,
	config: Record<string, unknown>,
): { tier: string | undefined; skills: Route["skills"] };

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
	allowInPlace?: boolean;
	inPlaceHandoff?: boolean;
	contextTokens?: number;
	targetContextWindow?: number;
}): { mode: "same-process" | "new-process"; compact: boolean };
export interface Review {
	enabled: boolean;
	/** Tier the review shift runs on; required when enabled. */
	tier?: string;
	when?: "resolve";
	/** Feature names that get reviews; every feature when omitted. */
	features?: string[];
	/** Ticket types (the effective type) that get reviews; every type when omitted. */
	types?: string[];
}

/** Whether a resolved ticket gets one review shift on the review tier. */
export declare function shouldReview(config: { review?: Review } & Record<string, unknown>, ticket: { feature?: string; type?: string }): boolean;

export declare function resolveTicketBudget(ticket: Ticket, config: Record<string, unknown>): Budget;
export declare function loadConfig(root: string, userDir?: string): Promise<Record<string, unknown>>;
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

export declare function applyProfileContext(
  event: { type: string } & Record<string, unknown>,
  contextWindow?: number,
): { type: string } & Record<string, unknown>;

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

export declare function formatTicketsTable(tickets: Ticket[]): string;

export interface Tracker {
	list(): Promise<(Ticket & { feature: string })[]>;
	frontier(): Promise<(Ticket & { feature: string })[]>;
	claim(ticket: Ticket, options?: { pid?: number }): Promise<Claim | null>;
	release(claim: Claim): Promise<void>;
	activeClaims(): Promise<Claim[]>;
	setStatus(ticketOrClaim: Ticket | Claim, status: string): Promise<void>;
	appendComment(ticketOrClaim: Ticket | Claim, markdown: string): Promise<void>;
	/** Append a new ready ticket to a feature (follow-ups); optional for trackers that cannot. */
	createTicket?(feature: string, ticket: { title?: string; what?: string; type?: string; verify?: string[]; status?: string }): Promise<
		Ticket & { feature: string; created?: boolean }
	>;
}

export declare function openTracker(root: string): Tracker;

/** Tracker on an OpenSpec layout (`openspec/changes/<change>/tasks.md` + `.shiftwork.md`). */
export declare function openOpenSpecTracker(root: string, options?: { verify?: string[] }): Tracker;

/** The tracker of the repo: `config.tracker` when set, else auto-detected (`.scratch/` wins over `openspec/changes/`). */
export declare function openRepoTracker(root: string, config?: Record<string, unknown>): Promise<Tracker>;
export declare function detectTracker(root: string, config?: Record<string, unknown>): Promise<"scratch" | "openspec">;

/** Parse the numbered `- [ ] N.M title` tasks of an OpenSpec tasks.md, in file order. */
export declare function parseTasks(text: string): { done: boolean; number: string; title: string; verify: string[] }[];

export declare function openCooldowns(root: string): {
	path: string;
	active(now?: Date): Promise<Cooldown[]>;
	add(provider: string, until: Date | string, kind?: string): Promise<void>;
};

export interface RunState {
	pid?: number;
	running?: boolean;
	/** Whether the runner process that wrote this state is still alive. */
	live?: boolean;
	startedAt?: string;
	updatedAt?: string;
	finishedAt?: string | null;
	feature?: string | null;
	stoppedReason?: string | null;
	/** Where a detached runner's output goes, when something started it that way. */
	logFile?: string;
	ticket?: { feature?: string; number?: string; title?: string; path?: string } | null;
	attempt?: number;
	shift?: number;
	model?: string;
	thinking?: string | null;
	tier?: string | null;
	budget?: Budget | null;
	usage?: { tokens: number; costUsd: number; turns: number; contextPct: number };
	summary?: { resolved: number; needsInfo: number; reopened?: number };
}

export interface RunStateStore {
	path: string | undefined;
	read(): Promise<RunState | null>;
	update(patch: Partial<RunState>): Promise<void>;
	clear(): Promise<void>;
}

export declare function openRunState(root: string): RunStateStore;
export declare function noRunState(): RunStateStore;
