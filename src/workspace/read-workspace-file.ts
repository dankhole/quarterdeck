import { readFile, stat } from "node:fs/promises";
import { normalize, resolve, sep } from "node:path";

import type { RuntimeFileContentResponse } from "../core/api-contract";

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

function validatePath(worktreePath: string, relativePath: string): string {
	if (relativePath.startsWith("/")) {
		throw new Error("Absolute paths are not allowed.");
	}
	const segments = relativePath.split(/[/\\]/);
	if (segments.includes("..")) {
		throw new Error("Path traversal is not allowed.");
	}
	const absolutePath = resolve(worktreePath, normalize(relativePath));
	const normalizedRoot = worktreePath.endsWith(sep) ? worktreePath : `${worktreePath}${sep}`;
	if (!absolutePath.startsWith(normalizedRoot) && absolutePath !== worktreePath) {
		throw new Error("Path resolves outside the worktree.");
	}
	return absolutePath;
}

export async function readWorkspaceFile(
	worktreePath: string,
	relativePath: string,
): Promise<RuntimeFileContentResponse> {
	const absolutePath = validatePath(worktreePath, relativePath);
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
	const content = truncated ? buffer.subarray(0, MAX_FILE_SIZE).toString("utf-8") : buffer.toString("utf-8");

	return {
		content,
		language: detectLanguage(relativePath),
		binary: false,
		size,
		truncated,
	};
}
