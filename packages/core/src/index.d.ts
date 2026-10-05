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
	/** True when the feature's spec.md Status is `paused`: the ticket is kept off the frontier. */
	featurePaused?: boolean;
	blockedBy: string[];
	type?: string;
	model?: string;
	skills: string[];
	budget?: string;
	/** `**Dual:** yes|no`: the ticket's own opt-in to (or out of) dual shifts; absent when the line is. */
	dual?: string;
	verify: string[];
	/** `**Frozen:**` globs: paths this ticket's shifts may not change; `[]` when the line is absent. */
	frozen: string[];
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
	/** Model id as the backend takes it, without the `claude:`/`codex:`/… prefix. */
	model: string;
	/** The model as written in the config or ticket, prefix included: `claude:sonnet`, `anthropic/claude-sonnet-4-5`. */
	ref: string;
	/** Provider part of the model reference (`anthropic` for `anthropic/claude-sonnet-4-5`); the cooldown key's provider. */
	provider: string;
	thinking: string;
	skills: { paths: string[]; preload: string[]; warnings: string[]; restricted: boolean };
	budget: Budget;
	onExceed: Record<string, { to?: string; mode?: string }>;
	contextWindow?: number;
}

export declare function parseTicket(markdown: string, path?: string): Ticket;
export declare function frontier<T extends Ticket>(tickets: T[]): T[];
/**
 * The order the frontier is worked, feature by feature: the `current` feature
 * first, then started features (a `resolved` or `claimed` ticket) before not
 * started ones, then feature name, then ticket number. Pure.
 */
export declare function orderFrontier<T extends Ticket>(frontier: T[], tickets: T[], options?: { current?: string | null }): T[];
export declare function loadTickets(root?: string): Promise<(Ticket & { feature: string })[]>;
/** Every candidate model is cooling or its provider is full: re-plan at `wait`. */
export interface PlanWait {
	wait: Date;
}
/** No eligible model is left (e.g. every model excluded as stalled): `stop` says why. */
export interface PlanStop {
	stop: string;
}
export type Plan = Route | PlanWait | PlanStop;

export declare function planShift(options: {
	ticket: Ticket;
	config: Record<string, unknown>;
	history?: Record<string, unknown>;
	cooldowns?: Cooldown[];
	now?: Date | number;
	classification?: TicketClassification | null;
	/** Providers at their `concurrency` cap: skipped like cooling ones, without a cooldown. */
	fullProviders?: string[];
}): Plan;
/**
 * The key a provider limit cools: the model ref itself for free models (`…:free`), else its provider.
 */
export declare function cooldownKey(ref: string): string;
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
	/** Tier the review shift runs on; the strongest configured tier by default. */
	tier?: string;
	/** Where the review shift runs: on the ticket's unlanded branch, before anything lands (the default), or after the ticket lands. `"resolve"` is `"after-land"`'s old name, still accepted. */
	when?: "before-land" | "after-land" | "resolve";
	/** Reopen verdicts a before-land review allows on one ticket before it goes to needs-info with the branch kept (default 2). */
	maxRounds?: number;
	/** Why reviews are off despite being on by default: no tier to review on. */
	reason?: string;
	/** Feature names that get reviews; every feature when omitted. */
	features?: string[];
	/** Ticket types (the effective type) that get reviews; every type when omitted. */
	types?: string[];
	/** The review shift's whole budget (`{ maxWallMin: 20, maxTurns: 60 }` by default): ticket, tier and model budgets never cap it, and no `unlimited` list lifts it — only `review.budget` itself does (a `null` field lifts that field's default). */
	budget?: Budget;
}

/** Whether a resolved ticket gets one review shift on the review tier. */
export declare function shouldReview(config: { review?: Review } & Record<string, unknown>, ticket: { feature?: string; type?: string }): boolean;
/** `dual`: two worker shifts on one ticket, on two models in two worktrees, then a merge shift (ADR-0007). */
export interface Dual {
	enabled: boolean;
	/** Ticket types (the routed type) that get dual shifts; every type when omitted. */
	types?: string[];
	/** Feature names that get dual shifts; every feature when omitted. */
	features?: string[];
	/** The two candidates' models, A then B. Without `models` or `tiers`, B is the ticket's next route on another provider. */
	models?: [string, string];
	/** The two candidates' tiers, A then B. */
	tiers?: [string, string];
	/** Tier of the merge shift; the review tier by default, else candidate A's tier. */
	mergeTier?: string;
	/** The merge shift's budget; the merge tier's budget when omitted. */
	budget?: Budget;
}

