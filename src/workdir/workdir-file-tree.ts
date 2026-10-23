import type { Dir } from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";

import { limitBulkFsCall } from "../fs/bulk-fs-limit";
import { isGitCommandIndeterminate, runGit, validateGitPath } from "./git-utils";
import { hasSkippedWorkdirPathComponent } from "./workdir-path-policy";

export const MAX_WORKDIR_FILE_TREE_ENTRIES = 20_000;
// Node may synchronously stat unknown dirent types within this buffer. The shared
// gate bounds asynchronous filesystem admission, not all event-loop work.
const DIRECTORY_BUFFER_SIZE = 32;

export interface WorkdirFileTree {
	files: string[];
	directories: string[];
}

export interface WorkdirFileTreeOptions {
	useGitIgnores?: boolean;
}

export class WorkdirFileTreeLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkdirFileTreeLimitError";
	}
}

function* readBoundedGitPaths(stdout: string, maxEntries: number): Generator<string> {
	// runGit bounds stdout bytes; scan fields without creating an unbounded split array.
	let offset = 0;
	let count = 0;
	while (offset < stdout.length) {
		const end = stdout.indexOf("\0", offset);
		if (end < 0) throw new Error("File tree ignore discovery returned incomplete Git output.");
		const path = stdout.slice(offset, end);
		offset = end + 1;
		if (++count > maxEntries) {
			throw new WorkdirFileTreeLimitError(`File tree ignore discovery exceeds the ${maxEntries} path limit.`);
		}
		yield path;
	}
}

function ignoredDirectoryLookupKey(path: string): string {
	// Git's core.precomposeUnicode can report NFC while macOS enumeration returns NFD.
	return process.platform === "darwin" ? path.normalize("NFC") : path;
}

async function loadIgnoredDirectories(cwd: string, maxEntries: number): Promise<Set<string>> {
	const result = await runGit(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
		trimStdout: false,
		timeoutClass: "default",
	});
	const directories = new Set<string>();
	if (!result.ok) {
		if (result.errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			throw new WorkdirFileTreeLimitError("File tree ignore discovery exceeds the Git output size limit.");
		}
		if (isGitCommandIndeterminate(result)) throw new Error("Git ignore discovery did not complete; retry.");
		// Only a definite non-repository answer permits an unpruned filesystem walk.
		if (result.failureKind === "command_failed" && /not a git repository/iu.test(result.stderr)) return directories;
		throw new Error("Could not discover Git ignore rules; retry.");
	}

	const candidates = new Set<string>();
	for (const path of readBoundedGitPaths(result.stdout, maxEntries)) {
		if (!path.endsWith("/")) continue;
		const directory = path.slice(0, -1);
		// In subdirectories Git can emit ./; it is not a child to prune.
		if (validateGitPath(directory)) candidates.add(directory);
	}
	if (candidates.size === 0) return directories;

	// ls-files also collapses directories containing only individually ignored files.
	// Prune only candidates whose directory path itself matches an ignore rule.
	const checked = await runGit(cwd, ["check-ignore", "-z", "--stdin"], {
		trimStdout: false,
		timeoutClass: "default",
		// A ./ prefix prevents names beginning with : from becoming Git pathspec magic.
		stdin: [...candidates].map((directory) => `./${directory}/\0`).join(""),
	});
	if (!checked.ok) {
		if (checked.errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			throw new WorkdirFileTreeLimitError("File tree ignore verification exceeds the Git output size limit.");
		}
		if (!isGitCommandIndeterminate(checked) && checked.exitCode === 1 && !checked.stdout) return directories;
		throw new Error("Git ignore directory verification did not complete; retry.");
	}
	for (const path of readBoundedGitPaths(checked.stdout, maxEntries)) {
		if (!path.endsWith("/")) continue;
		const directory = path.slice(path.startsWith("./") ? 2 : 0, -1);
		if (candidates.has(directory)) directories.add(ignoredDirectoryLookupKey(directory));
	}
	return directories;
}

/** Stream a bounded filesystem snapshot; symlinks are leaves, never traversal roots. */
export async function walkWorkdirFileTree(
	cwd: string,
	options: WorkdirFileTreeOptions & { maxEntries?: number } = {},
): Promise<WorkdirFileTree> {
	const maxEntries = options.maxEntries ?? MAX_WORKDIR_FILE_TREE_ENTRIES;
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("Invalid file tree entry limit.");
	const ignoredDirectories =
		options.useGitIgnores === false ? new Set<string>() : await loadIgnoredDirectories(cwd, maxEntries);
	const files: string[] = [];
	const directories: string[] = [];
	const pendingDirectories = [""];
	let visitedEntries = 0;

	for (const parent of pendingDirectories) {
		let directory: Dir;
		try {
			directory = await limitBulkFsCall(() => opendir(join(cwd, parent), { bufferSize: DIRECTORY_BUFFER_SIZE }));
		} catch {
			// Preserve listing behavior for inaccessible or concurrently removed directories.
			continue;
		}
		try {
			while (true) {
				const entry = await limitBulkFsCall(() => directory.read());
				if (!entry) break;
				// Also bound work on skipped entries, which do not consume output slots.
				if (++visitedEntries > maxEntries * 2) {
					throw new WorkdirFileTreeLimitError(
						`File tree traversal exceeds the ${maxEntries * 2} visited entry limit.`,
					);
				}
				const path = parent ? `${parent}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (
						hasSkippedWorkdirPathComponent(entry.name) ||
						ignoredDirectories.has(ignoredDirectoryLookupKey(path))
					)
						continue;
					directories.push(path);
					pendingDirectories.push(path);
				} else {
					files.push(path);
				}
				if (files.length + directories.length > maxEntries) {
					throw new WorkdirFileTreeLimitError(
						`File tree exceeds the ${maxEntries} file and directory entry limit.`,
					);
				}
			}
		} finally {
			await limitBulkFsCall(() => directory.close());
		}
	}

	files.sort();
	directories.sort();
	return { files, directories };
}
