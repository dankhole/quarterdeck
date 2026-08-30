import { randomUUID } from "node:crypto";

import type { RuntimeTaskSessionStartResponse, TaskResourceOperationRunner } from "../core";
import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import type { PreparedTaskSessionStart } from "../server/task-session-start-service";
import { launchPreparedTaskSession } from "../server/task-session-start-service";
import type { ProjectBoardCommandScope } from "../state";
import {
	ExecutionOperationIdentityConflictError,
	ExecutionOwnershipBusyError,
	ExecutionOwnershipGenerationConflictError,
	fingerprintExecutionOperation,
	ProjectExecutionOwnershipStore,
} from "../state";
import { isProcessAlive, MISSING_SESSION_LAUNCH_PATH_WARNING, type TerminalSessionManager } from "../terminal";
import type { NativeTaskSessionProfileEnvironment, StopTaskSessionResult } from "../terminal/session-manager-types";
import { pathExists } from "../workdir";
import {
	CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT,
	CLAUDE_STRUCTURED_CLI_VERSION,
	fingerprintClaudeProfileRoot,
	resolveClaudeCliVersion,
	resolveClaudeProfileRoot,
} from "./claude-structured-owner";
import { CODEX_APP_SERVER_SCHEMA_FINGERPRINT, CODEX_APP_SERVER_VERSION } from "./codex-app-server-protocol";
import {
	CodexStructuredOwnerCompatibilityError,
	CodexStructuredOwnerStopUnconfirmedError,
	fingerprintCodexProfileRoot,
	resolveCodexCliVersion,
	resolveCodexProfileRoot,
} from "./codex-structured-owner";
import type {
	ExecutionHandoffOutcome,
	ExecutionHandoffResult,
	TaskExecutionOwnership,
} from "./execution-ownership-contracts";
import {
	StructuredOwnerCompatibilityError,
	type StructuredOwnerContext,
	type StructuredOwnerRegistryContract,
	StructuredOwnerStopUnconfirmedError,
	type StructuredPendingInteraction,
	type StructuredTurn,
} from "./structured-owner";

const log = createTaggedLogger("execution-ownership");
const NATIVE_HANDOFF_READINESS_TIMEOUT_MS = 15_000;
const OWNER_STOP_TIMEOUT_MS = 3_000;

function ownerProcessKind(provider: "codex" | "claude"): "stdio_app_server" | "stdio_agent_sdk" {
	return provider === "codex" ? "stdio_app_server" : "stdio_agent_sdk";
}

export interface PrepareNativeResumeInput {
	scope: ProjectBoardCommandScope;
	taskId: string;
	operationId: string;
	providerSessionId: string;
	provider: "codex" | "claude";
	requiredExistingLaunchPath: string;
}

export interface TaskExecutionOwnershipServiceDependencies {
	store?: ProjectExecutionOwnershipStore;
	structuredOwners: StructuredOwnerRegistryContract;
	getTerminalManager: (scope: ProjectBoardCommandScope) => Promise<TerminalSessionManager>;
	prepareNativeResume: (input: PrepareNativeResumeInput) => Promise<PreparedTaskSessionStart>;
	assertDurableHistoryAvailable: (scope: ProjectBoardCommandScope, taskId: string) => Promise<boolean>;
	resolveProviderVersion?: (binary: string) => Promise<string>;
	isLaunchPathAvailable?: (path: string) => Promise<boolean>;
	diagnostics?: RuntimeDiagnostics;
	taskResourceOperations: TaskResourceOperationRunner;
}

export interface ExecutionHandoffCommand {
	operationId: string;
	taskId: string;
	expectedOwnerGeneration: number;
}

export class TaskExecutionOwnershipService {
	private readonly store: ProjectExecutionOwnershipStore;
	private readonly inFlight = new Map<string, Promise<ExecutionHandoffResult>>();
	private readonly intentionalStructuredStops = new Map<string, "transition" | "shutdown">();

	constructor(private readonly dependencies: TaskExecutionOwnershipServiceDependencies) {
		this.store = dependencies.store ?? new ProjectExecutionOwnershipStore();
		dependencies.structuredOwners.setEvents({
			onTurnStarted: (context, turn, clientUserMessageId) => {
				this.runStructuredEvent(
					"turn_started",
					context,
					async () => await this.onStructuredTurnStarted(context, turn, clientUserMessageId),
				);
			},
			onTurnCompleted: (context, turn) => {
				this.runStructuredEvent(
					"turn_completed",
					context,
					async () => await this.onStructuredTurnCompleted(context, turn),
				);
			},
			onInteractionRequested: (context, interaction) => {
				this.runStructuredEvent(
					"interaction_requested",
					context,
					async () => await this.onStructuredInteractionRequested(context, interaction),
				);
			},
			onInteractionResolved: (context, interaction) => {
				this.runStructuredEvent(
					"interaction_resolved",
					context,
					async () => await this.onStructuredInteractionResolved(context, interaction),
				);
			},
			onInteractionCancelled: (context, interaction) => {
				this.runStructuredEvent(
					"interaction_cancelled",
					context,
					async () => await this.onStructuredInteractionCancelled(context, interaction),
				);
			},
			onExit: (context, turnOutcomeUnknown) => {
				const stopIntent = this.intentionalStructuredStops.get(this.structuredStopKey(context)) ?? null;
				this.intentionalStructuredStops.delete(this.structuredStopKey(context));
				this.runStructuredEvent(
					"owner_exit",
					context,
					async () => await this.onStructuredOwnerExit(context, turnOutcomeUnknown, stopIntent),
				);
			},
		});
	}

	async getOwnership(scope: ProjectBoardCommandScope, taskId: string): Promise<TaskExecutionOwnership | null> {
		return await this.store.getOwnership(scope, taskId);
	}

	async assertNativeStartAllowed(scope: ProjectBoardCommandScope, taskId: string): Promise<void> {
		const ownership = await this.store.getOwnership(scope, taskId);
		const structuredOwner = this.dependencies.structuredOwners.get(scope.projectId, taskId);
		if (!ownership && !structuredOwner) return;
		if (ownership?.state !== "native_tui" || structuredOwner) {
			throw new Error("Task is owned by the structured execution runner.");
		}
	}

	async observeNativeOwner(
		scope: ProjectBoardCommandScope,
		taskId: string,
		manager: TerminalSessionManager,
	): Promise<TaskExecutionOwnership | null> {
		const summary = manager.store.getSummary(taskId);
		const processIdentity = manager.getTaskSessionProcessIdentity(taskId);
		const providerSessionId = summary?.resumeSessionId?.trim() ?? "";
		if (
			(summary?.agentId !== "codex" && summary?.agentId !== "claude") ||
			!processIdentity ||
			processIdentity.agentId !== summary.agentId ||
			!processIdentity.binary ||
			!providerSessionId
		) {
			return null;
		}
		const existing = await this.store.getOwnership(scope, taskId);
		if (existing && existing.state !== "native_tui") return existing;
		const provider = summary.agentId;
		const profileFingerprint =
			provider === "codex"
				? fingerprintCodexProfileRoot(resolveCodexProfileRoot(processIdentity.profileEnvironment))
				: fingerprintClaudeProfileRoot(resolveClaudeProfileRoot(processIdentity.profileEnvironment));
		const ownerInstanceChanged = Boolean(
			existing &&
				(existing.ownerSessionInstanceId !== processIdentity.sessionInstanceId ||
					existing.ownerProcess?.processKind !== "pty" ||
					existing.ownerProcess.pid !== processIdentity.pid),
		);
		const providerIdentityChanged = Boolean(
			existing &&
				(existing.providerSessionId !== providerSessionId ||
					existing.providerProfileFingerprint !== profileFingerprint),
		);
		if (existing && !ownerInstanceChanged && !providerIdentityChanged) return existing;
		const version = await (
			this.dependencies.resolveProviderVersion ??
			(provider === "codex" ? resolveCodexCliVersion : resolveClaudeCliVersion)
		)(processIdentity.binary);
		const providerVersionChanged = Boolean(existing && existing.providerVersion !== version);
		const ownership: TaskExecutionOwnership = {
			projectId: scope.projectId,
			taskId,
			provider,
			providerSessionId,
			providerSessionTreeId:
				providerIdentityChanged || providerVersionChanged ? null : (existing?.providerSessionTreeId ?? null),
			providerProfileFingerprint: profileFingerprint,
			configurationFingerprint:
				ownerInstanceChanged || providerIdentityChanged || providerVersionChanged
					? null
					: (existing?.configurationFingerprint ?? null),
			providerVersion: version,
			protocolSchemaFingerprint:
				provider === "codex" ? CODEX_APP_SERVER_SCHEMA_FINGERPRINT : CLAUDE_AGENT_SDK_SCHEMA_FINGERPRINT,
			historyMode:
				provider === "codex" && !providerIdentityChanged && !providerVersionChanged
					? (existing?.historyMode ?? null)
					: null,
			state: "native_tui",
			ownerGeneration:
				existing?.ownerGeneration === undefined
					? 0
					: existing.ownerGeneration +
						(ownerInstanceChanged || providerIdentityChanged || providerVersionChanged ? 1 : 0),
			ownerSessionInstanceId: processIdentity.sessionInstanceId,
			ownerProcess: {
				processKind: "pty",
				pid: processIdentity.pid,
				sessionInstanceId: processIdentity.sessionInstanceId,
				launchOperationId: processIdentity.launchOperationId,
			},
			activeTurn: null,
			pendingHandoff: null,
			lastFailure: null,
			updatedAt: Date.now(),
		};
		const currentProcessIdentity = manager.getTaskSessionProcessIdentity(taskId);
		if (
			!currentProcessIdentity ||
			currentProcessIdentity.pid !== processIdentity.pid ||
			currentProcessIdentity.sessionInstanceId !== processIdentity.sessionInstanceId ||
			currentProcessIdentity.binary !== processIdentity.binary
		) {
			return await this.store.getOwnership(scope, taskId);
		}
		return (await this.store.putOwnershipIfCurrent(scope, existing, ownership)).ownership;
	}

