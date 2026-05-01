import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { RuntimeWorkdirEntryKind, RuntimeWorkdirEntryMutationResponse } from "../core";
import { lockedFileSystem } from "../fs";
import { isNodeError } from "../fs/node-error";
import { invalidateWorkdirFileListCache } from "./search-workdir-files";
import { assertMutableWorkdirPath, normalizeWorkdirRelativePath } from "./workdir-path-policy";

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw error;
	}
}

async function resolveWorkdirPathForMutation(worktreePath: string, relativePath: string): Promise<string> {
	const normalized = normalizeWorkdirRelativePath(relativePath);
	assertMutableWorkdirPath(normalized);
	const absolutePath = resolve(worktreePath, normalized);
	const rel = relative(worktreePath, absolutePath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Path resolves outside the worktree.");
	}

	const realWorktree = await realpath(worktreePath);
	let realParent: string;
	try {
		realParent = await realpath(dirname(absolutePath));
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			throw new Error("Parent folder does not exist.");
		}
		throw error;
	}
	const realParentRel = relative(realWorktree, realParent);
	if (realParentRel.startsWith("..") || isAbsolute(realParentRel)) {
		throw new Error("Path resolves outside the worktree.");
	}
	return absolutePath;
}

async function assertEntryKind(path: string, kind: RuntimeWorkdirEntryKind): Promise<void> {
	const info = await lstat(path);
	if (kind === "directory") {
		if (!info.isDirectory()) {
			throw new Error("Path is not a directory.");
		}
		return;
	}
	if (info.isDirectory()) {
		throw new Error("Path is a directory.");
	}
}

function mutationResponse(path: string, kind: RuntimeWorkdirEntryKind): RuntimeWorkdirEntryMutationResponse {
	return { ok: true, path, kind };
}

export async function createWorkdirEntry(
	worktreePath: string,
	relativePath: string,
	kind: RuntimeWorkdirEntryKind,
): Promise<RuntimeWorkdirEntryMutationResponse> {
	const normalizedPath = normalizeWorkdirRelativePath(relativePath);
	const absolutePath = await resolveWorkdirPathForMutation(worktreePath, normalizedPath);
	await lockedFileSystem.withLock({ path: absolutePath, type: "file" }, async () => {
		if (await pathExists(absolutePath)) {
			throw new Error("Path already exists.");
		}
		if (kind === "directory") {
			await mkdir(absolutePath);
		} else {
			await writeFile(absolutePath, "", { encoding: "utf8", flag: "wx" });
		}
	});
	invalidateWorkdirFileListCache(worktreePath);
	return mutationResponse(normalizedPath, kind);
}

export async function renameWorkdirEntry(
	worktreePath: string,
	relativePath: string,
	nextRelativePath: string,
	kind: RuntimeWorkdirEntryKind,
): Promise<RuntimeWorkdirEntryMutationResponse> {
	const normalizedPath = normalizeWorkdirRelativePath(relativePath);
	const normalizedNextPath = normalizeWorkdirRelativePath(nextRelativePath);
	if (normalizedPath === normalizedNextPath) {
		return mutationResponse(normalizedNextPath, kind);
	}
	const absolutePath = await resolveWorkdirPathForMutation(worktreePath, normalizedPath);
	const nextAbsolutePath = await resolveWorkdirPathForMutation(worktreePath, normalizedNextPath);
	await lockedFileSystem.withLocks(
		[
			{ path: absolutePath, type: "file" },
			{ path: nextAbsolutePath, type: "file" },
		],
		async () => {
			await assertEntryKind(absolutePath, kind);
			if (await pathExists(nextAbsolutePath)) {
				throw new Error("Destination path already exists.");
			}
			if (kind === "directory") {
				const nestedRel = relative(absolutePath, nextAbsolutePath);
				if (!nestedRel || (!nestedRel.startsWith("..") && !isAbsolute(nestedRel))) {
					throw new Error("Cannot move a directory inside itself.");
				}
			}
			await rename(absolutePath, nextAbsolutePath);
		},
	);
	invalidateWorkdirFileListCache(worktreePath);
	return mutationResponse(normalizedNextPath, kind);
}

export async function deleteWorkdirEntry(
	worktreePath: string,
	relativePath: string,
	kind: RuntimeWorkdirEntryKind,
): Promise<RuntimeWorkdirEntryMutationResponse> {
	const normalizedPath = normalizeWorkdirRelativePath(relativePath);
	const absolutePath = await resolveWorkdirPathForMutation(worktreePath, normalizedPath);
	await lockedFileSystem.withLock({ path: absolutePath, type: "file" }, async () => {
		await assertEntryKind(absolutePath, kind);
		await rm(absolutePath, { recursive: kind === "directory", force: false });
	});
	invalidateWorkdirFileListCache(worktreePath);
	return mutationResponse(normalizedPath, kind);
}
