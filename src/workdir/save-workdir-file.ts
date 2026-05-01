import { readFile, stat } from "node:fs/promises";

import type { RuntimeFileSaveResponse } from "../core";
import { lockedFileSystem } from "../fs";
import {
	createWorkdirFileContentHash,
	detectWorkdirFileLanguage,
	isBinaryWorkdirFileBuffer,
	MAX_WORKDIR_FILE_EDIT_SIZE,
	MAX_WORKDIR_FILE_READ_SIZE,
	resolveWorkdirFilePath,
	WORKDIR_FILE_TOO_LARGE_TO_EDIT_MESSAGE,
} from "./read-workdir-file";
import { assertMutableWorkdirPath, normalizeWorkdirRelativePath } from "./workdir-path-policy";

export class WorkdirFileConflictError extends Error {
	constructor() {
		super("File changed on disk. Reload before saving.");
		this.name = "WorkdirFileConflictError";
	}
}

export async function saveWorkdirFile(
	worktreePath: string,
	relativePath: string,
	content: string,
	expectedContentHash: string,
): Promise<RuntimeFileSaveResponse> {
	const normalizedPath = normalizeWorkdirRelativePath(relativePath);
	assertMutableWorkdirPath(normalizedPath);
	const absolutePath = await resolveWorkdirFilePath(worktreePath, normalizedPath);
	return await lockedFileSystem.withLock({ path: absolutePath, type: "file" }, async () => {
		const fileStat = await stat(absolutePath);
		if (!fileStat.isFile()) {
			throw new Error("Path is not a regular file.");
		}
		if (fileStat.size > MAX_WORKDIR_FILE_READ_SIZE) {
			throw new Error(`File exceeds the ${MAX_WORKDIR_FILE_READ_SIZE} byte read limit.`);
		}
		if (fileStat.size > MAX_WORKDIR_FILE_EDIT_SIZE) {
			throw new Error(WORKDIR_FILE_TOO_LARGE_TO_EDIT_MESSAGE);
		}

		const currentBuffer = await readFile(absolutePath);
		if (isBinaryWorkdirFileBuffer(currentBuffer)) {
			throw new Error("Cannot edit binary files.");
		}
		if (createWorkdirFileContentHash(currentBuffer) !== expectedContentHash) {
			throw new WorkdirFileConflictError();
		}

		const nextBuffer = Buffer.from(content, "utf8");
		if (nextBuffer.length > MAX_WORKDIR_FILE_EDIT_SIZE) {
			throw new Error(WORKDIR_FILE_TOO_LARGE_TO_EDIT_MESSAGE);
		}

		await lockedFileSystem.writeTextFileAtomic(absolutePath, content, { lock: null, mode: fileStat.mode & 0o7777 });
		return {
			content,
			language: detectWorkdirFileLanguage(normalizedPath),
			binary: false,
			size: nextBuffer.length,
			truncated: false,
			contentHash: createWorkdirFileContentHash(nextBuffer),
			editable: true,
		};
	});
}