	handoffToStructured(
		scope: ProjectBoardCommandScope,
		command: ExecutionHandoffCommand,
	): Promise<ExecutionHandoffResult> {
		return this.runOnce(
			scope,
			command,
			"structured",
			async () =>
				await this.dependencies.taskResourceOperations.run(
					scope.projectId,
					command.taskId,
					async () => await this.handoffToStructuredOnce(scope, command),
				),
		);
	}

	handoffToNative(scope: ProjectBoardCommandScope, command: ExecutionHandoffCommand): Promise<ExecutionHandoffResult> {
		return this.runOnce(
			scope,
			command,
			"native_tui",
			async () =>
				await this.dependencies.taskResourceOperations.run(
					scope.projectId,
					command.taskId,
					async () => await this.handoffToNativeOnce(scope, command),
				),
		);
	}

	async stopCurrentOwner(
		scope: ProjectBoardCommandScope,
		taskId: string,
		nativeSessionInstanceId?: string,
	): Promise<StopTaskSessionResult> {
		const ownership = await this.store.getOwnership(scope, taskId);
		const manager = await this.dependencies.getTerminalManager(scope);
		if (!ownership) {
			return await manager.stopTaskSessionAndWaitForExit(taskId, OWNER_STOP_TIMEOUT_MS, nativeSessionInstanceId);
		}
		const structuredOwner = this.dependencies.structuredOwners.get(scope.projectId, taskId);
		const nativeIdentity = manager.getTaskSessionProcessIdentity(taskId);
		if (structuredOwner && (ownership.ownerProcess?.processKind === "pty" || nativeIdentity !== null)) {
			return {
				summary: manager.store.getSummary(taskId),
				requestedSessionInstanceId: ownership.ownerSessionInstanceId,
				didExit: false,
				outcome: "failed",
				error: "Execution ownership is ambiguous; no process was stopped.",
			};
		}
		const ownsNativeProcess =
			ownership.ownerProcess?.processKind === "pty" ||
			(!ownership.ownerProcess && !structuredOwner && nativeIdentity !== null);
		if (ownsNativeProcess) {
			const requestedSessionInstanceId =
				nativeSessionInstanceId ??
				nativeIdentity?.sessionInstanceId ??
				(ownership.ownerProcess?.processKind === "pty" ? ownership.ownerProcess.sessionInstanceId : undefined);
			const stopped = await manager.stopTaskSessionAndWaitForExit(
				taskId,
				OWNER_STOP_TIMEOUT_MS,
				requestedSessionInstanceId,
			);
			const remainingNativeIdentity = manager.getTaskSessionProcessIdentity(taskId);
			const persistedNativePidStillAlive =
				ownership.ownerProcess?.processKind === "pty" && isProcessAlive(ownership.ownerProcess.pid);
			if (stopped.didExit && (remainingNativeIdentity || persistedNativePidStillAlive)) {
				return {
					summary: manager.store.getSummary(taskId),
					requestedSessionInstanceId: requestedSessionInstanceId ?? null,
					didExit: false,
					outcome: "failed",
					error: "Native execution owner exit could not be confirmed.",
				};
			}
			if (stopped.didExit) await this.commitStoppedOwner(scope, ownership);
			return stopped;
		}
		if (!ownership.ownerProcess && !structuredOwner) {
			if (ownership.state === "native_tui") {
				return {
					summary: manager.store.getSummary(taskId),
					requestedSessionInstanceId: ownership.ownerSessionInstanceId,
					didExit: true,
					outcome: "not_running",
				};
			}
			await this.commitStoppedOwner(scope, ownership);
			return {
				summary: manager.store.getSummary(taskId),
				requestedSessionInstanceId: ownership.ownerSessionInstanceId,
				didExit: true,
				outcome: "not_running",
			};
		}
		let terminalTurn: StructuredTurn | null = null;
		if (structuredOwner?.hasActiveTurn()) {
			try {
				terminalTurn = await structuredOwner.interruptActiveTurn();
			} catch {
				return {
					summary: manager.store.getSummary(taskId),
					requestedSessionInstanceId: ownership.ownerSessionInstanceId,
					didExit: false,
					outcome: "failed",
					error: "The structured turn could not be interrupted safely.",
				};
			}
		}
		const outcome = await this.stopStructuredOwnerPlanned(scope, ownership);
		const didExit = outcome === "exited" || outcome === "not_running";
		if (didExit) {
			const summaryBeforeStop = manager.store.getSummary(taskId);
			if (summaryBeforeStop?.state === "running") {
				if (terminalTurn?.status === "completed" || terminalTurn?.status === "interrupted") {
					manager.applyStructuredTransition(taskId, { type: "structured.turn_completed" });
				} else {
					manager.applyStructuredTransition(taskId, {
						type: "structured.turn_failed",
						warningMessage:
							"The structured owner stopped before its final turn status could be projected. Review provider history before retrying.",
					});
				}
			}
			await this.commitStoppedOwner(scope, ownership);
			manager.applyStructuredTransition(taskId, { type: "structured.owner_stopped" });
		}
		return {
			summary: manager.store.getSummary(taskId),
			requestedSessionInstanceId: ownership.ownerSessionInstanceId,
			didExit,
			outcome: didExit
				? outcome === "not_running"
					? "not_running"
					: "exited"
				: outcome === "timed_out"
					? "timed_out"
					: "failed",
			...(didExit ? {} : { error: "Structured execution owner did not stop cleanly." }),
		};
	}

	private async commitStoppedOwner(scope: ProjectBoardCommandScope, ownership: TaskExecutionOwnership): Promise<void> {
		const pendingOperationId = ownership.pendingHandoff?.operationId ?? null;
		await this.updateOwnershipAndFinishKnownHandoff(
			scope,
			ownership.taskId,
			pendingOperationId,
			"stop_failed",
			(current) => {
				if (
					current.ownerGeneration !== ownership.ownerGeneration ||
					current.ownerSessionInstanceId !== ownership.ownerSessionInstanceId
				) {
					return current;
				}
				return {
					...current,
					state: "native_tui",
					ownerGeneration: current.ownerGeneration + 1,
					ownerSessionInstanceId: randomUUID(),
					ownerProcess: null,
					activeTurn: null,
					pendingHandoff: null,
					lastFailure: null,
				};
			},
		);
	}

	private async updateOwnershipAndFinishKnownHandoff(
		scope: ProjectBoardCommandScope,
		taskId: string,
		operationId: string | null,
		outcome: ExecutionHandoffOutcome,
		updater: (current: TaskExecutionOwnership) => TaskExecutionOwnership,
	): Promise<TaskExecutionOwnership> {
		return (await this.store.updateOwnershipAndFinishKnownHandoff(scope, taskId, operationId, outcome, updater))
			.ownership;
	}

	async removeTask(scope: ProjectBoardCommandScope, taskId: string): Promise<void> {
		await this.store.removeOwnership(scope, taskId);
	}

