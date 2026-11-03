import type { CodeNavigationLocation } from "../core/api/code-navigation";
import {
	type CommentRange,
	getCommentRanges,
	MAX_COMMENT_SOURCE_BYTES,
	overlapsComment,
} from "../search/comment-ranges";
import { isBinaryWorkdirFileBuffer, openWorkdirFile, readWorkdirFileHandle } from "../workdir/read-workdir-file";

const MAX_REQUEST_SOURCE_BYTES = 10 * MAX_COMMENT_SOURCE_BYTES;

interface CommentIndex {
	content: string;
	ranges: readonly CommentRange[];
	lineStarts: number[];
}

function indexComments(path: string, content: string): CommentIndex | null {
	const ranges = getCommentRanges(path, content);
	if (ranges === null) return null;
	const lineStarts = [0];
	for (const match of content.matchAll(/\r\n|\r|\n/g)) lineStarts.push(match.index + match[0].length);
	return { content, ranges, lineStarts };
}

function offsetAt(index: CommentIndex, position: CodeNavigationLocation["range"]["start"]): number | null {
	const start = index.lineStarts[position.line];
	if (start === undefined) return null;
	const end = index.lineStarts[position.line + 1] ?? index.content.length;
	const line = index.content.slice(start, end).replace(/[\r\n]+$/, "");
	return position.character <= line.length ? start + position.character : null;
}

/** Classify only contained, bounded snapshots. Uncertain results remain visible. */
export async function filterReferenceComments(
	root: string,
	locations: readonly CodeNavigationLocation[],
	source: { path: string; content: string },
): Promise<CodeNavigationLocation[]> {
	// Request-local indexes avoid re-reading a file once per reference, without stale cross-request caching.
	const indexes = new Map<string, CommentIndex | null>();
	let remainingBytes = MAX_REQUEST_SOURCE_BYTES;
	const getIndex = async (path: string): Promise<CommentIndex | null> => {
		if (indexes.has(path)) return indexes.get(path) ?? null;
		let index: CommentIndex | null = null;
		try {
			if (path === source.path) {
				const bytes = Buffer.byteLength(source.content, "utf8");
				if (bytes <= MAX_COMMENT_SOURCE_BYTES && bytes <= remainingBytes) {
					remainingBytes -= bytes;
					index = indexComments(path, source.content);
				}
			} else if (remainingBytes > 0) {
				const opened = await openWorkdirFile(root, path);
				try {
					const limit = Math.min(MAX_COMMENT_SOURCE_BYTES, remainingBytes);
					if (opened.fileStat.size <= limit) {
						// Reserve before I/O: a growing file can consume the full allowance and then fail.
						remainingBytes -= limit;
						const buffer = await readWorkdirFileHandle(opened.fileHandle, limit);
						remainingBytes += limit - buffer.length;
						if (!isBinaryWorkdirFileBuffer(buffer)) index = indexComments(path, buffer.toString("utf8"));
					}
				} finally {
					await opened.fileHandle.close();
				}
			}
		} catch {
			// A missing/changing/unreadable target is not proof that its location is a comment.
		}
		indexes.set(path, index);
		return index;
	};
	const retained: CodeNavigationLocation[] = [];
	for (const location of locations) {
		const index = await getIndex(location.path);
		const from = index ? offsetAt(index, location.range.start) : null;
		const to = index ? offsetAt(index, location.range.end) : null;
		if (!index || from === null || to === null || to < from || !overlapsComment(index.ranges, from, to))
			retained.push(location);
	}
	return retained;
}
