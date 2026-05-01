import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";

import type { RuntimeFileContentResponse } from "../core";
import {
	hasSkippedWorkdirPathComponent,
	MUTABLE_WORKDIR_PATH_BLOCKED_MESSAGE,
	normalizeWorkdirRelativePath,
} from "./workdir-path-policy";

export const MAX_WORKDIR_FILE_READ_SIZE = 10_485_760; // 10 MB — reject files larger than this to avoid OOM
export const MAX_WORKDIR_FILE_EDIT_SIZE = 5_242_880; // 5 MB — display larger text files read-only
export const WORKDIR_FILE_TOO_LARGE_TO_EDIT_MESSAGE =
	"File is larger than the 5 MB edit limit and is opened read-only.";
const BINARY_CHECK_BYTES = 8192;

export interface WorkdirFileExcerpt {
	content: string;
	binary: boolean;
	size: number;
	truncated: boolean;
	omittedReason?: "binary" | "symlink" | "unreadable";
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	bash: "bash",
	c: "c",
	cc: "cpp",
	cjs: "javascript",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	cxx: "cpp",
	go: "go",
	h: "c",
	hh: "cpp",
	hpp: "cpp",
	htm: "markup",
	html: "markup",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "jsx",
	md: "markdown",
	mdx: "markdown",
	mjs: "javascript",
	php: "php",
	py: "python",
	rb: "ruby",
	rs: "rust",
	scss: "css",
	sh: "bash",
	sql: "sql",
	svg: "markup",
	swift: "swift",
	ts: "typescript",
	tsx: "tsx",
	xml: "markup",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

/** Walk back from `limit` to avoid splitting a multi-byte UTF-8 character. */
function findUtf8Boundary(buffer: Buffer, limit: number): number {
	let i = limit;
	// Back up at most 3 bytes (max trailing bytes in a 4-byte UTF-8 sequence)
	while (i > limit - 4 && i > 0) {
		const byte = buffer[i - 1] ?? 0;
		// Single-byte ASCII or final continuation byte sequence is complete
		if (byte < 0x80) break;
		// Leading byte of a multi-byte sequence — check if the sequence fits
		if ((byte & 0xc0) !== 0x80) {
			const seqLen = byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
			if (i - 1 + seqLen <= limit) break;
			return i - 1;
		}
		i--;
	}
	return limit;
}

export function detectWorkdirFileLanguage(filePath: string): string {
	const basename = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
	if (basename === "dockerfile") {
		return "bash";
	}
	const dotIndex = basename.lastIndexOf(".");
	if (dotIndex < 0 || dotIndex === basename.length - 1) {
		return "";
	}
	return EXTENSION_TO_LANGUAGE[basename.slice(dotIndex + 1)] ?? "";
}

export function isBinaryWorkdirFileBuffer(buffer: Buffer): boolean {
	const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES);
	for (let i = 0; i < checkLength; i++) {
		if (buffer[i] === 0) {
			return true;
		}
	}
	return false;
}

export function createWorkdirFileContentHash(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function resolveContainedPath(worktreePath: string, relativePath: string): string {
	const absolutePath = resolve(worktreePath, normalize(relativePath));
	const rel = relative(worktreePath, absolutePath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Path resolves outside the worktree.");
	}
	return absolutePath;
}

export async function resolveWorkdirFilePath(worktreePath: string, relativePath: string): Promise<string> {
	const absolutePath = resolveContainedPath(worktreePath, relativePath);
	// Resolve symlinks so a link inside the worktree cannot escape to an arbitrary target
	const realWorktree = await realpath(worktreePath);
	const realAbsolute = await realpath(absolutePath);
	const realRel = relative(realWorktree, realAbsolute);
	if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
		throw new Error("Path resolves outside the worktree.");
	}
	return realAbsolute;
}

export async function readWorkdirFileExcerpt(
	worktreePath: string,
	relativePath: string,
	maxContentBytes: number,
): Promise<WorkdirFileExcerpt> {
	const absolutePath = resolveContainedPath(worktreePath, relativePath);
	const linkStat = await lstat(absolutePath);
	if (linkStat.isSymbolicLink()) {
		return {
			content: "",
			binary: false,
			size: linkStat.size,
			truncated: false,
			omittedReason: "symlink",
		};
	}

	const realAbsolute = await resolveWorkdirFilePath(worktreePath, relativePath);
	const fileStat = await stat(realAbsolute);
	if (!fileStat.isFile()) {
		throw new Error("Path is not a regular file.");
	}

	const maxBytes = Math.max(1, Math.floor(maxContentBytes));
	const readLength = Math.min(fileStat.size, Math.max(maxBytes + 4, BINARY_CHECK_BYTES));
	const buffer = Buffer.alloc(readLength);
	const file = await open(realAbsolute, "r");
	try {
		const { bytesRead } = await file.read(buffer, 0, readLength, 0);
		const contentBuffer = buffer.subarray(0, bytesRead);
		if (isBinaryWorkdirFileBuffer(contentBuffer)) {
			return {
				content: "",
				binary: true,
				size: fileStat.size,
				truncated: false,
				omittedReason: "binary",
			};
		}

		const contentByteLength = Math.min(bytesRead, maxBytes);
		const boundary = findUtf8Boundary(contentBuffer, contentByteLength);
		return {
			content: contentBuffer.subarray(0, boundary).toString("utf-8"),
			binary: false,
			size: fileStat.size,
			truncated: fileStat.size > boundary,
		};
	} finally {
		await file.close();
	}
}

// TODO: add unit tests for traversal and symlink-escape path validation.
export async function readWorkdirFile(worktreePath: string, relativePath: string): Promise<RuntimeFileContentResponse> {
	const normalizedPath = normalizeWorkdirRelativePath(relativePath);
	const absolutePath = await resolveWorkdirFilePath(worktreePath, normalizedPath);
	const fileStat = await stat(absolutePath);
	if (!fileStat.isFile()) {
		throw new Error("Path is not a regular file.");
	}
	if (fileStat.size > MAX_WORKDIR_FILE_READ_SIZE) {
		throw new Error(`File exceeds the ${MAX_WORKDIR_FILE_READ_SIZE} byte read limit.`);
	}
	const buffer = await readFile(absolutePath);
	const size = buffer.length;
	const binary = isBinaryWorkdirFileBuffer(buffer);
	const contentHash = createWorkdirFileContentHash(buffer);
	const isSkippedPath = hasSkippedWorkdirPathComponent(normalizedPath);

	if (binary) {
		return {
			content: "",
			language: detectWorkdirFileLanguage(normalizedPath),
			binary: true,
			size,
			truncated: false,
			contentHash,
			editable: false,
			editBlockedReason: "Binary files cannot be edited.",
		};
	}
	const editable = !isSkippedPath && size <= MAX_WORKDIR_FILE_EDIT_SIZE;
	const editBlockedReason = isSkippedPath
		? MUTABLE_WORKDIR_PATH_BLOCKED_MESSAGE
		: WORKDIR_FILE_TOO_LARGE_TO_EDIT_MESSAGE;

	return {
		content: buffer.toString("utf-8"),
		language: detectWorkdirFileLanguage(normalizedPath),
		binary: false,
		size,
		truncated: false,
		contentHash,
		editable,
		...(editable ? {} : { editBlockedReason }),
	};
}
