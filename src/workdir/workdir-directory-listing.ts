import { randomBytes } from "node:crypto";

import { normalizeFileSystemPathForComparison } from "../core";
import { isBrowseExcludedChildDirectory, resolveWorkdirBrowseDirectory } from "./workdir-browse-policy";
import { readWorkdirDirectoryPage, type WorkdirDirectoryPageFilters } from "./workdir-directory-page";
import {
	openGitTreeDirectorySource,
	openWorkdirDirectorySource,
	resolveGitTreeAtRef,
	type WorkdirDirectoryChildSource,
	WorkdirDirectorySourceError,
} from "./workdir-directory-source";
import { findGitIgnoredDirectories } from "./workdir-git-ignored-directories";

/**
 * Paged listing of one directory's immediate children for the Files browser.
 *
 * Correctness: each snapshot is one incremental enumeration (a filesystem directory
 * handle or a buffered Git tree), read in bounded pages. Policy layered on top: cursor
 * sessions keep that enumeration resumable, first pages are reused briefly so polling
 * does not restart pagination, and all retained resources are bounded. Losing a session
 * (expiry, eviction, invalidation, restart) only restarts the directory with a new
 * snapshot; it is never evidence that entries disappeared.
 */

export const WORKDIR_DIRECTORY_PAGE_LIMITS = { maxVisibleEntries: 500, maxExaminedEntries: 4_096 } as const;
/** A first page (and its snapshot) is reused for identical requests within this window. */
export const WORKDIR_DIRECTORY_FIRST_PAGE_REUSE_MS = 30_000;
/** Sessions idle this long are closed; their cursors then restart the directory. */
export const WORKDIR_DIRECTORY_SESSION_IDLE_MS = 60_000;
export const WORKDIR_DIRECTORY_MAX_OPEN_HANDLES = 32;
const MAX_SESSIONS = 256;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_PAGE_OPERATIONS = 64;
const SWEEP_INTERVAL_MS = 5_000;
/** Page 0 serves polling reuse; the last two computed pages serve duplicate cursor replays. */
const REPLAY_PAGES_RETAINED = 2;
const MAX_FIRST_PAGE_ATTEMPTS = 3;
const CURSOR_PATTERN = /^([A-Za-z0-9_-]{22})\.([1-9][0-9]{0,8})$/u;

export interface WorkdirDirectoryListingRequest {
	readonly cwd: string;
	/** Root-relative directory; `""` or undefined is the root. Validated here. */
	readonly directory: string | undefined;
	readonly cursor?: string;
	readonly showExcluded: boolean;
	/** False for folder projects: no Git commands, even when a `.git` directory exists. */
	readonly useGitIgnores: boolean;
	/** Read-only Git ref; mutually exclusive with working-tree listing. */
	readonly ref: string | null;
}

export interface WorkdirDirectoryListingPage {
	readonly directory: string;
	readonly files: string[];
	readonly directories: string[];
	readonly hiddenCount: number;
	readonly snapshotId: string;
	readonly nextCursor: string | null;
}

export type WorkdirDirectoryListingErrorCode =
	| "invalid_directory"
	| "blocked_directory"
	| "excluded_directory"
	| "not_found"
	| "invalid_cursor"
	| "busy";

export class WorkdirDirectoryListingError extends Error {
	constructor(
		readonly code: WorkdirDirectoryListingErrorCode,
		message: string,
	) {
		super(message);
		this.name = "WorkdirDirectoryListingError";
	}
}

interface ListingScope {
	readonly cwd: string;
	readonly cwdKey: string;
	readonly directory: string;
	/** Identity a cursor must match: cwd, mode, view toggle, ref name, and directory. */
	readonly scopeKey: string;
	readonly treeId: string | null;
	readonly filters: WorkdirDirectoryPageFilters;
}

interface ListingSession {
	readonly token: string;
	readonly snapshotId: string;
	readonly scope: ListingScope;
	readonly firstPageKey: string;
	readonly createdAt: number;
	lastAccessAt: number;
	source: WorkdirDirectoryChildSource | null;
	holdsHandleSlot: boolean;
	nextPageIndex: number;
	readonly pages: Map<number, { page: WorkdirDirectoryListingPage; bytes: number }>;
	retainedBytes: number;
	queue: Promise<unknown>;
	pendingOperations: number;
	closed: boolean;
}

