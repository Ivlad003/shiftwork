import path from "node:path";

/** A glob as a RegExp over `/`-separated relative paths: `**` crosses directories, `*` and `?`
 * stay within one. The fallback for Node versions before 22.5, which lack `path.matchesGlob`. */
export function globToRegExp(glob) {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			// `**/` matches zero or more whole directories; a trailing or inner `**` anything.
			if (glob[i + 2] === "/") {
				source += "(?:.*/)?";
				i += 2;
			} else {
				source += ".*";
				i += 1;
			}
		} else if (c === "*") source += "[^/]*";
		else if (c === "?") source += "[^/]";
		else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** Whether the relative path `file` matches `glob` (`*`, `**`, `?`): `path.matchesGlob` where
 * Node has it, else `globToRegExp`. */
export function matchesGlob(file, glob) {
	if (typeof path.matchesGlob === "function") return path.matchesGlob(file, glob);
	return globToRegExp(glob).test(file);
}
