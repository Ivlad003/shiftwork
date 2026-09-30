import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION } from "../src/index.js";

test("VERSION matches shiftwork-core's package.json, so `shiftwork --version` never drifts", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(VERSION, pkg.version);
});
