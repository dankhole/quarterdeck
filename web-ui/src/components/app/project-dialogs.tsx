import type { ReactElement } from "react";
import { ManualProjectPathDialog } from "@/components/app/manual-project-path-dialog";
import { ProjectManagementDialog } from "@/components/app/project-management-dialog";
import { StartupOnboardingDialog } from "@/components/app/startup-onboarding-dialog";
import { GitInitDialog } from "@/components/git/git-init-dialog";
import { useProjectManagementContext } from "@/providers/project-management-context";
import { useProjectNavigationContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";

/**
 * Renders the startup onboarding and git-init dialogs, reading all state from
 * project contexts. Extracted from App.tsx to reduce its JSX surface.
 */
export function ProjectDialogs(): ReactElement {
	const management = useProjectManagementContext();
	const {
		runtimeProjectConfig,
		isStartupOnboardingDialogOpen,
		handleCloseStartupOnboardingDialog,
		handleSelectOnboardingAgent,
	} = useProjectRuntimeContext();
	const {
		pendingGitInitializationPath,
		isInitializingGitProject,
		handleCancelInitializeGitProject,
		handleConfirmInitializeGitProject,
		isManualProjectPathDialogOpen,
		isAddingManualProject,
		handleCancelManualProjectPath,
		handleConfirmManualProjectPath,
	} = useProjectNavigationContext();

	return (
		<>
			<ProjectManagementDialog management={management} />
			<StartupOnboardingDialog
				open={isStartupOnboardingDialogOpen}
				onClose={handleCloseStartupOnboardingDialog}
				selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
				agents={runtimeProjectConfig?.agents ?? []}
				llmConfigured={runtimeProjectConfig?.llmConfigured ?? false}
				runtimePlatform={runtimeProjectConfig?.runtimePlatform ?? "other"}
				onSelectAgent={handleSelectOnboardingAgent}
			/>

			<GitInitDialog
				open={pendingGitInitializationPath !== null}
				path={pendingGitInitializationPath}
				isInitializing={isInitializingGitProject}
				onAddFolder={() => {
					void handleConfirmInitializeGitProject(true);
				}}
				onCancel={handleCancelInitializeGitProject}
				onConfirm={() => {
					void handleConfirmInitializeGitProject();
				}}
			/>

			<ManualProjectPathDialog
				open={isManualProjectPathDialogOpen}
				isAdding={isAddingManualProject}
				onCancel={handleCancelManualProjectPath}
				onConfirm={(path) => {
					void handleConfirmManualProjectPath(path);
				}}
			/>
		</>
	);
}
