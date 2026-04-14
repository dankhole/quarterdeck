// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions. Detailed terminal and config behavior should stay
// in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../config/agent-registry";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import type { RuntimeCommandRunResponse } from "../core/api-contract";
import {
	parseCommandRunRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation";
import { createTaggedLogger, isDebugLoggingEnabled, setDebugLoggingEnabled } from "../core/debug-logger";
import { emitSessionEvent, setEventLogEnabled } from "../core/event-log";
import { findCardInBoard } from "../core/task-board-mutations";
import { openInBrowser } from "../server/browser";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	applyTaskPatch,
	captureTaskPatch,
	ensureTaskWorktreeIfDoesntExist,
	findTaskPatch,
	pathExists,
	resolveTaskCwd,
	resolveTaskWorkingDirectory,
} from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	prepareForStateReset?: () => Promise<void>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	setPollIntervals?: (
		workspaceId: string,
		intervals: { focusedTaskPollMs: number; backgroundTaskPollMs: number; homeRepoPollMs: number },
	) => void;
	broadcastDebugLoggingState?: (enabled: boolean) => void;
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const debugResetTargetPaths = [
		join(homedir(), ".quarterdeck"),
		join(homedir(), ".quarterdeck", "worktrees"),
	] as const;

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) => buildRuntimeConfigResponse(runtimeConfig);

	return {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return buildConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(
					workspaceScope.workspacePath,
					workspaceScope.workspaceId,
					parsed,
				);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (deps.setPollIntervals && workspaceScope) {
				deps.setPollIntervals(workspaceScope.workspaceId, {
					focusedTaskPollMs: nextRuntimeConfig.focusedTaskPollMs,
					backgroundTaskPollMs: nextRuntimeConfig.backgroundTaskPollMs,
					homeRepoPollMs: nextRuntimeConfig.homeRepoPollMs,
				});
			}
			setEventLogEnabled(nextRuntimeConfig.eventLogEnabled);
			return buildConfigResponse(nextRuntimeConfig);
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
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
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = body.waitForExit
					? await terminalManager.stopTaskSessionAndWaitForExit(body.taskId)
					: terminalManager.stopTaskSession(body.taskId);
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				let shellCwd = workspaceScope.workspacePath;
				if (body.workspaceTaskId) {
					shellCwd = await resolveTaskWorkingDirectory({
						workspacePath: workspaceScope.workspacePath,
						taskId: body.workspaceTaskId,
						baseRef: body.baseRef,
						ensure: true,
					});
				}
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
		setDebugLogging: (enabled) => {
			setDebugLoggingEnabled(enabled);
			deps.broadcastDebugLoggingState?.(enabled);
			return { ok: true, enabled: isDebugLoggingEnabled() };
		},
		flagTaskForDebug: async (workspaceScope, input) => {
			const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
			const summary = terminalManager.store.getSummary(input.taskId);
			if (!summary) {
				return { ok: false };
			}
			emitSessionEvent(input.taskId, "user.flagged", {
				note: input.note ?? null,
				state: summary.state,
				reviewReason: summary.reviewReason,
				pid: summary.pid,
				agentId: summary.agentId,
				lastOutputAt: summary.lastOutputAt,
				lastHookAt: summary.lastHookAt,
				updatedAt: summary.updatedAt,
				startedAt: summary.startedAt,
				exitCode: summary.exitCode,
				latestHookEvent: summary.latestHookActivity?.hookEventName ?? null,
			});
			return { ok: true };
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: [...debugResetTargetPaths],
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		// NOTE: This handler is not concurrent-safe. Two browser tabs migrating the
		// same task simultaneously could race on stop/start. The failure mode is
		// benign (duplicate session start, not data loss) and the terminal manager
		// replaces existing sessions, so this is an accepted trade-off.
		migrateTaskWorkingDirectory: async (workspaceScope, input) => {
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
				let resolved: NonNullable<ReturnType<typeof resolveAgentCommand>> | undefined;
				let scopedRuntimeConfig: Awaited<ReturnType<typeof deps.loadScopedRuntimeConfig>> | undefined;

				if (wasRunning) {
					scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
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
					void deps.broadcastRuntimeWorkspaceStateUpdated(
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
							log(
								"session restart also failed",
								restartError instanceof Error ? restartError.message : restartError,
							);
						}
					}
					throw postStopError;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log("migration failed", message);
				return { ok: false, error: message };
			}
		},
	};
}
