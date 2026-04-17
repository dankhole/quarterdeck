import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";

import type { RuntimeFileContentResponse } from "../core";

const MAX_FILE_SIZE = 1_048_576; // 1 MB
const MAX_READ_SIZE = 10_485_760; // 10 MB — reject files larger than this to avoid OOM
const BINARY_CHECK_BYTES = 8192;

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
			if (i - 1 + seqLen <= limit) break; // sequence fits, keep it
			return i - 1; // sequence is cut — trim before the leading byte
		}
		i--;
	}
	return limit;
}

function detectLanguage(filePath: string): string {
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

function isBinaryBuffer(buffer: Buffer): boolean {
	const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES);
	for (let i = 0; i < checkLength; i++) {
		if (buffer[i] === 0) {
			return true;
		}
	}
	return false;
}

async function validatePath(worktreePath: string, relativePath: string): Promise<string> {
	const absolutePath = resolve(worktreePath, normalize(relativePath));
	const rel = relative(worktreePath, absolutePath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Path resolves outside the worktree.");
	}
	// Resolve symlinks so a link inside the worktree cannot escape to an arbitrary target
	const realWorktree = await realpath(worktreePath);
	const realAbsolute = await realpath(absolutePath);
	const realRel = relative(realWorktree, realAbsolute);
	if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
		throw new Error("Path resolves outside the worktree.");
	}
	return realAbsolute;
}

// TODO: add unit tests for validatePath (traversal, symlink escape) and readWorkdirFile (binary detection, truncation, UTF-8 boundary)
export async function readWorkdirFile(worktreePath: string, relativePath: string): Promise<RuntimeFileContentResponse> {
	const absolutePath = await validatePath(worktreePath, relativePath);
	const fileStat = await stat(absolutePath);
	if (!fileStat.isFile()) {
		throw new Error("Path is not a regular file.");
	}
	if (fileStat.size > MAX_READ_SIZE) {
		throw new Error(`File exceeds the ${MAX_READ_SIZE} byte read limit.`);
	}
	const buffer = await readFile(absolutePath);
	const size = buffer.length;
	const binary = isBinaryBuffer(buffer);

	if (binary) {
		return {
			content: "",
			language: detectLanguage(relativePath),
			binary: true,
			size,
			truncated: false,
		};
	}

	const truncated = size > MAX_FILE_SIZE;
	const content = truncated
		? buffer.subarray(0, findUtf8Boundary(buffer, MAX_FILE_SIZE)).toString("utf-8")
		: buffer.toString("utf-8");

	return {
		content,
		language: detectLanguage(relativePath),
		binary: false,
		size,
		truncated,
	};
}