/** Whether a ticket gets dual shifts: its own `**Dual:** yes|no` line wins, else `dual.enabled` and its filters. */
export declare function shouldDual(config: { dual?: Dual } & Record<string, unknown>, ticket: { feature?: string; type?: string; dual?: string }): boolean;
/** Where the review shift runs: "before-land" (the default) or "after-land" ("resolve" reads as it). */
export declare function reviewWhen(config: { review?: Review } & Record<string, unknown>): "before-land" | "after-land";

export interface GitHubLabels {
	/** The label that hands an issue to Shiftwork; required in every `github` block. */
	in: string;
	/** Label set while a ticket of the issue is being worked. */
	working: string;
	/** Label set when Shiftwork needs information from a collaborator. */
	needsInfo: string;
	/** Label set when every ticket of the issue is resolved. */
	done: string;
}

/** The `github` block of `.shiftwork/shiftwork.json`: the dark-factory watcher's source repo and behavior. */
export interface GitHub {
	/** `owner/name`; the `origin` remote when omitted. */
	repo?: string;
	/** Extra logins whose issues are imported, on top of repo collaborators. */
	authors?: string[];
	labels?: GitHubLabels;
	/** Minutes between polls of the repo's issues. */
	pollMin: number;
	/** Close the GitHub issue when every ticket of it is resolved. */
	autoClose: boolean;
	/** Push main after a landing so commit links in comments resolve. */
	push: boolean;
	/** Tier the planning ticket runs on; any configured tier when omitted. */
	planTier?: string;
	/** Path to the `gh` binary (the operator's installed GitHub CLI); `gh` on PATH when omitted. */
	gh?: string;
}

export declare function resolveTicketBudget(ticket: Ticket, config: Record<string, unknown>): Budget;
/** The backend names a model reference can name, `pi` included: the keys of a `backends` config section. */
export declare const BACKENDS: readonly ["pi", "claude", "codex", "opencode", "grok", "cursor"];
/**
 * The `unlimited` lists that apply to a route: the union of the top-level, tier
 * (`tiers.<tier>`), model profile (`models.<ref>`) and backend (`backends.<backend>`)
 * lists, short names normalized to budget fields. A route with no model (a wait/stop
 * plan, or none given) gets only the top-level list. Works with raw, unvalidated configs.
 */
export declare function liftedFor(
	route: { ref?: string; model?: string; tier?: string } | undefined | null,
	config: Record<string, unknown>,
): Array<keyof Budget>;
/** The validated `.shiftwork/shiftwork.json`: the knobs typed where the runner reads them; the rest stays `Record<string, unknown>`. */
export interface ShiftworkConfig extends Record<string, unknown> {
	/** Rebase-and-reverify rounds a landing takes while a parallel landing keeps moving the target (default 5). */
	landRetries: number;
	/** Provider-limit shifts in a row one ticket may take before it goes to needs-info (default 10). */
	maxLimitRetries: number;
	/** Frozen-path globs for every ticket, added to each ticket's own `**Frozen:**` list (default []). */
	frozen: string[];
}
export declare function loadConfig(root: string, userDir?: string): Promise<ShiftworkConfig>;
export declare function validateConfig(input: Record<string, unknown>): ShiftworkConfig;
export declare const THINKING_LEVELS: readonly string[];
/** Short budget-limit names (`tokens`, `cost`, `turns`, `time`, `context`, `stall`) → budget fields. */
export declare const LIMIT_NAMES: Readonly<Record<string, keyof Budget>>;
/** Default names of the labels Shiftwork itself sets on a GitHub issue. */
export declare const GITHUB_LABEL_DEFAULTS: Readonly<Record<"working" | "needsInfo" | "done", string>>;
/** The error for a `github` block without `labels.in`: required, never silently defaulted. */
export declare const GITHUB_LABELS_IN_REQUIRED: string;
/** Short budget-limit name, as `unlimited` lists take it. */
export type LimitName = "tokens" | "cost" | "turns" | "time" | "context" | "stall";
/**
 * `unlimited`: lift every budget limit (`true`) or only these. Accepted at the top level,
 * on a tier (`tiers.<name>.unlimited`), on a model profile (`models.<ref>.unlimited`) and
 * on a backend (`backends.<name>.unlimited`). Tier, model and backend lists lift every
 * limit for that route, the ticket budget included; the top-level list lifts them all.
 */
