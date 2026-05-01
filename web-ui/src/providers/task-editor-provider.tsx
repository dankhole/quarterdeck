import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { type UseTaskEditorResult, useTaskEditor } from "@/hooks/board/use-task-editor";
import { useTaskBranchOptions } from "@/hooks/git/use-task-branch-options";
import { useBoardContext } from "@/providers/board-provider";
import { useProjectNavigationContext, useProjectSyncContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { resolveTaskAgentFallbackId } from "@/utils/task-agent-display";

// ---------------------------------------------------------------------------
// Context value - task editor workflow ownership: branch-option derivation,
// create/edit dialog state, and the edit-save -> start bridge.
// ---------------------------------------------------------------------------

export interface TaskEditorContextValue {
	taskEditor: UseTaskEditorResult;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	pendingTaskStartAfterEditId: string | null;
	clearPendingTaskStartAfterEditId: () => void;
	resetTaskEditorWorkflow: () => void;
}

export const TaskEditorContext = createContext<TaskEditorContextValue | null>(null);

export function useTaskEditorContext(): TaskEditorContextValue {
	const ctx = useContext(TaskEditorContext);
	if (!ctx) {
		throw new Error("useTaskEditorContext must be used within a TaskEditorContext.Provider");
	}
	return ctx;
}

interface TaskEditorProviderProps {
	children: ReactNode;
}

export function TaskEditorProvider({ children }: TaskEditorProviderProps): ReactNode {
	const { currentProjectId } = useProjectNavigationContext();
	const { projectGit } = useProjectSyncContext();
	const { configDefaultBaseRef, runtimeProjectConfig } = useProjectRuntimeContext();
	const { board, setBoard, setSelectedTaskId } = useBoardContext();
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);

	const { createTaskBranchOptions, defaultTaskBranchRef } = useTaskBranchOptions({
		projectGit,
		configDefaultBaseRef,
	});
	const fallbackTaskAgentId = useMemo(() => resolveTaskAgentFallbackId(runtimeProjectConfig), [runtimeProjectConfig]);
	const availableTaskAgentIds = useMemo(
		() => runtimeProjectConfig?.agents.filter((agent) => agent.installed === true).map((agent) => agent.id) ?? null,
		[runtimeProjectConfig],
	);

	const queueTaskStartAfterEdit = useCallback((taskId: string) => {
		setPendingTaskStartAfterEditId(taskId);
	}, []);

	const clearPendingTaskStartAfterEditId = useCallback(() => {
		setPendingTaskStartAfterEditId(null);
	}, []);

	const taskEditor = useTaskEditor({
		board,
		setBoard,
		currentProjectId,
		createTaskBranchOptions,
		defaultTaskBranchRef,
		fallbackTaskAgentId,
		availableTaskAgentIds,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	const { resetTaskEditorState } = taskEditor;

	const resetTaskEditorWorkflow = useCallback(() => {
		resetTaskEditorState();
		setPendingTaskStartAfterEditId(null);
	}, [resetTaskEditorState]);

	const value = useMemo<TaskEditorContextValue>(
		() => ({
			taskEditor,
			createTaskBranchOptions,
			pendingTaskStartAfterEditId,
			clearPendingTaskStartAfterEditId,
			resetTaskEditorWorkflow,
		}),
		[
			taskEditor,
			createTaskBranchOptions,
			pendingTaskStartAfterEditId,
			clearPendingTaskStartAfterEditId,
			resetTaskEditorWorkflow,
		],
	);

	return <TaskEditorContext.Provider value={value}>{children}</TaskEditorContext.Provider>;
}
