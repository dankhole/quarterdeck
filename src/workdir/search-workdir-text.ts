import { TRPCError } from "@trpc/server";
import type { RuntimeWorkdirTextSearchFile, RuntimeWorkdirTextSearchResponse } from "../core";
import { GIT_INSPECTION_OPTIONS, runGit, validateGitRef } from "./git-utils.js";

const DEFAULT_LIMIT = 100;

interface SearchWorkdirTextOptions {
	caseSensitive?: boolean;
	isRegex?: boolean;
	limit?: number;
	ref?: string;
}

export async function searchWorkdirText(
	cwd: string,
	query: string,
	options: SearchWorkdirTextOptions = {},
): Promise<RuntimeWorkdirTextSearchResponse> {
	const { caseSensitive = false, isRegex = false, limit = DEFAULT_LIMIT, ref } = options;
	if (ref && !validateGitRef(ref)) {
		return { query, files: [], totalMatches: 0, truncated: false };
	}

	const args: string[] = ["grep", "-n", "--null", "--no-color"];
	if (!caseSensitive) {
		args.push("-i");
	}
	args.push(isRegex ? "-E" : "-F");
	args.push("-e", query);
	if (ref) {
		args.push(ref);
	}
	args.push("--");

	const result = await runGit(cwd, args, { trimStdout: false, ...GIT_INSPECTION_OPTIONS });

	// Exit code 1 = no matches found
	if (!result.ok && result.exitCode === 1) {
		return { query, files: [], totalMatches: 0, truncated: false };
	}

	// Exit code 2 = bad regex or other git grep error
	if (!result.ok && result.exitCode === 2) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: result.stderr || "Invalid search pattern.",
		});
	}

	// Other failures = return empty results
	if (!result.ok) {
		return { query, files: [], totalMatches: 0, truncated: false };
	}

	const lines = result.stdout.split("\n");
	const fileMap = new Map<string, RuntimeWorkdirTextSearchFile>();
	let totalMatches = 0;
	let truncated = false;

	for (const line of lines) {
		// Lines are formatted as: filepath\0lineNumber\0content on recent Git,
		// though older output can use filepath\0lineNumber:content.
		// Skip lines without NUL byte (binary file notices, etc.)
		const nulIndex = line.indexOf("\0");
		if (nulIndex === -1) {
			continue;
		}

		if (totalMatches >= limit) {
			truncated = true;
			break;
		}

		const rawFilepath = line.slice(0, nulIndex);
		const refPrefix = ref ? `${ref}:` : null;
		const filepath =
			refPrefix && rawFilepath.startsWith(refPrefix) ? rawFilepath.slice(refPrefix.length) : rawFilepath;
		const remainder = line.slice(nulIndex + 1);

		const lineSeparatorIndex = remainder.indexOf("\0");
		const colonIndex = remainder.indexOf(":");
		const separatorIndex = lineSeparatorIndex === -1 ? colonIndex : lineSeparatorIndex;
		if (separatorIndex === -1) continue;

		const lineNumber = parseInt(remainder.slice(0, separatorIndex), 10);
		if (!Number.isFinite(lineNumber)) {
			continue;
		}

		const content = remainder.slice(separatorIndex + 1);

		let fileEntry = fileMap.get(filepath);
		if (!fileEntry) {
			fileEntry = { path: filepath, matches: [] };
			fileMap.set(filepath, fileEntry);
		}

		fileEntry.matches.push({ line: lineNumber, content });
		totalMatches++;
	}

	return {
		query,
		files: [...fileMap.values()],
		totalMatches,
		truncated,
	};
}