export type Unlimited = boolean | Array<LimitName | keyof Budget>;
/** `unlimited` (true or a list of limit names) → the budget fields it lifts. */
export declare function normalizeUnlimited(value: Unlimited | undefined, path?: string): Array<keyof Budget>;

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
	/** The claim file: `.scratch/.claims/<feature>--<NN>.lock` (OpenSpec: `openspec/.claims/`). */
	path: string;
	pid: number;
	token: string;
	at: string;
}

export interface Cooldown {
	/** The cooled key: a provider, or a free model's own ref (see `cooldownKey`). */
	provider: string;
	until: string;
	kind?: string;
	/** When the cooldown was written (ISO). */
	at?: string;
	/** True when the provider gave the end time; a guessed one may be probed early. */
	exact?: boolean;
	/** When a guessed cooldown was last probed (ISO). */
	probedAt?: string;
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
	createTicket?(
		feature: string,
		ticket: { title?: string; what?: string; type?: string; verify?: string[]; status?: string; checkboxes?: string[] },
	): Promise<Ticket & { feature: string; created?: boolean }>;
	/** Add a ticket number to the ticket's `**Blocked by:**` line (a research rollback); optional for trackers that cannot. */
	addBlocker?(ticketOrClaim: Ticket | Claim, number: string): Promise<void>;
}

export declare function openTracker(root: string): Tracker;
/** The file with only its Status line set: the line when there is one, else one under the `#` title, else at the top. */
export declare function applyStatusLine(text: string, status: string): string;
/** Set a feature spec's Status line (pause/resume): only that line changes, under the shared-state lock. */
export declare function setSpecStatus(root: string, feature: string, status: string): Promise<void>;

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
	add(provider: string, until: Date | string, kind?: string, options?: { at?: Date | string; exact?: boolean }): Promise<void>;
	/** End a cooldown early (a probe found the provider answering again). */
	remove(provider: string): Promise<void>;
	/** Remember when a guessed cooldown was last probed. */
	markProbed(provider: string, at?: Date | string): Promise<void>;
};

/** One running shift in the run state: a worker entry per ticket being worked. */
export interface RunStateWorker {
	ticket?: { feature?: string; number?: string; title?: string; path?: string } | null;
	attempt?: number;
	shift?: number;
	model?: string;
	thinking?: string | null;
	tier?: string | null;
	budget?: Budget | null;
	usage?: { tokens: number; costUsd: number; turns: number; contextPct: number };
}

/** One runner process's entry in the run state: its run and its running shifts. */
export interface RunStateRunner extends RunStateWorker {
	pid?: number;
	running?: boolean;
	/** Whether this runner process is still alive. */
	live?: boolean;
	startedAt?: string;
	updatedAt?: string;
	finishedAt?: string | null;
	feature?: string | null;
	/** The runner's mode: `"dark-factory"` for a `run --dark-factory` watcher, else null. */
	mode?: string | null;
	stoppedReason?: string | null;
	/** Where a detached runner's output goes, when something started it that way. */
	logFile?: string;
	workers?: RunStateWorker[];
	summary?: { resolved: number; needsInfo: number; reopened?: number };
}

export interface RunState extends RunStateRunner {
	/** Every running shift across the live runners. */
	workers?: RunStateWorker[];
	/** Every runner entry (newest last), each with its own workers. */
	runners?: RunStateRunner[];
}

export interface RunStateStore {
	path: string | undefined;
	read(): Promise<RunState | null>;
	/** Merge `patch` into `patch.pid`'s runner entry (this process's by default). */
	update(patch: Partial<RunStateRunner> & { pid?: number }): Promise<void>;
	/** Merge `patch` into this process's worker entry for `ticket`. */
	updateWorker(ticket: { feature?: string; number?: string; dual?: string }, patch: Partial<RunStateWorker>): Promise<void>;
	/** Remove this process's worker entry for `ticket` once the shift settles. */
	removeWorker(ticket: { feature?: string; number?: string; dual?: string }): Promise<void>;
	clear(): Promise<void>;
}

export declare function openRunState(root: string): RunStateStore;
export declare function noRunState(): RunStateStore;

