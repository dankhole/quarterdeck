import type { RuntimeWorkdirTextSearchMatch } from "../core";
import { getCommentRanges, MAX_COMMENT_SOURCE_BYTES, overlapsComment } from "../search/comment-ranges.js";
import { GIT_INSPECTION_OPTIONS, getFileContentAtRef, runGit, validateGitPath } from "./git-utils.js";
import { openWorkdirFile, readWorkdirFileHandle } from "./read-workdir-file.js";

const MAX_TOTAL_COMMENT_SOURCE_BYTES = 10 * MAX_COMMENT_SOURCE_BYTES;

interface SearchOccurrence {
	from: number;
	to: number;
}

interface OccurrenceLine {
	content: string;
	matches: SearchOccurrence[];
}

type FileOccurrences = Map<number, OccurrenceLine>;
const MATCH_START = "\u001b[31m";
const MATCH_END = "\u001b[m";

interface CommentFilteredLine {
	keep: boolean;
	ranges?: RuntimeWorkdirTextSearchMatch["ranges"];
}

function parseOccurrences(output: string, ref?: string): Map<string, FileOccurrences> {
	const files = new Map<string, FileOccurrences>();
	let offset = 0;
	while (offset < output.length) {
		const pathEnd = output.indexOf("\0", offset);
		const lineEnd = output.indexOf("\0", pathEnd + 1);
		const matchEnd = output.indexOf("\n", lineEnd + 1);
		if (pathEnd < 0 || lineEnd < 0 || matchEnd < 0) break;
		const rawPath = output.slice(offset, pathEnd);
		const path = ref && rawPath.startsWith(`${ref}:`) ? rawPath.slice(ref.length + 1) : rawPath;
		const line = Number(output.slice(pathEnd + 1, lineEnd));
		const highlighted = output.slice(lineEnd + 1, matchEnd);
		offset = matchEnd + 1;
		if (!Number.isSafeInteger(line) || line < 1) continue;
		const matches: SearchOccurrence[] = [];
		let content = "";
		let position = 0;
		while (position < highlighted.length) {
			const from = highlighted.indexOf(MATCH_START, position);
			if (from < 0) {
				content += highlighted.slice(position);
				break;
			}
			content += highlighted.slice(position, from);
			const to = highlighted.indexOf(MATCH_END, from + MATCH_START.length);
			if (to < 0) break;
			const start = content.length;
			content += highlighted.slice(from + MATCH_START.length, to);
			matches.push({ from: start, to: content.length });
			position = to + MATCH_END.length;
		}
		// Escapes in source or unexpected Git colors are unclassifiable. Source
		// equality below additionally detects delimiter collisions in file text.
		if (content.includes("\u001b")) continue;
		let file = files.get(path);
		if (!file) {
			file = new Map();
			files.set(path, file);
		}
		file.set(line, { content: content.replace(/\r$/u, ""), matches });
	}
	return files;
}

interface SourceBudget {
	remaining: number;
}

async function readCommentSource(
	cwd: string,
	path: string,
	budget: SourceBudget,
	ref?: string,
): Promise<string | null> {
	const maxBytes = Math.min(MAX_COMMENT_SOURCE_BYTES, budget.remaining);
	if (maxBytes <= 0) return null;
	try {
		if (ref) {
			if (!validateGitPath(path)) return null;
			// The captured tree OID makes this size check and the subsequent read
			// refer to the same immutable object, never a live worktree file.
			const stat = await runGit(cwd, ["cat-file", "-s", `${ref}:${path}`], GIT_INSPECTION_OPTIONS);
			const size = Number(stat.stdout);
			if (!stat.ok || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) return null;
			budget.remaining -= size;
			const source = await getFileContentAtRef(cwd, ref, path);
			return source && !source.binary ? source.content : null;
		}
		const opened = await openWorkdirFile(cwd, path);
		try {
			if (opened.fileStat.size > maxBytes) return null;
			// Reserve the full allowance, including growth during reading. The
			// bounded handle read and canonical opener retain workdir containment.
			budget.remaining -= maxBytes;
			const buffer = await readWorkdirFileHandle(opened.fileHandle, maxBytes);
			budget.remaining += maxBytes - buffer.length;
			return buffer.toString("utf8");
		} finally {
			await opened.fileHandle.close();
		}
	} catch {
		return null;
	}
}

/** Git marks exact POSIX matches; reconstructing its source yields UTF-16 spans. */
export function createTextSearchCommentFilter(cwd: string, occurrenceOutput: string, ref?: string) {
	const occurrences = parseOccurrences(occurrenceOutput, ref);
	const budget: SourceBudget = { remaining: MAX_TOTAL_COMMENT_SOURCE_BYTES };
	// Git groups records by file. Retain only the current complete parsed document,
	// rather than accumulating source text for every file in a large search.
	let currentPath: string | undefined;
	let source: string | null = null;
	let ranges: ReturnType<typeof getCommentRanges> = null;
	let lineStarts: number[] = [];

	return async (path: string, line: number, content: string): Promise<CommentFilteredLine> => {
		const occurrenceLine = occurrences.get(path)?.get(line);
		if (!occurrenceLine?.matches.length || occurrenceLine.content !== content) return { keep: true };
		if (path !== currentPath) {
			currentPath = path;
			source = await readCommentSource(cwd, path, budget, ref);
			ranges = source === null ? null : getCommentRanges(path, source);
			lineStarts = [0];
			if (source !== null && ranges !== null) {
				for (let index = 0; index < source.length; index++) {
					if (source[index] === "\n") lineStarts.push(index + 1);
				}
			}
		}
		if (source === null || ranges === null) return { keep: true };
		const start = lineStarts[line - 1];
		if (start === undefined) return { keep: true };
		const end = source.indexOf("\n", start);
		const sourceLine = source.slice(start, end < 0 ? source.length : end).replace(/\r$/u, "");
		// The worktree can change between grep and reading. Do not classify stale spans.
		if (sourceLine !== content) return { keep: true };
		const matchRanges: NonNullable<RuntimeWorkdirTextSearchMatch["ranges"]> = [];
		for (const match of occurrenceLine.matches) {
			if (match.to > content.length) return { keep: true };
			if (!overlapsComment(ranges, start + match.from, start + match.to)) {
				matchRanges.push({ start: match.from, end: match.to });
			}
		}
		return { keep: matchRanges.length > 0, ranges: matchRanges };
	};
}
