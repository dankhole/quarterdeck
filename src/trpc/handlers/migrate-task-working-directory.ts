import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResolvedAgentCommand } from "../../config/agent-registry";
import { resolveAgentCommand } from "../../config/agent-registry";
import type { RuntimeConfigState } from "../../config/runtime-config";
import { createTaggedLogger } from "../../core/debug-logger";
import type { IRuntimeBroadcaster, IRuntimeConfigProvider } from "../../core/service-interfaces";
import { findCardInBoard } from "../../core/task-board-mutations";
import { loadWorkspaceState, mutateWorkspaceState } from "../../state/workspace-state";
import type { TerminalSessionManager } from "../../terminal/session-manager";
import {
	applyTaskPatch,
	captureTaskPatch,
	ensureTaskWorktreeIfDoesntExist,
	findTaskPatch,
	resolveTaskCwd,
} from "../../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../../workspace/turn-checkpoints";
import type { RuntimeTrpcWorkspaceScope } from "../app-router-context";

export interface MigrateTaskWorkingDirectoryDeps {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastRuntimeWorkspaceStateUpdated">;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
}

// NOTE: This handler is not concurrent-safe. Two browser tabs migrating the
// same task simultaneously could race on stop/start. The failure mode is
// benign (duplicate session start, not data loss) and the terminal manager
// replaces existing sessions, so this is an accepted trade-off.
export async function handleMigrateTaskWorkingDirectory(
	workspaceScope: RuntimeTrpcWorkspaceScope,
	input: { taskId: string; direction: "isolate" | "de-isolate" },
	deps: MigrateTaskWorkingDirectoryDeps,
) {
	const migrateLog = createTaggedLogger("migrate");
	const log = (message: string, data?: unknown) =>
		migrateLog.info(`[${input.taskId} ${input.direction}] ${message}`, data);

	try {
		const state = await loadWorkspaceState(workspaceScope.workspacePath);
		const card = findCardInBoard(state.board, input.taskId);
		if (!card) {
			log("card not found");
			return { ok: false, error: `Task "${input.taskId}" not found.` };
		}

		// Resolve the current working directory. For legacy tasks started
		// before workingDirectory was persisted, infer it from the task's
		// worktree state.
		let currentWorkingDirectory = card.workingDirectory ?? null;
		if (!currentWorkingDirectory) {
			log("workingDirectory not persisted, resolving from worktree/workspace state");
			if (card.useWorktree !== false) {
				try {
					currentWorkingDirectory = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: input.taskId,
						baseRef: card.baseRef,
						ensure: false,
					});
				} catch {
					// Worktree doesn't exist — fall back to workspace path.
					currentWorkingDirectory = workspaceScope.workspacePath;
				}
			} else {
				currentWorkingDirectory = workspaceScope.workspacePath;
			}
			log("resolved currentWorkingDirectory", currentWorkingDirectory);
		}

		// If the task is already in the requested state, bail early to avoid
		// wasteful session stop/restart cycles.
		const isAlreadyIsolated = resolve(currentWorkingDirectory) !== resolve(workspaceScope.workspacePath);
		if (
			(input.direction === "isolate" && isAlreadyIsolated) ||
			(input.direction === "de-isolate" && !isAlreadyIsolated)
		) {
			log("already in requested state, no-op");
			return { ok: true, newWorkingDirectory: currentWorkingDirectory };
		}

		const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
		const summary = terminalManager.store.getSummary(input.taskId);
		const wasRunning = summary && (summary.state === "running" || summary.state === "awaiting_review");
		log("session state check", { wasRunning, state: summary?.state ?? "no session" });

		// Resolve agent command and runtime config only when we need to
		// restart a session. Idle tasks (no running session) don't need an
		// agent command, so we shouldn't reject the migration for them.
		let resolved: ResolvedAgentCommand | undefined;
		let scopedRuntimeConfig: RuntimeConfigState | undefined;

		if (wasRunning) {
			scopedRuntimeConfig = await deps.config.loadScopedRuntimeConfig(workspaceScope);
			resolved = resolveAgentCommand(scopedRuntimeConfig) ?? undefined;
			if (!resolved) {
				log("no agent command configured");
				return {
					ok: false,
					error: "No runnable agent command is configured. Cannot restart session after migration.",
				};
			}
		}

		// Only called when wasRunning is true, so resolved and scopedRuntimeConfig
		// are guaranteed to be set (guarded above with an early return).
		const buildRestartRequest = (cwd: string, resumeConversation: boolean) => {
			if (!resolved || !scopedRuntimeConfig) {
				throw new Error("buildRestartRequest called without resolved agent command");
			}
			return {
				taskId: input.taskId,
				agentId: summary?.agentId ?? resolved.agentId,
				binary: resolved.binary,
				args: resolved.args,
				autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
				cwd,
				prompt: "",
				resumeConversation,
				awaitReview: summary?.state === "awaiting_review",
				workspaceId: workspaceScope.workspaceId,
				workspacePath: workspaceScope.workspacePath,
				statuslineEnabled: scopedRuntimeConfig.statuslineEnabled,
				worktreeAddParentGitDir: scopedRuntimeConfig.worktreeAddParentGitDir,
				worktreeAddQuarterdeckDir: scopedRuntimeConfig.worktreeAddQuarterdeckDir,
				worktreeSystemPromptTemplate: scopedRuntimeConfig.worktreeSystemPromptTemplate,
				env: card.baseRef ? { QUARTERDECK_BASE_REF: card.baseRef } : undefined,
			};
		};

		// Stop the running session and wait for the process to fully exit
		// before proceeding. Without this, the old PTY may still be alive
		// when startTaskSession is called, causing it to bail early.
		if (wasRunning) {
			log("stopping session and waiting for exit");
			await terminalManager.stopTaskSessionAndWaitForExit(input.taskId);
			log("session stopped");
		}

		let newWorkingDirectory: string;

		if (input.direction === "isolate") {
			// Main checkout -> isolated worktree.
			// NOTE: When the source is a shared checkout with multiple tasks,
			// captureTaskPatch diffs all uncommitted changes — not just this
			// task's. This means the patch may include other tasks' uncommitted
			// work. Isolating from a shared checkout is inherently imprecise
			// because git has no per-task change tracking.
			log("capturing patch", currentWorkingDirectory);
			await captureTaskPatch({
				repoPath: workspaceScope.workspacePath,
				taskId: input.taskId,
				worktreePath: currentWorkingDirectory,
			});
			log("creating worktree");
			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: workspaceScope.workspacePath,
				taskId: input.taskId,
				baseRef: card.baseRef,
			});
			if (!ensured.ok || !ensured.path) {
				log("worktree creation failed", ensured.error);
				// Worktree creation failed — restart the session at the old CWD
				// so the user isn't left with a dead task.
				if (wasRunning) {
					log("restarting session at old cwd");
					await terminalManager.startTaskSession(buildRestartRequest(currentWorkingDirectory, true));
				}
				return { ok: false, error: ensured.error ?? "Failed to create worktree." };
			}
			newWorkingDirectory = ensured.path;
			log("worktree created", newWorkingDirectory);
			// Apply patch in worktree.
			const patch = await findTaskPatch(input.taskId);
			if (patch) {
				try {
					log("applying patch");
					await applyTaskPatch(patch.path, newWorkingDirectory);
					log("patch applied");
				} catch (patchError) {
					log("patch apply failed", patchError instanceof Error ? patchError.message : patchError);
				} finally {
					// TODO: Consider keeping the patch file on apply failure so the
					// user can recover manually (e.g. `git apply <path>`).
					await rm(patch.path, { force: true });
				}
			} else {
				log("no patch to apply");
			}
		} else {
			// Worktree -> main checkout (de-isolate).
			// Uncommitted changes stay in the worktree as a safety net.
			newWorkingDirectory = workspaceScope.workspacePath;
			log("de-isolating", newWorkingDirectory);
		}

		// Update the card's workingDirectory.
		try {
			log("persisting workingDirectory", newWorkingDirectory);
			await mutateWorkspaceState(workspaceScope.workspacePath, (currentState) => {
				const board = structuredClone(currentState.board);
				const target = findCardInBoard(board, input.taskId);
				if (target) {
					target.workingDirectory = newWorkingDirectory;
					target.useWorktree = input.direction === "isolate";
					target.updatedAt = Date.now();
				}
				return { board, value: null };
			});

			// Broadcast the state change so the metadata monitor picks up the new
			// workingDirectory immediately instead of waiting for the next poll.
			void deps.broadcaster.broadcastRuntimeWorkspaceStateUpdated(
				workspaceScope.workspaceId,
				workspaceScope.workspacePath,
			);

			// Only restart the session if it was running before migration.
			// Otherwise we'd spawn an unwanted agent session for tasks that
			// were idle (e.g., in review with no active session).
			if (wasRunning) {
				// Restart session at the new working directory. When the CWD changes
				// (isolate/de-isolate), agent CLIs like Claude treat it as a different
				// project and --continue won't find the old conversation. Use
				// resumeConversation only when the CWD hasn't changed (error recovery).
				const cwdChanged = resolve(currentWorkingDirectory) !== resolve(newWorkingDirectory);
				log("restarting session", { cwd: newWorkingDirectory, mode: cwdChanged ? "fresh" : "resume" });
				const restartedSummary = await terminalManager.startTaskSession(
					buildRestartRequest(newWorkingDirectory, !cwdChanged),
				);

				// Capture a fresh turn checkpoint at the new CWD so "revert to
				// last turn" works correctly after migration.
				try {
					const nextTurn = (restartedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					log("capturing turn checkpoint", { turn: nextTurn });
					await captureTaskTurnCheckpoint({
						cwd: newWorkingDirectory,
						taskId: input.taskId,
						turn: nextTurn,
					});
				} catch {
					log("turn checkpoint capture failed (non-fatal)");
				}
			}

			log("migration complete", { from: currentWorkingDirectory, to: newWorkingDirectory });
			return { ok: true, newWorkingDirectory };
		} catch (postStopError) {
			// If the post-stop operations fail (state persistence, session
			// restart), attempt to restart the session at the original CWD so
			// the user isn't left with a dead task — mirrors the isolate
			// branch's error recovery for worktree creation failure.
			if (wasRunning) {
				log("post-stop failed, restarting session at old cwd", currentWorkingDirectory);
				try {
					await terminalManager.startTaskSession(buildRestartRequest(currentWorkingDirectory, true));
				} catch (restartError) {
					log("session restart also failed", restartError instanceof Error ? restartError.message : restartError);
				}
			}
			throw postStopError;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log("migration failed", message);
		return { ok: false, error: message };
	}
}
