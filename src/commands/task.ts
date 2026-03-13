import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";

import type { RuntimeBoardCard, RuntimeBoardDependency, RuntimeWorkspaceStateResponse } from "../core/api-contract.js";
import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin } from "../core/runtime-endpoint.js";
import {
	addTaskDependency,
	addTaskToColumn,
	getTaskColumnId,
	moveTaskToColumn,
	removeTaskDependency,
	type RuntimeAddTaskDependencyResult,
	updateTask,
} from "../core/task-board-mutations.js";
import { resolveProjectInputPath } from "../projects/project-path.js";
import { loadWorkspaceContext } from "../state/workspace-state.js";
import type { RuntimeAppRouter } from "../trpc/app-router.js";

const LIST_TASK_COLUMNS = ["backlog", "in_progress", "review"] as const;
type ListTaskColumn = (typeof LIST_TASK_COLUMNS)[number];

interface RuntimeWorkspaceMutationResult<T> {
	board: RuntimeWorkspaceStateResponse["board"];
	value: T;
}

type JsonRecord = Record<string, unknown>;
type ParsedFlagValue = { value: string; hasExplicitValue: boolean };

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeFlagName(raw: string): string {
	const stripped = raw.replace(/^--/u, "");
	return stripped
		.replaceAll("_", "-")
		.replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
		.toLowerCase();
}