/** Shiftwork's per-repo directory name: `.shiftwork`. */
export declare const SHIFTWORK_DIR: string;
/** The legacy directory Shiftwork's files lived in: `.pi`. */
export declare const LEGACY_DIR: string;
/** The one-time stderr hint printed in legacy mode. */
export declare const LEGACY_HINT: string;
/** Whether a file name is one of Shiftwork's own (`shiftwork.json`, `shiftwork-*.json|md|lock`, `shiftwork.lock`). */
export declare function isShiftworkFile(name: string): boolean;
/** Shiftwork's own files still under `<root>/.pi/`, sorted. */
export declare function legacyFiles(root: string): string[];
/**
 * The repo's Shiftwork directory: `.shiftwork/` when it exists; `.pi/` when Shiftwork files are
 * still there (legacy mode, one stderr hint per process); else `.shiftwork/`.
 */
export declare function stateDir(root: string, options?: { warn?: (message: string) => void }): string;
/** A Shiftwork file under `stateDir(root)`. */
export declare function shiftworkPath(root: string, name: string, options?: { warn?: (message: string) => void }): string;

/** The shared-state lock path: `.shiftwork/shiftwork.lock` (legacy `.pi/`). */
export declare function lockPath(root: string, name?: string): string;
/**
 * Run `fn` while holding the repo's shared-state lock, so parallel shifts and a
 * second runner process never interleave a read-modify-write of the shared state
 * (cooldowns, run-state, the spec tickets table). A lock left by a dead pid is
 * taken over at once; a live one is waited for.
 */
export declare function withLock<T>(root: string, fn: () => T | Promise<T>, options?: { pid?: number; timeoutMs?: number; stepMs?: number; name?: string }): Promise<T>;

/** System prompt of a worker shift. */
export declare const WORKER_PROMPT: string;
/** System prompt of a review shift. */
export declare const REVIEWER_PROMPT: string;
/** The user prompt that starts a shift: pointers to the ticket and spec, not copies. */
export declare function buildShiftPrompt(
	ticket: Ticket,
	options: { root: string; attempt: number; absolute?: boolean; reopenedByReview?: boolean; dual?: string; frozen?: string[] },
): string;
/** The user prompt that starts a dual-shift merge shift: both candidates' branches and verify results, and the branch the worktree starts from. */
export declare function buildMergePrompt(
	ticket: Ticket,
	options: {
		root: string;
		target?: string;
		base: string;
		candidates: { label: string; model: string; branch: string; verify: string; stat?: string }[];
	},
): string;
/** The user prompt that starts a review shift; `target` makes it a before-land review of the unlanded branch. */
export declare function buildReviewPrompt(
	ticket: Ticket,
	options: { root: string; landed?: string; target?: string; absolute?: boolean; resumed?: boolean },
): string;

/** What happens to a ticket after one attempt. Pure. */
export declare function decideNext(options: {
	attempt: number;
	maxAttempts: number;
	needsInfo?: string | null;
	hasVerify: boolean;
	verifyOk?: boolean;
}): { action: "resolve" | "retry" | "needs-info"; reason?: string };

/** One run's outcome: the tickets resolved, sent to needs-info and reopened by review. */
export interface RunSummary {
	resolved: (Ticket & { reason?: string; review?: unknown })[];
	needsInfo: (Ticket & { reason?: string })[];
	reopened: (Ticket & { reason?: string; review?: unknown })[];
	stoppedReason?: string;
	/** 0 all resolved, 2 needs-info or reopened tickets, 3 stopped. */
	exitCode?: number;
	[key: string]: unknown;
}

/**
 * Work the frontier: claim, plan, run shifts, verify, land and review tickets until none is
 * ready or the run stops. Every dependency is injected.
 */
export declare function runFrontier(options: {
	root: string;
	tracker: Tracker;
	backend: unknown;
	verify?: unknown;
	config: Record<string, unknown>;
	workspace?: unknown;
	log?: (...args: unknown[]) => void;
	options?: {
		feature?: string;
		ticket?: string;
		parallel?: number;
		holdOnNeedsInfo?: boolean;
		[key: string]: unknown;
	};
	classify?: typeof classifyError;
	classifyTicket?: (ticket: Ticket) => Promise<TicketClassification | null> | TicketClassification | null;
	clock?: { now(): Date; sleep(ms: number): Promise<void> };
	cooldowns?: ReturnType<typeof openCooldowns>;
	runState?: RunStateStore;
	[key: string]: unknown;
}): Promise<RunSummary>;
