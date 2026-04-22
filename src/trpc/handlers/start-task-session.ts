import { resolveAgentCommand } from "../../config";
import type { IRuntimeConfigProvider } from "../../core";
import { findCardInBoard, parseTaskSessionStartRequest } from "../../core";
import { loadProjectState } from "../../state";
import type { TerminalSessionManager } from "../../terminal";
import { captureTaskTurnCheckpoint, pathExists, resolveTaskCwd } from "../../workdir";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface StartTaskSessionDeps {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
}

export async function handleStartTaskSession(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: StartTaskSessionDeps,
) {
	try {
		const body = parseTaskSessionStartRequest(input);
		const scopedRuntimeConfig = await deps.config.loadScopedRuntimeConfig(projectScope);
		const useWorktree = body.useWorktree !== false;
		// Prefer the persisted working directory if it still exists on disk.
		const state = await loadProjectState(projectScope.projectPath);
		const existingCard = findCardInBoard(state.board, body.taskId);
		const persisted = existingCard?.workingDirectory ?? null;
		// Branch must be threaded to resolveTaskCwd for branch-aware worktree creation.
		// The other path to ensureTaskWorktreeIfDoesntExist is workdir-api.ts:ensureWorktree,
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
				cwd: projectScope.projectPath,
				taskId: body.taskId,
				baseRef: body.baseRef,
				ensure: true,
				branch: savedBranch,
			});
		} else {
			taskCwd = projectScope.projectPath;
		}

		// workingDirectory is persisted by the client after the response
		// arrives (via summary.projectPath). This avoids a dual-writer
		// race where the server bumps the revision while the client's
		// persist debounce is in flight.

		const shouldCaptureTurnCheckpoint = !body.resumeConversation;

		const terminalManager = await deps.getScopedTerminalManager(projectScope);
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
			projectId: projectScope.projectId,
			projectPath: projectScope.projectPath,
			statuslineEnabled: scopedRuntimeConfig.statuslineEnabled,
			worktreeAddParentGitDir: scopedRuntimeConfig.worktreeAddParentGitDir,
			worktreeAddQuarterdeckDir: scopedRuntimeConfig.worktreeAddQuarterdeckDir,
			worktreeSystemPromptTemplate: scopedRuntimeConfig.worktreeSystemPromptTemplate,
			agentTerminalRowMultiplier: scopedRuntimeConfig.agentTerminalRowMultiplier,
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
