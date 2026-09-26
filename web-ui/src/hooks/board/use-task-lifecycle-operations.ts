import { useCallback, useMemo, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { resolveTaskStartGeometry } from "@/hooks/board/task-session-geometry";
import type { FlushProjectBoardCommandsResult } from "@/hooks/project/use-project-sync";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeProjectStateResponse,
	RuntimeTaskLifecycleCommand,
	RuntimeTaskLifecycleResult,
} from "@/runtime/types";
import { createClientLogger } from "@/utils/client-logger";
import { useInterval } from "@/utils/react-use";
import { toErrorMessage } from "@/utils/to-error-message";
import {
	createTaskLifecycleOperationId,
	createTaskLifecycleScopeKey,
	getTaskLifecycleFailureMessage,
	getTaskLifecyclePendingLabel,
	type TaskLifecycleCommandDraft,
} from "./task-lifecycle-operations";
import { type ClearTrash, useClearTrashOperation } from "./use-clear-trash-operation";

const log = createClientLogger("task-lifecycle");

export interface PendingTaskLifecycleOperation {
	operationId: string;
	kind: RuntimeTaskLifecycleCommand["kind"];
	label: string;
}

interface ScopedPendingTaskLifecycleOperation extends PendingTaskLifecycleOperation {
	projectId: string;
	taskId: string;
}

interface UseTaskLifecycleOperationsInput {
	currentProjectId: string | null;
	flushBoardCommands: () => Promise<FlushProjectBoardCommandsResult>;
	getAuthoritativeRevision: () => number | null;
	applyLifecycleProjectState: (state: RuntimeProjectStateResponse) => void;
	refreshProjectState: () => Promise<void>;
}

export interface UseTaskLifecycleOperationsResult {
	clearTrash: ClearTrash;
	executeTaskLifecycle: (draft: TaskLifecycleCommandDraft) => Promise<RuntimeTaskLifecycleResult | null>;
	pendingTaskLifecycleById: Record<string, PendingTaskLifecycleOperation>;
}

async function sendLifecycleCommand(
	projectId: string,
	command: RuntimeTaskLifecycleCommand,
): Promise<RuntimeTaskLifecycleResult> {
	const client = getRuntimeTrpcClient(projectId);
	try {
		return await client.runtime.executeTaskLifecycle.mutate(command);
	} catch (firstError) {
		log.warn("task lifecycle response was ambiguous; retrying with the same operation id", {
			projectId,
			taskId: command.kind === "create_and_start" ? command.task.taskId : command.taskId,
			operationId: command.operationId,
			operationKind: command.kind,
			error: toErrorMessage(firstError),
		});
		try {
			return await client.runtime.executeTaskLifecycle.mutate(command);
		} catch (retryError) {
			const recovered = await client.runtime.getTaskLifecycleOperation.query({
				operationId: command.operationId,
			});
			if (recovered) {
				return recovered;
			}
			throw retryError;
		}
	}
}

