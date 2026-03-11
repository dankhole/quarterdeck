import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import chokidar, { type FSWatcher } from "chokidar";

import type {
	RuntimeGitSyncSummary,
	RuntimeStateStreamWorkspaceGitStatusMessage,
	RuntimeTaskGitStatus,
} from "../core/api-contract.js";
import { loadWorkspaceState } from "../state/workspace-state.js";
import { getGitSyncSummary } from "../workspace/git-sync.js";
import { getTaskWorkspaceInfoForRepoPath } from "../workspace/task-worktree.js";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const WATCH_RECOMPUTE_DEBOUNCE_MS = 180;

interface RecomputeFlags {
	full: boolean;
	dirtyHome: boolean;
	dirtyTaskIds: Set<string>;
}

interface TaskScope {
	taskId: string;
	baseRef: string;
}

interface WorkspaceWatchSession {
	workspaceId: string;
	workspacePath: string;
	subscriberCount: number;
	watcher: FSWatcher;
	watchRoots: Set<string>;
	ignoredRoots: Set<string>;
	homeSummary: RuntimeGitSyncSummary;
	homeStateToken: string;
	homeChangeRevision: number;
	taskStatusesByTaskId: Map<string, RuntimeTaskGitStatus>;
	taskStateTokenByTaskId: Map<string, string>;
	taskScopeByTaskId: Map<string, TaskScope>;
	recomputeTimer: NodeJS.Timeout | null;
	inFlightRecompute: boolean;
	rerunRequested: boolean;
	fullRefreshRequested: boolean;
	dirtyHome: boolean;
	dirtyTaskIds: Set<string>;
}

export interface WorkspaceGitWatchService {
	subscribeWorkspace: (workspaceId: string, workspacePath: string) => Promise<void>;
	unsubscribeWorkspace: (workspaceId: string) => Promise<void>;
	requestRefresh: (workspaceId: string, options?: { full?: boolean; taskId?: string; home?: boolean }) => void;
	disposeWorkspace: (workspaceId: string) => Promise<void>;
	close: () => Promise<void>;
}

export interface CreateWorkspaceGitWatchServiceDependencies {
	broadcastWorkspaceGitStatusUpdated: (payload: RuntimeStateStreamWorkspaceGitStatusMessage) => void;
	warn: (message: string) => void;
}

function createEmptyGitSummary(): RuntimeGitSyncSummary {
	return {
		currentBranch: null,
		upstreamBranch: null,
		changedFiles: 0,
		additions: 0,
		deletions: 0,
		aheadCount: 0,
		behindCount: 0,
	};
}

function toNormalizedPath(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/g, "");
	if (!normalized) {
		return "/";
	}
	return normalized;
}

function isPathWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function isGitMetadataPath(path: string): boolean {
	if (!path.includes("/.git/")) {
		return false;
	}
	if (path.endsWith("/.git/HEAD")) {
		return true;
	}
	if (path.endsWith("/.git/index")) {
		return true;
	}
	if (path.endsWith("/.git/packed-refs")) {
		return true;
	}
	if (path.includes("/.git/refs/")) {
		return true;
	}
	if (path.includes("/.git/worktrees/")) {
		return true;
	}
	return false;
}

function areGitSummariesEqual(left: RuntimeGitSyncSummary, right: RuntimeGitSyncSummary): boolean {
	return (
		left.currentBranch === right.currentBranch &&
		left.upstreamBranch === right.upstreamBranch &&
		left.changedFiles === right.changedFiles &&
		left.additions === right.additions &&
		left.deletions === right.deletions &&
		left.aheadCount === right.aheadCount &&
		left.behindCount === right.behindCount
	);
}

function areTaskStatusesEquivalent(left: RuntimeTaskGitStatus, right: RuntimeTaskGitStatus): boolean {
	return (
		left.taskId === right.taskId &&
		left.baseRef === right.baseRef &&
		left.path === right.path &&
		left.exists === right.exists &&
		left.branch === right.branch &&
		left.isDetached === right.isDetached &&
		left.headCommit === right.headCommit &&
		left.changedFiles === right.changedFiles &&
		left.additions === right.additions &&
		left.deletions === right.deletions
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER_BYTES,
	});
	return String(stdout ?? "").trim();
}