	async prepareProjectRemoval(scope: ProjectBoardCommandScope): Promise<{ ok: boolean; error?: string }> {
		for (const persisted of await this.store.listOwnership(scope)) {
			const stopped = await this.dependencies.taskResourceOperations.run(
				scope.projectId,
				persisted.taskId,
				async () => {
					const ownership = await this.store.getOwnership(scope, persisted.taskId);
					if (!ownership) return true;
					const manager = await this.dependencies.getTerminalManager(scope);
					if (ownership.ownerProcess?.processKind === "pty") {
						const outcome = await manager.stopTaskSessionAndWaitForExit(
							ownership.taskId,
							OWNER_STOP_TIMEOUT_MS,
							ownership.ownerProcess.sessionInstanceId,
						);
						if (
							!outcome.didExit ||
							(outcome.outcome === "not_running" && isProcessAlive(ownership.ownerProcess.pid))
						) {
							return false;
						}
					} else if (
						ownership.ownerProcess ||
						this.dependencies.structuredOwners.get(scope.projectId, ownership.taskId)
					) {
						const owner = this.dependencies.structuredOwners.get(scope.projectId, ownership.taskId);
						if (owner?.hasActiveTurn()) {
							try {
								await owner.interruptActiveTurn();
							} catch {
								return false;
							}
						}
						const outcome = await this.stopStructuredOwnerPlanned(scope, ownership);
						if (outcome !== "exited" && outcome !== "not_running") return false;
					}
					await this.store.updateOwnership(scope, ownership.taskId, (current) => ({
						...current,
						state: "native_tui",
						ownerGeneration: current.ownerGeneration + 1,
						ownerSessionInstanceId: randomUUID(),
						ownerProcess: null,
						activeTurn: null,
						pendingHandoff: null,
						lastFailure: null,
					}));
					return true;
				},
			);
			if (!stopped) {
				return { ok: false, error: "A task execution owner could not be stopped safely." };
			}
		}
		return { ok: true };
	}

	async reconcileProjectLaunchPaths(scope: ProjectBoardCommandScope): Promise<void> {
		for (const persisted of await this.store.listOwnership(scope)) {
			if (
				persisted.ownerProcess?.processKind !== "stdio_app_server" &&
				persisted.ownerProcess?.processKind !== "stdio_agent_sdk" &&
				!this.dependencies.structuredOwners.get(scope.projectId, persisted.taskId)
			) {
				continue;
			}
			await this.dependencies.taskResourceOperations.run(scope.projectId, persisted.taskId, async () => {
				const ownership = await this.store.getOwnership(scope, persisted.taskId);
				if (
					!ownership ||
					((!ownership.ownerProcess || ownership.ownerProcess.processKind === "pty") &&
						!this.dependencies.structuredOwners.get(scope.projectId, persisted.taskId))
				) {
					return;
				}
				const manager = await this.dependencies.getTerminalManager(scope);
				if (await this.resolveExistingLaunchPath(manager, persisted.taskId)) return;
				const owner = this.dependencies.structuredOwners.get(scope.projectId, persisted.taskId);
				if (owner?.hasActiveTurn()) {
					try {
						await owner.interruptActiveTurn();
					} catch {
						this.record("execution.missing_launch_path_stop_failed", scope, persisted.taskId, ownership);
						return;
					}
				}
				const stopOutcome = await this.stopStructuredOwnerPlanned(scope, ownership);
				if (stopOutcome !== "exited" && stopOutcome !== "not_running") {
					this.record("execution.missing_launch_path_stop_failed", scope, persisted.taskId, ownership);
					return;
				}
				const pendingOperationId = ownership.pendingHandoff?.operationId ?? null;
				await this.updateOwnershipAndFinishKnownHandoff(
					scope,
					persisted.taskId,
					pendingOperationId,
					"worktree_missing",
					(current) => ({
						...current,
						state: "native_tui",
						ownerGeneration: current.ownerGeneration + 1,
						ownerSessionInstanceId: randomUUID(),
						ownerProcess: null,
						activeTurn: null,
						pendingHandoff: null,
						lastFailure: { code: "worktree_missing", at: Date.now() },
					}),
				);
				manager.applyStructuredTransition(persisted.taskId, { type: "structured.owner_stopped" });
				manager.applyStructuredLaunchPathMissing(persisted.taskId, MISSING_SESSION_LAUNCH_PATH_WARNING);
			});
		}
	}

	async restartStructuredOwner(
		scope: ProjectBoardCommandScope,
		taskId: string,
		operationId: string,
	): Promise<RuntimeTaskSessionStartResponse | null> {
		let ownership = await this.store.getOwnership(scope, taskId);
		if (!ownership || ownership.state === "native_tui") return null;
		const persistedFailure = ownership.lastFailure;
		const persistedUnknownOutcome = persistedFailure?.code === "turn_outcome_unknown";
		const unknownOutcomeAt = persistedUnknownOutcome ? persistedFailure.at : null;
		const owner = this.dependencies.structuredOwners.get(scope.projectId, taskId);
		const ownerMatchesPersistedIdentity = Boolean(
			owner?.hasWriteAuthority() &&
				owner.context.ownerGeneration === ownership.ownerGeneration &&
				owner.context.ownerSessionInstanceId === ownership.ownerSessionInstanceId,
		);
		if (
			ownership.state === "structured" &&
			ownerMatchesPersistedIdentity &&
			ownership.ownerProcess?.launchOperationId === operationId
		) {
			const summary = (await this.dependencies.getTerminalManager(scope)).store.getSummary(taskId);
			return {
				ok: summary !== null,
				summary,
				...(summary ? {} : { error: "Session summary was unavailable." }),
			};
		}
		const reconstructWithoutStop =
			(ownership.state === "structured" || ownership.state === "handoff_to_structured_pending") &&
			!ownership.ownerProcess &&
			!owner;
		if (ownership.state !== "structured" && !reconstructWithoutStop) {
			return { ok: false, summary: null, error: "Execution ownership handoff is still pending." };
		}
		if (!owner && !reconstructWithoutStop) {
			return { ok: false, summary: null, error: "Structured owner is not running." };
		}
		const manager = await this.dependencies.getTerminalManager(scope);
		const launchPath = await this.resolveExistingLaunchPath(manager, taskId);
		if (!launchPath) return { ok: false, summary: null, error: "Task worktree is missing or changed." };
		const prepared = await this.dependencies.prepareNativeResume({
			scope,
			taskId,
			operationId,
			providerSessionId: ownership.providerSessionId,
			provider: ownership.provider,
			requiredExistingLaunchPath: launchPath,
		});
		if (!(await this.preparedLaunchPathIsValid(prepared, launchPath))) {
			return { ok: false, summary: null, error: "Task worktree is missing or changed." };
		}
		ownership = await this.store.updateOwnership(scope, taskId, (current) => ({
			...current,
			state: "handoff_to_structured_pending",
			pendingHandoff: {
				operationId,
				targetOwner: "structured",
				expectedOwnerGeneration: current.ownerGeneration,
				phase: reconstructWithoutStop ? "starting_replacement" : "stopping_owner",
				startedAt: Date.now(),
			},
		}));
		if (!reconstructWithoutStop && owner?.hasActiveTurn()) {
			try {
				await owner.interruptActiveTurn();
			} catch {
				await this.restoreStructuredAfterFailedStop(scope, taskId);
				return { ok: false, summary: null, error: "Structured turn could not be interrupted safely." };
			}
		}
		if (!reconstructWithoutStop) {
			const stopped = await this.stopStructuredOwnerPlanned(scope, ownership);
			if (stopped !== "exited" && stopped !== "not_running") {
				await this.restoreStructuredAfterFailedStop(scope, taskId);
				return { ok: false, summary: null, error: "Structured owner did not stop before restart." };
			}
			ownership = await this.store.updateOwnership(scope, taskId, (current) => ({
				...current,
				ownerProcess: null,
				activeTurn: null,
				pendingHandoff: current.pendingHandoff
					? { ...current.pendingHandoff, phase: "starting_replacement" }
					: current.pendingHandoff,
			}));
		}
		try {
			const nextGeneration = ownership.ownerGeneration + 1;
			const replacement = await this.startStructuredReplacement(
				scope,
				ownership,
				prepared,
				nextGeneration,
				operationId,
			);
			ownership = await this.store.updateOwnership(scope, taskId, (current) => ({
				...this.assertStructuredReplacementCurrent(current, replacement.identity.ownerSessionInstanceId),
				state: "structured",
				configurationFingerprint: replacement.identity.configurationFingerprint,
				historyMode: replacement.identity.historyMode,
				pendingHandoff: null,
				lastFailure: persistedUnknownOutcome
					? { code: "turn_outcome_unknown", at: unknownOutcomeAt ?? Date.now() }
					: null,
			}));
			const manager = await this.dependencies.getTerminalManager(scope);
			manager.applyStructuredTransition(taskId, {
				type: "structured.owner_activated",
				pid: replacement.identity.pid,
				sessionInstanceId: replacement.identity.ownerSessionInstanceId,
			});
			if (persistedUnknownOutcome) {
				manager.applyStructuredTransition(taskId, {
					type: "structured.turn_failed",
					warningMessage: "The previous structured turn outcome is unknown and was not replayed.",
				});
			}
			const summary = manager.store.getSummary(taskId);
			return { ok: summary !== null, summary, ...(summary ? {} : { error: "Session summary was unavailable." }) };
		} catch (error) {
			const outcome = this.toStartFailureOutcome(error);
			await this.store.updateOwnership(scope, taskId, (current) => ({
				...current,
				lastFailure: { code: this.toPersistedFailureCode(outcome), at: Date.now() },
			}));
			return { ok: false, summary: null, error: "Structured owner replacement failed." };
		}
	}