function parseSubcommandFlags(args: string[]): Map<string, ParsedFlagValue> {
	const flags = new Map<string, ParsedFlagValue>();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected positional argument: ${arg}`);
		}

		const equalsIndex = arg.indexOf("=");
		if (equalsIndex >= 0) {
			const key = normalizeFlagName(arg.slice(0, equalsIndex));
			const value = arg.slice(equalsIndex + 1);
			flags.set(key, { value, hasExplicitValue: true });
			continue;
		}

		const key = normalizeFlagName(arg);
		const next = args[index + 1];
		if (next && !next.startsWith("--")) {
			flags.set(key, { value: next, hasExplicitValue: true });
			index += 1;
			continue;
		}

		flags.set(key, { value: "true", hasExplicitValue: false });
	}
	return flags;
}

function readStringFlag(flags: Map<string, ParsedFlagValue>, ...names: string[]): string | undefined {
	for (const name of names) {
		const parsed = flags.get(normalizeFlagName(name));
		if (parsed === undefined) {
			continue;
		}
		if (!parsed.hasExplicitValue) {
			const requiredName = names[0] ?? "--value";
			throw new Error(`Missing value for ${requiredName}.`);
		}
		const trimmed = parsed.value.trim();
		return trimmed.length > 0 ? trimmed : "";
	}
	return undefined;
}

function requireStringFlag(flags: Map<string, ParsedFlagValue>, ...names: string[]): string {
	const value = readStringFlag(flags, ...names);
	const requiredName = names[0] ?? "--value";
	if (value === undefined || value.length === 0) {
		throw new Error(`Missing required flag ${requiredName}.`);
	}
	return value;
}

function parseBooleanFlag(flags: Map<string, ParsedFlagValue>, ...names: string[]): boolean | undefined {
	for (const name of names) {
		const parsed = flags.get(normalizeFlagName(name));
		if (parsed === undefined) {
			continue;
		}
		if (!parsed.hasExplicitValue) {
			return true;
		}
		const normalized = parsed.value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1" || normalized === "yes") {
			return true;
		}
		if (normalized === "false" || normalized === "0" || normalized === "no") {
			return false;
		}
		const requiredName = names[0] ?? "--value";
		throw new Error(`Invalid boolean value for ${requiredName}: "${parsed.value}". Use true or false.`);
	}
	return undefined;
}

function assertOnlyKnownFlags(flags: Map<string, ParsedFlagValue>, allowedFlags: string[]): void {
	const allowed = new Set(allowedFlags.map((flag) => normalizeFlagName(flag)));
	for (const key of flags.keys()) {
		if (!allowed.has(key)) {
			throw new Error(`Unknown flag --${key}. Use "kanban task --help" for usage.`);
		}
	}
}

function parseListColumn(value: string | undefined): ListTaskColumn | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "backlog" || value === "in_progress" || value === "review") {
		return value;
	}
	throw new Error(`Invalid column "${value}". Expected one of: ${LIST_TASK_COLUMNS.join(", ")}.`);
}

function parseAutoReviewMode(value: string | undefined): "commit" | "pr" | "move_to_trash" | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "commit" || value === "pr" || value === "move_to_trash") {
		return value;
	}
	throw new Error(`Invalid auto review mode "${value}". Expected: commit, pr, move_to_trash.`);
}

function createRuntimeTrpcClient(workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
			}),
		],
	});
}

async function resolveRuntimeWorkspace(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
) {
	const normalizedProjectPath = (projectPath ?? "").trim();
	const resolvedPath = normalizedProjectPath ? resolveProjectInputPath(normalizedProjectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath, {
		autoCreateIfMissing: options.autoCreateIfMissing ?? true,
	});
}

async function resolveWorkspaceRepoPath(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
): Promise<string> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, options);
	return workspace.repoPath;
}

async function ensureRuntimeWorkspace(workspaceRepoPath: string): Promise<string> {
	const runtimeClient = createRuntimeTrpcClient(null);
	const added = await runtimeClient.projects.add.mutate({
		path: workspaceRepoPath,
	});
	if (!added.ok || !added.project) {
		throw new Error(added.error ?? `Could not register project ${workspaceRepoPath} in Kanban runtime.`);
	}
	return added.project.id;
}

async function updateRuntimeWorkspaceState<T>(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceMutationResult<T>,
): Promise<T> {
	const state = await runtimeClient.workspace.getState.query();
	const mutation = mutate(state);
	await runtimeClient.workspace.saveState.mutate({
		board: mutation.board,
		sessions: state.sessions,
		expectedRevision: state.revision,
	});
	return mutation.value;
}

function resolveTaskBaseRef(state: RuntimeWorkspaceStateResponse): string {
	return state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0] ?? "";
}

function findTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { task: RuntimeBoardCard; columnId: string } | null {
	for (const column of state.board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) {
			return {
				task,
				columnId: column.id,
			};
		}
	}
	return null;
}

function formatTaskRecord(state: RuntimeWorkspaceStateResponse, task: RuntimeBoardCard, columnId: string): JsonRecord {
	const session = state.sessions[task.id] ?? null;
	return {
		id: task.id,
		prompt: task.prompt,
		column: columnId,
		baseRef: task.baseRef,
		startInPlanMode: task.startInPlanMode,
		autoReviewEnabled: task.autoReviewEnabled === true,
		autoReviewMode: task.autoReviewMode ?? "commit",
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		session: session
			? {
					state: session.state,
					agentId: session.agentId,
					pid: session.pid,
					startedAt: session.startedAt,
					updatedAt: session.updatedAt,
					lastOutputAt: session.lastOutputAt,
					reviewReason: session.reviewReason,
					exitCode: session.exitCode,
				}
			: null,
	};
}

function formatDependencyRecord(
	state: RuntimeWorkspaceStateResponse,
	dependency: RuntimeBoardDependency,
): Record<string, unknown> {
	return {
		id: dependency.id,
		backlogTaskId: dependency.fromTaskId,
		backlogTaskColumn: getTaskColumnId(state.board, dependency.fromTaskId),
		linkedTaskId: dependency.toTaskId,
		linkedTaskColumn: getTaskColumnId(state.board, dependency.toTaskId),
		createdAt: dependency.createdAt,
	};
}

function getLinkFailureMessage(reason: RuntimeAddTaskDependencyResult["reason"]): string {
	if (reason === "same_task") {
		return "A task cannot be linked to itself.";
	}
	if (reason === "duplicate") {
		return "These tasks are already linked.";
	}
	if (reason === "trash_task") {
		return "Links cannot include trashed tasks.";
	}
	if (reason === "non_backlog") {
		return "Links require at least one backlog task.";
	}
	return "One or both tasks could not be found.";
}

async function listTasks(input: { cwd: string; projectPath?: string; column?: ListTaskColumn }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();

	const tasks = state.board.columns.flatMap((boardColumn) => {
		if (boardColumn.id === "trash") {
			return [];
		}
		if (input.column && boardColumn.id !== input.column) {
			return [];
		}
		return boardColumn.cards.map((task) => formatTaskRecord(state, task, boardColumn.id));
	});

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		column: input.column ?? null,
		tasks,
		dependencies: state.board.dependencies.map((dependency) => formatDependencyRecord(state, dependency)),
		count: tasks.length,
	};
}

async function createTask(input: {
	cwd: string;
	prompt: string;
	projectPath?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr" | "move_to_trash";
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const created = await updateRuntimeWorkspaceState(runtimeClient, (state) => {
		const resolvedBaseRef = (input.baseRef ?? "").trim() || resolveTaskBaseRef(state);
		if (!resolvedBaseRef) {
			throw new Error("Could not determine task base branch for this workspace.");
		}
		const result = addTaskToColumn(
			state.board,
			"backlog",
			{
				prompt: input.prompt,
				startInPlanMode: input.startInPlanMode,
				autoReviewEnabled: input.autoReviewEnabled,
				autoReviewMode: input.autoReviewMode,
				baseRef: resolvedBaseRef,
			},
			() => globalThis.crypto.randomUUID(),
		);
		return {
			board: result.board,
			value: result.task,
		};
	});

	return {
		ok: true,
		task: {
			id: created.id,
			column: "backlog",
			workspacePath: workspaceRepoPath,
			prompt: created.prompt,
			baseRef: created.baseRef,
			startInPlanMode: created.startInPlanMode,
			autoReviewEnabled: created.autoReviewEnabled === true,
			autoReviewMode: created.autoReviewMode ?? "commit",
		},
	};
}

async function updateTaskCommand(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	prompt?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr" | "move_to_trash";
}): Promise<JsonRecord> {
	if (
		input.prompt === undefined &&
		input.baseRef === undefined &&
		input.startInPlanMode === undefined &&
		input.autoReviewEnabled === undefined &&
		input.autoReviewMode === undefined
	) {
		throw new Error("task update requires at least one field to change.");
	}

	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const taskRecord = findTaskRecord(runtimeState, input.taskId);
	if (!taskRecord) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}

	const updated = updateTask(runtimeState.board, input.taskId, {
		prompt: input.prompt ?? taskRecord.task.prompt,
		baseRef: input.baseRef ?? taskRecord.task.baseRef,
		startInPlanMode: input.startInPlanMode ?? taskRecord.task.startInPlanMode,
		autoReviewEnabled: input.autoReviewEnabled ?? taskRecord.task.autoReviewEnabled === true,
		autoReviewMode: input.autoReviewMode ?? taskRecord.task.autoReviewMode ?? "commit",
	});
	if (!updated.updated || !updated.task) {
		throw new Error(`Task "${input.taskId}" could not be updated.`);
	}

	await runtimeClient.workspace.saveState.mutate({
		board: updated.board,
		sessions: runtimeState.sessions,
		expectedRevision: runtimeState.revision,
	});

	const nextState: RuntimeWorkspaceStateResponse = {
		...runtimeState,
		board: updated.board,
	};
	return {
		ok: true,
		task: formatTaskRecord(nextState, updated.task, taskRecord.columnId),
		workspacePath: workspaceRepoPath,
	};
}

async function linkTasks(input: {
	cwd: string;
	taskId: string;
	linkedTaskId: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const linked = addTaskDependency(runtimeState.board, input.taskId, input.linkedTaskId);
	if (!linked.added || !linked.dependency) {
		throw new Error(getLinkFailureMessage(linked.reason));
	}

	await runtimeClient.workspace.saveState.mutate({
		board: linked.board,
		sessions: runtimeState.sessions,
		expectedRevision: runtimeState.revision,
	});

	const nextState: RuntimeWorkspaceStateResponse = {
		...runtimeState,
		board: linked.board,
	};
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		dependency: formatDependencyRecord(nextState, linked.dependency),
	};
}

async function unlinkTasks(input: { cwd: string; dependencyId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const dependency = runtimeState.board.dependencies.find((candidate) => candidate.id === input.dependencyId) ?? null;
	if (!dependency) {
		throw new Error(`Dependency "${input.dependencyId}" was not found in workspace ${workspaceRepoPath}.`);
	}

	const unlinked = removeTaskDependency(runtimeState.board, input.dependencyId);
	if (!unlinked.removed) {
		throw new Error(`Dependency "${input.dependencyId}" could not be removed.`);
	}

	await runtimeClient.workspace.saveState.mutate({
		board: unlinked.board,
		sessions: runtimeState.sessions,
		expectedRevision: runtimeState.revision,
	});

	const nextState: RuntimeWorkspaceStateResponse = {
		...runtimeState,
		board: unlinked.board,
	};
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		removedDependency: formatDependencyRecord(nextState, dependency),
	};
}

async function startTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const fromColumnId = getTaskColumnId(runtimeState.board, input.taskId);
	if (!fromColumnId) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}

	if (fromColumnId !== "backlog" && fromColumnId !== "in_progress") {
		throw new Error(`Task "${input.taskId}" is in "${fromColumnId}" and can only be started from backlog or in_progress.`);
	}

	const moved = moveTaskToColumn(runtimeState.board, input.taskId, "in_progress");
	const task = moved.task;
	if (!task) {
		throw new Error(`Task "${input.taskId}" could not be resolved.`);
	}

	const existingSession = runtimeState.sessions[task.id] ?? null;
	const shouldStartSession = !existingSession || existingSession.state !== "running";

	if (shouldStartSession) {
		const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
			taskId: task.id,
			baseRef: task.baseRef,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Could not ensure task worktree.");
		}

		const started = await runtimeClient.runtime.startTaskSession.mutate({
			taskId: task.id,
			prompt: task.prompt,
			startInPlanMode: task.startInPlanMode,
			baseRef: task.baseRef,
		});
		if (!started.ok || !started.summary) {
			throw new Error(started.error ?? "Could not start task session.");
		}
	}

	if (moved.moved) {
		await runtimeClient.workspace.saveState.mutate({
			board: moved.board,
			sessions: runtimeState.sessions,
			expectedRevision: runtimeState.revision,
		});
	}

	if (!moved.moved) {
		return {
			ok: true,
			message: `Task "${input.taskId}" is already in progress.`,
			task: {
				id: task.id,
				prompt: task.prompt,
				column: "in_progress",
				workspacePath: workspaceRepoPath,
			},
		};
	}

	return {
		ok: true,
		task: {
			id: task.id,
			prompt: task.prompt,
			column: "in_progress",
			workspacePath: workspaceRepoPath,
		},
	};
}

function printTaskHelp(): void {
	process.stdout.write("kanban task\n");
	process.stdout.write("Manage Kanban board tasks from the CLI.\n");
	process.stdout.write("\n");
	process.stdout.write("Usage:\n");
	process.stdout.write("  kanban task list [--project-path <path>] [--column backlog|in_progress|review]\n");
	process.stdout.write(
		"  kanban task create --prompt <text> [--project-path <path>] [--base-ref <branch>] [--start-in-plan-mode <true|false>] [--auto-review-enabled <true|false>] [--auto-review-mode commit|pr|move_to_trash]\n",
	);
	process.stdout.write(
		"  kanban task update --task-id <id> [--prompt <text>] [--project-path <path>] [--base-ref <branch>] [--start-in-plan-mode <true|false>] [--auto-review-enabled <true|false>] [--auto-review-mode commit|pr|move_to_trash]\n",
	);
	process.stdout.write("  kanban task link --task-id <id> --linked-task-id <id> [--project-path <path>]\n");
	process.stdout.write("  kanban task unlink --dependency-id <id> [--project-path <path>]\n");
	process.stdout.write("  kanban task start --task-id <id> [--project-path <path>]\n");
	process.stdout.write("  kanban task --help\n");
	process.stdout.write("\n");
	process.stdout.write(`Runtime URL: ${getKanbanRuntimeOrigin()}\n`);
}

export function isTaskSubcommand(argv: string[]): boolean {
	return argv[0] === "task" || argv[0] === "tasks";
}

export async function runTaskSubcommand(argv: string[]): Promise<void> {
	const args = argv.slice(1);
	const hasSubcommandHelp = args.includes("--help") || args.includes("-h");
	const action = args[0] && !args[0].startsWith("-") ? args[0] : null;
	const flagArgs = action ? args.slice(1) : args;

	if (!action || hasSubcommandHelp) {
		printTaskHelp();
		return;
	}

	try {
		const flags = parseSubcommandFlags(flagArgs);
		const projectPath = readStringFlag(flags, "--project-path", "--projectPath");
		const cwd = process.cwd();

		if (action === "list") {
			assertOnlyKnownFlags(flags, ["--project-path", "--projectPath", "--column"]);
			const column = parseListColumn(readStringFlag(flags, "--column"));
			const result = await listTasks({ cwd, projectPath, column });
			printJson(result);
			return;
		}

		if (action === "create") {
			assertOnlyKnownFlags(flags, [
				"--project-path",
				"--projectPath",
				"--prompt",
				"--base-ref",
				"--baseRef",
				"--start-in-plan-mode",
				"--startInPlanMode",
				"--auto-review-enabled",
				"--autoReviewEnabled",
				"--auto-review-mode",
				"--autoReviewMode",
			]);
			const prompt = requireStringFlag(flags, "--prompt");
			const baseRef = readStringFlag(flags, "--base-ref", "--baseRef");
			const startInPlanMode = parseBooleanFlag(flags, "--start-in-plan-mode", "--startInPlanMode");
			const autoReviewEnabled = parseBooleanFlag(flags, "--auto-review-enabled", "--autoReviewEnabled");
			const autoReviewMode = parseAutoReviewMode(readStringFlag(flags, "--auto-review-mode", "--autoReviewMode"));
			const result = await createTask({
				cwd,
				prompt,
				projectPath,
				baseRef,
				startInPlanMode,
				autoReviewEnabled,
				autoReviewMode,
			});
			printJson(result);
			return;
		}

		if (action === "update") {
			assertOnlyKnownFlags(flags, [
				"--project-path",
				"--projectPath",
				"--task-id",
				"--taskId",
				"--prompt",
				"--base-ref",
				"--baseRef",
				"--start-in-plan-mode",
				"--startInPlanMode",
				"--auto-review-enabled",
				"--autoReviewEnabled",
				"--auto-review-mode",
				"--autoReviewMode",
			]);
			const taskId = requireStringFlag(flags, "--task-id", "--taskId");
			const prompt = readStringFlag(flags, "--prompt");
			const baseRef = readStringFlag(flags, "--base-ref", "--baseRef");
			const startInPlanMode = parseBooleanFlag(flags, "--start-in-plan-mode", "--startInPlanMode");
			const autoReviewEnabled = parseBooleanFlag(flags, "--auto-review-enabled", "--autoReviewEnabled");
			const autoReviewMode = parseAutoReviewMode(readStringFlag(flags, "--auto-review-mode", "--autoReviewMode"));
			const result = await updateTaskCommand({
				cwd,
				taskId,
				projectPath,
				prompt,
				baseRef,
				startInPlanMode,
				autoReviewEnabled,
				autoReviewMode,
			});
			printJson(result);
			return;
		}

		if (action === "link") {
			assertOnlyKnownFlags(flags, [
				"--project-path",
				"--projectPath",
				"--task-id",
				"--taskId",
				"--linked-task-id",
				"--linkedTaskId",
			]);
			const taskId = requireStringFlag(flags, "--task-id", "--taskId");
			const linkedTaskId = requireStringFlag(flags, "--linked-task-id", "--linkedTaskId");
			const result = await linkTasks({
				cwd,
				taskId,
				linkedTaskId,
				projectPath,
			});
			printJson(result);
			return;
		}

		if (action === "unlink") {
			assertOnlyKnownFlags(flags, ["--project-path", "--projectPath", "--dependency-id", "--dependencyId"]);
			const dependencyId = requireStringFlag(flags, "--dependency-id", "--dependencyId");
			const result = await unlinkTasks({
				cwd,
				dependencyId,
				projectPath,
			});
			printJson(result);
			return;
		}

		if (action === "start") {
			assertOnlyKnownFlags(flags, ["--project-path", "--projectPath", "--task-id", "--taskId"]);
			const taskId = requireStringFlag(flags, "--task-id", "--taskId");
			const result = await startTask({
				cwd,
				taskId,
				projectPath,
			});
			printJson(result);
			return;
		}

		throw new Error(`Unknown task action "${action}". Use "kanban task --help" for usage.`);
	} catch (error) {
		printJson({
			ok: false,
			error: `Task command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}