function getRootPaths(paths: string[]): string[] {
	const uniquePaths = Array.from(new Set(paths.filter(Boolean).map((path) => toNormalizedPath(path))));
	uniquePaths.sort((left, right) => {
		const leftDepth = left.split("/").length;
		const rightDepth = right.split("/").length;
		if (leftDepth !== rightDepth) {
			return leftDepth - rightDepth;
		}
		return left.localeCompare(right);
	});
	const roots: string[] = [];
	for (const path of uniquePaths) {
		if (roots.some((root) => isPathWithin(path, root))) {
			continue;
		}
		roots.push(path);
	}
	return roots;
}

async function listIgnoredRootPaths(workspacePath: string): Promise<string[]> {
	let output = "";
	try {
		output = await runGit(workspacePath, [
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"--directory",
		]);
	} catch {
		return [];
	}
	if (!output) {
		return [];
	}
	const relativePaths = output
		.split("\n")
		.map((line) => line.trim().replace(/\/+$/g, ""))
		.filter(Boolean);
	const absolutePaths = relativePaths.map((path) => toNormalizedPath(resolve(workspacePath, path)));
	return getRootPaths(absolutePaths);
}

async function listWorktreePaths(workspacePath: string): Promise<string[]> {
	let output = "";
	try {
		output = await runGit(workspacePath, ["worktree", "list", "--porcelain"]);
	} catch {
		return [toNormalizedPath(workspacePath)];
	}
	const roots = new Set<string>([toNormalizedPath(workspacePath)]);
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("worktree ")) {
			continue;
		}
		const worktreePath = line.slice("worktree ".length).trim();
		if (!worktreePath) {
			continue;
		}
		roots.add(toNormalizedPath(worktreePath));
	}
	const existing = await Promise.all(
		Array.from(roots).map(async (root) => ({
			root,
			exists: await pathExists(root),
		})),
	);
	return existing.filter((entry) => entry.exists).map((entry) => entry.root);
}

function parseTrackedChangedPaths(output: string): string[] {
	const paths: string[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const parts = line.split("\t");
		if (parts.length >= 3) {
			const previousPath = parts[1]?.trim();
			const nextPath = parts[2]?.trim();
			if (previousPath) {
				paths.push(previousPath);
			}
			if (nextPath) {
				paths.push(nextPath);
			}
			continue;
		}
		const path = parts[1]?.trim();
		if (path) {
			paths.push(path);
		}
	}
	return paths;
}

