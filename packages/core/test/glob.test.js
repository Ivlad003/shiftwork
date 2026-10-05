import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, matchesGlob } from "../src/glob.js";

const cases = [
	["packages/*/test/fixtures/**", "packages/core/test/fixtures/a/b.json", true],
	["packages/*/test/fixtures/**", "packages/core/x/test/fixtures/a.json", false],
	["package.json", "package.json", true],
	["package.json", "packages/core/package.json", false],
	["**/package.json", "packages/core/package.json", true],
	["**/package.json", "package.json", true],
	["test/*.js", "test/a.js", true],
	["test/*.js", "test/sub/a.js", false],
	["test/?.js", "test/a.js", true],
	["test/?.js", "test/ab.js", false],
	["a.b", "axb", false],
];

test("globToRegExp (the fallback) and matchesGlob agree on *, ** and ?", () => {
	for (const [glob, file, expected] of cases) {
		assert.equal(globToRegExp(glob).test(file), expected, `fallback: ${glob} vs ${file}`);
		assert.equal(matchesGlob(file, glob), expected, `matchesGlob: ${glob} vs ${file}`);
	}
});
