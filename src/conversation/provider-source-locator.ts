import { constants, type Dir, type Dirent } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import type { ConversationReadLimits } from "./limits.js";
import type {
	ConversationProviderId,
	ConversationReadAccounting,
	ConversationSourceLocatorInput,
	ConversationSourceLookup,
	ValidatedConversationSource,
} from "./types.js";

const MAX_SOURCE_LOOKUP_DEPTH = 12;

export interface ConversationHistoryRoots {
	claude: readonly string[];
	codex: readonly string[];
}

export function resolveDefaultConversationHistoryRoots(input?: {
	homeDirectory?: string;
	environment?: Readonly<NodeJS.ProcessEnv>;
}): ConversationHistoryRoots {
	const environment = input?.environment ?? process.env;
	const homeDirectory = input?.homeDirectory ?? homedir();
	const claudeConfigDirectory = environment.CLAUDE_CONFIG_DIR?.trim() || join(homeDirectory, ".claude");
	const codexHome = environment.CODEX_HOME?.trim() || join(homeDirectory, ".codex");
	return {
		claude: [join(claudeConfigDirectory, "projects")],
		codex: [join(codexHome, "sessions"), join(codexHome, "archived_sessions")],
	};
}

function emptyAccounting(): ConversationReadAccounting {
	return { sourceBytesExamined: 0, recordsExamined: 0, lookupEntriesExamined: 0 };
}

function isMissingPathError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";
}

