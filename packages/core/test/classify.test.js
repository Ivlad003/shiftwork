import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError, cooldownMs } from "../src/index.js";

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
	["available balance required to continue", , "usage"],

	// Quota / billing
	["insufficient_quota", , "quota"],
	["You exceeded your current quota", , "quota"],
	["quota exceeded", , "quota"],
	["out of budget", , "quota"],
	["billing hard limit reached", , "quota"],

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
	const got = classifyError("usage limit reached; resets at 2026-09-30T14:00:00Z");
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
