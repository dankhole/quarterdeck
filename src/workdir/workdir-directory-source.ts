import type { Dir } from "node:fs";
import { opendir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { isFileSystemPathWithin, normalizeFileSystemPathForComparison } from "../core";
import { limitBulkFsCall } from "../fs/bulk-fs-limit";
import { isGitCommandIndeterminate, runGit, validateGitRef } from "./git-utils";

// Node may synchronously stat unknown dirent types within this buffer. The shared
// gate bounds asynchronous filesystem admission, not all event-loop work.
const DIRECTORY_BUFFER_SIZE = 32;

export interface WorkdirDirectoryChild {
	readonly name: string;
	/** Symlinks and other non-directories are leaves, never traversal roots. */
	readonly isDirectory: boolean;
}

/** Incremental enumeration of one directory's immediate children. */
export interface WorkdirDirectoryChildSource {
	/** Approximate memory retained by buffered entries. */
	readonly retainedBytes: number;
	next(): Promise<WorkdirDirectoryChild | null>;
	/** Idempotent; safe after exhaustion or failure. */
	close(): Promise<void>;
}

export type WorkdirDirectorySourceErrorCode = "not_found" | "outside_root" | "git_unavailable";

export class WorkdirDirectorySourceError extends Error {
	constructor(
		readonly code: WorkdirDirectorySourceErrorCode,
		message: string,
	) {
		super(message);
		this.name = "WorkdirDirectorySourceError";
	}
}

function isMissingDirectoryError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function comparableCanonicalPath(path: string): string {
	const normalized = normalizeFileSystemPathForComparison(path);
	// APFS/HFS+ are normalization- and (by default) case-insensitive. This comparison only
	// decides whether a lexical path traverses a symlink; containment is checked separately.
	return process.platform === "darwin" ? normalized.normalize("NFC").toLowerCase() : normalized;
}

async function resolveContainedDirectory(cwd: string, directory: string): Promise<string> {
	if (!directory) return cwd;
	const [canonicalRoot, canonicalTarget] = await Promise.all([
		limitBulkFsCall(() => realpath(cwd)),
		limitBulkFsCall(() => realpath(join(cwd, directory))),
	]);
	if (!isFileSystemPathWithin(canonicalRoot, canonicalTarget)) {
		throw new WorkdirDirectorySourceError("outside_root", "Directory resolves outside the worktree.");
	}
	// Symlinked directories are listed as leaves, so a path through one is not browsable.
	if (comparableCanonicalPath(canonicalTarget) !== comparableCanonicalPath(join(canonicalRoot, directory))) {
		throw new WorkdirDirectorySourceError("outside_root", "Directory path traverses a symbolic link.");
	}
	return canonicalTarget;
}

class FileSystemDirectoryChildSource implements WorkdirDirectoryChildSource {
	readonly retainedBytes = 0;
	#closed = false;

	constructor(readonly handle: Dir) {}

	async next(): Promise<WorkdirDirectoryChild | null> {
		if (this.#closed) return null;
		const entry = await limitBulkFsCall(() => this.handle.read());
		return entry ? { name: entry.name, isDirectory: entry.isDirectory() } : null;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await limitBulkFsCall(() => this.handle.close());
	}
}

/**
 * Opens a streaming reader for an absolute directory path the caller already trusts,
 * such as a non-symlink child discovered by enumerating a validated directory.
 */
export async function openDirectoryChildSource(absolutePath: string): Promise<WorkdirDirectoryChildSource> {
	const handle = await limitBulkFsCall(() => opendir(absolutePath, { bufferSize: DIRECTORY_BUFFER_SIZE }));
	return new FileSystemDirectoryChildSource(handle);
}

/** Opens a streaming reader for one directory inside `cwd` without following symlinked paths. */
export async function openWorkdirDirectorySource(cwd: string, directory: string): Promise<WorkdirDirectoryChildSource> {
	try {
		return await openDirectoryChildSource(await resolveContainedDirectory(cwd, directory));
	} catch (error) {
		if (isMissingDirectoryError(error)) {
			throw new WorkdirDirectorySourceError("not_found", "Directory was not found.");
		}
		throw error;
	}
}

class BufferedDirectoryChildSource implements WorkdirDirectoryChildSource {
	readonly retainedBytes: number;
	#index = 0;
	#entries: readonly WorkdirDirectoryChild[];

	constructor(entries: readonly WorkdirDirectoryChild[]) {
		this.#entries = entries;
		this.retainedBytes = entries.reduce((total, entry) => total + entry.name.length * 2 + 16, 0);
	}

	async next(): Promise<WorkdirDirectoryChild | null> {
		return this.#entries[this.#index++] ?? null;
	}

	async close(): Promise<void> {
		this.#entries = [];
	}
}

function gitFailure(result: Parameters<typeof isGitCommandIndeterminate>[0], fallback: string): Error {
	return isGitCommandIndeterminate(result)
		? new WorkdirDirectorySourceError("git_unavailable", "Git did not respond in time; retry.")
		: new Error(fallback);
}

/** Resolves a ref to the immutable tree OID of the scope root (`cwd`) at that ref. */
export async function resolveGitTreeAtRef(cwd: string, ref: string): Promise<string> {
	if (!validateGitRef(ref)) throw new WorkdirDirectorySourceError("not_found", "Git ref was not found.");
	// `<rev>:./` is relative to cwd, so a project rooted in a repository subdirectory resolves its subtree.
	const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}:./`], {
		timeoutClass: "inspection",
		priority: "foreground",
	});
	if (!result.ok) {
		if (!isGitCommandIndeterminate(result) && result.exitCode === 1) {
			throw new WorkdirDirectorySourceError("not_found", "Git ref was not found.");
		}
		throw gitFailure(result, "Could not resolve the Git ref; retry.");
	}
	const treeId = result.stdout.trim();
	if (!/^[0-9a-f]{40,64}$/u.test(treeId)) throw new Error("Git returned an invalid tree identity.");
	return treeId;
}

function parseLsTreeChildren(stdout: string): WorkdirDirectoryChild[] {
	const children: WorkdirDirectoryChild[] = [];
	let offset = 0;
	while (offset < stdout.length) {
		const end = stdout.indexOf("\0", offset);
		if (end < 0) throw new Error("Git tree listing returned incomplete output.");
		const record = stdout.slice(offset, end);
		offset = end + 1;
		const tab = record.indexOf("\t");
		if (tab < 0) throw new Error("Git tree listing returned malformed output.");
		const [, type] = record.slice(0, tab).split(" ");
		const name = record.slice(tab + 1);
		if (!name || name.includes("/")) throw new Error("Git tree listing returned malformed output.");
		// Submodule commits and blobs (including symlinks) are leaves.
		children.push({ name, isDirectory: type === "tree" });
	}
	return children;
}

/**
 * Lists one tree's immediate children. Git output is bounded by the shared Git output
 * limit and buffered, so no Git process is held open between page requests.
 */
export async function openGitTreeDirectorySource(
	cwd: string,
	rootTreeId: string,
	directory: string,
): Promise<WorkdirDirectoryChildSource> {
	const treeish = directory ? `${rootTreeId}:${directory}` : rootTreeId;
	const result = await runGit(cwd, ["ls-tree", "-z", "--full-tree", treeish], {
		trimStdout: false,
		timeoutClass: "inspection",
		priority: "foreground",
	});
	if (!result.ok) {
		if (result.errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			throw new Error("Directory is too large to browse at this ref.");
		}
		if (!isGitCommandIndeterminate(result) && result.exitCode === 128) {
			throw new WorkdirDirectorySourceError("not_found", "Directory was not found at this ref.");
		}
		throw gitFailure(result, "Could not list the Git tree; retry.");
	}
	return new BufferedDirectoryChildSource(parseLsTreeChildren(result.stdout));
}
