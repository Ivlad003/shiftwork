import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "../src/index.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const dts = join(src, "index.d.ts");

/** Names the d.ts declares for export: `export (declare )?<kind> Name` and `export { a, b as c }`. */
function declaredNames(text) {
	const names = new Set();
	for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
		names.add(m[1]);
	}
	for (const m of text.matchAll(/^export\s*(?:type\s*)?\{([^}]*)\}/gm)) {
		for (const part of m[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop();
			if (name) names.add(name);
		}
	}
	return names;
}

test("every name index.js exports is declared in index.d.ts", async () => {
	const declared = declaredNames(await readFile(dts, "utf8"));
	const missing = Object.keys(core).filter((name) => !declared.has(name)).sort();
	assert.deepEqual(missing, []);
});

/** The typescript package when something in the workspace already installed it; never a dependency. */
function findTypeScript() {
	try {
		return createRequire(import.meta.url).resolve("typescript/bin/tsc");
	} catch {
		return null;
	}
}

const tsc = findTypeScript();

test("index.d.ts type-checks", { skip: tsc ? false : "typescript is not installed" }, () => {
	execFileSync(process.execPath, [tsc, "--noEmit", "--strict", dts], { stdio: "pipe" });
});