const sessionsByToken = new Map<string, ListingSession>();
const firstPageSessions = new Map<string, ListingSession>();
let openHandleSlots = 0;
let totalRetainedBytes = 0;
/** Admitted listing calls, including ref resolution and root checks before the session queue. */
let pendingListingOperations = 0;
/** Bumped by every invalidation so preflight work begun earlier cannot bind a new snapshot. */
let invalidationEpoch = 0;
/** Identical in-flight ref resolutions share one Git process; entries leave when settled. */
const treeResolutions = new Map<string, Promise<string>>();
let capacityWaiters: Array<() => void> = [];
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function notifyCapacityChanged(): void {
	const waiters = capacityWaiters;
	capacityWaiters = [];
	for (const resolve of waiters) resolve();
}

function waitForCapacityChange(): Promise<void> {
	return new Promise((resolve) => capacityWaiters.push(resolve));
}

function createOpaqueId(): string {
	return randomBytes(16).toString("base64url");
}

function estimatePageBytes(page: WorkdirDirectoryListingPage): number {
	let bytes = 256;
	for (const path of page.files) bytes += path.length * 2 + 32;
	for (const path of page.directories) bytes += path.length * 2 + 32;
	return bytes;
}

function updateRetainedBytes(session: ListingSession): void {
	let bytes = session.source?.retainedBytes ?? 0;
	for (const cached of session.pages.values()) bytes += cached.bytes;
	// Include replay pages before publishing their cursors; otherwise idle eviction
	// can retire this very session and make every continuation restart at page zero.
	reserveRetainedBytes(session, bytes - session.retainedBytes);
	totalRetainedBytes += bytes - session.retainedBytes;
	session.retainedBytes = bytes;
}

function enqueue<Result>(session: ListingSession, operation: () => Promise<Result>): Promise<Result> {
	session.pendingOperations += 1;
	const run = session.queue.then(operation);
	session.queue = run.then(
		() => undefined,
		() => undefined,
	);
	return run.finally(() => {
		session.pendingOperations -= 1;
		if (session.pendingOperations === 0) {
			notifyCapacityChanged();
			// Active sessions cannot be evicted, so recheck the ceiling once one goes idle.
			enforceRetainedBytes();
		}
	});
}

async function closeSessionSource(session: ListingSession): Promise<void> {
	const source = session.source;
	session.source = null;
	try {
		await source?.close();
	} finally {
		if (session.holdsHandleSlot) {
			session.holdsHandleSlot = false;
			openHandleSlots -= 1;
			notifyCapacityChanged();
		}
		if (!session.closed) updateRetainedBytes(session);
	}
}

/** Detaches a session immediately; its handle closes after any operation already running. */
function retireSession(session: ListingSession): Promise<void> {
	if (session.closed) return session.queue.then(() => undefined);
	session.closed = true;
	sessionsByToken.delete(session.token);
	if (firstPageSessions.get(session.firstPageKey) === session) firstPageSessions.delete(session.firstPageKey);
	totalRetainedBytes -= session.retainedBytes;
	session.retainedBytes = 0;
	session.pages.clear();
	if (sessionsByToken.size === 0 && sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = null;
	}
	return enqueue(session, () => closeSessionSource(session)).catch(() => undefined);
}

function leastRecentlyUsedIdleSession(
	predicate: (session: ListingSession) => boolean,
	except?: ListingSession,
): ListingSession | null {
	let candidate: ListingSession | null = null;
	for (const session of sessionsByToken.values()) {
		if (session === except || session.pendingOperations > 0 || !predicate(session)) continue;
		if (!candidate || session.lastAccessAt < candidate.lastAccessAt) candidate = session;
	}
	return candidate;
}