	async recoverProject(
		scope: ProjectBoardCommandScope,
	): Promise<Array<{ taskId: string; outcome: "recovered" | "turn_outcome_unknown" | "failed" | "not_required" }>> {
		const results: Array<{
			taskId: string;
			outcome: "recovered" | "turn_outcome_unknown" | "failed" | "not_required";
		}> = [];
		for (let ownership of await this.store.listOwnership(scope)) {
			const previousOwnerLaunchOperationId = ownership.ownerProcess?.launchOperationId ?? null;
			if (ownership.state === "native_tui") {
				results.push({ taskId: ownership.taskId, outcome: "not_required" });
				continue;
			}
			const liveOwner = this.dependencies.structuredOwners.get(scope.projectId, ownership.taskId);
			if (
				liveOwner?.hasWriteAuthority() &&
				liveOwner.context.ownerGeneration === ownership.ownerGeneration &&
				liveOwner.context.ownerSessionInstanceId === ownership.ownerSessionInstanceId
			) {
				results.push({ taskId: ownership.taskId, outcome: "not_required" });
				continue;
			}
			if (ownership.ownerProcess) {
				if (isProcessAlive(ownership.ownerProcess.pid)) {
					this.record("execution.recovery_owner_still_alive", scope, ownership.taskId, ownership);
					results.push({ taskId: ownership.taskId, outcome: "failed" });
					continue;
				}
				ownership = await this.store.updateOwnership(scope, ownership.taskId, (current) => ({
					...current,
					ownerProcess: null,
				}));
			}
			if (ownership.state === "handoff_to_native_pending") {
				const pendingOperationId = ownership.pendingHandoff?.operationId ?? null;
				let launched: Awaited<ReturnType<typeof launchPreparedTaskSession>> | null = null;
				let processIdentity: ReturnType<TerminalSessionManager["getTaskSessionProcessIdentity"]> = null;
				try {
					const manager = await this.dependencies.getTerminalManager(scope);
					const launchPath = await this.resolveExistingLaunchPath(manager, ownership.taskId);
					if (!launchPath) throw new Error("The existing task launch path is unavailable.");
					const prepared = await this.dependencies.prepareNativeResume({
						scope,
						taskId: ownership.taskId,
						operationId: ownership.pendingHandoff?.operationId ?? `recovery-${randomUUID()}`,
						providerSessionId: ownership.providerSessionId,
						provider: ownership.provider,
						requiredExistingLaunchPath: launchPath,
					});
					if (!(await this.preparedLaunchPathIsValid(prepared, launchPath))) {
						throw new Error("The existing task launch path changed during recovery.");
					}
					launched = await launchPreparedTaskSession(prepared);
					const launchedIdentity = launched.terminalManager.getTaskSessionProcessIdentity(ownership.taskId);
					if (!launchedIdentity) throw new Error("Native recovery did not create a process identity.");
					processIdentity = launchedIdentity;
					ownership = await this.store.updateOwnership(scope, ownership.taskId, (current) => ({
						...current,
						ownerGeneration: current.ownerGeneration + 1,
						ownerSessionInstanceId: launchedIdentity.sessionInstanceId,
						ownerProcess: {
							processKind: "pty",
							pid: launchedIdentity.pid,
							sessionInstanceId: launchedIdentity.sessionInstanceId,
							launchOperationId: launchedIdentity.launchOperationId,
						},
					}));
					const readiness = await launched.terminalManager.waitForTaskSessionLaunch(
						ownership.taskId,
						launchedIdentity.sessionInstanceId,
						NATIVE_HANDOFF_READINESS_TIMEOUT_MS,
					);
					if (readiness.status !== "ready" || readiness.observedSessionId !== ownership.providerSessionId) {
						throw new Error("Native recovery identity was not confirmed.");
					}
					ownership = await this.updateOwnershipAndFinishKnownHandoff(
						scope,
						ownership.taskId,
						pendingOperationId,
						"completed",
						(current) => ({
							...current,
							state: "native_tui",
							pendingHandoff: null,
							activeTurn: null,
							lastFailure: null,
						}),
					);
					results.push({ taskId: ownership.taskId, outcome: "recovered" });
				} catch (error) {
					let failureOutcome: ExecutionHandoffOutcome = "replacement_start_failed";
					if (launched) {
						const stopped = await launched.terminalManager.stopTaskSessionAndWaitForExit(
							ownership.taskId,
							OWNER_STOP_TIMEOUT_MS,
							processIdentity?.sessionInstanceId,
						);
						failureOutcome = stopped.didExit
							? "identity_mismatch"
							: stopped.outcome === "timed_out"
								? "stop_timed_out"
								: "stop_failed";
					}
					ownership = await this.updateOwnershipAndFinishKnownHandoff(
						scope,
						ownership.taskId,
						pendingOperationId,
						failureOutcome,
						(current) => ({
							...current,
							...(failureOutcome === "identity_mismatch" || !launched ? { ownerProcess: null } : {}),
							lastFailure: {
								code:
									failureOutcome === "stop_failed" || failureOutcome === "stop_timed_out"
										? "stop_failed"
										: "identity_mismatch",
								at: Date.now(),
							},
						}),
					);
					this.record("execution.recovery_failed", scope, ownership.taskId, ownership, error);
					results.push({ taskId: ownership.taskId, outcome: "failed" });
				}
				continue;
			}

			const pendingOperationId = ownership.pendingHandoff?.operationId ?? null;
			const recoveryOperationId = pendingOperationId ?? previousOwnerLaunchOperationId ?? `recovery-${randomUUID()}`;
			let structured: ReturnType<StructuredOwnerRegistryContract["get"]> = null;
			try {
				const manager = await this.dependencies.getTerminalManager(scope);
				const launchPath = await this.resolveExistingLaunchPath(manager, ownership.taskId);
				if (!launchPath) throw new Error("The existing task launch path is unavailable.");
				const prepared = await this.dependencies.prepareNativeResume({
					scope,
					taskId: ownership.taskId,
					operationId: recoveryOperationId,
					providerSessionId: ownership.providerSessionId,
					provider: ownership.provider,
					requiredExistingLaunchPath: launchPath,
				});
				if (!(await this.preparedLaunchPathIsValid(prepared, launchPath))) {
					throw new Error("The existing task launch path changed during recovery.");
				}
				const nextGeneration = ownership.ownerGeneration + 1;
				const replacement = await this.startStructuredReplacement(
					scope,
					ownership,
					prepared,
					nextGeneration,
					recoveryOperationId,
				);
				structured = replacement;
				const previousActiveTurn = ownership.activeTurn;
				const persistedFailure = ownership.lastFailure;
				const persistedUnknownOutcome = persistedFailure?.code === "turn_outcome_unknown";
				const unknownOutcomeAt = persistedUnknownOutcome ? persistedFailure.at : null;
				let recoveredTurn: StructuredTurn | null = null;
				if (previousActiveTurn) {
					recoveredTurn =
						(await replacement.readRecentTurns()).find((turn) => turn.id === previousActiveTurn.turnId) ?? null;
				}
				const outcomeUnknown = previousActiveTurn
					? !recoveredTurn || recoveredTurn.status === "inProgress"
					: persistedUnknownOutcome;
				ownership = await this.updateOwnershipAndFinishKnownHandoff(
					scope,
					ownership.taskId,
					pendingOperationId,
					"completed",
					(current) => ({
						...this.assertStructuredReplacementCurrent(current, replacement.identity.ownerSessionInstanceId),
						providerSessionTreeId: replacement.identity.providerSessionTreeId,
						configurationFingerprint: replacement.identity.configurationFingerprint,
						historyMode: replacement.identity.historyMode,
						state: "structured",
						activeTurn: null,
						pendingHandoff: null,
						lastFailure: outcomeUnknown
							? { code: "turn_outcome_unknown", at: unknownOutcomeAt ?? Date.now() }
							: null,
					}),
				);
				manager.applyStructuredTransition(ownership.taskId, {
					type: "structured.owner_activated",
					pid: replacement.identity.pid,
					sessionInstanceId: replacement.identity.ownerSessionInstanceId,
				});
				if (outcomeUnknown) {
					manager.applyStructuredTransition(ownership.taskId, {
						type: "structured.turn_failed",
						warningMessage: "The previous structured turn outcome is unknown and was not replayed.",
					});
				} else if (previousActiveTurn) {
					if (recoveredTurn?.status === "failed") {
						manager.applyStructuredTransition(ownership.taskId, {
							type: "structured.turn_failed",
							warningMessage: "The previous structured turn failed before runtime recovery.",
						});
					} else {
						manager.applyStructuredTransition(ownership.taskId, { type: "structured.turn_completed" });
					}
				}
				results.push({ taskId: ownership.taskId, outcome: outcomeUnknown ? "turn_outcome_unknown" : "recovered" });
			} catch (error) {
				let failureOutcome: ExecutionHandoffOutcome = this.toStartFailureOutcome(error);
				if (structured) {
					const current = await this.store.getOwnership(scope, ownership.taskId);
					if (current) {
						const stopped = await this.stopStructuredOwnerPlanned(scope, current);
						failureOutcome = stopped === "timed_out" || stopped === "superseded" ? "stop_failed" : failureOutcome;
						if (stopped === "exited" || stopped === "not_running") {
							ownership = await this.store.updateOwnership(scope, ownership.taskId, (latest) => ({
								...latest,
								ownerProcess: null,
								activeTurn: null,
							}));
						}
					}
				}
				ownership = await this.updateOwnershipAndFinishKnownHandoff(
					scope,
					ownership.taskId,
					pendingOperationId,
					failureOutcome,
					(current) => ({
						...current,
						lastFailure: { code: this.toPersistedFailureCode(failureOutcome), at: Date.now() },
					}),
				);
				this.record("execution.recovery_failed", scope, ownership.taskId, ownership, error);
				results.push({ taskId: ownership.taskId, outcome: "failed" });
			}
		}
		return results;
	}

