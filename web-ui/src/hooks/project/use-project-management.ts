import { runtimeProjectDisplayNameSchema } from "@runtime-contract";
import { useCallback, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { guardFileEditorScopes, retireFileEditorScopes } from "@/hooks/git/file-editor-cache";
import { resolveProjectDirectoryPickerDecision } from "@/hooks/project/project-navigation";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeProjectManagementResponse,
	RuntimeProjectStateResponse,
	RuntimeProjectSummary,
} from "@/runtime/types";
import { toErrorMessage } from "@/utils/to-error-message";

export type ProjectManagementAction = "rename" | "locate" | "rename_folder";

export interface ProjectManagementDialogState {
	action: ProjectManagementAction;
	project: RuntimeProjectSummary;
	value: string;
}

interface UseProjectManagementInput {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	isRuntimeDisconnected: boolean;
	flushBoardCommands: () => Promise<{ ok: boolean; message?: string }>;
	applyResult: (project: RuntimeProjectSummary, state?: RuntimeProjectStateResponse) => void;
}

export interface UseProjectManagementResult {
	dialog: ProjectManagementDialogState | null;
	error: string | null;
	pendingProjectId: string | null;
	isPickingFolder: boolean;
	requestRename: (projectId: string) => void;
	requestLocate: (projectId: string) => void;
	requestRenameFolder: (projectId: string) => void;
	setValue: (value: string) => void;
	close: () => void;
	confirm: () => Promise<void>;
	pickFolder: () => Promise<void>;
	checkAvailability: (projectId: string) => Promise<void>;
}

export type ProjectManagementMenuActions = Pick<
	UseProjectManagementResult,
	"requestRename" | "requestLocate" | "requestRenameFolder" | "pendingProjectId"
>;

export function useProjectManagement({
	currentProjectId,
	projects,
	isRuntimeDisconnected,
	flushBoardCommands,
	applyResult,
}: UseProjectManagementInput): UseProjectManagementResult {
	const [dialog, setDialog] = useState<ProjectManagementDialogState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
	const [isPickingFolder, setIsPickingFolder] = useState(false);
	const pendingRef = useRef(false);

	const request = useCallback(
		(action: ProjectManagementAction, projectId: string) => {
			if (pendingRef.current || isRuntimeDisconnected) return;
			const project = projects.find((item) => item.id === projectId);
			if (!project || (action === "rename_folder" && project.availability?.status === "unavailable")) return;
			const folderName =
				project.path
					.replace(/[\\/]+$/, "")
					.split(/[\\/]/)
					.at(-1) ?? "";
			setError(null);
			setDialog({
				action,
				project,
				value: action === "rename" ? project.name : action === "locate" ? project.path : folderName,
			});
		},
		[isRuntimeDisconnected, projects],
	);
	const requestRename = useCallback((projectId: string) => request("rename", projectId), [request]);
	const requestLocate = useCallback((projectId: string) => request("locate", projectId), [request]);
	const requestRenameFolder = useCallback((projectId: string) => request("rename_folder", projectId), [request]);
	const setValue = useCallback((value: string) => {
		setDialog((current) => current && { ...current, value });
		setError(null);
	}, []);
	const close = useCallback(() => {
		if (!pendingRef.current) {
			setDialog(null);
			setError(null);
		}
	}, []);

	const confirm = async () => {
		if (!dialog || pendingRef.current) return;
		if (isRuntimeDisconnected) {
			setError("Reconnect to Quarterdeck before saving this change.");
			return;
		}
		const value = dialog.value.trim();
		if (dialog.action === "rename" && value) {
			const validation = runtimeProjectDisplayNameSchema.safeParse(value);
			if (!validation.success) {
				setError(validation.error.issues[0]?.message ?? "Enter a project name.");
				return;
			}
		} else if (dialog.action !== "rename" && !value) {
			setError(dialog.action === "locate" ? "Enter the project folder path." : "Enter a folder name.");
			return;
		}
		if (dialog.action === "rename_folder" && (/[\\/]/.test(value) || value === "." || value === "..")) {
			setError("Enter one folder name without a path.");
			return;
		}
		const { project, action } = dialog;
		pendingRef.current = true;
		setPendingProjectId(project.id);
		setError(null);
		try {
			if (action !== "rename") {
				if (project.id === currentProjectId) {
					const flushed = await flushBoardCommands();
					if (!flushed.ok)
						throw new Error(flushed.message ?? "Save pending task changes before moving this folder.");
				}
				if (!guardFileEditorScopes({ projectId: project.id }, { includeDetached: false })) {
					setError("Save or discard this project's file changes before changing its folder.");
					return;
				}
			}
			const client = getRuntimeTrpcClient(project.id);
			let result: RuntimeProjectManagementResponse;
			if (action === "rename")
				result = await client.projects.rename.mutate({ projectId: project.id, name: value || null });
			else if (action === "locate")
				result = await client.projects.locate.mutate({
					projectId: project.id,
					expectedPath: project.path,
					path: value,
				});
			else
				result = await client.projects.renameFolder.mutate({
					projectId: project.id,
					expectedPath: project.path,
					folderName: value,
				});
			if (result.project) applyResult(result.project, result.state);
			if (!result.ok) throw new Error(result.error ?? "Could not save this project change.");
			if (action !== "rename") retireFileEditorScopes({ projectId: project.id });
			setDialog(null);
			showAppToast({
				intent: "success",
				message:
					action === "rename"
						? "Project name saved."
						: action === "locate"
							? "Project folder reconnected."
							: "Project folder renamed.",
			});
		} catch (cause) {
			setError(toErrorMessage(cause));
		} finally {
			pendingRef.current = false;
			setPendingProjectId(null);
		}
	};

	const pickFolder = async () => {
		if (dialog?.action !== "locate" || pendingRef.current || isRuntimeDisconnected) return;
		pendingRef.current = true;
		setPendingProjectId(dialog.project.id);
		setIsPickingFolder(true);
		setError(null);
		try {
			const result = await getRuntimeTrpcClient(dialog.project.id).projects.pickDirectory.mutate();
			const decision = resolveProjectDirectoryPickerDecision(result);
			if (decision.kind === "selected") setValue(decision.path);
			else if (decision.kind === "failed") setError(decision.message);
			else if (decision.kind === "manual_path")
				setError("Enter the folder path on the machine running Quarterdeck.");
		} catch (cause) {
			setError(toErrorMessage(cause));
		} finally {
			pendingRef.current = false;
			setPendingProjectId(null);
			setIsPickingFolder(false);
		}
	};

	const checkAvailability = async (projectId: string) => {
		if (pendingRef.current || isRuntimeDisconnected) return;
		pendingRef.current = true;
		setPendingProjectId(projectId);
		try {
			const result = await getRuntimeTrpcClient(projectId).projects.checkAvailability.mutate({ projectId });
			if (result.project) applyResult(result.project, result.state);
			if (!result.ok) throw new Error(result.error ?? "Could not check this project folder.");
			if (result.project?.availability?.status === "unavailable")
				showAppToast({
					intent: "warning",
					message: "Folder is still unavailable. Locate it to reconnect this project.",
				});
		} catch (cause) {
			notifyError(toErrorMessage(cause));
		} finally {
			pendingRef.current = false;
			setPendingProjectId(null);
		}
	};

	return {
		dialog,
		error,
		pendingProjectId,
		isPickingFolder,
		requestRename,
		requestLocate,
		requestRenameFolder,
		setValue,
		close,
		confirm,
		pickFolder,
		checkAvailability,
	};
}
