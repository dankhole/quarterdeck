import { createGitProcessEnv } from "../core";
import { isGitCommandIndeterminate, runGit } from "./git-utils";

// Untranslated diagnostics so the definite answers below are recognized in every locale.
const UNTRANSLATED_GIT_ENV_OVERRIDES = { LC_ALL: "C" } as const;

function gitLookupPath(path: string): string {
	// Git's core.precomposeUnicode stores NFC while macOS enumeration may return NFD;
	// check-ignore does not precompose stdin, so send Git's canonical spelling.
	return process.platform === "darwin" ? path.normalize("NFC") : path;
}

/**
 * Returns the subset of candidate directory paths (relative to `cwd`) that Git ignores.
 *
 * Only the given candidates are checked: no recursive discovery. `check-ignore` matches
 * each candidate against the index first, so a directory containing tracked content is
 * never reported and stays visible; individually ignored files are never candidates.
 * Pathspec wildcards in names can only cause conservative retention. A definite
 * non-repository answer means nothing is ignored. Inside a registered submodule the outer
 * repository cannot answer (all candidates share one parent), so they are conservatively
 * retained without nested ignore discovery. Other Git failures throw.
 */
export async function findGitIgnoredDirectories(cwd: string, candidates: readonly string[]): Promise<Set<string>> {
	const ignored = new Set<string>();
	if (candidates.length === 0) return ignored;
	const candidatesByLookup = new Map<string, string[]>();
	for (const candidate of candidates) {
		// A ./ prefix prevents names beginning with : from becoming Git pathspec magic. No
		// trailing slash: Git then lstat()s the directory for directory-only rules, while
		// `dir/` would also match child globs such as `dir/*` against the directory itself.
		const lookup = `./${gitLookupPath(candidate)}`;
		const existing = candidatesByLookup.get(lookup);
		if (existing) existing.push(candidate);
		else candidatesByLookup.set(lookup, [candidate]);
	}
	const result = await runGit(cwd, ["check-ignore", "-z", "--stdin"], {
		trimStdout: false,
		timeoutClass: "default",
		env: createGitProcessEnv(UNTRANSLATED_GIT_ENV_OVERRIDES),
		stdin: [...candidatesByLookup.keys()].map((lookup) => `${lookup}\0`).join(""),
	});
	if (!result.ok) {
		if (isGitCommandIndeterminate(result)) throw new Error("Git ignore check did not complete; retry.");
		if (result.exitCode === 1 && !result.stdout) return ignored;
		if (result.failureKind === "command_failed" && /not a git repository/iu.test(result.stderr)) return ignored;
		if (result.failureKind === "command_failed" && /is in submodule '/u.test(result.stderr)) return ignored;
		throw new Error("Could not check Git ignore rules; retry.");
	}
	// Output echoes the submitted paths; the candidate count bounds its size.
	let offset = 0;
	while (offset < result.stdout.length) {
		const end = result.stdout.indexOf("\0", offset);
		if (end < 0) throw new Error("Git ignore check returned incomplete output.");
		const lookup = result.stdout.slice(offset, end);
		offset = end + 1;
		for (const candidate of candidatesByLookup.get(lookup) ?? []) ignored.add(candidate);
	}
	return ignored;
}