async function buildWorkspaceDiffStateToken(cwd: string): Promise<string> {
	const [headCommit, trackedOutput, untrackedOutput] = await Promise.all([
		runGit(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
		runGit(cwd, ["diff", "--name-status", "HEAD", "--"]).catch(() => ""),
		runGit(cwd, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
	]);

	const changedPaths = new Set<string>([
		...parseTrackedChangedPaths(trackedOutput),
		...untrackedOutput
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	]);

	const fingerprints = await Promise.all(
		Array.from(changedPaths)
			.sort((left, right) => left.localeCompare(right))
			.map(async (relativePath) => {
				const absolutePath = resolve(cwd, relativePath);
				try {
					const fileStat = await stat(absolutePath);
					return `${relativePath}\t${fileStat.size}\t${fileStat.mtimeMs}\t${fileStat.ctimeMs}`;
				} catch {
					return `${relativePath}\tnull\tnull\tnull`;
				}
			}),
	);

	return [headCommit.trim(), trackedOutput, untrackedOutput, fingerprints.join("\n")].join("\n--\n");
}

function buildWorkspaceWatchPayload(session: WorkspaceWatchSession): RuntimeStateStreamWorkspaceGitStatusMessage {
	const tasks = Array.from(session.taskStatusesByTaskId.values()).sort((left, right) => left.taskId.localeCompare(right.taskId));
	return {
		type: "workspace_git_status_updated",
		workspaceId: session.workspaceId,
		homeSummary: session.homeSummary,
		homeChangeRevision: session.homeChangeRevision,
		tasks,
	};
}

async function buildTaskStatus(workspacePath: string, scope: TaskScope): Promise<RuntimeTaskGitStatus> {
	const info = await getTaskWorkspaceInfoForRepoPath({
		repoPath: workspacePath,
		taskId: scope.taskId,
		baseRef: scope.baseRef,
	});
	if (!info.exists) {
		return {
			taskId: scope.taskId,
			baseRef: scope.baseRef,
			path: info.path,
			exists: false,
			branch: info.branch,
			isDetached: info.isDetached,
			headCommit: info.headCommit,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			changeRevision: 0,
		};
	}
	let summary: RuntimeGitSyncSummary;
	try {
		summary = await getGitSyncSummary(info.path);
	} catch {
		summary = createEmptyGitSummary();
	}
	return {
		taskId: scope.taskId,
		baseRef: scope.baseRef,
		path: info.path,
		exists: info.exists,
		branch: info.branch,
		isDetached: info.isDetached,
		headCommit: info.headCommit,
		changedFiles: summary.changedFiles,
		additions: summary.additions,
		deletions: summary.deletions,
		changeRevision: 0,
	};
}

async function buildTaskStatusResult(
	workspacePath: string,
	scope: TaskScope,
): Promise<{ status: RuntimeTaskGitStatus; stateToken: string }> {
	const status = await buildTaskStatus(workspacePath, scope);
	if (!status.exists) {
		return {
			status,
			stateToken: `missing:${status.path}:${status.branch ?? ""}:${status.headCommit ?? ""}`,
		};
	}
	const stateToken = await buildWorkspaceDiffStateToken(status.path).catch(() => "error");
	return {
		status,
		stateToken,
	};
}

function markWorkspaceDirtyFromPath(session: WorkspaceWatchSession, changedPath: string): void {
	const normalizedPath = toNormalizedPath(changedPath);
	if (isGitMetadataPath(normalizedPath)) {
		session.fullRefreshRequested = true;
		session.dirtyHome = true;
		return;
	}

	if (isPathWithin(normalizedPath, toNormalizedPath(session.workspacePath))) {
		session.dirtyHome = true;
	}

	let matchedTask = false;
	for (const [taskId, status] of session.taskStatusesByTaskId.entries()) {
		if (!status.exists) {
			continue;
		}
		if (isPathWithin(normalizedPath, toNormalizedPath(status.path))) {
			session.dirtyTaskIds.add(taskId);
			matchedTask = true;
		}
	}

	if (!matchedTask && !session.dirtyHome) {
		session.fullRefreshRequested = true;
	}
}

export function createWorkspaceGitWatchService(
	deps: CreateWorkspaceGitWatchServiceDependencies,
): WorkspaceGitWatchService {
	const sessionsByWorkspaceId = new Map<string, WorkspaceWatchSession>();

	const scheduleRecompute = (session: WorkspaceWatchSession) => {
		if (session.recomputeTimer) {
			return;
		}
		session.recomputeTimer = setTimeout(() => {
			session.recomputeTimer = null;
			void runRecompute(session);
		}, WATCH_RECOMPUTE_DEBOUNCE_MS);
		session.recomputeTimer.unref();
	};

	const syncWatchRoots = async (session: WorkspaceWatchSession) => {
		const nextRoots = new Set(await listWorktreePaths(session.workspacePath));
		for (const root of nextRoots) {
			if (!session.watchRoots.has(root)) {
				session.watcher.add(root);
			}
		}
		for (const root of session.watchRoots) {
			if (!nextRoots.has(root)) {
				await session.watcher.unwatch(root);
			}
		}
		session.watchRoots = nextRoots;
		const ignoredRootsByWorkspace = await Promise.all(Array.from(session.watchRoots).map(listIgnoredRootPaths));
		session.ignoredRoots = new Set(getRootPaths(ignoredRootsByWorkspace.flat()));
	};

	const runFullTaskRefresh = async (session: WorkspaceWatchSession): Promise<boolean> => {
		let hasChanges = false;
		const workspaceState = await loadWorkspaceState(session.workspacePath, {
			autoCreateIfMissing: false,
		});
		const taskScopeByTaskId = new Map<string, TaskScope>();
		for (const column of workspaceState.board.columns) {
			for (const card of column.cards) {
				if (!taskScopeByTaskId.has(card.id)) {
					taskScopeByTaskId.set(card.id, {
						taskId: card.id,
						baseRef: card.baseRef,
					});
				}
			}
		}

		const nextStatuses = new Map<string, RuntimeTaskGitStatus>();
		const nextStateTokens = new Map<string, string>();
		const nextStatusesArray = await Promise.all(
			Array.from(taskScopeByTaskId.values()).map(
				async (scope) => await buildTaskStatusResult(session.workspacePath, scope),
			),
		);

		for (const nextStatusResult of nextStatusesArray) {
			const nextStatus = nextStatusResult.status;
			const previousStatus = session.taskStatusesByTaskId.get(nextStatus.taskId);
			const previousStateToken = session.taskStateTokenByTaskId.get(nextStatus.taskId) ?? "";
			const statusChanged = !previousStatus || !areTaskStatusesEquivalent(previousStatus, nextStatus);
			const stateTokenChanged = previousStateToken !== nextStatusResult.stateToken;
			const nextRevision = !previousStatus
				? 0
				: statusChanged || stateTokenChanged
					? previousStatus.changeRevision + 1
					: previousStatus.changeRevision;
			nextStatuses.set(nextStatus.taskId, {
				...nextStatus,
				changeRevision: nextRevision,
			});
			nextStateTokens.set(nextStatus.taskId, nextStatusResult.stateToken);
			if (statusChanged || stateTokenChanged) {
				hasChanges = true;
			}
		}

		for (const previousTaskId of session.taskStatusesByTaskId.keys()) {
			if (!nextStatuses.has(previousTaskId)) {
				hasChanges = true;
			}
		}

		session.taskScopeByTaskId = taskScopeByTaskId;
		session.taskStatusesByTaskId = nextStatuses;
		session.taskStateTokenByTaskId = nextStateTokens;
		return hasChanges;
	};

	const runPartialTaskRefresh = async (session: WorkspaceWatchSession, dirtyTaskIds: Set<string>): Promise<boolean> => {
		let hasChanges = false;
		for (const taskId of dirtyTaskIds) {
			const scope = session.taskScopeByTaskId.get(taskId);
			if (!scope) {
				session.fullRefreshRequested = true;
				continue;
			}
			const nextStatusResult = await buildTaskStatusResult(session.workspacePath, scope);
			const nextStatus = nextStatusResult.status;
			const previousStatus = session.taskStatusesByTaskId.get(taskId);
			const previousStateToken = session.taskStateTokenByTaskId.get(taskId) ?? "";
			const statusChanged = !previousStatus || !areTaskStatusesEquivalent(previousStatus, nextStatus);
			const stateTokenChanged = previousStateToken !== nextStatusResult.stateToken;
			const nextRevision = !previousStatus
				? 0
				: statusChanged || stateTokenChanged
					? previousStatus.changeRevision + 1
					: previousStatus.changeRevision;
			const resolved = {
				...nextStatus,
				changeRevision: nextRevision,
			};
			session.taskStatusesByTaskId.set(taskId, resolved);
			session.taskStateTokenByTaskId.set(taskId, nextStatusResult.stateToken);
			if (statusChanged || stateTokenChanged) {
				hasChanges = true;
			}
		}
		return hasChanges;
	};

	const recomputeOnce = async (session: WorkspaceWatchSession, flags: RecomputeFlags): Promise<boolean> => {
		let changed = false;

		if (flags.full) {
			await syncWatchRoots(session);
		}

		if (flags.full || flags.dirtyHome) {
			let nextHomeSummary: RuntimeGitSyncSummary;
			let nextHomeStateToken = "";
			try {
				nextHomeSummary = await getGitSyncSummary(session.workspacePath);
			} catch {
				nextHomeSummary = createEmptyGitSummary();
			}
			try {
				nextHomeStateToken = await buildWorkspaceDiffStateToken(session.workspacePath);
			} catch {
				nextHomeStateToken = "error";
			}
			if (
				!areGitSummariesEqual(session.homeSummary, nextHomeSummary) ||
				session.homeStateToken !== nextHomeStateToken
			) {
				session.homeSummary = nextHomeSummary;
				session.homeStateToken = nextHomeStateToken;
				session.homeChangeRevision += 1;
				changed = true;
			}
		}

		if (flags.full) {
			changed = (await runFullTaskRefresh(session)) || changed;
		} else if (flags.dirtyTaskIds.size > 0) {
			changed = (await runPartialTaskRefresh(session, flags.dirtyTaskIds)) || changed;
		}

		if (changed || flags.full) {
			deps.broadcastWorkspaceGitStatusUpdated(buildWorkspaceWatchPayload(session));
		}

		return changed;
	};

	const runRecompute = async (session: WorkspaceWatchSession) => {
		if (session.inFlightRecompute) {
			session.rerunRequested = true;
			return;
		}
		session.inFlightRecompute = true;
		try {
			do {
				session.rerunRequested = false;
				const flags: RecomputeFlags = {
					full: session.fullRefreshRequested,
					dirtyHome: session.dirtyHome,
					dirtyTaskIds: new Set(session.dirtyTaskIds),
				};
				session.fullRefreshRequested = false;
				session.dirtyHome = false;
				session.dirtyTaskIds.clear();
				try {
					await recomputeOnce(session, flags);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					deps.warn(`[workspace-git-watch-service] Failed to refresh ${session.workspaceId}: ${message}`);
				}
			} while (session.rerunRequested || session.fullRefreshRequested || session.dirtyHome || session.dirtyTaskIds.size > 0);
		} finally {
			session.inFlightRecompute = false;
		}
	};

	const createSession = (workspaceId: string, workspacePath: string): WorkspaceWatchSession => {
		const normalizedWorkspacePath = toNormalizedPath(workspacePath);
		const session: WorkspaceWatchSession = {
			workspaceId,
			workspacePath: normalizedWorkspacePath,
			subscriberCount: 0,
			watcher: null as unknown as FSWatcher,
			watchRoots: new Set([normalizedWorkspacePath]),
			ignoredRoots: new Set(),
			homeSummary: createEmptyGitSummary(),
			homeStateToken: "",
			homeChangeRevision: 0,
			taskStatusesByTaskId: new Map(),
			taskStateTokenByTaskId: new Map(),
			taskScopeByTaskId: new Map(),
			recomputeTimer: null,
			inFlightRecompute: false,
			rerunRequested: false,
			fullRefreshRequested: true,
			dirtyHome: true,
			dirtyTaskIds: new Set(),
		};

		const watcher = chokidar.watch(Array.from(session.watchRoots), {
			ignoreInitial: true,
			persistent: true,
			awaitWriteFinish: {
				stabilityThreshold: 120,
				pollInterval: 25,
			},
			ignored: (candidatePath) => {
				const normalizedPath = toNormalizedPath(String(candidatePath));
				if (isGitMetadataPath(normalizedPath)) {
					return false;
				}
				for (const ignoredRoot of session.ignoredRoots) {
					if (isPathWithin(normalizedPath, ignoredRoot)) {
						return true;
					}
				}
				return false;
			},
		});

		watcher.on("all", (_eventName, changedPath) => {
			markWorkspaceDirtyFromPath(session, String(changedPath));
			scheduleRecompute(session);
		});

		watcher.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`[workspace-git-watch-service] Watcher error for ${session.workspaceId}: ${message}`);
		});

		session.watcher = watcher;
		return session;
	};

	const disposeSession = async (workspaceId: string) => {
		const session = sessionsByWorkspaceId.get(workspaceId);
		if (!session) {
			return;
		}
		sessionsByWorkspaceId.delete(workspaceId);
		if (session.recomputeTimer) {
			clearTimeout(session.recomputeTimer);
			session.recomputeTimer = null;
		}
		try {
			await session.watcher.close();
		} catch {
			// Best effort watcher teardown.
		}
	};

	const subscribeWorkspace = async (workspaceId: string, workspacePath: string) => {
		const normalizedWorkspacePath = toNormalizedPath(workspacePath);
		let session = sessionsByWorkspaceId.get(workspaceId);
		if (!session) {
			session = createSession(workspaceId, normalizedWorkspacePath);
			sessionsByWorkspaceId.set(workspaceId, session);
		} else if (session.workspacePath !== normalizedWorkspacePath) {
			session.workspacePath = normalizedWorkspacePath;
			session.fullRefreshRequested = true;
		}
		session.subscriberCount += 1;
		session.fullRefreshRequested = true;
		session.dirtyHome = true;
		scheduleRecompute(session);
	};

	const unsubscribeWorkspace = async (workspaceId: string) => {
		const session = sessionsByWorkspaceId.get(workspaceId);
		if (!session) {
			return;
		}
		session.subscriberCount = Math.max(0, session.subscriberCount - 1);
		if (session.subscriberCount === 0) {
			await disposeSession(workspaceId);
		}
	};

	const requestRefresh = (workspaceId: string, options?: { full?: boolean; taskId?: string; home?: boolean }) => {
		const session = sessionsByWorkspaceId.get(workspaceId);
		if (!session) {
			return;
		}
		if (options?.full) {
			session.fullRefreshRequested = true;
		}
		if (options?.home) {
			session.dirtyHome = true;
		}
		if (options?.taskId) {
			session.dirtyTaskIds.add(options.taskId);
		}
		scheduleRecompute(session);
	};

	return {
		subscribeWorkspace,
		unsubscribeWorkspace,
		requestRefresh,
		disposeWorkspace: async (workspaceId: string) => {
			await disposeSession(workspaceId);
		},
		close: async () => {
			const workspaceIds = Array.from(sessionsByWorkspaceId.keys());
			await Promise.all(workspaceIds.map(async (workspaceId) => await disposeSession(workspaceId)));
		},
	};
}