export function useTaskLifecycleOperations({
	currentProjectId,
	flushBoardCommands,
	getAuthoritativeRevision,
	applyLifecycleProjectState,
	refreshProjectState,
}: UseTaskLifecycleOperationsInput): UseTaskLifecycleOperationsResult {
	const clearTrash = useClearTrashOperation({
		currentProjectId,
		flushBoardCommands,
		getAuthoritativeRevision,
		applyLifecycleProjectState,
	});
	const [pendingTaskLifecycleByScope, setPendingTaskLifecycleByScope] = useState<
		Record<string, ScopedPendingTaskLifecycleOperation>
	>({});
	const inFlightByScopeRef = useRef(new Map<string, Promise<RuntimeTaskLifecycleResult | null>>());
	const pendingScopesRef = useRef(pendingTaskLifecycleByScope);
	pendingScopesRef.current = pendingTaskLifecycleByScope;
	const progressQueriesRef = useRef(new Set<string>());
	const setupToastsRef = useRef(new Set<string>());
	useInterval(
		() => {
			for (const [scopeKey, pending] of Object.entries(pendingTaskLifecycleByScope)) {
				if (progressQueriesRef.current.has(pending.operationId)) continue;
				progressQueriesRef.current.add(pending.operationId);
				void getRuntimeTrpcClient(pending.projectId)
					.runtime.getTaskLifecycleOperation.query({
						operationId: pending.operationId,
					})
					.then((result) => {
						if (
							result?.operation.status !== "pending" ||
							pendingScopesRef.current[scopeKey]?.operationId !== pending.operationId
						)
							return;
						const label = getTaskLifecyclePendingLabel(pending.kind, result.operation.phase);
						setPendingTaskLifecycleByScope((current) => {
							if (current[scopeKey]?.operationId !== pending.operationId || current[scopeKey]?.label === label)
								return current;
							return { ...current, [scopeKey]: { ...pending, label } };
						});
						if (result.operation.phase === "running_setup") {
							setupToastsRef.current.add(pending.operationId);
							showAppToast({ message: "Running worktree setup script…", timeout: 2500 }, pending.operationId);
						}
					})
					.catch(() => {
						// Progress is advisory; the command response remains authoritative.
					})
					.finally(() => progressQueriesRef.current.delete(pending.operationId));
			}
		},
		Object.keys(pendingTaskLifecycleByScope).length > 0 ? 1000 : null,
	);

	const pendingTaskLifecycleById = useMemo(() => {
		if (!currentProjectId) {
			return {};
		}
		const activeProjectOperations: Record<string, PendingTaskLifecycleOperation> = {};
		for (const pending of Object.values(pendingTaskLifecycleByScope)) {
			if (pending.projectId === currentProjectId) {
				activeProjectOperations[pending.taskId] = {
					operationId: pending.operationId,
					kind: pending.kind,
					label: pending.label,
				};
			}
		}
		return activeProjectOperations;
	}, [currentProjectId, pendingTaskLifecycleByScope]);

	const executeTaskLifecycle = useCallback(
		async (draft: TaskLifecycleCommandDraft): Promise<RuntimeTaskLifecycleResult | null> => {
			const projectId = currentProjectId;
			if (!projectId) {
				notifyError("No project selected.");
				return null;
			}
			const taskId = draft.kind === "create_and_start" ? draft.task.taskId : draft.taskId;
			const scopeKey = createTaskLifecycleScopeKey(projectId, taskId);
			const existing = inFlightByScopeRef.current.get(scopeKey);
			if (existing) {
				return await existing;
			}

			const operationId = createTaskLifecycleOperationId(draft.kind);
			const deleteToastKey = draft.kind === "delete" ? operationId : undefined;
			const errorToastOptions = () =>
				deleteToastKey || setupToastsRef.current.has(operationId) ? { key: operationId } : undefined;
			const promise = (async (): Promise<RuntimeTaskLifecycleResult | null> => {
				if (deleteToastKey) {
					showAppToast({ message: "Deleting task permanently…", timeout: Infinity }, deleteToastKey);
				}
				setPendingTaskLifecycleByScope((current) => ({
					...current,
					[scopeKey]: {
						operationId,
						kind: draft.kind,
						label: getTaskLifecyclePendingLabel(draft.kind),
						projectId,
						taskId,
					},
				}));
				try {
					const flushed = await flushBoardCommands();
					if (!flushed.ok) {
						notifyError(flushed.message ?? "Could not save pending board changes.", errorToastOptions());
						return null;
					}
					const expectedRevision = getAuthoritativeRevision();
					if (expectedRevision === null) {
						notifyError("The project is still loading. Try the action again.", errorToastOptions());
						return null;
					}
					const geometry =
						draft.kind === "start" ||
						draft.kind === "restore" ||
						draft.kind === "restart" ||
						draft.kind === "create_and_start"
							? await resolveTaskStartGeometry({
									taskId,
									viewportWidth: window.innerWidth,
									viewportHeight: window.innerHeight,
								})
							: null;
					const command = {
						...draft,
						...(geometry ?? {}),
						operationId,
						expectedRevision,
					} as RuntimeTaskLifecycleCommand;
					const result = await sendLifecycleCommand(projectId, command);
					applyLifecycleProjectState(result.state);
					if (!result.ok) {
						notifyError(
							getTaskLifecycleFailureMessage(result.operation.outcomeCode, result.error),
							errorToastOptions(),
						);
					} else if (result.warning) {
						showAppToast(
							{
								intent: "warning",
								icon: "warning-sign",
								message: result.warning,
								timeout: 7000,
							},
							operationId,
						);
					} else if (deleteToastKey) {
						showAppToast({ intent: "success", message: "Task permanently deleted." }, deleteToastKey);
					} else if (setupToastsRef.current.has(operationId)) {
						showAppToast({ intent: "success", message: "Worktree ready. Agent started." }, operationId);
					}
					return result;
				} catch (error) {
					const message = toErrorMessage(error);
					log.warn("task lifecycle request failed without a recoverable outcome", {
						projectId,
						taskId,
						operationId,
						operationKind: draft.kind,
						error: message,
					});
					notifyError(`Could not confirm the task action: ${message}`, errorToastOptions());
					// The server may have accepted the operation even though both the
					// response and status lookup were lost. Replace the optimistic board
					// with a fresh authoritative snapshot instead of leaving a card in a
					// locally invented lifecycle state.
					await refreshProjectState();
					return null;
				} finally {
					setupToastsRef.current.delete(operationId);
					setPendingTaskLifecycleByScope((current) => {
						if (current[scopeKey]?.operationId !== operationId) {
							return current;
						}
						const next = { ...current };
						delete next[scopeKey];
						return next;
					});
				}
			})();
			inFlightByScopeRef.current.set(scopeKey, promise);
			try {
				return await promise;
			} finally {
				if (inFlightByScopeRef.current.get(scopeKey) === promise) {
					inFlightByScopeRef.current.delete(scopeKey);
				}
			}
		},
		[applyLifecycleProjectState, currentProjectId, flushBoardCommands, getAuthoritativeRevision, refreshProjectState],
	);

	return { clearTrash, executeTaskLifecycle, pendingTaskLifecycleById };
}