function isPathWithinRoot(path: string, root: string): boolean {
	const relativePath = relative(root, path);
	return (
		relativePath.length > 0 &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`) &&
		!isAbsolute(relativePath)
	);
}

function isSafeSessionId(sessionId: string): boolean {
	const hasUnsafeControl = [...sessionId].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 31 || codePoint === 127;
	});
	return (
		sessionId.length > 0 &&
		sessionId.length <= 512 &&
		!sessionId.includes("/") &&
		!sessionId.includes("\\") &&
		!hasUnsafeControl &&
		sessionId !== "." &&
		sessionId !== ".."
	);
}

function matchesProviderFilename(providerId: ConversationProviderId, filename: string, sessionId: string): boolean {
	if (providerId === "claude") {
		return filename === `${sessionId}.jsonl`;
	}
	return filename === `${sessionId}.jsonl` || filename.endsWith(`-${sessionId}.jsonl`);
}

async function resolveCanonicalRoots(roots: readonly string[]): Promise<string[]> {
	const canonicalRoots: string[] = [];
	for (const root of roots) {
		if (!root.trim() || !isAbsolute(root)) {
			continue;
		}
		try {
			const canonicalRoot = await realpath(root);
			const rootStat = await stat(canonicalRoot);
			if (rootStat.isDirectory() && !canonicalRoots.includes(canonicalRoot)) {
				canonicalRoots.push(canonicalRoot);
			}
		} catch {
			// Provider roots are optional until that provider has persisted a session.
		}
	}
	return canonicalRoots;
}

type CandidateValidation =
	| { status: "available"; source: ValidatedConversationSource }
	| {
			status: "invalid_source";
			reason: "source_not_regular_file" | "source_outside_allowed_roots" | "source_path_invalid";
	  }
	| { status: "missing" };

async function validateAndOpenCandidate(input: {
	providerId: ConversationProviderId;
	providerSessionId: string;
	sourcePath: string;
	canonicalRoots: readonly string[];
}): Promise<CandidateValidation> {
	if (!input.sourcePath.trim() || !isAbsolute(input.sourcePath)) {
		return { status: "invalid_source", reason: "source_path_invalid" };
	}

	let canonicalPath: string;
	try {
		canonicalPath = await realpath(input.sourcePath);
	} catch (error) {
		return isMissingPathError(error)
			? { status: "missing" }
			: { status: "invalid_source", reason: "source_path_invalid" };
	}
	const canonicalRoot = input.canonicalRoots.find((root) => isPathWithinRoot(canonicalPath, root));
	if (!canonicalRoot) {
		return { status: "invalid_source", reason: "source_outside_allowed_roots" };
	}

	let pathStat: Awaited<ReturnType<typeof stat>>;
	try {
		pathStat = await stat(canonicalPath);
	} catch (error) {
		return isMissingPathError(error)
			? { status: "missing" }
			: { status: "invalid_source", reason: "source_path_invalid" };
	}
	if (!pathStat.isFile()) {
		return { status: "invalid_source", reason: "source_not_regular_file" };
	}

	let fileHandle: Awaited<ReturnType<typeof open>>;
	try {
		fileHandle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		return isMissingPathError(error)
			? { status: "missing" }
			: { status: "invalid_source", reason: "source_path_invalid" };
	}
	try {
		const fileStat = await fileHandle.stat();
		if (!fileStat.isFile()) {
			await fileHandle.close();
			return { status: "invalid_source", reason: "source_not_regular_file" };
		}
		if (fileStat.dev !== pathStat.dev || fileStat.ino !== pathStat.ino) {
			await fileHandle.close();
			return { status: "invalid_source", reason: "source_path_invalid" };
		}
		if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
			await fileHandle.close();
			return { status: "invalid_source", reason: "source_path_invalid" };
		}
		return {
			status: "available",
			source: {
				providerId: input.providerId,
				providerSessionId: input.providerSessionId,
				canonicalPath,
				canonicalRoot,
				fileHandle,
				fileSize: fileStat.size,
			},
		};
	} catch (error) {
		await fileHandle.close().catch(() => undefined);
		return isMissingPathError(error)
			? { status: "missing" }
			: { status: "invalid_source", reason: "source_path_invalid" };
	}
}

interface DirectorySearchResult {
	candidatePaths: string[];
	lookupEntriesExamined: number;
	limitReached: boolean;
	deadlineReached: boolean;
}

async function findCandidatePaths(input: {
	providerId: ConversationProviderId;
	providerSessionId: string;
	canonicalRoots: readonly string[];
	maxLookupEntries: number;
	deadlineAt: number;
}): Promise<DirectorySearchResult> {
	const queue = input.canonicalRoots.map((root) => ({ path: root, depth: 0 }));
	const candidatePaths: string[] = [];
	let lookupEntriesExamined = 0;

	while (queue.length > 0) {
		if (Date.now() > input.deadlineAt) {
			return { candidatePaths, lookupEntriesExamined, limitReached: false, deadlineReached: true };
		}
		const current = queue.shift();
		if (!current) {
			break;
		}
		let directory: Dir;
		try {
			directory = await opendir(current.path);
		} catch {
			continue;
		}
		const entries: Dirent[] = [];
		try {
			for await (const entry of directory) {
				if (Date.now() > input.deadlineAt) {
					return { candidatePaths, lookupEntriesExamined, limitReached: false, deadlineReached: true };
				}
				lookupEntriesExamined += 1;
				if (lookupEntriesExamined > input.maxLookupEntries) {
					return {
						candidatePaths,
						lookupEntriesExamined: input.maxLookupEntries,
						limitReached: true,
						deadlineReached: false,
					};
				}
				entries.push(entry);
			}
		} catch {
			continue;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		const childDirectories: Array<{ path: string; depth: number }> = [];
		for (const entry of entries) {
			const entryPath = join(current.path, entry.name);
			if (
				(entry.isFile() || entry.isSymbolicLink()) &&
				matchesProviderFilename(input.providerId, entry.name, input.providerSessionId)
			) {
				candidatePaths.push(entryPath);
			}
			if (entry.isDirectory() && current.depth < MAX_SOURCE_LOOKUP_DEPTH) {
				childDirectories.push({ path: entryPath, depth: current.depth + 1 });
			}
		}
		if (candidatePaths.length > 0) {
			return { candidatePaths, lookupEntriesExamined, limitReached: false, deadlineReached: false };
		}
		queue.unshift(...childDirectories);
	}

	return { candidatePaths, lookupEntriesExamined, limitReached: false, deadlineReached: false };
}

export class ProviderConversationSourceLocator {
	constructor(
		private readonly providerId: ConversationProviderId,
		private readonly roots: readonly string[],
		private readonly limits: Readonly<ConversationReadLimits>,
	) {}

	async locate(input: ConversationSourceLocatorInput): Promise<ConversationSourceLookup> {
		const accounting = emptyAccounting();
		if (!isSafeSessionId(input.providerSessionId)) {
			return { status: "invalid_source", reason: "source_path_invalid", accounting };
		}
		if (Date.now() > input.deadlineAt) {
			return { status: "unavailable", reason: "deadline_exceeded", accounting };
		}
		const canonicalRoots = await resolveCanonicalRoots(this.roots);
		if (Date.now() > input.deadlineAt) {
			return { status: "unavailable", reason: "deadline_exceeded", accounting };
		}
		if (canonicalRoots.length === 0) {
			return { status: "unavailable", reason: "source_root_unavailable", accounting };
		}

		let retainedInvalidReason: Extract<ConversationSourceLookup, { status: "invalid_source" }>["reason"] | null =
			null;
		const hintPath =
			input.hint?.providerId === this.providerId &&
			input.hint.providerSessionId === input.providerSessionId &&
			matchesProviderFilename(this.providerId, basename(input.hint.sourcePath), input.providerSessionId)
				? input.hint.sourcePath
				: null;
		if (hintPath) {
			const hintValidation = await validateAndOpenCandidate({
				providerId: this.providerId,
				providerSessionId: input.providerSessionId,
				sourcePath: hintPath,
				canonicalRoots,
			});
			if (hintValidation.status === "available") {
				if (Date.now() > input.deadlineAt) {
					await hintValidation.source.fileHandle.close().catch(() => undefined);
					return { status: "unavailable", reason: "deadline_exceeded", accounting };
				}
				return { status: "available", source: hintValidation.source, accounting };
			}
			if (hintValidation.status === "invalid_source") {
				retainedInvalidReason = hintValidation.reason;
			}
		}

		if (
			input.hint &&
			input.hint.providerId === this.providerId &&
			input.hint.providerSessionId === input.providerSessionId &&
			!hintPath
		) {
			retainedInvalidReason = "source_path_invalid";
		}

		const search = await findCandidatePaths({
			providerId: this.providerId,
			providerSessionId: input.providerSessionId,
			canonicalRoots,
			maxLookupEntries: this.limits.maxLookupEntries,
			deadlineAt: input.deadlineAt,
		});
		accounting.lookupEntriesExamined = search.lookupEntriesExamined;

		for (const candidatePath of new Set(search.candidatePaths)) {
			if (Date.now() > input.deadlineAt) {
				return { status: "unavailable", reason: "deadline_exceeded", accounting };
			}
			const validation = await validateAndOpenCandidate({
				providerId: this.providerId,
				providerSessionId: input.providerSessionId,
				sourcePath: candidatePath,
				canonicalRoots,
			});
			if (validation.status === "available") {
				if (Date.now() > input.deadlineAt) {
					await validation.source.fileHandle.close().catch(() => undefined);
					return { status: "unavailable", reason: "deadline_exceeded", accounting };
				}
				return { status: "available", source: validation.source, accounting };
			}
			if (validation.status === "invalid_source") {
				retainedInvalidReason ??= validation.reason;
			}
		}

		if (retainedInvalidReason) {
			return { status: "invalid_source", reason: retainedInvalidReason, accounting };
		}
		if (search.deadlineReached) {
			return { status: "unavailable", reason: "deadline_exceeded", accounting };
		}
		if (search.limitReached) {
			return { status: "unavailable", reason: "source_lookup_limit", accounting };
		}
		return { status: "source_missing", reason: "source_not_found", accounting };
	}
}
