import { useCallback, useState } from "react";

import type { RuntimeConfigResponse } from "@/runtime/types";

interface UseDebugToolsParams {
	runtimeProjectConfig: RuntimeConfigResponse | null;
	settingsRuntimeProjectConfig: RuntimeConfigResponse | null;
	onOpenStartupOnboardingDialog: () => void;
}

interface UseDebugToolsResult {
	debugModeEnabled: boolean;
	isDebugDialogOpen: boolean;
	handleOpenDebugDialog: () => void;
	handleShowStartupOnboardingDialog: () => void;
	handleDebugDialogOpenChange: (nextOpen: boolean) => void;
}

export function useDebugTools({
	runtimeProjectConfig,
	settingsRuntimeProjectConfig,
	onOpenStartupOnboardingDialog,
}: UseDebugToolsParams): UseDebugToolsResult {
	const [isDebugDialogOpen, setIsDebugDialogOpen] = useState(false);
	const debugModeEnabled =
		(settingsRuntimeProjectConfig?.debugModeEnabled ?? runtimeProjectConfig?.debugModeEnabled ?? false) === true;

	const handleOpenDebugDialog = useCallback(() => {
		setIsDebugDialogOpen(true);
	}, []);

	const handleDebugDialogOpenChange = useCallback((nextOpen: boolean) => {
		setIsDebugDialogOpen(nextOpen);
	}, []);

	const handleShowStartupOnboardingDialog = useCallback(() => {
		setIsDebugDialogOpen(false);
		onOpenStartupOnboardingDialog();
	}, [onOpenStartupOnboardingDialog]);

	return {
		debugModeEnabled,
		isDebugDialogOpen,
		handleOpenDebugDialog,
		handleShowStartupOnboardingDialog,
		handleDebugDialogOpenChange,
	};
}
