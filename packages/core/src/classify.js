const USAGE = pattern([
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"subscription_sharing_usage_limit_exceeded",
	"usage_limit_reached",
	"usage.?limit",
	"usage.?limit.?reached",
	"usage.?limit.?resets",
	"hit your (?:claude |openai |chatgpt )?(?:usage |token )?limit",
	"hit your weekly limit",
	"reached your (?:claude |openai |chatgpt )?(?:usage |token )?limit",
	"claude code usage limit",
	"claude code limit",
]);

const QUOTA = pattern([
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"exceeded your (?:current )?quota",
	"out of credits",
	"billing",
	"insufficient (?:account )?(?:funds|balance|credits?)",
	"payment.?required",
	"\\b402\\b",
]);

const RATE = pattern(["rate_limit", "rate.?limit", "too many requests", "429", "ResourceExhausted"]);

const SERVER = pattern([
	"overloaded",
	"currently experiencing high demand",
	"500",
	"502",
	"503",
	"504",
	"520",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?error",
]);

/** Default cooldown lengths when the provider gives no reset hint. */
export const DEFAULT_COOLDOWN_MS = {
	rate: 15 * 60 * 1000,
	usage: 5 * 60 * 60 * 1000,
	quota: 24 * 60 * 60 * 1000,
	server: 5 * 60 * 1000,
};

/**
 * Classify a provider error into a limit kind, with an optional reset time.
 * Usage and quota beat a wrapping 429 (OpenCode returns those as 429 JSON).
 * @returns {null | { kind: "rate" | "usage" | "quota" | "server", resetAt?: Date }}
 */
export function classifyError(message, headers, now = Date.now()) {
	if (!message || typeof message !== "string") return null;
	let kind;
	if (USAGE.test(message)) kind = "usage";
	else if (QUOTA.test(message)) kind = "quota";
	else if (RATE.test(message)) kind = "rate";
	else if (SERVER.test(message)) kind = "server";
	else return null;
	const resetAt = parseReset(message, headers, timestamp(now));
	return resetAt ? { kind, resetAt } : { kind };
}

/** Cooldown length for a kind, from config or the defaults. */
export function cooldownMs(config, kind) {
	const value = config?.cooldown?.[kind];
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	const parsed = parseCooldownDuration(value);
	if (parsed != null) return parsed;
	return DEFAULT_COOLDOWN_MS[kind] ?? DEFAULT_COOLDOWN_MS.rate;
}

export function parseCooldownDuration(value) {
	if (typeof value !== "string") return undefined;
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
	if (!match) return undefined;
	const n = Number(match[1]);
	return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()];
}

function pattern(patterns) {
	return new RegExp(patterns.join("|"), "i");
}

function timestamp(now) {
	if (now instanceof Date) return now.getTime();
	if (typeof now === "number") return now;
	return Date.now();
}

function header(headers, name) {
	if (!headers || typeof headers !== "object") return undefined;
	const want = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === want) return value;
	}
	return undefined;
}

function parseReset(message, headers, nowMs) {
	const retryAfter = header(headers, "retry-after");
	if (retryAfter != null) {
		const parsed = parseRetryAfter(retryAfter, nowMs);
		if (parsed) return parsed;
	}
	for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
		const value = header(headers, name);
		if (value == null) continue;
		const n = Number(value);
		if (Number.isFinite(n) && String(value).trim() !== "") {
			return new Date(n < 1e12 ? n * 1000 : n);
		}
		const date = Date.parse(value);
		if (!Number.isNaN(date)) return new Date(date);
	}
	const iso = message.match(/resets?\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?)/i);
	if (iso) {
		const date = Date.parse(iso[1]);
		if (!Number.isNaN(date)) return new Date(date);
	}
	const again = message.match(/try again in\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|s|m|h)\b/i);
	if (again) {
		const n = Number(again[1]);
		const unit = again[2].toLowerCase();
		const ms = unit.startsWith("h") ? n * 3_600_000 : unit.startsWith("m") ? n * 60_000 : n * 1000;
		return new Date(nowMs + ms);
	}
	return undefined;
}

function parseRetryAfter(value, nowMs) {
	const text = String(value).trim();
	if (/^\d+(?:\.\d+)?$/.test(text)) return new Date(nowMs + Number(text) * 1000);
	const date = Date.parse(text);
	if (!Number.isNaN(date)) return new Date(date);
	return undefined;
}