	async shutdownProject(scope: ProjectBoardCommandScope): Promise<void> {
		for (const persisted of await this.store.listOwnership(scope)) {
			await this.dependencies.taskResourceOperations.run(scope.projectId, persisted.taskId, async () => {
				const ownership = await this.store.getOwnership(scope, persisted.taskId);
				if (
					!ownership ||
					((!ownership.ownerProcess || ownership.ownerProcess.processKind === "pty") &&
						!this.dependencies.structuredOwners.get(scope.projectId, persisted.taskId))
				) {
					return;
				}
				const owner = this.dependencies.structuredOwners.get(scope.projectId, persisted.taskId);
				const liveActiveTurn = owner?.getActiveTurn() ?? null;
				let turnSettled = liveActiveTurn === null && ownership.activeTurn === null;
				if (liveActiveTurn) {
					try {
						await owner?.interruptActiveTurn();
						turnSettled = true;
					} catch {
						turnSettled = false;
					}
				}
				const stopped = await this.stopStructuredOwnerPlanned(scope, ownership, "shutdown");
				if (stopped !== "exited" && stopped !== "not_running") return;
				await this.store.updateOwnership(scope, persisted.taskId, (current) => {
					if (
						current.ownerGeneration !== ownership.ownerGeneration ||
						current.ownerSessionInstanceId !== ownership.ownerSessionInstanceId
					) {
						return current;
					}
					const unresolvedTurn = turnSettled
						? null
						: (current.activeTurn ??
							(liveActiveTurn
								? {
										turnId: liveActiveTurn.turnId,
										clientUserMessageId: liveActiveTurn.clientUserMessageId,
										startedAt: Date.now(),
									}
								: null));
					return {
						...current,
						ownerProcess: null,
						activeTurn: unresolvedTurn,
						...(unresolvedTurn ? { lastFailure: { code: "turn_outcome_unknown", at: Date.now() } } : {}),
					};
				});
			});
		}
	}

	private runOnce(
		scope: ProjectBoardCommandScope,
		command: ExecutionHandoffCommand,
		targetOwner: "native_tui" | "structured",
		run: () => Promise<ExecutionHandoffResult>,
	): Promise<ExecutionHandoffResult> {
		const key = JSON.stringify([
			scope.projectId,
			command.operationId,
			command.taskId,
			command.expectedOwnerGeneration,
			targetOwner,
		]);
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = run().finally(() => {
			if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
		});
		this.inFlight.set(key, promise);
		return promise;
	}

	private async handoffToStructuredOnce(
		scope: ProjectBoardCommandScope,
		command: ExecutionHandoffCommand,
	): Promise<ExecutionHandoffResult> {
		const priorResult = await this.replayExistingHandoff(scope, command, "structured");
		if (priorResult) return priorResult;
		let prepared: PreparedTaskSessionStart;
		let ownership = await this.store.getOwnership(scope, command.taskId);
		const manager = await this.dependencies.getTerminalManager(scope);
		const summary = manager.store.getSummary(command.taskId);
		const nativeIdentity = manager.getTaskSessionProcessIdentity(command.taskId);
		let launchPath: string | null = null;
		if (!ownership) {
			if (summary?.agentId !== "codex" && summary?.agentId !== "claude") {
				return this.failure("provider_not_supported", null);
			}
			if (!summary.resumeSessionId) return this.failure("exact_session_required", null);
			if (!nativeIdentity) return this.failure("native_owner_not_running", null);
			launchPath = await this.resolveExistingLaunchPath(manager, command.taskId);
			if (!launchPath) return this.failure("worktree_missing", null);
			prepared = await this.dependencies.prepareNativeResume({
				scope,
				taskId: command.taskId,
				operationId: command.operationId,
				providerSessionId: summary.resumeSessionId,
				provider: summary.agentId,
				requiredExistingLaunchPath: launchPath,
			});
			if (!(await this.preparedLaunchPathIsValid(prepared, launchPath))) {
				return this.failure("worktree_missing", ownership);
			}
			ownership = await this.observeNativeOwner(scope, command.taskId, manager);
		}
		if (
			ownership?.state === "native_tui" &&
			(summary?.agentId === "codex" || summary?.agentId === "claude") &&
			nativeIdentity
		) {
			launchPath ??= await this.resolveExistingLaunchPath(manager, command.taskId);
			if (!launchPath) return this.failure("worktree_missing", ownership);
			prepared ??= await this.dependencies.prepareNativeResume({
				scope,
				taskId: command.taskId,
				operationId: command.operationId,
				providerSessionId: summary.resumeSessionId ?? ownership.providerSessionId,
				provider: ownership.provider,
				requiredExistingLaunchPath: launchPath,
			});
			ownership = await this.observeNativeOwner(scope, command.taskId, manager);
		}
		if (!ownership) return this.failure("unsupported_provider_version", null);
		if (ownership.ownerGeneration !== command.expectedOwnerGeneration) {
			return this.failure("stale_owner_generation", ownership);
		}
		if (
			ownership.providerVersion !==
			(ownership.provider === "codex" ? CODEX_APP_SERVER_VERSION : CLAUDE_STRUCTURED_CLI_VERSION)
		) {
			return this.failure("unsupported_provider_version", ownership);
		}
		if (ownership.state === "structured") {
			return await this.recordAlreadyAppliedHandoff(scope, command, "structured", ownership);
		}
		if (ownership.state !== "native_tui") return this.failure("busy", ownership);
		if (summary?.state === "running" || summary?.outstandingInteraction || ownership.activeTurn) {
			return this.failure("mid_turn_rejected", ownership);
		}
		if (!nativeIdentity || nativeIdentity.sessionInstanceId !== ownership.ownerSessionInstanceId) {
			return this.failure("native_owner_not_running", ownership);
		}
		if (!(await this.dependencies.assertDurableHistoryAvailable(scope, command.taskId))) {
			return this.failure("history_unavailable", ownership);
		}
		launchPath ??= await this.resolveExistingLaunchPath(manager, command.taskId);
		if (!launchPath) return this.failure("worktree_missing", ownership);
		prepared ??= await this.dependencies.prepareNativeResume({
			scope,
			taskId: command.taskId,
			operationId: command.operationId,
			providerSessionId: ownership.providerSessionId,
			provider: ownership.provider,
			requiredExistingLaunchPath: launchPath,
		});
		if (!(await this.preparedLaunchPathIsValid(prepared, launchPath))) {
			return this.failure("worktree_missing", ownership);
		}
		const begun = await this.beginHandoff(scope, command, "structured");
		if (begun.kind !== "started") return this.failure(begun.outcome, ownership);
		if (begun.value.replayed) {
			return this.replayedHandoff(scope, command.taskId, begun.value.operation);
		}
		ownership = await this.store.updateOwnership(scope, command.taskId, (current) => ({
			...current,
			state: "handoff_to_structured_pending",
			pendingHandoff: {
				operationId: command.operationId,
				targetOwner: "structured",
				expectedOwnerGeneration: command.expectedOwnerGeneration,
				phase: "stopping_owner",
				startedAt: Date.now(),
			},
		}));
		const stopped = await manager.stopTaskSessionAndWaitForExit(
			command.taskId,
			OWNER_STOP_TIMEOUT_MS,
			nativeIdentity.sessionInstanceId,
		);
		if (!stopped.didExit) {
			const outcome: ExecutionHandoffOutcome = stopped.outcome === "timed_out" ? "stop_timed_out" : "stop_failed";
			ownership = await this.updateOwnershipAndFinishKnownHandoff(
				scope,
				command.taskId,
				command.operationId,
				outcome,
				(current) => ({
					...current,
					state: "native_tui",
					pendingHandoff: null,
					lastFailure: { code: "stop_failed", at: Date.now() },
				}),
			);
			return this.failure(outcome, ownership);
		}
		ownership = await this.store.updateOwnership(scope, command.taskId, (current) => ({
			...current,
			ownerProcess: null,
			pendingHandoff: current.pendingHandoff
				? { ...current.pendingHandoff, phase: "starting_replacement" }
				: current.pendingHandoff,
		}));
		try {
			const nextGeneration = ownership.ownerGeneration + 1;
			const structured = await this.startStructuredReplacement(
				scope,
				ownership,
				prepared,
				nextGeneration,
				command.operationId,
				nativeIdentity.profileEnvironment,
			);
			ownership = (
				await this.store.updateOwnershipAndFinishHandoff(
					scope,
					command.taskId,
					command.operationId,
					"completed",
					(current) => ({
						...this.assertStructuredReplacementCurrent(current, structured.identity.ownerSessionInstanceId),
						providerSessionTreeId: structured.identity.providerSessionTreeId,
						configurationFingerprint: structured.identity.configurationFingerprint,
						providerVersion: structured.identity.providerVersion,
						protocolSchemaFingerprint: structured.identity.protocolSchemaFingerprint,
						historyMode: structured.identity.historyMode,
						state: "structured",
						activeTurn: null,
						pendingHandoff: null,
						lastFailure: null,
					}),
				)
			).ownership;
			manager.applyStructuredTransition(command.taskId, {
				type: "structured.owner_activated",
				pid: structured.identity.pid,
				sessionInstanceId: structured.identity.ownerSessionInstanceId,
			});
			this.record("execution.handoff_completed", scope, command.taskId, ownership);
			return this.success("completed", ownership, false);
		} catch (error) {
			const outcome = this.toStartFailureOutcome(error);
			ownership = await this.updateOwnershipAndFinishKnownHandoff(
				scope,
				command.taskId,
				command.operationId,
				outcome,
				(current) => ({
					...current,
					lastFailure: { code: this.toPersistedFailureCode(outcome), at: Date.now() },
				}),
			);
			this.record("execution.handoff_failed", scope, command.taskId, ownership, error);
			return this.failure(outcome, ownership);
		}
	}

