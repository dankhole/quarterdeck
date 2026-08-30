import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { type FileHandle, lstat, realpath } from "node:fs/promises";
import { normalize, resolve } from "node:path";

import { areFileSystemPathsEqual, isFileSystemPathWithin, type RuntimeFileContentResponse } from "../core";
import { openValidatedContainedRegularFile } from "../fs";
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
	if (areFileSystemPathsEqual(worktreePath, absolutePath) || !isFileSystemPathWithin(worktreePath, absolutePath)) {
		throw new Error("Path resolves outside the worktree.");
	}
	return absolutePath;
}

async function resolveCanonicalWorkdirFilePath(
	worktreePath: string,
	relativePath: string,
): Promise<{ canonicalRoot: string; canonicalPath: string }> {
	const absolutePath = resolveContainedPath(worktreePath, relativePath);
	// Resolve symlinks so a link inside the worktree cannot escape to an arbitrary target
	const canonicalRoot = await realpath(worktreePath);
	const canonicalPath = await realpath(absolutePath);
	if (areFileSystemPathsEqual(canonicalRoot, canonicalPath) || !isFileSystemPathWithin(canonicalRoot, canonicalPath)) {
		throw new Error("Path resolves outside the worktree.");
	}
	return { canonicalRoot, canonicalPath };
}

export async function resolveWorkdirFilePath(worktreePath: string, relativePath: string): Promise<string> {
	return (await resolveCanonicalWorkdirFilePath(worktreePath, relativePath)).canonicalPath;
}

export interface OpenedWorkdirFile {
	absolutePath: string;
	fileHandle: FileHandle;
	fileStat: Stats;
}

export async function openWorkdirFile(worktreePath: string, relativePath: string): Promise<OpenedWorkdirFile> {
	const { canonicalRoot, canonicalPath } = await resolveCanonicalWorkdirFilePath(worktreePath, relativePath);
	const result = await openValidatedContainedRegularFile({ canonicalRoot, canonicalPath });
	if (result.status === "invalid") {
		throw new Error(
			result.reason === "not_regular_file" ? "Path is not a regular file." : "File path changed while opening.",
		);
	}
	return { absolutePath: canonicalPath, fileHandle: result.fileHandle, fileStat: result.fileStat };
}

export async function readWorkdirFileHandle(fileHandle: FileHandle, maxBytes: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(maxBytes + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await fileHandle.read(buffer, offset, buffer.length - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > maxBytes) {
		throw new Error(`File exceeds the ${maxBytes} byte read limit.`);
	}
	return buffer.subarray(0, offset);
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

	const openedFile = await openWorkdirFile(worktreePath, relativePath);

	try {
		const maxBytes = Math.max(1, Math.floor(maxContentBytes));
		const readLength = Math.min(openedFile.fileStat.size, Math.max(maxBytes + 4, BINARY_CHECK_BYTES));
		const buffer = Buffer.alloc(readLength);
		const { bytesRead } = await openedFile.fileHandle.read(buffer, 0, readLength, 0);
		const contentBuffer = buffer.subarray(0, bytesRead);
		if (isBinaryWorkdirFileBuffer(contentBuffer)) {
			return {
				content: "",
				binary: true,
				size: openedFile.fileStat.size,
				truncated: false,
				omittedReason: "binary",
			};
		}

		const contentByteLength = Math.min(bytesRead, maxBytes);
		const boundary = findUtf8Boundary(contentBuffer, contentByteLength);
		return {
			content: contentBuffer.subarray(0, boundary).toString("utf-8"),
			binary: false,
			size: openedFile.fileStat.size,
			truncated: openedFile.fileStat.size > boundary,
		};
	} finally {
		await openedFile.fileHandle.close();
	}
}

export async function readWorkdirFile(worktreePath: string, relativePath: string): Promise<RuntimeFileContentResponse> {
	const normalizedPath = normalizeWorkdirRelativePath(relativePath);
	const openedFile = await openWorkdirFile(worktreePath, normalizedPath);
	let buffer: Buffer;
	try {
		if (openedFile.fileStat.size > MAX_WORKDIR_FILE_READ_SIZE) {
			throw new Error(`File exceeds the ${MAX_WORKDIR_FILE_READ_SIZE} byte read limit.`);
		}
		buffer = await readWorkdirFileHandle(openedFile.fileHandle, MAX_WORKDIR_FILE_READ_SIZE);
	} finally {
		await openedFile.fileHandle.close();
	}
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
