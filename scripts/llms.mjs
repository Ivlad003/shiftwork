#!/usr/bin/env node
// Generates llms-full.txt from llms.txt: every linked file, in link order,
// each under its path as a header. Deterministic - no timestamps, no globs:
// the same llms.txt and the same files always produce the same llms-full.txt.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * Relative file links in a markdown document, in order of appearance,
 * deduplicated. External URLs (scheme://) and anchors (#) are skipped.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractLinks(markdown) {
	const links = [];
	for (const match of markdown.matchAll(LINK_RE)) {
		const target = match[1];
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith("#")) continue;
		if (!links.includes(target)) links.push(target);
	}
	return links;
}

/**
 * Concatenate the files linked from llms.txt into the contents of
 * llms-full.txt. Throws if a linked file is missing, so `npm run llms`
 * doubles as a link check.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ text: string, links: string[] }>}
 */
export async function buildFullText(repoRoot) {
	const llms = await readFile(path.join(repoRoot, "llms.txt"), "utf8");
	const links = extractLinks(llms);
	const parts = [];
	for (const link of extractLinks(llms)) {
		const file = path.join(repoRoot, link);
		if (!existsSync(file)) {
			throw new Error(`llms.txt links to a missing file: ${link}`);
		}
		const contents = await readFile(file, "utf8");
		parts.push(`# ${link}\n\n${contents.trimEnd()}\n`);
	}
	return { text: parts.join("\n"), links };
}

/**
 * Write llms-full.txt into the repo root.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ files: number, bytes: number }>}
 */
export async function writeFullText(repoRoot) {
	const { text, links } = await buildFullText(repoRoot);
	await writeFile(path.join(repoRoot, "llms-full.txt"), text);
	return { files: links.length, bytes: Buffer.byteLength(text) };
}

const invokedDirectly =
	process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
	const repoRoot = process.cwd();
	const { files, bytes } = await writeFullText(repoRoot);
	console.log(`llms-full.txt: ${files} files, ${bytes} bytes`);
}