	private async handoffToNativeOnce(
		scope: ProjectBoardCommandScope,
		command: ExecutionHandoffCommand,
	): Promise<ExecutionHandoffResult> {
		const priorResult = await this.replayExistingHandoff(scope, command, "native_tui");
		if (priorResult) return priorResult;
		let ownership = await this.store.getOwnership(scope, command.taskId);
		if (!ownership) return this.failure("native_owner_not_running", null);
		if (ownership.ownerGeneration !== command.expectedOwnerGeneration) {
			return this.failure("stale_owner_generation", ownership);
		}
		if (ownership.state === "native_tui") {
			return await this.recordAlreadyAppliedHandoff(scope, command, "native_tui", ownership);
		}
		const structured = this.dependencies.structuredOwners.get(scope.projectId, command.taskId);
		const structuredOwnerUnavailable =
			(ownership.state === "structured" ||
				ownership.state === "handoff_to_structured_pending" ||
				ownership.state === "handoff_to_native_pending") &&
			!ownership.ownerProcess &&
			!structured;
		if (ownership.state !== "structured" && !structuredOwnerUnavailable) {
			return this.failure("busy", ownership);
		}
		if (!structuredOwnerUnavailable) {
			if (!structured || !ownership.ownerProcess) return this.failure("replacement_start_failed", ownership);
			if (structured.hasActiveTurn() || structured.hasPendingInteractions() || ownership.activeTurn) {
				return this.failure("mid_turn_rejected", ownership);
			}
		}
		const manager = await this.dependencies.getTerminalManager(scope);
		const launchPath = await this.resolveExistingLaunchPath(manager, command.taskId);
		if (!launchPath) return this.failure("worktree_missing", ownership);
		const prepared = await this.dependencies.prepareNativeResume({
			scope,
			taskId: command.taskId,
			operationId: command.operationId,
			providerSessionId: ownership.providerSessionId,
			provider: ownership.provider,
			requiredExistingLaunchPath: launchPath,
		});
		if (!(await this.preparedLaunchPathIsValid(prepared, launchPath))) {
			return this.failure("worktree_missing", ownership);
		}
		const begun = await this.beginHandoff(scope, command, "native_tui");
		if (begun.kind !== "started") return this.failure(begun.outcome, ownership);
		if (begun.value.replayed) {
			return this.replayedHandoff(scope, command.taskId, begun.value.operation);
		}
		ownership = await this.store.updateOwnership(scope, command.taskId, (current) => ({
			...current,
			state: "handoff_to_native_pending",
			pendingHandoff: {
				operationId: command.operationId,
				targetOwner: "native_tui",
				expectedOwnerGeneration: command.expectedOwnerGeneration,
				phase: "stopping_owner",
				startedAt: Date.now(),
			},
		}));
		const stopOutcome = structuredOwnerUnavailable
			? "not_running"
			: await this.stopStructuredOwnerPlanned(scope, ownership);
		if (stopOutcome !== "exited" && stopOutcome !== "not_running") {
			const outcome = stopOutcome === "timed_out" ? "stop_timed_out" : "stop_failed";
			ownership = await this.updateOwnershipAndFinishKnownHandoff(
				scope,
				command.taskId,
				command.operationId,
				outcome,
				(current) => ({
					...current,
					state: "structured",
					pendingHandoff: null,
					lastFailure: { code: "stop_failed", at: Date.now() },
				}),
			);
			return this.failure(outcome, ownership);
		}
		ownership = await this.store.updateOwnership(scope, command.taskId, (current) => ({
			...current,
			ownerProcess: null,
			pendingHandoff: current.pendingHandoff
				? { ...current.pendingHandoff, phase: "starting_replacement" }
				: current.pendingHandoff,
		}));
		let launched: Awaited<ReturnType<typeof launchPreparedTaskSession>>;
		try {
			launched = await launchPreparedTaskSession(prepared);
		} catch (error) {
			ownership = await this.updateOwnershipAndFinishKnownHandoff(
				scope,
				command.taskId,
				command.operationId,
				"replacement_start_failed",
				(current) => ({
					...current,
					lastFailure: { code: "identity_mismatch", at: Date.now() },
				}),
			);
			this.record("execution.handoff_failed", scope, command.taskId, ownership, error);
			return this.failure("replacement_start_failed", ownership);
		}
		const processIdentity = launched.terminalManager.getTaskSessionProcessIdentity(command.taskId);
		if (processIdentity) {
			ownership = await this.store.updateOwnership(scope, command.taskId, (current) => ({
				...current,
				ownerGeneration: current.ownerGeneration + 1,
				ownerSessionInstanceId: processIdentity.sessionInstanceId,
				ownerProcess: {
					processKind: "pty",
					pid: processIdentity.pid,
					sessionInstanceId: processIdentity.sessionInstanceId,
					launchOperationId: processIdentity.launchOperationId,
				},
				pendingHandoff: current.pendingHandoff
					? { ...current.pendingHandoff, phase: "verifying_replacement" }
					: current.pendingHandoff,
			}));
		}
		const failUnverifiedReplacement = async (
			outcome: "identity_mismatch" | "replacement_start_failed",
		): Promise<ExecutionHandoffResult> => {
			const stopped = await launched.terminalManager.stopTaskSessionAndWaitForExit(
				command.taskId,
				OWNER_STOP_TIMEOUT_MS,
				processIdentity?.sessionInstanceId,
			);
			const finalOutcome: ExecutionHandoffOutcome = stopped.didExit
				? outcome
				: stopped.outcome === "timed_out"
					? "stop_timed_out"
					: "stop_failed";
			ownership = await this.updateOwnershipAndFinishKnownHandoff(
				scope,
				command.taskId,
				command.operationId,
				finalOutcome,
				(current) => ({
					...current,
					...(stopped.didExit ? { ownerProcess: null } : {}),
					lastFailure: {
						code: stopped.didExit ? "identity_mismatch" : "stop_failed",
						at: Date.now(),
					},
				}),
			);
			return this.failure(finalOutcome, ownership);
		};
		if (!processIdentity || launched.summary.resumeSessionId !== ownership.providerSessionId) {
			return await failUnverifiedReplacement("identity_mismatch");
		}
		const readiness = await launched.terminalManager.waitForTaskSessionLaunch(
			command.taskId,
			processIdentity.sessionInstanceId,
			NATIVE_HANDOFF_READINESS_TIMEOUT_MS,
		);
		if (readiness.status !== "ready" || readiness.observedSessionId !== ownership.providerSessionId) {
			const outcome: ExecutionHandoffOutcome =
				readiness.status === "identity_mismatch" ? "identity_mismatch" : "replacement_start_failed";
			return await failUnverifiedReplacement(outcome);
		}
		ownership = (
			await this.store.updateOwnershipAndFinishHandoff(
				scope,
				command.taskId,
				command.operationId,
				"completed",
				(current) => ({
					...current,
					state: "native_tui",
					activeTurn: null,
					pendingHandoff: null,
					lastFailure: null,
				}),
			)
		).ownership;
		this.record("execution.handoff_completed", scope, command.taskId, ownership);
		return this.success("completed", ownership, false);
	}