async function acquireHandleSlot(session: ListingSession): Promise<boolean> {
	while (openHandleSlots >= WORKDIR_DIRECTORY_MAX_OPEN_HANDLES) {
		if (session.closed) return false;
		const idleHolder = leastRecentlyUsedIdleSession((candidate) => candidate.holdsHandleSlot, session);
		if (idleHolder) await retireSession(idleHolder);
		else await waitForCapacityChange();
	}
	if (session.closed) return false;
	openHandleSlots += 1;
	session.holdsHandleSlot = true;
	return true;
}

function enforceRetainedBytes(current?: ListingSession): void {
	while (totalRetainedBytes > MAX_RETAINED_BYTES) {
		const victim = leastRecentlyUsedIdleSession(() => true, current);
		if (!victim) return;
		void retireSession(victim);
	}
}

/** Makes room for a retained-data delta before accounting it, or rejects it. */
function reserveRetainedBytes(session: ListingSession, bytes: number): void {
	if (session.retainedBytes + bytes > MAX_RETAINED_BYTES)
		throw new Error("Directory is too large to browse at this ref.");
	while (totalRetainedBytes + bytes > MAX_RETAINED_BYTES) {
		const victim = leastRecentlyUsedIdleSession(() => true, session);
		if (!victim)
			throw new WorkdirDirectoryListingError("busy", "Too many directory listings are in progress; retry.");
		void retireSession(victim);
	}
}

function sweepIdleSessions(): void {
	const now = Date.now();
	for (const session of [...sessionsByToken.values()]) {
		if (session.pendingOperations === 0 && now - session.lastAccessAt >= WORKDIR_DIRECTORY_SESSION_IDLE_MS) {
			void retireSession(session);
		}
	}
}

function toListingError(error: unknown): unknown {
	if (!(error instanceof WorkdirDirectorySourceError)) return error;
	if (error.code === "not_found") return new WorkdirDirectoryListingError("not_found", error.message);
	if (error.code === "outside_root") return new WorkdirDirectoryListingError("blocked_directory", error.message);
	return error;
}

/** Opens and accounts the session source. False means the session closed first. */
async function openSource(session: ListingSession): Promise<boolean> {
	const { scope } = session;
	if (scope.treeId) {
		const source = await openGitTreeDirectorySource(scope.cwd, scope.treeId, scope.directory);
		if (session.closed) {
			await source.close();
			return false;
		}
		try {
			reserveRetainedBytes(session, source.retainedBytes);
		} catch (error) {
			await source.close();
			throw error;
		}
		session.source = source;
		updateRetainedBytes(session);
		return true;
	}
	if (!(await acquireHandleSlot(session))) return false;
	try {
		// Assigned even if the session closed meanwhile, so its queued retirement closes it.
		session.source = await openWorkdirDirectorySource(scope.cwd, scope.directory);
		return !session.closed;
	} catch (error) {
		session.holdsHandleSlot = false;
		openHandleSlots -= 1;
		notifyCapacityChanged();
		throw error;
	}
}

/** Computes the session's next page. Runs inside the session queue. Null means the session closed. */
async function computeNextPage(session: ListingSession): Promise<WorkdirDirectoryListingPage | null> {
	const pageIndex = session.nextPageIndex;
	if (pageIndex === 0 && !(await openSource(session))) return null;
	if (session.closed || !session.source) return null;
	const content = await readWorkdirDirectoryPage(
		session.source,
		session.scope.directory,
		WORKDIR_DIRECTORY_PAGE_LIMITS,
		session.scope.filters,
	);
	if (content.exhausted) await closeSessionSource(session);
	// Invalidation may have retired this snapshot while it was being read.
	if (session.closed) return null;
	const page: WorkdirDirectoryListingPage = {
		directory: session.scope.directory,
		files: content.files,
		directories: content.directories,
		hiddenCount: content.hiddenCount,
		snapshotId: session.snapshotId,
		nextCursor: content.exhausted ? null : `${session.token}.${pageIndex + 1}`,
	};
	session.nextPageIndex = pageIndex + 1;
	session.pages.set(pageIndex, { page, bytes: estimatePageBytes(page) });
	for (const cachedIndex of session.pages.keys()) {
		if (cachedIndex !== 0 && cachedIndex <= pageIndex - REPLAY_PAGES_RETAINED) session.pages.delete(cachedIndex);
	}
	updateRetainedBytes(session);
	enforceRetainedBytes(session);
	return page;
}

