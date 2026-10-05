import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError, cooldownMs } from "../src/index.js";
import { isAuthError } from "../src/classify.js";

const now = Date.parse("2026-01-01T00:00:00Z");

const cases = [
	// Rate (pi-ai retryable + Claude)
	["HTTP 429 Too Many Requests", , "rate"],
	["rate limit exceeded", , "rate"],
	["Rate limit reached. Please try again later", , "rate"],
	["too many requests", , "rate"],
	["rate_limit_error", , "rate"],
	["ResourceExhausted", , "rate"],
	["This request would exceed your organization's rate limit", , "rate"],
	["You've hit the rate limit for your plan.", , "rate"],

	// Usage: OpenCode, ChatGPT, Claude wording. Beats a wrapping 429.
	["GoUsageLimitError", , "usage"],
	["FreeUsageLimitError", , "usage"],
	["Monthly usage limit reached. Enable available balance usage.", , "usage"],
	["429 {\"type\":\"GoUsageLimitError\"}", , "usage"],
	["subscription_sharing_usage_limit_exceeded", , "usage"],
	["You've hit your Claude usage limit", , "usage"],
	["usage limit reached", , "usage"],
	["Claude Code usage limit reached", , "usage"],
	["Claude Code limit resets at 2026-10-01T00:00:00Z", , "usage"],
	["You hit your weekly limit. Upgrade to a higher tier for more usage.", , "usage"],
	["available balance required to continue", , "usage"],

	// Quota / billing
	["insufficient_quota", , "quota"],
	["You exceeded your current quota", , "quota"],
	["quota exceeded", , "quota"],
	["Agent-message quota exceeded (resets at 2026-10-01T00:00:00Z)", , "quota"],
	["You've run out of credits. Purchase credits to keep using Grok Build.", , "quota"],
	["out of budget", , "quota"],
	["billing hard limit reached", , "quota"],
	['error: 402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}', , "quota"],
	["insufficient balance", , "quota"],
	["402 Payment Required", , "quota"],

	// Server (pi-ai 5xx / overloaded)
	["overloaded_error: The model is currently overloaded", , "server"],
	["currently experiencing high demand", , "server"],
	["503 Service Unavailable", , "server"],
	["502 Bad Gateway", , "server"],
	["internal server error", , "server"],
	["Provider returned error", , "server"],

	// Not a provider limit
	["model not found", , null],
	["syntax error in tool call", , null],
	["", , null],
];

for (const [message, headers, kind] of cases) {
	test(`classifyError: ${message || "(empty)"} → ${kind}`, () => {
		const got = classifyError(message, headers);
		if (kind === null) assert.equal(got, null);
		else assert.equal(got.kind, kind);
	});
}

test("classifyError: retry-after seconds becomes resetAt", () => {
	const got = classifyError("429", { "retry-after": "60" }, now);
	assert.equal(got.kind, "rate");
	assert.equal(got.resetAt.toISOString(), "2026-01-01T00:01:00.000Z");
});

test("classifyError: Retry-After HTTP-date is case-insensitive", () => {
	const got = classifyError("rate limit", { "Retry-After": "Thu, 01 Jan 2026 01:00:00 GMT" }, now);
	assert.equal(got.resetAt.toISOString(), "2026-01-01T01:00:00.000Z");
});

test("classifyError: x-ratelimit-reset unix seconds", () => {
	const got = classifyError("429", { "x-ratelimit-reset": String(now / 1000 + 120) }, now);
	assert.equal(got.resetAt.toISOString(), "2026-01-01T00:02:00.000Z");
});

test("classifyError: 'resets at' ISO timestamp in the body", () => {
	const got = classifyError("usage limit reached; resets at 2026-09-30T14:00:00Z", undefined, now);
	assert.equal(got.kind, "usage");
	assert.equal(got.resetAt.toISOString(), "2026-09-30T14:00:00.000Z");
});

test("classifyError: 'try again in 15 minutes'", () => {
	const got = classifyError("Rate limit. Please try again in 15 minutes", undefined, now);
	assert.equal(got.kind, "rate");
	assert.equal(got.resetAt.toISOString(), "2026-01-01T00:15:00.000Z");
});

test("cooldownMs uses config then defaults", () => {
	assert.equal(cooldownMs({ cooldown: { rate: "2m" } }, "rate"), 120_000);
	assert.equal(cooldownMs({ cooldown: { rate: 1000 } }, "rate"), 1000);
	assert.equal(cooldownMs({}, "usage"), 5 * 60 * 60 * 1000);
});

test("classifyError: a small x-ratelimit-reset is seconds from now, not an epoch", () => {
	const got = classifyError("429", { "x-ratelimit-reset": "30" }, now);
	assert.equal(got.resetAt.toISOString(), "2026-01-01T00:00:30.000Z");
});

test("classifyError: a reset time already past is no reset (the default cooldown applies)", () => {
	assert.equal(classifyError("429", { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, now).resetAt, undefined);
	assert.equal(classifyError("429", { "x-ratelimit-reset": String(now / 1000 - 60) }, now).resetAt, undefined);
	assert.equal(classifyError("usage limit reached; resets at 2025-09-30T14:00:00Z", undefined, now).resetAt, undefined);
});

test("isAuthError: a missing or rejected API key is an auth error, a rate limit is not", () => {
	assert.equal(isAuthError("No API key found for opencode-go"), true);
	assert.equal(isAuthError("401 Unauthorized: invalid x-api-key"), true);
	assert.equal(isAuthError("Invalid API key provided"), true);
	assert.equal(isAuthError("anything", "auth"), true);
	assert.equal(isAuthError("HTTP 429 Too Many Requests"), false);
	assert.equal(isAuthError(undefined), false);
});