	private async beginHandoff(
		scope: ProjectBoardCommandScope,
		command: ExecutionHandoffCommand,
		targetOwner: "native_tui" | "structured",
	): Promise<
		| {
				kind: "started";
				value: Awaited<ReturnType<ProjectExecutionOwnershipStore["beginHandoff"]>>;
		  }
		| { kind: "rejected"; outcome: "operation_identity_conflict" | "busy" | "stale_owner_generation" }
	> {
		try {
			return {
				kind: "started",
				value: await this.store.beginHandoff(scope, { ...command, targetOwner }),
			};
		} catch (error) {
			if (error instanceof ExecutionOperationIdentityConflictError) {
				return { kind: "rejected", outcome: "operation_identity_conflict" };
			}
			if (error instanceof ExecutionOwnershipBusyError) return { kind: "rejected", outcome: "busy" };
			if (error instanceof ExecutionOwnershipGenerationConflictError) {
				return { kind: "rejected", outcome: "stale_owner_generation" };
			}
			throw error;
		}
	}

	private async replayExistingHandoff(
		scope: ProjectBoardCommandScope,
		command: ExecutionHandoffCommand,
		targetOwner: "native_tui" | "structured",
	): Promise<ExecutionHandoffResult | null> {
		const operation = await this.store.getHandoff(scope, command.operationId);
		if (!operation) return null;
		const expectedFingerprint = fingerprintExecutionOperation({ ...command, targetOwner });
		const ownership = await this.store.getOwnership(scope, command.taskId);
		if (operation.fingerprint !== expectedFingerprint) {
			return this.failure("operation_identity_conflict", ownership);
		}
		return await this.replayedHandoff(scope, command.taskId, operation);
	}

	private async recordAlreadyAppliedHandoff(
		scope: ProjectBoardCommandScope,
		command: ExecutionHandoffCommand,
		targetOwner: "native_tui" | "structured",
		ownership: TaskExecutionOwnership,
	): Promise<ExecutionHandoffResult> {
		try {
			const recorded = await this.store.recordAlreadyAppliedHandoff(scope, {
				...command,
				targetOwner,
			});
			if (recorded.replayed) {
				return await this.replayedHandoff(scope, command.taskId, recorded.operation);
			}
			return this.success("already_applied", ownership, false);
		} catch (error) {
			if (error instanceof ExecutionOperationIdentityConflictError) {
				return this.failure("operation_identity_conflict", ownership);
			}
			if (error instanceof ExecutionOwnershipBusyError) return this.failure("busy", ownership);
			throw error;
		}
	}

	private async resolveExistingLaunchPath(manager: TerminalSessionManager, taskId: string): Promise<string | null> {
		const launchPath = manager.store.getSummary(taskId)?.sessionLaunchPath?.trim() ?? "";
		if (!launchPath) return null;
		const isAvailable = this.dependencies.isLaunchPathAvailable ?? pathExists;
		return (await isAvailable(launchPath)) ? launchPath : null;
	}

	private async preparedLaunchPathIsValid(
		prepared: PreparedTaskSessionStart,
		expectedLaunchPath: string,
	): Promise<boolean> {
		if (prepared.request.cwd !== expectedLaunchPath) return false;
		const isAvailable = this.dependencies.isLaunchPathAvailable ?? pathExists;
		return await isAvailable(expectedLaunchPath);
	}

	private async startStructuredReplacement(
		scope: ProjectBoardCommandScope,
		ownership: TaskExecutionOwnership,
		prepared: PreparedTaskSessionStart,
		nextGeneration: number,
		operationId: string,
		profileEnvironment?: NativeTaskSessionProfileEnvironment,
	) {
		const ownerSessionInstanceId = randomUUID();
		try {
			const owner = await this.dependencies.structuredOwners.start({
				provider: ownership.provider,
				projectId: scope.projectId,
				projectPath: scope.projectPath,
				taskId: ownership.taskId,
				binary: prepared.request.binary,
				nativeArgs: prepared.request.args,
				cwd: prepared.request.cwd,
				env: { ...prepared.request.env, ...profileEnvironment },
				providerSessionId: ownership.providerSessionId,
				expectedProviderSessionTreeId: ownership.providerSessionTreeId,
				expectedProviderProfileFingerprint: ownership.providerProfileFingerprint,
				expectedConfigurationFingerprint: ownership.configurationFingerprint,
				expectedProviderVersion: ownership.providerVersion,
				expectedProtocolSchemaFingerprint: ownership.protocolSchemaFingerprint,
				expectedHistoryMode: ownership.historyMode,
				ownerGeneration: nextGeneration,
				ownerSessionInstanceId,
				launchOperationId: operationId,
				claudeLaunchPermissionMode: prepared.request.claudeLaunchPermissionMode,
				codexApprovalsReviewer: prepared.request.codexApprovalsReviewer,
				statuslineEnabled: prepared.request.statuslineEnabled,
				worktreeSystemPromptTemplate: prepared.request.worktreeSystemPromptTemplate,
				onProcessStarted: async ({ pid }) => {
					await this.store.updateOwnership(scope, ownership.taskId, (current) => {
						if (
							current.ownerGeneration !== ownership.ownerGeneration ||
							current.ownerSessionInstanceId !== ownership.ownerSessionInstanceId
						) {
							throw new Error("Execution ownership changed before structured process persistence.");
						}
						return {
							...current,
							ownerGeneration: nextGeneration,
							ownerSessionInstanceId,
							ownerProcess: {
								processKind: ownerProcessKind(ownership.provider),
								pid,
								sessionInstanceId: ownerSessionInstanceId,
								launchOperationId: operationId,
							},
						};
					});
				},
			});
			if (
				!owner.hasWriteAuthority() ||
				this.dependencies.structuredOwners.get(scope.projectId, ownership.taskId) !== owner
			) {
				throw new Error("Structured replacement lost write authority before ownership verification.");
			}
			return owner;
		} catch (error) {
			await this.store
				.updateOwnership(scope, ownership.taskId, (current) => {
					if (current.ownerSessionInstanceId !== ownerSessionInstanceId) return current;
					if (
						error instanceof CodexStructuredOwnerStopUnconfirmedError ||
						error instanceof StructuredOwnerStopUnconfirmedError
					) {
						return current;
					}
					return { ...current, ownerProcess: null };
				})
				.catch(() => undefined);
			throw error;
		}
	}

	private assertStructuredReplacementCurrent(
		current: TaskExecutionOwnership,
		ownerSessionInstanceId: string,
	): TaskExecutionOwnership {
		if (
			current.ownerSessionInstanceId !== ownerSessionInstanceId ||
			current.ownerProcess?.sessionInstanceId !== ownerSessionInstanceId
		) {
			throw new Error("Structured replacement lost write authority before ownership commit.");
		}
		return current;
	}

	private async replayedHandoff(
		scope: ProjectBoardCommandScope,
		taskId: string,
		operation: { status: string; outcome: ExecutionHandoffOutcome | null },
	): Promise<ExecutionHandoffResult> {
		const ownership = await this.store.getOwnership(scope, taskId);
		if (operation.status === "completed") return this.success("already_applied", ownership, true);
		if (operation.outcome === "completed" || operation.outcome === "already_applied") {
			return this.success("already_applied", ownership, true);
		}
		return this.failure(operation.outcome ?? "busy", ownership, true);
	}

	private async onStructuredTurnStarted(
		context: StructuredOwnerContext,
		turn: StructuredTurn,
		clientUserMessageId: string,
	): Promise<void> {
		const scope = await this.resolveEventScope(context);
		if (!scope) return;
		const ownership = await this.store.updateOwnership(scope, context.taskId, (current) => ({
			...current,
			activeTurn: { turnId: turn.id, clientUserMessageId, startedAt: Date.now() },
		}));
		const pid = ownership.ownerProcess?.pid;
		if (!pid) return;
		(await this.dependencies.getTerminalManager(scope)).applyStructuredTransition(context.taskId, {
			type: "structured.turn_started",
			pid,
			sessionInstanceId: ownership.ownerSessionInstanceId,
		});
	}

	private async onStructuredTurnCompleted(context: StructuredOwnerContext, turn: StructuredTurn): Promise<void> {
		const scope = await this.resolveEventScope(context);
		if (!scope) return;
		await this.store.updateOwnership(scope, context.taskId, (current) => ({ ...current, activeTurn: null }));
		const manager = await this.dependencies.getTerminalManager(scope);
		if (turn.status === "completed" || turn.status === "interrupted") {
			manager.applyStructuredTransition(context.taskId, { type: "structured.turn_completed" });
		} else {
			manager.applyStructuredTransition(context.taskId, {
				type: "structured.turn_failed",
				warningMessage: `The structured ${context.provider === "codex" ? "Codex" : "Claude"} turn failed. Review provider history before retrying.`,
			});
		}
	}