/** Admits a complete listing call (preflight and page work) or rejects it as retryable. */
async function withListingAdmission<Result>(operation: () => Promise<Result>): Promise<Result> {
	if (pendingListingOperations >= MAX_PENDING_PAGE_OPERATIONS) {
		throw new WorkdirDirectoryListingError("busy", "Too many directory listings are in progress; retry.");
	}
	pendingListingOperations += 1;
	try {
		return await operation();
	} finally {
		pendingListingOperations -= 1;
	}
}

/** Serves a cached page or computes the next one; null when the session cannot serve `pageIndex`. */
async function servePage(session: ListingSession, pageIndex: number): Promise<WorkdirDirectoryListingPage | null> {
	session.lastAccessAt = Date.now();
	try {
		return await enqueue(session, async () => {
			if (session.closed) return null;
			const cached = session.pages.get(pageIndex);
			if (cached) return cached.page;
			if (pageIndex !== session.nextPageIndex) return null;
			try {
				return await computeNextPage(session);
			} catch (error) {
				// A failed enumeration cannot resume reliably; later requests start a new snapshot.
				void retireSession(session);
				throw toListingError(error);
			}
		});
	} finally {
		session.lastAccessAt = Date.now();
	}
}

function createSession(scope: ListingScope, firstPageKey: string): ListingSession {
	if (sessionsByToken.size >= MAX_SESSIONS) {
		const victim = leastRecentlyUsedIdleSession(() => true);
		if (!victim)
			throw new WorkdirDirectoryListingError("busy", "Too many directory listings are in progress; retry.");
		void retireSession(victim);
	}
	const now = Date.now();
	const session: ListingSession = {
		token: createOpaqueId(),
		snapshotId: createOpaqueId(),
		scope,
		firstPageKey,
		createdAt: now,
		lastAccessAt: now,
		source: null,
		holdsHandleSlot: false,
		nextPageIndex: 0,
		pages: new Map(),
		retainedBytes: 0,
		queue: Promise.resolve(),
		pendingOperations: 0,
		closed: false,
	};
	sessionsByToken.set(session.token, session);
	firstPageSessions.set(firstPageKey, session);
	if (!sweepTimer) {
		sweepTimer = setInterval(sweepIdleSessions, SWEEP_INTERVAL_MS);
		sweepTimer.unref?.();
	}
	return session;
}

function resolveListingScope(request: WorkdirDirectoryListingRequest, treeId: string | null): ListingScope {
	const browseOptions = { showExcluded: request.showExcluded };
	const resolved = resolveWorkdirBrowseDirectory(request.directory, browseOptions);
	if (!resolved.ok) {
		const code =
			resolved.reason === "invalid"
				? "invalid_directory"
				: resolved.reason === "skipped"
					? "blocked_directory"
					: "excluded_directory";
		throw new WorkdirDirectoryListingError(code, resolved.message);
	}
	const { directory } = resolved;
	const cwdKey = normalizeFileSystemPathForComparison(request.cwd);
	const useGitIgnores = request.useGitIgnores && request.ref === null;
	const mode = request.ref !== null ? "ref" : request.useGitIgnores ? "git" : "folder";
	return {
		cwd: request.cwd,
		cwdKey,
		directory,
		scopeKey: JSON.stringify([cwdKey, mode, request.ref, request.showExcluded, directory]),
		treeId,
		filters: {
			isExcludedDirectory: (name) => isBrowseExcludedChildDirectory(directory, name, browseOptions),
			...(useGitIgnores ? { findHiddenDirectories: (paths) => findGitIgnoredDirectories(request.cwd, paths) } : {}),
		},
	};
}

function resolveTreeOnce(scope: ListingScope, ref: string): Promise<string> {
	const key = JSON.stringify([scope.cwdKey, ref, invalidationEpoch]);
	const existing = treeResolutions.get(key);
	if (existing) return existing;
	const resolution = resolveGitTreeAtRef(scope.cwd, ref).finally(() => {
		if (treeResolutions.get(key) === resolution) treeResolutions.delete(key);
	});
	treeResolutions.set(key, resolution);
	return resolution;
}

