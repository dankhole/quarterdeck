import { TRPCError } from "@trpc/server";
import type { RuntimeWorkdirTextSearchFile, RuntimeWorkdirTextSearchResponse } from "../core";
import { runGit } from "./git-utils.js";

const DEFAULT_LIMIT = 100;

interface SearchWorkdirTextOptions {
	caseSensitive?: boolean;
	isRegex?: boolean;
	limit?: number;
}

export async function searchWorkdirText(
	cwd: string,
	query: string,
	options: SearchWorkdirTextOptions = {},
): Promise<RuntimeWorkdirTextSearchResponse> {
	const { caseSensitive = false, isRegex = false, limit = DEFAULT_LIMIT } = options;

	const args: string[] = ["grep", "-rn", "--null", "--no-color"];
	if (!caseSensitive) {
		args.push("-i");
	}
	args.push(isRegex ? "-E" : "-F");
	args.push("--", query);

	const result = await runGit(cwd, args, { trimStdout: false });

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
		// Lines are formatted as: filepath\0lineNumber:content
		// Skip lines without NUL byte (binary file notices, etc.)
		const nulIndex = line.indexOf("\0");
		if (nulIndex === -1) {
			continue;
		}

		if (totalMatches >= limit) {
			truncated = true;
			break;
		}

		const filepath = line.slice(0, nulIndex);
		const remainder = line.slice(nulIndex + 1);

		// Split remainder on first ":" to get line number and content
		const colonIndex = remainder.indexOf(":");
		if (colonIndex === -1) {
			continue;
		}

		const lineNumber = parseInt(remainder.slice(0, colonIndex), 10);
		if (!Number.isFinite(lineNumber)) {
			continue;
		}

		const content = remainder.slice(colonIndex + 1);

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