	private async onStructuredInteractionRequested(
		context: StructuredOwnerContext,
		interaction: StructuredPendingInteraction,
	): Promise<void> {
		const scope = await this.resolveEventScope(context);
		if (!scope) return;
		(await this.dependencies.getTerminalManager(scope)).applyStructuredTransition(context.taskId, {
			type: "structured.interaction_requested",
			provider: context.provider,
			interactionKind: interaction.kind,
			interactionId: interaction.interactionId,
			providerSessionId: interaction.providerSessionId,
			turnId: interaction.turnId,
			itemId: interaction.itemId,
			openedAt: interaction.createdAt,
			sessionInstanceId: context.ownerSessionInstanceId,
		});
	}

	private async onStructuredInteractionResolved(
		context: StructuredOwnerContext,
		interaction: StructuredPendingInteraction,
	): Promise<void> {
		const scope = await this.resolveEventScope(context);
		if (!scope) return;
		(await this.dependencies.getTerminalManager(scope)).applyStructuredTransition(context.taskId, {
			type: "structured.interaction_resolved",
			interactionId: interaction.interactionId,
			resolvedAt: Date.now(),
		});
	}

	private async onStructuredInteractionCancelled(
		context: StructuredOwnerContext,
		interaction: StructuredPendingInteraction,
	): Promise<void> {
		const scope = await this.resolveEventScope(context);
		if (!scope) return;
		(await this.dependencies.getTerminalManager(scope)).applyStructuredTransition(context.taskId, {
			type: "structured.interaction_cancelled",
			interactionId: interaction.interactionId,
		});
	}

	private async onStructuredOwnerExit(
		context: StructuredOwnerContext,
		turnOutcomeUnknown: boolean,
		stopIntent: "transition" | "shutdown" | null,
	): Promise<void> {
		const scope = await this.resolveEventScope(context, { allowPending: true });
		if (!scope) return;
		const current = await this.store.getOwnership(scope, context.taskId);
		if (!current) return;
		const plannedStop = current.state === "handoff_to_native_pending" || stopIntent !== null;
		if (plannedStop) {
			const preserveUnknownShutdownTurn = stopIntent === "shutdown" && turnOutcomeUnknown;
			await this.store.updateOwnership(scope, context.taskId, (ownership) => ({
				...ownership,
				ownerProcess: null,
				activeTurn: preserveUnknownShutdownTurn ? ownership.activeTurn : null,
				...(preserveUnknownShutdownTurn
					? { lastFailure: { code: "turn_outcome_unknown" as const, at: Date.now() } }
					: ownership.state === "structured" && stopIntent !== "shutdown"
						? {
								lastFailure: {
									code: turnOutcomeUnknown ? "turn_outcome_unknown" : "owner_crashed",
									at: Date.now(),
								},
							}
						: {}),
			}));
			(await this.dependencies.getTerminalManager(scope)).applyStructuredTransition(context.taskId, {
				type: "structured.owner_stopped",
			});
			return;
		}
		await this.store.updateOwnership(scope, context.taskId, (ownership) => ({
			...ownership,
			ownerProcess: null,
			activeTurn: null,
			lastFailure: { code: turnOutcomeUnknown ? "turn_outcome_unknown" : "owner_crashed", at: Date.now() },
		}));
		(await this.dependencies.getTerminalManager(scope)).applyStructuredTransition(context.taskId, {
			type: "structured.owner_crashed",
			turnOutcomeUnknown,
			warningMessage: turnOutcomeUnknown
				? "The structured owner exited mid-turn. The outcome is unknown; Quarterdeck will not replay it automatically."
				: "The structured owner exited. Quarterdeck will resume the exact session without replaying a turn.",
		});
	}

	private async stopStructuredOwnerPlanned(
		scope: ProjectBoardCommandScope,
		ownership: TaskExecutionOwnership,
		stopIntent: "transition" | "shutdown" = "transition",
	): Promise<"exited" | "not_running" | "superseded" | "timed_out"> {
		const context = {
			provider: ownership.provider,
			projectId: scope.projectId,
			projectPath: scope.projectPath,
			taskId: ownership.taskId,
			ownerGeneration: ownership.ownerGeneration,
			ownerSessionInstanceId: ownership.ownerSessionInstanceId,
		};
		const key = this.structuredStopKey(context);
		this.intentionalStructuredStops.set(key, stopIntent);
		const outcome = await this.dependencies.structuredOwners.stop(
			scope.projectId,
			ownership.taskId,
			ownership.ownerGeneration,
			ownership.ownerSessionInstanceId,
			OWNER_STOP_TIMEOUT_MS,
		);
		if (outcome === "exited" || outcome === "not_running" || outcome === "superseded") {
			this.intentionalStructuredStops.delete(key);
		}
		if (outcome === "not_running" && ownership.ownerProcess && isProcessAlive(ownership.ownerProcess.pid)) {
			return "superseded";
		}
		return outcome;
	}

	private async restoreStructuredAfterFailedStop(
		scope: ProjectBoardCommandScope,
		taskId: string,
	): Promise<TaskExecutionOwnership> {
		return await this.store.updateOwnership(scope, taskId, (current) => ({
			...current,
			state: "structured",
			pendingHandoff: null,
			lastFailure: { code: "stop_failed", at: Date.now() },
		}));
	}

	private structuredStopKey(context: StructuredOwnerContext): string {
		return JSON.stringify([
			context.projectId,
			context.taskId,
			context.ownerGeneration,
			context.ownerSessionInstanceId,
		]);
	}

	private runStructuredEvent(event: string, context: StructuredOwnerContext, run: () => Promise<void>): void {
		void this.dependencies.taskResourceOperations.run(context.projectId, context.taskId, run).catch((error) => {
			log.warn("structured execution event failed", {
				projectId: context.projectId,
				taskId: context.taskId,
				event,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			});
		});
	}

	private async resolveEventScope(
		context: StructuredOwnerContext,
		options?: { allowPending?: boolean },
	): Promise<ProjectBoardCommandScope | null> {
		const scope = { projectId: context.projectId, projectPath: context.projectPath };
		const ownership = await this.store.getOwnership(scope, context.taskId);
		if (!ownership) return null;
		if (
			ownership.ownerGeneration !== context.ownerGeneration ||
			ownership.ownerSessionInstanceId !== context.ownerSessionInstanceId ||
			(ownership.state !== "structured" &&
				!(
					options?.allowPending &&
					(ownership.state === "handoff_to_native_pending" || ownership.state === "handoff_to_structured_pending")
				))
		) {
			return null;
		}
		return scope;
	}

	private toStartFailureOutcome(error: unknown): Exclude<ExecutionHandoffOutcome, "completed" | "already_applied"> {
		if (
			error instanceof CodexStructuredOwnerStopUnconfirmedError ||
			error instanceof StructuredOwnerStopUnconfirmedError
		) {
			return "stop_failed";
		}
		if (
			error instanceof CodexStructuredOwnerCompatibilityError ||
			error instanceof StructuredOwnerCompatibilityError
		) {
			switch (error.code) {
				case "unsupported_version":
					return "unsupported_provider_version";
				case "profile_mismatch":
					return "profile_mismatch";
				case "configuration_mismatch":
					return "configuration_mismatch";
				case "history_mode":
					return "unsupported_history_mode";
				default:
					return "identity_mismatch";
			}
		}
		return "replacement_start_failed";
	}

	private toPersistedFailureCode(
		outcome: ExecutionHandoffOutcome,
	): NonNullable<TaskExecutionOwnership["lastFailure"]>["code"] {
		switch (outcome) {
			case "profile_mismatch":
				return "profile_mismatch";
			case "configuration_mismatch":
				return "configuration_mismatch";
			case "unsupported_provider_version":
				return "unsupported_version";
			case "unsupported_history_mode":
				return "unsupported_history_mode";
			case "history_unavailable":
				return "history_unavailable";
			case "worktree_missing":
				return "worktree_missing";
			case "stop_failed":
			case "stop_timed_out":
				return "stop_failed";
			default:
				return "identity_mismatch";
		}
	}

	private success(
		outcome: "completed" | "already_applied",
		ownership: TaskExecutionOwnership | null,
		replayed: boolean,
	): ExecutionHandoffResult {
		return { ok: true, outcome, ownership, replayed };
	}

	private failure(
		outcome: Exclude<ExecutionHandoffOutcome, "completed" | "already_applied">,
		ownership: TaskExecutionOwnership | null,
		replayed = false,
	): ExecutionHandoffResult {
		return { ok: false, outcome, ownership, replayed };
	}

	private record(
		event: string,
		scope: ProjectBoardCommandScope,
		taskId: string,
		ownership: TaskExecutionOwnership,
		error?: unknown,
	): void {
		this.dependencies.diagnostics?.recordEvent(
			event,
			{
				state: ownership.state,
				ownerGeneration: ownership.ownerGeneration,
				historyMode: ownership.historyMode,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : null,
			},
			{ projectId: scope.projectId, taskId, sessionInstanceId: ownership.ownerSessionInstanceId },
			{ level: error ? "warn" : "info", essential: true },
		);
		log.debug(event, {
			projectId: scope.projectId,
			taskId,
			state: ownership.state,
			ownerGeneration: ownership.ownerGeneration,
		});
	}
}
