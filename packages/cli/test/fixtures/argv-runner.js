#!/usr/bin/env node
// Stands in for `shiftwork run` in the TUI controls tests: it writes the argv it was
// given (without node and the script path) to argv.json in the repo root and exits.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

await writeFile(join(process.cwd(), "argv.json"), `${JSON.stringify(process.argv.slice(2))}\n`);
