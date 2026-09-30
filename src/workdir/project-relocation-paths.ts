import { lstat, realpath, stat } from "node:fs/promises";
import { join, posix, relative, resolve, win32 } from "node:path";

import { areFileSystemPathsEqual, isFileSystemPathWithin, isWindowsSafePathComponent } from "../core";
import { isNodeError } from "../fs/node-error";
import type { ProjectDirectoryIdentity } from "../state/project-state-index";

export async function readProjectDirectoryIdentity(path: string): Promise<ProjectDirectoryIdentity> {
	const entry = await stat(path, { bigint: true });
	if (!entry.isDirectory()) throw new Error("The selected path is not a folder.");
	return { device: entry.dev.toString(), inode: entry.ino.toString() };
}

export function sameProjectDirectoryIdentity(left: ProjectDirectoryIdentity, right: ProjectDirectoryIdentity): boolean {
	return left.device === right.device && left.inode === right.inode;
}

export async function projectPathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return false;
		throw error;
	}
}

/** Only paths owned by the moved root change; sibling prefixes are unrelated. */
export function relocateProjectPath(path: string, oldPath: string, newPath: string): string {
	return isFileSystemPathWithin(oldPath, path) ? join(newPath, relative(oldPath, path)) : path;
}

export function resolveRenamedProjectPath(
	oldPath: string,
	folderName: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const pathApi = platform === "win32" ? win32 : posix;
	if (
		!folderName.trim() ||
		folderName !== folderName.trim() ||
		folderName === "." ||
		folderName === ".." ||
		/[\\/]/u.test(folderName) ||
		[...folderName].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
		(platform === "win32" && !isWindowsSafePathComponent(folderName))
	) {
		throw new Error("Enter one valid folder name without path separators.");
	}
	if (areFileSystemPathsEqual(pathApi.dirname(oldPath), oldPath, platform))
		throw new Error("A filesystem root cannot be renamed.");
	if (pathApi.basename(oldPath) === folderName) throw new Error("The folder already has that name.");
	return pathApi.join(pathApi.dirname(oldPath), folderName);
}

export function isCaseOnlyProjectRename(oldPath: string, newPath: string): boolean {
	return oldPath !== newPath && oldPath.toLowerCase() === newPath.toLowerCase();
}

export async function canonicalProjectDirectory(path: string): Promise<string> {
	if (!path.trim()) throw new Error("Select a project folder.");
	const canonical = await realpath(resolve(path));
	await readProjectDirectoryIdentity(canonical);
	return canonical;
}
