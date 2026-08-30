import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";

import { areFileSystemPathsEqual, isFileSystemPathWithin } from "../core/path-comparison";

interface ReadOnlyFileOpenConstants {
	O_RDONLY: number;
	O_NOFOLLOW?: number;
}

export type ValidatedFileOpenFailureReason = "not_regular_file" | "path_changed";

export type ValidatedFileOpenResult =
	| { status: "opened"; fileHandle: FileHandle; fileStat: Stats }
	| { status: "invalid"; reason: ValidatedFileOpenFailureReason };

/**
 * Windows does not expose `O_NOFOLLOW`. The pre/post-open canonical path and
 * identity checks in {@link openValidatedContainedRegularFile} provide the
 * cross-platform replacement there.
 */
export function resolveReadOnlyFileOpenFlags(
	platform: NodeJS.Platform = process.platform,
	openConstants: ReadOnlyFileOpenConstants = constants,
): number {
	return platform === "win32" || typeof openConstants.O_NOFOLLOW !== "number"
		? openConstants.O_RDONLY
		: openConstants.O_RDONLY | openConstants.O_NOFOLLOW;
}

function fileIdentitiesMatch(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export async function validateOpenedContainedRegularFile(input: {
	canonicalRoot: string;
	canonicalPath: string;
	pathStat: Stats;
	fileHandle: FileHandle;
	platform?: NodeJS.Platform;
}): Promise<{ status: "valid"; fileStat: Stats } | { status: "invalid"; reason: ValidatedFileOpenFailureReason }> {
	const platform = input.platform ?? process.platform;
	const fileStat = await input.fileHandle.stat();
	if (!fileStat.isFile()) {
		return { status: "invalid", reason: "not_regular_file" };
	}
	if (!fileIdentitiesMatch(fileStat, input.pathStat)) {
		return { status: "invalid", reason: "path_changed" };
	}

	const postOpenCanonicalPath = await realpath(input.canonicalPath);
	if (
		!areFileSystemPathsEqual(input.canonicalPath, postOpenCanonicalPath, platform) ||
		areFileSystemPathsEqual(input.canonicalRoot, postOpenCanonicalPath, platform) ||
		!isFileSystemPathWithin(input.canonicalRoot, postOpenCanonicalPath, platform)
	) {
		return { status: "invalid", reason: "path_changed" };
	}

	const postOpenPathStat = await lstat(input.canonicalPath);
	if (!postOpenPathStat.isFile() || !fileIdentitiesMatch(fileStat, postOpenPathStat)) {
		return { status: "invalid", reason: "path_changed" };
	}
	return { status: "valid", fileStat };
}

/**
 * Opens a pre-canonicalized regular file only when its path remains inside the
 * approved canonical root and still names the exact file held by the handle.
 * Invalid results always return with the handle closed.
 */
export async function openValidatedContainedRegularFile(input: {
	canonicalRoot: string;
	canonicalPath: string;
	platform?: NodeJS.Platform;
	openFlags?: number;
}): Promise<ValidatedFileOpenResult> {
	const platform = input.platform ?? process.platform;
	if (
		areFileSystemPathsEqual(input.canonicalRoot, input.canonicalPath, platform) ||
		!isFileSystemPathWithin(input.canonicalRoot, input.canonicalPath, platform)
	) {
		return { status: "invalid", reason: "path_changed" };
	}

	const pathStat = await lstat(input.canonicalPath);
	if (!pathStat.isFile()) {
		return { status: "invalid", reason: "not_regular_file" };
	}

	const fileHandle = await open(input.canonicalPath, input.openFlags ?? resolveReadOnlyFileOpenFlags(platform));
	try {
		const validation = await validateOpenedContainedRegularFile({
			canonicalRoot: input.canonicalRoot,
			canonicalPath: input.canonicalPath,
			pathStat,
			fileHandle,
			platform,
		});
		if (validation.status === "invalid") {
			await fileHandle.close();
			return validation;
		}
		return { status: "opened", fileHandle, fileStat: validation.fileStat };
	} catch (error) {
		await fileHandle.close().catch(() => undefined);
		throw error;
	}
}
