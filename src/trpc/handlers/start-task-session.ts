import { resolveAgentCommand } from "../../config/agent-registry";
import { parseTaskSessionStartRequest } from "../../core/api-validation";
import type { IRuntimeConfigProvider } from "../../core/service-interfaces";
import { findCardInBoard } from "../../core/task-board-mutations";
import { loadWorkspaceState } from "../../state/workspace-state";
import type { TerminalSessionManager } from "../../terminal/session-manager";
import { pathExists, resolveTaskCwd } from "../../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../../workspace/turn-checkpoints";
import type { RuntimeTrpcWorkspaceScope } from "../app-router-context";

export interface StartTaskSessionDeps {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
}

export async function handleStartTaskSession(
	workspaceScope: RuntimeTrpcWorkspaceScope,
	input: unknown,
	deps: StartTaskSessionDeps,
) {
	try {
		const body = parseTaskSessionStartRequest(input);
		const scopedRuntimeConfig = await deps.config.loadScopedRuntimeConfig(workspaceScope);
		const useWorktree = body.useWorktree !== false;
		// Prefer the persisted working directory if it still exists on disk.
		const state = await loadWorkspaceState(workspaceScope.workspacePath);
		const existingCard = findCardInBoard(state.board, body.taskId);
		const persisted = existingCard?.workingDirectory ?? null;
		// Branch must be threaded to resolveTaskCwd for branch-aware worktree creation.
		// The other path to ensureTaskWorktreeIfDoesntExist is workspace-api.ts:ensureWorktree,
		// which receives branch from the client request instead.
		const savedBranch = existingCard?.branch ?? null;
		const persistedExists = persisted !== null && (await pathExists(persisted));

		// The persisted workingDirectory is the source of truth. It's kept
		// in sync with useWorktree by migrateTaskWorkingDirectory. We only
		// fall back to useWorktree for legacy or first-run cards.
		let taskCwd: string;
		if (persistedExists) {
			taskCwd = persisted;
		} else if (useWorktree) {
			taskCwd = await resolveTaskCwd({
				cwd: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
				ensure: true,
				branch: savedBranch,
			});
		} else {
			taskCwd = workspaceScope.workspacePath;
		}

		// workingDirectory is persisted by the client after the response
		// arrives (via summary.workspacePath). This avoids a dual-writer
		// race where the server bumps the revision while the client's
		// persist debounce is in flight.

		const shouldCaptureTurnCheckpoint = !body.resumeConversation;

		const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
		const previousTerminalAgentId = body.resumeConversation
			? (terminalManager.store.getSummary(body.taskId)?.agentId ?? null)
			: null;
		const effectiveAgentId = previousTerminalAgentId ?? scopedRuntimeConfig.selectedAgentId;

		const resolvedConfig =
			effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
				? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
				: scopedRuntimeConfig;
		const resolved = resolveAgentCommand(resolvedConfig);
		if (!resolved) {
			return {
				ok: false,
				summary: null,
				error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
			};
		}
		const summary = await terminalManager.startTaskSession({
			taskId: body.taskId,
			agentId: resolved.agentId,
			binary: resolved.binary,
			args: resolved.args,
			autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
			cwd: taskCwd,
			prompt: body.prompt,
			images: body.images,
			startInPlanMode: body.startInPlanMode,
			resumeConversation: body.resumeConversation,
			awaitReview: body.awaitReview,
			cols: body.cols,
			rows: body.rows,
			workspaceId: workspaceScope.workspaceId,
			workspacePath: workspaceScope.workspacePath,
			statuslineEnabled: scopedRuntimeConfig.statuslineEnabled,
			worktreeAddParentGitDir: scopedRuntimeConfig.worktreeAddParentGitDir,
			worktreeAddQuarterdeckDir: scopedRuntimeConfig.worktreeAddQuarterdeckDir,
			worktreeSystemPromptTemplate: scopedRuntimeConfig.worktreeSystemPromptTemplate,
			env: body.baseRef ? { QUARTERDECK_BASE_REF: body.baseRef } : undefined,
		});

		let nextSummary = summary;
		if (shouldCaptureTurnCheckpoint) {
			try {
				const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
				const checkpoint = await captureTaskTurnCheckpoint({
					cwd: taskCwd,
					taskId: body.taskId,
					turn: nextTurn,
				});
				nextSummary = terminalManager.store.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
			} catch {
				// Best effort checkpointing only.
			}
		}
		return {
			ok: true,
			summary: nextSummary,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			summary: null,
			error: message,
		};
	}
}