async function listFirstPage(request: WorkdirDirectoryListingRequest): Promise<WorkdirDirectoryListingPage> {
	// Validate before any Git work; ref scopes then bind to the ref's current immutable tree.
	const workingTreeScope = resolveListingScope(request, null);
	for (let attempt = 0; attempt < MAX_FIRST_PAGE_ATTEMPTS; attempt += 1) {
		const epoch = invalidationEpoch;
		let scope = workingTreeScope;
		if (request.ref !== null) {
			let treeId: string;
			try {
				treeId = await resolveTreeOnce(workingTreeScope, request.ref);
			} catch (error) {
				throw toListingError(error);
			}
			// An invalidation during resolution may have moved the ref; resolve it again.
			if (epoch !== invalidationEpoch) continue;
			scope = resolveListingScope(request, treeId);
		}
		const firstPageKey = JSON.stringify([scope.scopeKey, scope.treeId]);
		let session = firstPageSessions.get(firstPageKey);
		if (!session || session.closed || Date.now() - session.createdAt >= WORKDIR_DIRECTORY_FIRST_PAGE_REUSE_MS) {
			// An older session keeps serving its own cursors until idle; new requests get a new snapshot.
			session = createSession(scope, firstPageKey);
		}
		const page = await servePage(session, 0);
		if (page) return page;
	}
	throw new Error("Directory listing was invalidated repeatedly; retry.");
}

function parseCursor(cursor: string): { token: string; pageIndex: number } {
	const match = CURSOR_PATTERN.exec(cursor);
	if (!match?.[1] || !match[2]) throw new WorkdirDirectoryListingError("invalid_cursor", "Invalid file list cursor.");
	return { token: match[1], pageIndex: Number(match[2]) };
}

/**
 * Lists one page of a directory. Without a cursor, returns the (briefly reused) first page.
 * With a cursor, continues that snapshot; a well-formed cursor whose session is gone yields
 * a first page with a different snapshot, which callers must treat as a replacement.
 */
export function listWorkdirDirectoryPage(
	request: WorkdirDirectoryListingRequest,
): Promise<WorkdirDirectoryListingPage> {
	return withListingAdmission(() => listAdmittedPage(request));
}

async function listAdmittedPage(request: WorkdirDirectoryListingRequest): Promise<WorkdirDirectoryListingPage> {
	if (request.cursor === undefined) return await listFirstPage(request);
	const { token, pageIndex } = parseCursor(request.cursor);
	const scope = resolveListingScope(request, null);
	const session = sessionsByToken.get(token);
	if (session) {
		// Never let a cursor carry one scope's authority into another request.
		if (session.scope.scopeKey !== scope.scopeKey) {
			throw new WorkdirDirectoryListingError("invalid_cursor", "File list cursor does not match this directory.");
		}
		const page = await servePage(session, pageIndex);
		if (page) return page;
		// This snapshot cannot continue; make sure the restart does not reuse its snapshot id.
		await retireSession(session);
	}
	return await listFirstPage(request);
}

/** Restarts every listing snapshot for `cwd`; in-flight pages for old snapshots are discarded. */
export function invalidateWorkdirDirectoryListings(cwd: string): void {
	const cwdKey = normalizeFileSystemPathForComparison(cwd);
	invalidationEpoch += 1;
	for (const session of [...sessionsByToken.values()]) {
		if (session.scope.cwdKey === cwdKey) void retireSession(session);
	}
}

export interface WorkdirDirectoryListingSnapshot {
	readonly sessions: number;
	readonly openHandleSlots: number;
	readonly retainedBytes: number;
	readonly pendingPageOperations: number;
}

export function getWorkdirDirectoryListingSnapshot(): WorkdirDirectoryListingSnapshot {
	return {
		sessions: sessionsByToken.size,
		openHandleSlots,
		retainedBytes: totalRetainedBytes,
		pendingPageOperations: pendingListingOperations,
	};
}
