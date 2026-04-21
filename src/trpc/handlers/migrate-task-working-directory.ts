import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResolvedAgentCommand, RuntimeConfigState } from "../../config";
import { resolveAgentCommand } from "../../config";
import type { IRuntimeBroadcaster, IRuntimeConfigProvider } from "../../core";
import { createTaggedLogger, findCardInBoard } from "../../core";
import { loadProjectState } from "../../state";
import type { TerminalSessionManager } from "../../terminal";
import {
	applyTaskPatch,
	captureTaskPatch,
	captureTaskTurnCheckpoint,
	ensureTaskWorktreeIfDoesntExist,
	findTaskPatch,
	resolveTaskCwd,
} from "../../workdir";
import type { RuntimeTrpcProjectScope } from "../app-router-context";
import { applyRuntimeMutationEffects, createTaskWorkingDirectoryUpdatedEffects } from "../runtime-mutation-effects";

export interface MigrateTaskWorkingDirectoryDeps {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	broadcaster: Pick<IRuntimeBroadcaster, "broadcastTaskWorkingDirectoryUpdated">;
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
}

// NOTE: This handler is not concurrent-safe. Two browser tabs migrating the
// same task simultaneously could race on stop/start. The failure mode is
// benign (duplicate session start, not data loss) and the terminal manager
// replaces existing sessions, so this is an accepted trade-off.
export async function handleMigrateTaskWorkingDirectory(
	projectScope: RuntimeTrpcProjectScope,
	input: { taskId: string; direction: "isolate" | "de-isolate" },
	deps: MigrateTaskWorkingDirectoryDeps,
) {
	const migrateLog = createTaggedLogger("migrate");
	const log = (message: string, data?: unknown) =>
		migrateLog.info(`[${input.taskId} ${input.direction}] ${message}`, data);

	try {
		const state = await loadProjectState(projectScope.projectPath);
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
			log("workingDirectory not persisted, resolving from worktree/project state");
			if (card.useWorktree !== false) {
				try {
					currentWorkingDirectory = await resolveTaskCwd({
						cwd: projectScope.projectPath,
						taskId: input.taskId,
						baseRef: card.baseRef,
						ensure: false,
					});
				} catch {
					// Worktree doesn't exist — fall back to project path.
					currentWorkingDirectory = projectScope.projectPath;
				}
			} else {
				currentWorkingDirectory = projectScope.projectPath;
			}
			log("resolved currentWorkingDirectory", currentWorkingDirectory);
		}

		// If the task is already in the requested state, bail early to avoid
		// wasteful session stop/restart cycles.
		const isAlreadyIsolated = resolve(currentWorkingDirectory) !== resolve(projectScope.projectPath);
		if (
			(input.direction === "isolate" && isAlreadyIsolated) ||
			(input.direction === "de-isolate" && !isAlreadyIsolated)
		) {
			log("already in requested state, no-op");
			return { ok: true, newWorkingDirectory: currentWorkingDirectory };
		}

		const terminalManager = await deps.getScopedTerminalManager(projectScope);
		const summary = terminalManager.store.getSummary(input.taskId);
		const wasRunning = summary && (summary.state === "running" || summary.state === "awaiting_review");
		log("session state check", { wasRunning, state: summary?.state ?? "no session" });

		// Resolve agent command and runtime config only when we need to
		// restart a session. Idle tasks (no running session) don't need an
		// agent command, so we shouldn't reject the migration for them.
		let resolved: ResolvedAgentCommand | undefined;
		let scopedRuntimeConfig: RuntimeConfigState | undefined;

		if (wasRunning) {
			scopedRuntimeConfig = await deps.config.loadScopedRuntimeConfig(projectScope);
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
				projectId: projectScope.projectId,
				projectPath: projectScope.projectPath,
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
				repoPath: projectScope.projectPath,
				taskId: input.taskId,
				worktreePath: currentWorkingDirectory,
			});
			log("creating worktree");
			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: projectScope.projectPath,
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
			newWorkingDirectory = projectScope.projectPath;
			log("de-isolating", newWorkingDirectory);
		}

		// Broadcast the working directory change to the UI, which applies it
		// to the board and persists through its normal single-writer cycle.
		try {
			log("broadcasting workingDirectory update", newWorkingDirectory);
			await applyRuntimeMutationEffects(
				deps.broadcaster,
				createTaskWorkingDirectoryUpdatedEffects({
					projectId: projectScope.projectId,
					taskId: input.taskId,
					workingDirectory: newWorkingDirectory,
					useWorktree: input.direction === "isolate",
				}),
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
