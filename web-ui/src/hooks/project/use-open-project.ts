import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import {
	buildOpenCommand,
	getOpenTargetOption,
	getOpenTargetOptions,
	normalizeOpenTargetId,
	type OpenTargetId,
	type OpenTargetOption,
	PREFERRED_OPEN_TARGET_STORAGE_KEY,
	resolveOpenTargetPlatform,
} from "@/utils/open-targets";
import { useRawLocalStorageValue } from "@/utils/react-use";
import { toErrorMessage } from "@/utils/to-error-message";

interface UseOpenWorkspaceParams {
	currentProjectId: string | null;
	projectPath?: string;
}

interface UseOpenWorkspaceResult {
	openTargetOptions: readonly OpenTargetOption[];
	selectedOpenTargetId: OpenTargetId;
	onSelectOpenTarget: (targetId: OpenTargetId) => void;
	onOpenWorkspace: () => void;
	canOpenWorkspace: boolean;
	isOpeningWorkspace: boolean;
}

function getFirstOutputLine(output: string): string | null {
	return (
		output
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? null
	);
}

export function useOpenProject({ currentProjectId, projectPath }: UseOpenWorkspaceParams): UseOpenWorkspaceResult {
	const openTargetPlatform = resolveOpenTargetPlatform();
	const openTargetOptions = useMemo(() => getOpenTargetOptions(openTargetPlatform), [openTargetPlatform]);
	const fallbackTargetId = openTargetOptions[0]?.id ?? "vscode";
	const [preferredOpenTargetId, setPreferredOpenTargetId] = useRawLocalStorageValue<OpenTargetId>(
		PREFERRED_OPEN_TARGET_STORAGE_KEY,
		fallbackTargetId,
		(value) => normalizeOpenTargetId(value),
	);
	const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
	const selectedOpenTarget = useMemo(
		() => getOpenTargetOption(preferredOpenTargetId, openTargetPlatform),
		[openTargetPlatform, preferredOpenTargetId],
	);
	const canOpenWorkspace = Boolean(currentProjectId && projectPath);

	const onSelectOpenTarget = useCallback(
		(targetId: OpenTargetId) => {
			if (!openTargetOptions.some((option) => option.id === targetId)) {
				return;
			}
			setPreferredOpenTargetId(targetId);
		},
		[openTargetOptions, setPreferredOpenTargetId],
	);

	const showOpenFailureToast = useCallback(
		(message: string) => {
			showAppToast(
				{
					intent: "danger",
					icon: "error",
					message: `Could not open in ${selectedOpenTarget.label}: ${message}`,
					timeout: 6000,
				},
				"open-project-failed",
			);
		},
		[selectedOpenTarget.label],
	);

	const onOpenWorkspace = useCallback(() => {
		if (isOpeningWorkspace || !currentProjectId || !projectPath) {
			return;
		}

		void (async () => {
			setIsOpeningWorkspace(true);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.runCommand.mutate({
					command: buildOpenCommand(selectedOpenTarget.id, projectPath, openTargetPlatform),
				});
				if (payload.exitCode !== 0) {
					const details = getFirstOutputLine(payload.combinedOutput) ?? `Exited with code ${payload.exitCode}.`;
					showOpenFailureToast(details);
				}
			} catch (error) {
				const message = toErrorMessage(error);
				showOpenFailureToast(message);
			} finally {
				setIsOpeningWorkspace(false);
			}
		})();
	}, [
		currentProjectId,
		isOpeningWorkspace,
		openTargetPlatform,
		selectedOpenTarget.id,
		showOpenFailureToast,
		projectPath,
	]);

	return {
		openTargetOptions,
		selectedOpenTargetId: selectedOpenTarget.id,
		onSelectOpenTarget,
		onOpenWorkspace,
		canOpenWorkspace,
		isOpeningWorkspace,
	};
}
